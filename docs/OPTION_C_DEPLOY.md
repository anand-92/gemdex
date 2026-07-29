# Option C deploy / re-import runbook

Ship notes for **TEXT memory ids**, **transcript file attachments** on chat
digests, and MCP **`read_attachment`**.

## What changed

| Area | Change |
|------|--------|
| Postgres | Migration `003` rebuilds document/attachment/chunk tables with **TEXT** memory ids; attachment `kind` allows `file`. |
| Ingest | New digests attach a **cleaned plain-text** transcript as a non-embedded `file` blob (`id=transcript`, `text/plain`). Wire JSONL bloat (thinking, signatures, message ids, system-reminders) is stripped at attach time; digest text still embeds only. |
| Backfill | `gemdex backfill-transcripts` and `gemdex import-local-to-remote --attach-transcripts`. |
| MCP | 6th tool: `read_attachment` (local + remote, no `GEMINI_API_KEY`). |

## Mac Mini always-on BYOI box

Implement/merge this branch into the checkout that owns Docker Compose (often
`/Users/nikhilanand/gemdex`), then:

```sh
# 1. Rebuild server so migration 003 runs on startup
cd packages/server   # or repo path on the Mini
docker compose up -d --build
curl --fail http://127.0.0.1:8765/v1/health
curl --fail http://127.0.0.1:8765/v1/version

# Optional explicit migrate if you use the migrate subcommand:
# docker compose run --rm gemdex-server migrate
```

```sh
# 2. Re-import ~1.2k local digests WITH transcript blobs
# From a client machine that still has ~/.gemdex Lance data + session files:
gemdex import-local-to-remote production --attach-transcripts

# Or attach on the active remote after a plain import:
gemdex mode remote production
gemdex backfill-transcripts --dry-run
gemdex backfill-transcripts
```

Missing transcript paths are **skipped with a stderr message** (not a hard fail).

```sh
# 3. MCP clients
# Upgrade gemdex-mcp; agents gain read_attachment automatically.
# No GEMDEX_MODE / token change required for remote clients.
npx -y gemdex-mcp@latest status
```

## Agent usage

After `recall` hits a chat digest:

```text
read_attachment memory_id="chat:factory:<sessionId>"
```

Omit `attachment_id` when there is a single `file` / transcript attachment.
Optional `max_chars` (default ~1.5e6) truncates with a clear note.

## Invariants preserved

- Ingest remains **new-sessions-only** (no re-digest of changed sessions).
- No agent delete tool.
- Parent-document recall unchanged; transcript body is **not** embedded.
