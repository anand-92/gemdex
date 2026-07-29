"""Pure render helpers for tool output.

Ported line-for-line from `packages/mcp/src/handlers.ts` so an agent sees
byte-identical text whether it reached Gemdex over stdio or Streamable HTTP.
Any change here must be mirrored there (and vice versa).
"""

from __future__ import annotations

import math
import re
import time
from typing import Any

PREVIEW_LENGTH = 200
DEFAULT_READ_ATTACHMENT_MAX_CHARS = 1_500_000

_TEXTISH_MIME_PREFIXES = ("text/", "application/json", "application/x-ndjson", "application/jsonl")
_WHITESPACE = re.compile(r"\s+")


def now_ms() -> int:
    return int(time.time() * 1000)


def is_textish_mime(mime_type: str) -> bool:
    lower = mime_type.lower()
    return (
        any(lower == prefix or lower.startswith(prefix) for prefix in _TEXTISH_MIME_PREFIXES)
        or "json" in lower
        or lower == "application/xml"
        or lower.endswith("+json")
        or lower.endswith("+xml")
    )


def make_preview(content: str, length: int = PREVIEW_LENGTH) -> str:
    """Collapse whitespace and truncate content to a short, single-line preview."""
    collapsed = _WHITESPACE.sub(" ", content or "").strip()
    if len(collapsed) <= length:
        return collapsed
    return collapsed[:length].rstrip() + "…"


def format_relative_age(timestamp: float, now: int | None = None) -> str:
    """Compact relative age ("just now", "5m ago", "3d ago", "2y ago").

    Future timestamps (clock skew) read "just now".
    """
    current = now_ms() if now is None else now
    diff_ms = current - timestamp
    if not math.isfinite(diff_ms) or diff_ms < 0:
        return "just now"
    seconds = int(diff_ms // 1000)
    if seconds < 60:
        return "just now"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}m ago"
    hours = minutes // 60
    if hours < 24:
        return f"{hours}h ago"
    days = hours // 24
    if days < 7:
        return f"{days}d ago"
    if days < 30:
        return f"{days // 7}w ago"
    if days < 365:
        return f"{days // 30}mo ago"
    return f"{days // 365}y ago"


def format_track_record_line(stats: dict[str, Any] | None, now: int | None = None) -> str | None:
    """Per-hit track-record line; `None` when no stats exist for the memory yet.

    Only non-zero tallies are shown, EXCEPT that `failed`/`stale` are always
    both shown together once either is non-zero, prefixed with `⚠`.
    """
    if not stats:
        return None
    failed = stats.get("failedCount", 0)
    stale = stats.get("staleCount", 0)
    has_bad_outcomes = failed + stale > 0
    parts = [f"recalled {stats.get('recallCount', 0)}×"]
    worked = stats.get("workedCount", 0)
    if worked > 0:
        parts.append(f"worked {worked}×")
    if has_bad_outcomes:
        if failed > 0:
            parts.append(f"failed {failed}×")
        if stale > 0:
            parts.append(f"stale {stale}×")
    last_outcome = stats.get("lastOutcome")
    note = ""
    if isinstance(last_outcome, dict):
        note = f" (last: {last_outcome.get('outcome')} {format_relative_age(last_outcome.get('at', 0), now)})"
    prefix = "⚠ track record" if has_bad_outcomes else "track record"
    return f"{prefix}: {', '.join(parts)}{note}"


def trust_multiplier(stats: dict[str, Any] | None) -> float:
    """Trust-weighted re-ranking multiplier (opt-in, `GEMDEX_TRUST_RANKING=true`).

    Exactly 1 — a no-op — for a memory with no stats, so untracked memories keep
    their relative order:

      trust = clamp( (1 + 0.08·ln(1+worked)) / (1 + 0.20·ln(1+failed+stale)), 0.6, 1.4 )
    """
    if not stats:
        return 1.0
    boost = 1 + 0.08 * math.log(1 + stats.get("workedCount", 0))
    penalty = 1 + 0.20 * math.log(1 + stats.get("failedCount", 0) + stats.get("staleCount", 0))
    return min(1.4, max(0.6, boost / penalty))


def format_attachments_line(attachments: list[dict[str, Any]] | None) -> str | None:
    """Per-hit attachment line for recall output; `None` when there are none."""
    if not attachments:
        return None
    parts = []
    for attachment in attachments:
        caption = attachment.get("caption")
        caption_part = f': "{caption}"' if caption else ""
        parts.append(f"{attachment.get('kind')} (id {attachment.get('id')}{caption_part})")
    return f"attachments: {', '.join(parts)}"


def format_attachment_counts(attachments: list[dict[str, Any]] | None) -> str:
    """Compact attachment summary for list output, e.g. ` · 1 image, 1 pdf`."""
    if not attachments:
        return ""
    counts: dict[str, int] = {}
    for attachment in attachments:
        kind = str(attachment.get("kind"))
        counts[kind] = counts.get(kind, 0) + 1
    parts = [f"{n} {kind}{'s' if n > 1 else ''}" for kind, n in counts.items()]
    return f" · {', '.join(parts)}"


def _format_score_branch(label: str, rank: Any, detail: str) -> str:
    if rank is None:
        return f"{label}=—"
    return f"{label}=#{rank}{detail}"


def format_sub_scores_line(
    fused_score: float,
    sub_scores: dict[str, Any] | None = None,
    trust: float | None = None,
) -> str:
    """Per-branch sub-score line beneath each recall hit.

    `fused_score` is always the raw relevance score (pre-trust-adjustment);
    `trust` is omitted entirely when `GEMDEX_TRUST_RANKING` is off, so output is
    byte-identical to the flag-off case.
    """
    fused = f"fused={fused_score:.4f}"
    trust_part = f" · trust=×{trust:.2f}" if trust is not None else ""
    if not sub_scores:
        return f"Scores: {fused}{trust_part}"
    dense_distance = sub_scores.get("denseDistance")
    fts_score = sub_scores.get("ftsScore")
    dense_detail = f" (d={dense_distance:.4f})" if dense_distance is not None else ""
    fts_detail = f" (s={fts_score:.2f})" if fts_score is not None else ""
    dense = _format_score_branch("dense", sub_scores.get("denseRank"), dense_detail)
    bm25 = _format_score_branch("bm25", sub_scores.get("ftsRank"), fts_detail)
    return f"Scores: {fused}{trust_part} · {dense} · {bm25}"


def format_memory_result(verb: str, memory: dict[str, Any]) -> str:
    """Confirmation block returned to the agent after a save/update."""
    lines = [f"{verb} memory.", f"id: {memory.get('id')}", f"title: {memory.get('title')}"]
    count = len(memory.get("attachments") or [])
    if count > 0:
        lines.append(f"attachments: {count}")
    return "\n".join(lines)


def format_similar_block(similar: list[dict[str, Any]], now: int | None = None) -> str:
    """Advisory near-duplicate block appended after `save_memory`.

    Ids are shown in full (not truncated) since the text asks the agent to pass
    one straight into `update_memory`.
    """
    lines = ["⚠ similar existing memories already stored:"]
    for index, ref in enumerate(similar):
        age = format_relative_age(ref.get("updatedAt", 0), now)
        similarity = ref.get("similarity", 0)
        lines.append(
            f"  {index + 1}. \"{ref.get('title')}\" (id {ref.get('id')}, "
            f"updated {age}, {similarity:.2f} similar)"
        )
    lines.extend(
        [
            "If the new memory revises or duplicates one of these, consolidate: keep ONE",
            "canonical memory — update_memory the existing id with the merged content (or",
            "confirm with the user which should win). Avoid leaving both.",
        ]
    )
    return "\n".join(lines)


def pick_default_attachment_id(attachments: list[dict[str, Any]]) -> str | None:
    """Pick a default attachment when the agent omits `attachment_id`.

    1. sole attachment on the memory
    2. sole `file` kind (transcripts)
    3. sole caption matching /transcript/i
    Otherwise `None` so the caller asks the agent to choose.
    """
    if len(attachments) == 1:
        return attachments[0].get("id")
    files = [a for a in attachments if a.get("kind") == "file"]
    if len(files) == 1:
        return files[0].get("id")
    transcripts = [
        a for a in attachments
        if isinstance(a.get("caption"), str) and re.search("transcript", a["caption"], re.IGNORECASE)
    ]
    if len(transcripts) == 1:
        return transcripts[0].get("id")
    return None


def apply_content_edits(content: str, edits: list[dict[str, Any]]) -> str:
    """Literal find-and-replace edits, ported from `core/memory/content-edits.ts`.

    Applied in order, each against the result of the previous one. Occurrences
    are non-overlapping. Raises `ValueError` on an empty edit list, an empty or
    unchanged `oldText`, a missing `oldText`, or a non-unique `oldText` without
    `replaceAll`.
    """
    if not edits:
        raise ValueError("at least one edit is required")
    result = content
    for edit in edits:
        old_text = edit["oldText"]
        new_text = edit["newText"]
        if not old_text:
            raise ValueError("'oldText' must not be empty")
        if old_text == new_text:
            raise ValueError("'oldText' and 'newText' are identical; no change to apply")
        occurrences = result.count(old_text)
        if occurrences == 0:
            raise ValueError(f'oldText not found in memory content: "{make_preview(old_text, 60)}"')
        if occurrences > 1 and not edit.get("replaceAll"):
            raise ValueError(
                f"oldText is not unique ({occurrences} matches); add surrounding context or "
                f'set replaceAll: true: "{make_preview(old_text, 60)}"'
            )
        result = result.replace(old_text, new_text) if edit.get("replaceAll") else result.replace(old_text, new_text, 1)
    return result
