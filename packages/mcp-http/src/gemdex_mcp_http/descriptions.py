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
Retrieve memories from the user's global memory layer by natural-language query
and/or inline media (image / audio / video / PDF).

🎯 **When to use**: proactively and by default — make checking memory a reflex,
not something you wait to be told to do. Recall at the start of a task, before
solving a problem, before setting up a tool or environment, before making a
design/convention decision, and before asking the user for information they may
have already given you. Explicit prompts ("check your memory layer", "how do we
usually do X", "what were those credentials", "find the memory that matches this
screenshot") are just some of the triggers; a quick recall is cheap and often
surfaces prior work, so prefer checking first over assuming nothing is stored.

Behavior: hybrid semantic + BM25 search over text, plus a media-similarity
branch for each query attachment, fused by relevance. Returns the FULL matching
memories (never fragments). A query attachment must carry inline base64 `data`
plus a `mimeType` over this HTTP transport. Either `query` or at least one
attachment is required; recall-by-media requires the gemini-embedding-2 model.

Each hit reports its relative age (`updated: …`) and any attachments
(`kind (id …)`) so you can judge freshness and know media exists; fetch
attachment bytes with `read_attachment`. Pass `detail: "summary"` to get title +
preview + score only (cheap to scan many hits), then re-run with
`detail: "full"` (the default) for the complete content you need.

When available, each hit also shows a "track record" line (recalled/worked/
failed/stale counts from prior `report_outcome` calls) so you can judge how
trustworthy this memory has been in practice — a `⚠` prefix means it has failed
or gone stale before. Setting `GEMDEX_TRUST_RANKING=true` additionally re-ranks
results by that track record (off by default; ranking stays pure relevance until
you opt in).

Chat digests often attach the full session as a non-embedded `file` attachment
(caption "Full transcript (source file)"). Use `read_attachment` with the memory
id to fetch that transcript — the bytes come from the server blob store over
HTTP. Do NOT try to open a "Full transcript:" filesystem path: it refers to the
machine that ingested the session, not yours. Treat the transcript as supporting
evidence for exact prior code, commands, or session details when the digest
summary is not enough.
"""

LIST_MEMORIES = """
Browse the user's global memory layer: list stored memories newest-first, each
as a compact title + id + relative age + preview (no embedding/search).

🎯 **When to use**: whenever you want to orient yourself in what's stored — when
the user asks ("what do you have in memory?", "list your memories about
deploys") and also proactively, e.g. to get a memory's exact `id` for
`update_memory` when a fuzzy `recall` isn't precise, or to scan what already
exists before saving something new. Use it freely; you don't need the user to
point you at the memory layer first.

Behavior: returns lightweight summaries (content truncated to a preview), not
full content — use `recall` for relevance-ranked full memories. Optional
`filter` is a case-insensitive substring matched against title + preview (a
literal filter, NOT semantic search). `limit` defaults to 50 (max 200).
"""

UPDATE_MEMORY = """
Revise an existing memory in place, identified by its id.

🎯 **When to use**: proactively whenever you discover a stored memory is
outdated, wrong, or duplicated — not only when the user asks
("the notarization step changed — update that memory"). If you learn a better
fact, or a `save_memory` response flags "⚠ similar existing memories already
stored", prefer correcting/consolidating the existing memory in place over
leaving stale or conflicting copies. Get the id from a prior save_memory,
recall, or list_memories result.

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

🎯 **When to use**: after `recall` / `list_memories` shows a memory with
attachments — especially chat digests that include a `file` attachment captioned
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
