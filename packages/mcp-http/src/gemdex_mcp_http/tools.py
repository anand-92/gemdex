"""The six Gemdex tool wrappers.

The Python counterpart of `packages/mcp/src/handlers.ts`: argument validation,
delegation to the BYOI `/v1` API, and result formatting. There is deliberately no
memory logic here — chunking, embedding, ranking, and storage all happen behind
`ByoiClient`.

Errors are raised as `ToolError` so the client sees `isError` with a
human-readable message, matching the TS handlers' "never throw a raw exception at
the protocol" contract.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastmcp.exceptions import ToolError
from pydantic import Field

from .byoi import ByoiClient, ByoiError
from .descriptions import ATTACHMENTS_FIELD
from .formatting import (
    DEFAULT_READ_ATTACHMENT_MAX_CHARS,
    apply_content_edits,
    format_attachments_line,
    format_memory_result,
    format_relative_age,
    format_similar_block,
    format_track_record_line,
    is_textish_mime,
    now_ms,
    pick_default_attachment_id,
    trust_multiplier,
)
from .stats import MemoryStatsStore

#: Fixed top-N for the title-index `recall` tool. No agent-facing limit param.
RECALL_FIXED_LIMIT = 10
#: Cap for trust-ranking over-fetch (well above fixed N so re-ranking has room).
RECALL_OVERFETCH_CAP = 100

AttachmentList = Annotated[list[dict[str, Any]] | None, Field(default=None, description=ATTACHMENTS_FIELD)]


def _validate_attachments(attachments: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    """Enforce inline-base64-only attachments.

    The TS stdio tools accept a local file `path` and read it off disk, because
    the agent and the MCP server share a machine. Over HTTP that assumption is
    false: a `path` would resolve on THIS host's filesystem, either failing or
    silently reading an unrelated file. So `path` is rejected explicitly rather
    than quietly host-resolved. See README "Attachment paths are host-local".
    """
    if attachments is None:
        return None
    validated: list[dict[str, Any]] = []
    for index, attachment in enumerate(attachments):
        if not isinstance(attachment, dict):
            raise ToolError(f"Error: attachment #{index + 1} must be an object.")
        if attachment.get("path"):
            raise ToolError(
                f"Error: attachment #{index + 1} uses 'path', which is not supported over the "
                "HTTP transport — the path would be read on the server host, not your machine. "
                "Send inline base64 'data' with a 'mimeType' instead."
            )
        if not attachment.get("data") or not attachment.get("mimeType"):
            raise ToolError(
                f"Error: attachment #{index + 1} requires inline base64 'data' and a 'mimeType'."
            )
        entry: dict[str, Any] = {"mimeType": attachment["mimeType"], "data": attachment["data"]}
        if attachment.get("caption") is not None:
            entry["caption"] = attachment["caption"]
        if attachment.get("id") is not None:
            entry["id"] = attachment["id"]
        validated.append(entry)
    return validated


def _validate_edits(edits: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    if edits is None:
        return None
    if not edits:
        raise ToolError("Error: 'edits' must contain at least one edit.")
    validated: list[dict[str, Any]] = []
    for edit in edits:
        if not isinstance(edit, dict):
            raise ToolError("Error: each edit must be an object with 'oldText' and 'newText'.")
        old_text = edit.get("oldText")
        new_text = edit.get("newText")
        if not isinstance(old_text, str) or not isinstance(new_text, str):
            raise ToolError("Error: each edit requires string 'oldText' and 'newText'.")
        replace_all = edit.get("replaceAll")
        if replace_all is not None and not isinstance(replace_all, bool):
            raise ToolError("Error: 'replaceAll' must be a boolean when provided.")
        entry: dict[str, Any] = {"oldText": old_text, "newText": new_text}
        if replace_all is not None:
            entry["replaceAll"] = replace_all
        validated.append(entry)
    return validated


class GemdexTools:
    """The tool implementations, bound to one BYOI client and one stats ledger."""

    def __init__(self, client: ByoiClient, stats: MemoryStatsStore, trust_ranking: bool = False) -> None:
        self._client = client
        self._stats = stats
        self._trust_ranking = trust_ranking

    # --- save_memory ------------------------------------------------------

    async def save_memory(
        self,
        content: Annotated[
            str | None,
            Field(
                default=None,
                description=(
                    "The memory content. A one-line fact or a long playbook — anything. "
                    "Recommended; optional only when attachments are provided."
                ),
            ),
        ] = None,
        title: Annotated[
            str | None,
            Field(default=None, description="Optional human-readable name. Auto-derived from content if omitted."),
        ] = None,
        attachments: AttachmentList = None,
    ) -> str:
        text = content or ""
        resolved = _validate_attachments(attachments)
        if not text.strip() and not resolved:
            raise ToolError("Error: provide 'content' or at least one attachment.")

        payload: dict[str, Any] = {"content": text}
        if title is not None:
            payload["title"] = title
        if resolved is not None:
            payload["attachments"] = resolved

        memory = await self._call("save memory", self._client.save(payload))
        base = format_memory_result("Saved", memory)
        similar = memory.get("similar") or []
        if similar:
            return f"{base}\n\n{format_similar_block(similar)}"
        return base

    # --- recall -----------------------------------------------------------

    async def recall(
        self,
        query: Annotated[
            str,
            Field(description="Natural-language description of what to recall."),
        ],
    ) -> str:
        text = (query or "").strip()
        if not text:
            raise ToolError("Error: 'query' is required.")

        label = f'"{text}"'
        # Flag off: fetch exactly N. Flag on: over-fetch so re-ranking has room.
        fetch_limit = (
            min(max(RECALL_FIXED_LIMIT * 2, RECALL_FIXED_LIMIT + 5), RECALL_OVERFETCH_CAP)
            if self._trust_ranking
            else RECALL_FIXED_LIMIT
        )
        payload: dict[str, Any] = {"query": text, "limit": fetch_limit}

        fetched = await self._call("recall memories", self._client.recall(payload))
        results = (
            self._apply_trust_ranking(fetched)[:RECALL_FIXED_LIMIT]
            if self._trust_ranking
            else fetched
        )
        if not results:
            return f"No memories matched {label}. Nothing stored yet, or no relevant match."

        # Title-index only — opening via get_memory is what counts as a recall.
        now = now_ms()
        blocks = []
        for index, result in enumerate(results):
            lines = [
                f"{index + 1}. {result.get('title')}",
                f"   id: {result['id']}",
            ]
            track_record = format_track_record_line(self._safe_get_stats(result["id"]), now)
            if track_record:
                lines.append(f"   {track_record}")
            blocks.append("\n".join(lines))

        noun = "memory" if len(results) == 1 else "memories"
        header = (
            f"Recalled {len(results)} {noun} for {label} "
            "(titles only — call get_memory with an id to open full content):\n"
        )
        return header + "\n" + "\n\n".join(blocks)

    # --- get_memory -------------------------------------------------------

    async def get_memory(
        self,
        id: Annotated[
            str,
            Field(description="The id of the memory to open (from recall or save_memory)."),
        ],
    ) -> str:
        memory_id = (id or "").strip()
        if not memory_id:
            raise ToolError("Error: 'id' is required.")

        memory = await self._call("get memory", self._client.get(memory_id))
        if memory is None:
            raise ToolError(f"Failed to get memory: Memory not found: {memory_id}")

        # Telemetry only — a stats-store failure must never break get_memory.
        try:
            self._stats.record_recall([memory_id])
        except Exception:  # noqa: BLE001 - telemetry is never a point of failure
            pass

        now = now_ms()
        lines = [
            memory.get("title") or "",
            f"id: {memory.get('id', memory_id)}",
            f"updated: {format_relative_age(memory.get('updatedAt', 0), now)}",
        ]
        track_record = format_track_record_line(self._safe_get_stats(memory_id), now)
        if track_record:
            lines.append(track_record)
        attachments_line = format_attachments_line(memory.get("attachments"))
        if attachments_line:
            lines.append(attachments_line)
        lines.extend(["", memory.get("content") or ""])
        return "\n".join(lines)

    def _apply_trust_ranking(self, hits: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Re-rank over-fetched hits by `score * trustMultiplier(stats)`.

        Python's `sorted` is stable, so the backend's relative order survives
        ties, and untracked memories carry `trust = 1`.
        """
        return sorted(
            hits,
            key=lambda hit: hit.get("score", 0) * trust_multiplier(self._safe_get_stats(hit["id"])),
            reverse=True,
        )

    def _safe_get_stats(self, memory_id: str) -> dict[str, Any] | None:
        """Stats reads hit the filesystem; degrade to "no stats" rather than fail recall."""
        try:
            return self._stats.get(memory_id)
        except Exception:  # noqa: BLE001 - telemetry is never a point of failure
            return None

    # --- update_memory ----------------------------------------------------

    async def update_memory(
        self,
        id: Annotated[
            str, Field(description="The id of the memory to revise (from save_memory, recall, or get_memory).")
        ],
        content: Annotated[
            str | None,
            Field(
                default=None,
                description=(
                    "Full replacement text. Omit to keep the existing text. Mutually exclusive with "
                    "'edits'; prefer 'edits' for large memories."
                ),
            ),
        ] = None,
        edits: Annotated[
            list[dict[str, Any]] | None,
            Field(
                default=None,
                description=(
                    "Targeted find-and-replace edits applied to the current content — the preferred way "
                    "to change part of a large memory without resending the whole note. Each item is "
                    "{ oldText, newText, replaceAll? }, applied in order. Mutually exclusive with 'content'."
                ),
            ),
        ] = None,
        title: Annotated[
            str | None,
            Field(default=None, description="Optional new title. Omit to keep the existing title."),
        ] = None,
        attachments: AttachmentList = None,
    ) -> str:
        if not id.strip():
            raise ToolError("Error: 'id' is required.")
        resolved_attachments = _validate_attachments(attachments)
        resolved_edits = _validate_edits(edits)
        if content is not None and resolved_edits is not None:
            raise ToolError("Error: provide either 'content' or 'edits', not both.")
        if content is None and resolved_edits is None and title is None and attachments is None:
            raise ToolError(
                "Error: provide at least one of 'content', 'edits', 'title', or 'attachments' to update."
            )

        # Only include provided fields so the store preserves the rest in place.
        payload: dict[str, Any] = {}
        if content is not None:
            payload["content"] = content
        if title is not None:
            payload["title"] = title
        if resolved_attachments is not None:
            payload["attachments"] = resolved_attachments

        if resolved_edits is not None:
            # `edits` are applied client-side against the current content, then
            # persisted via the normal full-content update path. Read-modify-write
            # is last-write-wins: a concurrent edit in between is overwritten.
            current = await self._call("update memory", self._client.get(id))
            if current is None:
                raise ToolError(f"Failed to update memory: Memory not found: {id}")
            try:
                payload["content"] = apply_content_edits(current.get("content", ""), resolved_edits)
            except ValueError as error:
                raise ToolError(f"Failed to update memory: {error}") from error

        memory = await self._call("update memory", self._client.update(id, payload))
        return format_memory_result("Updated", memory)

    # --- report_outcome ---------------------------------------------------

    async def report_outcome(
        self,
        id: Annotated[
            str,
            Field(description="The id of the memory you acted on (from a prior get_memory or save_memory result)."),
        ],
        outcome: Annotated[
            Literal["worked", "failed", "stale"],
            Field(
                description=(
                    "'worked' — followed it and it was correct. 'failed' — its information was wrong or "
                    "broken. 'stale' — clearly outdated (e.g. rotated credentials, moved paths)."
                )
            ),
        ],
        note: Annotated[
            str | None,
            Field(
                default=None,
                description=(
                    "Optional one-line note on what happened (e.g. \"notarytool flags changed; --wait no "
                    'longer accepts --timeout"). Capped at 500 characters.'
                ),
            ),
        ] = None,
    ) -> str:
        if not id.strip():
            raise ToolError("Error: 'id' is required.")
        # Validate the id against the backend first so a junk id can never
        # pollute the stats ledger.
        memory = await self._call("report outcome", self._client.get(id))
        if memory is None:
            raise ToolError(f"Failed to report outcome: Memory not found: {id}")
        try:
            stats = self._stats.record_outcome(id, outcome, note)
        except Exception as error:  # noqa: BLE001 - surface as a tool error, not a crash
            raise ToolError(f"Failed to report outcome: {error}") from error
        return "\n".join(
            [
                f'Recorded outcome for "{memory.get("title")}".',
                f"id: {id}",
                f"track record: recalled {stats['recallCount']}×, worked {stats['workedCount']}×, "
                f"failed {stats['failedCount']}×, stale {stats['staleCount']}×",
            ]
        )

    # --- read_attachment --------------------------------------------------

    async def read_attachment(
        self,
        memory_id: Annotated[
            str, Field(description="Id of the parent memory (from save_memory, recall, or get_memory).")
        ],
        attachment_id: Annotated[
            str | None,
            Field(
                default=None,
                description=(
                    "Optional attachment id. Omit when the memory has a single attachment or a single "
                    "Full transcript file attachment."
                ),
            ),
        ] = None,
        max_chars: Annotated[
            int,
            Field(
                default=DEFAULT_READ_ATTACHMENT_MAX_CHARS,
                description=(
                    "Max characters of text/base64 to return (default 1500000). Truncates with an "
                    "overflow note when exceeded."
                ),
                gt=0,
            ),
        ] = DEFAULT_READ_ATTACHMENT_MAX_CHARS,
    ) -> str:
        if not memory_id.strip():
            raise ToolError("Error: 'memory_id' is required.")

        memory = await self._call("read attachment", self._client.get(memory_id))
        if memory is None:
            raise ToolError(f"Failed to read attachment: Memory not found: {memory_id}")
        attachments = memory.get("attachments") or []
        if not attachments:
            hint = (
                " Digest still has a local path footer — use read_attachment after backfill, "
                "or open the path when local."
                if "Full transcript:" in (memory.get("content") or "")
                else ""
            )
            raise ToolError(f"Failed to read attachment: Memory {memory_id} has no attachments.{hint}")

        resolved_id = attachment_id.strip() if attachment_id and attachment_id.strip() else pick_default_attachment_id(attachments)
        if not resolved_id:
            listed = ", ".join(
                f"{a.get('id')} ({a.get('kind')}" + (f': "{a["caption"]}"' if a.get("caption") else "") + ")"
                for a in attachments
            )
            raise ToolError(f"Error: multiple attachments; pass 'attachment_id'. Available: {listed}")

        meta = next((a for a in attachments if a.get("id") == resolved_id), None)
        if meta is None:
            listed = ", ".join(str(a.get("id")) for a in attachments)
            raise ToolError(
                f"Failed to read attachment: Attachment {resolved_id} not found on {memory_id}. "
                f"Available: {listed}"
            )

        blob = await self._call("read attachment", self._client.read_attachment(memory_id, resolved_id))
        if blob is None:
            raise ToolError(f"Failed to read attachment: Blob missing for {memory_id}/{resolved_id}.")
        data, mime_type = blob

        header_lines = [
            f"Attachment {resolved_id} of memory {memory_id}",
            f"kind: {meta.get('kind')}",
            f"mimeType: {mime_type}",
            f"byteLength: {len(data)}",
        ]
        if meta.get("caption"):
            header_lines.append(f"caption: {meta['caption']}")
        header = "\n".join(header_lines)

        if is_textish_mime(mime_type):
            text = data.decode("utf-8", errors="replace")
            if len(text) <= max_chars:
                return f"{header}\nencoding: utf-8\n\n{text}"
            return (
                f"{header}\nencoding: utf-8\ntruncated: true\n"
                f"showingChars: {max_chars} of {len(text)}\n"
                f"(raise max_chars to read more; default is {DEFAULT_READ_ATTACHMENT_MAX_CHARS})\n\n"
                f"{text[:max_chars]}"
            )

        import base64

        encoded = base64.b64encode(data).decode("ascii")
        if len(encoded) <= max_chars:
            return f"{header}\nencoding: base64\n\n{encoded}"
        return (
            f"{header}\nencoding: base64\ntruncated: true\n"
            f"showingChars: {max_chars} of {len(encoded)} (base64)\n"
            f"(raise max_chars to read more)\n\n"
            f"{encoded[:max_chars]}"
        )

    # --- plumbing ---------------------------------------------------------

    @staticmethod
    async def _call(action: str, awaitable: Any) -> Any:
        """Await a BYOI call, converting transport/HTTP failures into a ToolError."""
        try:
            return await awaitable
        except ByoiError as error:
            raise ToolError(f"Failed to {action}: {error}") from error
