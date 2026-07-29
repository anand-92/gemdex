# Chat-history ingestion — which path to use

Gemdex can distill coding-agent chat transcripts into memories: **one memory per
session**, holding a Gemini-written digest plus the full cleaned transcript as a
non-embedded `file` attachment. There are three ways to get a session into the
pool, and picking the wrong one is the most common source of confusion in a
self-hosted setup.

## The invariant that makes all three safe

Every path writes the same deterministic id:

```
chat:<source>:<sessionId>
```

That single fact is why the paths compose instead of colliding:

- Re-running any path **upserts** rather than duplicating.
- A session already synced from a laptop is *updated*, not doubled, if it is
  later uploaded through the browser.
- The pool itself is the durable record of what has been ingested — filtering on
  the `chat:` prefix yields exactly the ingested sessions, which is how the web
  manager's ingest-history view works without any extra ledger or schema.

All paths also share the same cleaning and the same digest prompt. The digest
text is embedded; the transcript body is **not**.

Ingestion is **new-sessions-only**. A session that was already ingested is never
reprocessed, even if its transcript later changes.

## Decision table

| | **A — `gemdex sync-history`** | **B — web upload** | **Host-only — `ingest-history` on the host** |
|---|---|---|---|
| Run it from | Each coding machine | Any browser | The host itself |
| Command / surface | `gemdex sync-history` | Manager → upload transcripts | `gemdex ingest-history` |
| Reads transcripts from | That machine's disk | Files you hand it | The host's own disk |
| Who digests (and pays) | That machine, with **its own** `GEMINI_API_KEY` | **`gemdex-server`** on the host | The host |
| Auth | OAuth 2.1 to `/mcp`, browser once | Your manager session | None (local process) |
| Needs a local Gemini key | Yes | No | Yes (on the host) |
| Best for | The normal case: laptops that generate sessions | A machine that never ran the CLI; someone's exported session; a one-off | A stack where the agent runs *on* the host |

### A — `gemdex sync-history` (the normal path)

`ingest-history` pointed at a **remote** host instead of this machine's pool:
same scan, digest, and ledger semantics, but each digest is upserted into the
host's pool over its OAuth-protected `/mcp` endpoint.

```bash
gemdex sync-history --url https://memory.example.com/mcp
```

Run it on every coding machine. **The host never reads your laptop's disk** —
the laptop does the work and pushes finished records. The first run opens a
browser once to authorize as the host's allowlisted Google account; the refresh
token is then stored in `~/.gemdex/sync-auth.json` (`0600`). `--logout` forgets
it.

Useful flags: `--dry-run` prints the scan plus a cost estimate; `--batch`
submits a Gemini Batch API job (50% cost, results within ~24h) that you collect
later with `--collect`; `--source` selects presets (`claude`, `factory`, `codex`,
`antigravity`) or any folder of `.jsonl` sessions.

Its ledger (`~/.gemdex/ingest.json`, keyed by absolute path + mtime) is
inherently local — a per-path ledger is meaningless to a host that never had
those paths.

### B — web upload (hand over raw transcripts)

The human uploads transcripts in the manager and the **deployment** cleans and
digests them. This is how a machine that never ran the CLI — or an exported
session from somewhere else — still lands in the pool, with no local Gemini key
and nothing installed.

The digesting happens on `gemdex-server`, the one process that already holds a
Gemini key; the web BFF only decodes the form (expanding zips) and forwards to
`POST /v1/sessions/ingest`. Limits: `.jsonl` transcripts or `.zip` archives, ≤25
files, ≤24 MB per file, ≤64 MB per request. The response is always a per-file
list — a corrupt transcript among ten good ones is that file's status, never a
500 that discards the batch.

### Host-only sessions

If the agent runs on the host itself, that machine's transcripts are already
local: use `gemdex ingest-history` there against the active backend. No OAuth, no
upload. It needs a Gemini key on the host.

## Practical guidance

- **Default to A on every machine that generates sessions.** It scales to many
  laptops, keeps cost with whoever created the work, and needs no file shuffling.
- **Use B for the exceptions**, not as the routine — someone else's export, a
  machine you will not install the CLI on, a phone-to-browser handoff.
- Mixing them is safe and expected. The deterministic id absorbs overlap.
- One caveat when reading the manager's ingest view: a digest memory's
  `createdAt` / `updatedAt` are the **session's** first and last activity
  timestamps, not when it was ingested.

## Reading a transcript back

After `recall` surfaces a chat digest, the agent fetches the stored transcript
with the `read_attachment` tool (works local and remote, no `GEMINI_API_KEY`):

```text
read_attachment memory_id="chat:factory:<sessionId>"
```

Omit `attachment_id` when the memory has a single transcript attachment.

## Setup pointers

- Per-machine sync against a public host:
  [deploy guide → sync chat history](SELF_HOST_DEPLOY.md#sync-chat-history-from-each-machine)
- Browser upload:
  [deploy guide → upload sessions](SELF_HOST_DEPLOY.md#or-upload-sessions-from-the-browser)
- Attachment/transcript storage behaviour:
  [BYOI operations guide](BYOI_OPERATIONS.md)
