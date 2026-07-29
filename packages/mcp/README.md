# gemdex-mcp

MCP memory layer for AI coding agents — `save_memory` / `recall` /
`update_memory` backed by Gemini embeddings + embedded LanceDB.

Part of [Gemdex](https://github.com/anand-92/gemdex).

## Install for Claude Code

```bash
claude mcp add gemdex \
  -e GEMINI_API_KEY=your-key \
  -- npx -y gemdex-mcp@latest
```

No Docker, no daemon. Memories live at `~/.gemdex/lance` by default.

To use a self-hosted Gemdex Server instead, configure remote mode. The client
does not need `GEMINI_API_KEY`; embedding runs on the server:

```bash
claude mcp add gemdex \
  -e GEMDEX_MODE=remote \
  -e GEMDEX_REMOTE_URL=https://memory.example.com \
  -e GEMDEX_REMOTE_TOKEN=your-server-token \
  -- npx -y gemdex-mcp@latest
```

### Configure remotes with the CLI

The easiest path is `init-remote` — it adds the remote, prompts for the token
(without echoing it), verifies the server is reachable, authenticated, and
version-compatible, switches to remote mode, and prints the agent command:

```bash
npx gemdex init-remote production https://memory.example.com

# Also copy this machine's local memories into the server in the same step:
npx gemdex init-remote production https://memory.example.com --import-local
```

Or run the individual steps:

```bash
# Prompts for the bearer token without echoing it.
npx gemdex remote add production https://memory.example.com

npx gemdex remote list
npx gemdex mode remote production
npx gemdex status

# Return to the embedded local backend.
npx gemdex mode local

# Copy the local store to a named remote, preserving memory ids.
npx gemdex import-local-to-remote production
```

Named remotes live in `~/.gemdex/config.json`. Bearer tokens are stored
separately in `~/.gemdex/.env` with user-only file permissions and are never
printed. For automation, use `--token-stdin`; to manage the secret externally,
use `--token-env MY_TOKEN_VAR`.

### Local and remote at the same time

Mode is per process via `GEMDEX_MODE`, so you can register two MCP servers — one
local, one remote — as two independent memory pools that never merge:

```bash
claude mcp add gemdex-local \
  -e GEMDEX_MODE=local -e GEMINI_API_KEY=your-key \
  -- npx -y gemdex-mcp@latest

claude mcp add gemdex-remote \
  -e GEMDEX_MODE=remote \
  -e GEMDEX_REMOTE_URL=https://memory.example.com \
  -e GEMDEX_REMOTE_TOKEN=your-server-token \
  -- npx -y gemdex-mcp@latest
```

Pass `GEMDEX_MODE` per server (not `gemdex mode …`, which sets one shared mode).

## Install for any MCP client

```json
{
  "mcpServers": {
    "gemdex": {
      "command": "npx",
      "args": ["-y", "gemdex-mcp@latest"],
      "env": {
        "GEMINI_API_KEY": "your-key"
      }
    }
  }
}
```

See the [BYOI operations guide](../../docs/BYOI_OPERATIONS.md) for server
deployment, TLS, storage, backup/restore, upgrades, and troubleshooting.

## Tools

- `save_memory(content, title?)` — persist a new memory; returns its `id`.
- `recall(query, limit?)` — retrieve full memories by natural language (hybrid
  semantic + BM25), ranked by relevance. Never returns fragments.
- `update_memory(id, content?, edits?, title?)` — revise an existing memory in
  place. `edits` is a targeted find-and-replace (`{ oldText, newText, replaceAll? }`)
  so you can change part of a large memory without resending it; `content` is a
  full rewrite. The two are mutually exclusive.

Deletion is intentionally **not** an agent tool — it's a human action in the
Gemdex desktop app.

## Chat-history ingestion

```bash
npx gemdex ingest-history --source claude --dry-run
npx gemdex ingest-history --source claude
```

Ingestion processes **only sessions that have never been successfully ingested**.
Previously ingested sessions are reported as skipped and are never re-digested,
even if the transcript later changes. This invariant is enforced by the core
engine; there is no CLI or sidecar override. Digestion always needs a local
`GEMINI_API_KEY`, including when memory storage is remote.

### Syncing history to a self-hosted host

`sync-history` is the same pipeline pointed at a **remote** Gemdex host, so every
machine you code on feeds one searchable pool:

```bash
npx gemdex sync-history --url https://gemdex.example.com/mcp --dry-run
npx gemdex sync-history --url https://gemdex.example.com/mcp
```

The first run opens a browser once to sign in as the host's allowlisted Google
account; after that the stored refresh token is redeemed silently. Set
`GEMDEX_SYNC_URL` to skip `--url`, and use `--logout` to forget a host's
credentials (kept in `~/.gemdex/sync-auth.json`, `0600`).

Notes:

- Digests are built **on your machine** (your `GEMINI_API_KEY`) — only the digest
  and the transcript are uploaded, never your whole session history unprocessed.
- Session ids are deterministic, so syncing the same history twice updates in
  place instead of creating duplicates. Safe to re-run, and safe to run from
  several machines.
- `https` is required for anything but a loopback host: the request carries an
  access token.
- This is a **write-only** capability. It can add or update chat digests on the
  host and nothing else.

## Desktop sidecar

The same binary also runs the localhost HTTP manager API used by the desktop app:

```bash
npx gemdex serve --port 0   # 127.0.0.1 only; --port 0 = OS picks a free port
```

## Environment

| Variable | Description |
|----------|-------------|
| `GEMDEX_MODE` | `local` (default) or `remote` |
| `GEMINI_API_KEY` | Required in local mode; Google AI Studio API key |
| `LANCEDB_PATH` | *(optional)* Custom directory for the embedded store (default `~/.gemdex/lance`) |
| `GEMDEX_REMOTE_URL` | Required in remote mode; Gemdex Server root URL |
| `GEMDEX_REMOTE_TOKEN` | Required in remote mode by default; server bearer token |
| `GEMDEX_REMOTE_TOKEN_ENV_VAR` | Optional alternate env var containing the remote token |
| `GEMDEX_SYNC_URL` | *(optional)* Default host `/mcp` endpoint for `sync-history` |
| `GEMDEX_REMOTE_NAME` | Optional human-readable remote name |

See the [main repo](https://github.com/anand-92/gemdex) for all environment
variables and configuration options.

## License

MIT
