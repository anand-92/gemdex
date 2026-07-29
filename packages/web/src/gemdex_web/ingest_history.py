"""Deriving ingest history from the memory pool itself.

**The data source, and why it is the pool rather than a ledger.**

Chat-history ingestion has two paths, and neither leaves host-side bookkeeping
this service could read:

- **Path A — `gemdex sync-history`** runs on each laptop. Its ledger
  (`~/.gemdex/ingest.json`, keyed by absolute file path + mtime) lives on *that
  laptop*; the host never sees it, and a per-path ledger is meaningless for a
  host that never had those paths. The host only ever received finished records
  through `POST /mcp/sync/records`, which stores them and keeps no separate log.
- **Path B — web upload** (GEM2-7) forwards transcripts to
  `POST /v1/sessions/ingest`, which upserts memories and returns a per-request
  summary. That summary is handed to the browser and then gone; nothing
  persists it.

So the only durable, host-side record of "what has been ingested" is **the
memories themselves**. That is a genuine advantage rather than a fallback: it
cannot drift from reality, it needs no new schema or volume, and it reports both
paths identically because both paths write the same kind of memory.

What makes this work is the deterministic id from `gemdex-core`:
`chat:<source>:<sessionId>`. Filtering the pool on that prefix yields exactly
the ingested sessions, and the `<source>` segment is authoritative — it is
written by the ingester, not inferred here.

**The one thing this view must not claim.** A digest memory's `createdAt` /
`updatedAt` are the *session's* first and last activity timestamps, not when it
was ingested (see `ingest-manager.ts`: `createdAt: meta.firstTs ?? now`, and
`importRecords` preserves them rather than stamping its own). Verified against
the real pool: 1278 chat memories spread over 73 distinct days, each matching
the session date in its own digest header. So this module says "session
activity", never "ingested at" — the host genuinely does not know when a laptop
ran sync, and inventing that would be the kind of plausible-looking lie an
operator would later make decisions on.

Repo and agent come from the digest's own header line, which
`renderDigestMemory` writes as:

    Source: <label> · Repo: <cwd> (<branch>) · <YYYY-MM-DD>

That header is the first thing in the content, so it survives into the 100-char
`preview` the BYOI's list route returns — meaning this whole view costs one
`GET /v1/memories` that the list view was already making, with no per-memory
fetch.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from typing import Any

#: Ids of ingested chat sessions. Written by core's `memoryIdForSession`.
CHAT_ID_PREFIX = "chat:"

#: Sources core can attribute a session to (`IngestSource` in core's
#: `ingest/types.ts`), mapped to the same labels the digest header uses so the
#: UI and the memory body agree.
SOURCE_LABELS = {
    "claude": "Claude Code",
    "factory": "Factory CLI",
    "codex": "Codex",
    "antigravity": "Antigravity",
    "custom": "Coding agent",
}

#: The digest header `renderDigestMemory` writes as the memory's first line.
#: Every part after the source is optional because the header omits the repo
#: when the session had no cwd, and the preview is truncated at 100 characters —
#: which cuts the header mid-way for long repo paths (18 of 1278 in the real
#: pool), so the trailing groups must tolerate running off the end.
_HEADER = re.compile(
    r"^Source: (?P<label>[^\n·]+?)"
    r"(?: · Repo: (?P<repo>[^\n·]+?))?"
    r"(?: · (?P<date>\d{4}-\d{2}-\d{2}))?"
    r"\s*(?:\n|$)"
)

#: A repo path may carry its git branch: `/path/to/repo (main)`.
_REPO_WITH_BRANCH = re.compile(r"^(?P<path>.*?)\s+\((?P<branch>[^()]*)\)$")

#: The same thing with its closing paren cut off by the 100-char preview limit.
#: Worth handling separately: without it, `/repo (main)` and a truncated
#: `/repo (fix/some-long-bra` become different keys and one repo shows up as
#: several rows in the summary.
_REPO_TRUNCATED_BRANCH = re.compile(r"^(?P<path>.*?)\s+\((?P<branch>[^()]*)$")


@dataclass(frozen=True)
class IngestedSession:
    """One ingested chat session, as the pool knows it."""

    memory_id: str
    source: str
    source_label: str
    session_id: str
    title: str | None
    repo: str | None
    branch: str | None
    #: Session activity, NOT ingest time. See the module docstring.
    started_at: int | None
    last_active_at: int | None
    has_transcript: bool


def parse_chat_memory_id(memory_id: str) -> tuple[str, str] | None:
    """Split `chat:<source>:<sessionId>` into its source and session id.

    Returns `None` for anything that is not a chat memory. The session id may
    itself contain colons (a custom source could produce one), so only the first
    two segments are split off.
    """
    if not memory_id.startswith(CHAT_ID_PREFIX):
        return None
    remainder = memory_id[len(CHAT_ID_PREFIX) :]
    source, separator, session_id = remainder.partition(":")
    if not separator or not source or not session_id:
        return None
    return source, session_id


def _split_repo(repo: str | None) -> tuple[str | None, str | None]:
    """Separate `/path/to/repo (branch)` into its parts.

    A truncated branch is still split off the path, so the repo groups with its
    fully-rendered siblings instead of forming a bucket of one. The branch itself
    is dropped in that case rather than reported half-written.
    """
    if not repo:
        return None, None
    stripped = repo.strip()
    match = _REPO_WITH_BRANCH.match(stripped)
    if match:
        return match.group("path").strip() or None, match.group("branch").strip() or None
    truncated = _REPO_TRUNCATED_BRANCH.match(stripped)
    if truncated:
        return truncated.group("path").strip() or None, None
    return stripped or None, None


def describe_session(memory: dict[str, Any]) -> IngestedSession | None:
    """Project one pool memory into an ingest-history row, or `None`.

    `None` means "not an ingested chat session" — a hand-written memory, or an
    id that does not parse. Those are simply not part of this view.
    """
    memory_id = memory.get("id")
    if not isinstance(memory_id, str):
        return None
    parsed = parse_chat_memory_id(memory_id)
    if parsed is None:
        return None
    source, session_id = parsed

    header = _HEADER.match(memory.get("preview") or "")
    repo, branch = _split_repo(header.group("repo") if header else None)

    return IngestedSession(
        memory_id=memory_id,
        source=source,
        # The id's source segment wins over the header's label: it is what the
        # ingester wrote, whereas the label is prose that was truncated into the
        # preview and may be missing entirely.
        source_label=SOURCE_LABELS.get(source, SOURCE_LABELS["custom"]),
        session_id=session_id,
        title=memory.get("title"),
        repo=repo,
        branch=branch,
        started_at=_timestamp(memory.get("createdAt")),
        last_active_at=_timestamp(memory.get("updatedAt")),
        # Path A and path B both attach the cleaned transcript under the id
        # `transcript`. A session without one predates transcript attachment or
        # was digested from an empty parse; either way the digest is all there is.
        has_transcript=bool(memory.get("attachments")),
    )


def _timestamp(value: Any) -> int | None:
    return value if isinstance(value, int) else None


def collect_sessions(memories: list[dict[str, Any]]) -> list[IngestedSession]:
    """Every ingested chat session in the pool, newest activity first."""
    sessions = [
        session for session in (describe_session(memory) for memory in memories) if session is not None
    ]
    sessions.sort(key=lambda session: session.last_active_at or 0, reverse=True)
    return sessions


def summarize_sources(sessions: list[IngestedSession]) -> list[dict[str, Any]]:
    """Per-agent totals: how much of the pool came from which coding agent."""
    counts = Counter(session.source for session in sessions)
    latest: dict[str, int] = {}
    for session in sessions:
        stamp = session.last_active_at or 0
        if stamp > latest.get(session.source, 0):
            latest[session.source] = stamp
    return [
        {
            "source": source,
            "label": SOURCE_LABELS.get(source, SOURCE_LABELS["custom"]),
            "sessions": count,
            "lastActiveAt": latest.get(source) or None,
        }
        for source, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]


def summarize_repos(sessions: list[IngestedSession], limit: int) -> list[dict[str, Any]]:
    """Busiest repos by session count.

    The closest honest answer to "which machine did this come from". The host is
    never told the hostname — path A pushes digests, not machine identity — but
    the repo path is in every digest header and is what a human actually
    recognizes ("that's my work laptop's checkout").
    """
    counts = Counter(session.repo for session in sessions if session.repo)
    return [{"repo": repo, "sessions": count} for repo, count in counts.most_common(limit)]
