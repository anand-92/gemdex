"""Tool descriptions, copied from `packages/mcp/src/index.ts`.

Agents must see identical guidance whether they reach Gemdex over stdio or
Streamable HTTP, so these strings are kept in sync with the TS originals. The
one intentional divergence: attachments here are **inline base64 only** — a
local `path` refers to the agent's machine, not this service's host (see the
README section "Attachment paths are host-local"), so every mention of the
`path` shortcut is replaced with that constraint.
"""

SAVE_MEMORY = """
Persist a new memory to the user's global, durable memory layer.

🎯 **When to use**: proactively, as you work — you do NOT need the user to ask.
Save durable, reusable knowledge the moment you learn it: hard-won fixes and
root causes, project conventions and architecture decisions, setup/build/deploy
steps, credentials and paths the user shares, gotchas, and the rationale behind
choices. If it's likely to matter in a future session or repo, store it now
without waiting for permission. Explicit user requests ("remember that…", "save
this") are just one trigger among many. Keep memories to durable, reusable facts
— skip one-off trivia and anything easily re-derived from the current context.

Behavior: the content is chunked, embedded via Gemini, and stored globally
(searchable from every repo and session). Returns the new memory id.

Multimodal: optionally pass `attachments` (image/audio/video/PDF) to embed media
alongside the text. Over this HTTP transport each attachment MUST carry inline
base64 `data` plus a `mimeType` — a local file `path` would be read on the
service host, not your machine, so it is rejected. Requires the
gemini-embedding-2 model. Either `content` or at least one attachment is
required.

If the response includes a "⚠ similar existing memories already stored" block,
the store found near-duplicate/conflicting memories already there — read it and
consolidate with `update_memory` (or confirm with the user which should win)
rather than leaving both.
"""

RECALL = """
Search the user's global memory layer by natural-language query and return a
cheap ranked title index (never full bodies).

🎯 **When to use**: proactively and by default — make checking memory a reflex,
not something you wait to be told to do. Recall at the start of a task, before
solving a problem, before setting up a tool or environment, before making a
design/convention decision, and before asking the user for information they may
have already given you. A title-index recall is cheap; prefer checking first
over assuming nothing is stored.

Behavior: hybrid semantic + BM25 search, fused by relevance. Always returns up
to 10 hits as title + id only (plus a track-record line when outcome stats
exist). Most tasks end here with nothing useful — that is expected. When a
title looks clearly task-relevant, open THAT memory with `get_memory({ id })`.
Do not expect bodies from this tool.

Setting `GEMDEX_TRUST_RANKING=true` re-ranks the title index by track record
(off by default; ranking stays pure relevance until you opt in).
"""

GET_MEMORY = """
Load the full content of one stored memory by id.

🎯 **When to use**: after `recall` returns a title that looks clearly relevant
to the current task — or when you already have an exact id from `save_memory`.
This is the only MCP path that returns the full parent body. Most recalls need
no follow-up; only open memories you actually intend to use.

Behavior: returns title, id, relative age, optional track-record and attachment
metadata, and the full content. Use `read_attachment` afterward if you need
attachment/transcript bytes. Opening a memory counts as a recall for the
per-client outcome ledger (feeds track-record / optional trust ranking).
"""

UPDATE_MEMORY = """
Revise an existing memory in place, identified by its id.

🎯 **When to use**: proactively whenever you discover a stored memory is
outdated, wrong, or duplicated — not only when the user asks
("the notarization step changed — update that memory"). If you learn a better
fact, or a `save_memory` response flags "⚠ similar existing memories already
stored", prefer correcting/consolidating the existing memory in place over
leaving stale or conflicting copies. Get the id from a prior save_memory,
recall, or get_memory result.

Two ways to change the text:
- `edits`: targeted find-and-replace — preferred for large memories. Pass an
  array of `{ oldText, newText, replaceAll? }`; you emit only the changed
  snippets instead of resending the whole note. Each `oldText` must match
  exactly and be unique (set `replaceAll: true` to change every occurrence).
- `content`: full replacement of the text. Use for small memories or rewrites.
`content` and `edits` are mutually exclusive.

Behavior: re-chunks and re-embeds the resulting content under the same id.
Omitted fields are preserved — leave out `content`/`edits` to keep the prior
text, leave out `attachments` to keep the prior media (pass `attachments: []` to
clear it). Each attachment must carry inline base64 `data` plus a `mimeType`
over this HTTP transport. There is no delete via MCP — deletion is a human
action in the desktop app.
"""

REPORT_OUTCOME = """
Report how acting on a recalled memory went, so the memory layer learns which
memories are trustworthy.

🎯 **When to use**: right after you used a recalled memory and the outcome is
clear — `worked` (followed it and it was correct), `failed` (its information was
wrong or broken), `stale` (clearly outdated, e.g. rotated credentials or moved
paths). One call per memory actually used; do not report memories you merely saw
in results. This is meta-feedback on the memory layer itself and is the one
gemdex tool you should call without being asked, whenever a clear outcome
exists.

Recorded in a per-service ledger keyed by memory id (not written back into the
memory itself). With `GEMDEX_TRUST_RANKING=true` it also adjusts future `recall`
ranking — proven memories rank higher, memories that have burned the agent rank
lower.
"""

READ_ATTACHMENT = """
Read the bytes of an attachment on a stored memory as text (UTF-8) or base64.

🎯 **When to use**: after `get_memory` shows a memory with attachments —
especially chat digests that include a `file` attachment captioned
"Full transcript (source file)". This is the ONLY way to get attachment bytes
over this HTTP transport: the bytes live in the server blob store and are
fetched over HTTP, and a local path from a digest footer refers to a different
machine. No GEMINI_API_KEY required.

Args: `memory_id` (required), optional `attachment_id` (omit when there is
exactly one attachment, or a single transcript/`file` attachment), optional
`max_chars` (default ~1.5M; truncates with a clear overflow note).
"""

ATTACHMENTS_FIELD = (
    "Optional media to embed. Each item requires inline base64 'data' plus a "
    "'mimeType' — a local file 'path' is NOT supported over this HTTP transport "
    "(it would resolve on the service host, not your machine). Requires the "
    "gemini-embedding-2 model. Limits: ≤6 images, ≤1 PDF, ≤1 audio, ≤1 video "
    "per memory."
)
