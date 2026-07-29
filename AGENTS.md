# AGENTS.md — Gemdex (system map)

Repo-root reference for coding agents. This file is the **map**: how the four
packages fit together and where the hard problems live. Each package has its own
`AGENTS.md` explaining its internals — read the relevant one before editing
code there. The closest `AGENTS.md` wins.

## What Gemdex is

A **global, persistent memory layer for AI coding agents**. An agent explicitly
saves a memory once and recalls it across every repo, session, and machine.
Retrieval is the **parent-document ("small-to-big")** pattern: content is
chunked and embedded for sharp matching (hybrid dense + BM25 fused with
Reciprocal Rank Fusion), but recall always returns the **whole parent memory,
never a fragment**.

## The one architectural idea to hold in your head

**All memory logic lives in `gemdex-core`. Everything else is a thin shell.**

```
                 ┌──────────────────────────────────────────────┐
                 │  gemdex-core  (the engine)                    │
                 │  • MemoryStore: chunk → embed → store →       │
                 │    recall → resolve to whole parent           │
                 │  • GeminiEmbedding (multimodal)               │
                 │  • LanceDBVectorDatabase (dense + BM25 + RRF) │
                 │  • handleMemoryApiRequest  ← shared HTTP API  │
                 │  • MemoryBackend: Local ⇄ Remote (same iface) │
                 └──────────────────────────────────────────────┘
                    ▲              ▲                        ▲
        depends on  │              │ depends on             │ depends on
   ┌────────────────┴───┐   ┌──────┴───────────────┐   the same shared
   │ gemdex-mcp         │   │ gemdex-server        │   HTTP router is
   │ (client surface)   │   │ (BYOI backend)       │   mounted by BOTH
   │ • MCP stdio tools  │   │ • node:http + /v1    │   mcp's `serve`
   │ • `gemdex serve`   │   │ • Postgres/pgvector  │   sidecar AND the
   │   localhost sidecar│   │ • file/S3 blobs      │   server
   │ • remote-mode CLI  │   │ • server-side embed  │
   └────────────────────┘   └──────────────────────┘
              ▲                          ▲
              │ spawns sidecar over      │ HTTP /v1 over the compose network
              │ localhost (PORT/TOKEN)   │ (BYOI bearer stays server-side)
   ┌──────────┴──────────┐   ┌───────────┴──────────┐
   │ packages/app        │   │ packages/web         │
   │ native SwiftUI mac  │   │ React SPA + FastAPI  │
   │ (thin HTTP client)  │   │ BFF. Browser manage  │
   └─────────────────────┘   │ surface; has DELETE  │
                             └──────────────────────┘
```

Two facts that explain most of the codebase:

1. **`gemdex-core/src/http/http-api.ts` (`handleMemoryApiRequest`) is the single
   memory HTTP API**, mounted verbatim by *both* the `gemdex serve` sidecar (in
   `mcp`) and the BYOI `server`. Fix a memory-route bug there, not in either
   shell.
2. **`MemoryBackend` has two interchangeable impls** — `LocalMemoryBackend`
   (embeds client-side via Gemini + LanceDB) and `RemoteMemoryBackend` (HTTP to
   a BYOI server, which embeds). Callers are written once and swapped by
   `GEMDEX_MODE`. Remote-mode clients need **no `GEMINI_API_KEY`**.

## Packages

| Package | Name | What it is | Read |
|---------|------|------------|------|
| `packages/core` | `gemdex-core` | The engine: chunking + parent-document recall, embeddings, LanceDB hybrid+RRF, the shared HTTP router, the backend interface. | [core/AGENTS.md](packages/core/AGENTS.md) |
| `packages/mcp` | `gemdex-mcp` | One binary, three modes: MCP stdio tools, the `gemdex serve` localhost sidecar, the remote-mode CLI. | [mcp/AGENTS.md](packages/mcp/AGENTS.md) |
| `packages/server` | `gemdex-server` | Self-hosted BYOI backend: thin `node:http` shell (`/v1`, auth, CORS, migrations) over Postgres/pgvector + file/S3 blobs, server-side embedding. | [server/AGENTS.md](packages/server/AGENTS.md) |
| `packages/mcp-http` | `gemdex-mcp-http` | **Python.** The Streamable HTTP MCP surface (FastMCP v4) at `/mcp` for remote agents; OAuth 2.1 single-user auth. Thin wrapper over the BYOI `/v1` API — cannot import core. | [mcp-http/AGENTS.md](packages/mcp-http/AGENTS.md) |
| `packages/web` | `gemdex-web` | **Python + React.** The browser manager UI: a Vite/TS SPA over a FastAPI backend-for-frontend. Google single-user login; the self-host manage surface, and it has delete. | [web/AGENTS.md](packages/web/AGENTS.md) |
| `packages/app` | — | Native SwiftUI macOS manage-only app; spawns the sidecar and is a thin HTTP client. Swift, not TS. **Maintenance-only** — `packages/web` is the primary manage surface; keep this working, don't delete it, land new manage features in `web`. | [app/AGENTS.md](packages/app/AGENTS.md) |

`deploy/` is the reference Compose stack for the full setup — BYOI + MCP (agents)
+ web manager (humans) behind a public HTTPS edge — see
[deploy/README.md](deploy/README.md). `scripts/install.sh` is the one-line
installer that stands that stack up locally.

`docs/` map:

| Doc | What it is |
|-----|------------|
| [BYOI_OPERATIONS.md](docs/BYOI_OPERATIONS.md) | Operating a BYOI backend; security and custody model |
| [BYOI_REMOTE_MODE.md](docs/BYOI_REMOTE_MODE.md) | The `/v1` wire contract: auth, attachments, compat floor, ranking invariants |
| [SELF_HOST_DEPLOY.md](docs/SELF_HOST_DEPLOY.md) | Canonical end-to-end public deploy: Compose, Google OAuth, HTTPS edge, exposure proof |
| [GO_FURTHER.md](docs/GO_FURTHER.md) | DNS/TLS, Render, Railway, VPS, local-vs-cloud split, cost/sizing |
| [SECURITY_SELFHOST.md](docs/SECURITY_SELFHOST.md) | What the deployment enforces and where in the code; pre-launch checklist |
| [CHAT_HISTORY.md](docs/CHAT_HISTORY.md) | The three ingestion paths (`sync-history`, web upload, host-local) and the deterministic-id invariant |

When you change auth, exposure, or ingestion behaviour, `SECURITY_SELFHOST.md`
and `CHAT_HISTORY.md` cite specific code paths — update them with the code.

## Cross-cutting mechanics (where to look)

- **Save → recall pipeline** (chunking, attachments-as-rows, two RRF layers,
  embed-before-delete, embed → **detect** (save-time similar-memory check) →
  insert on the save path): `gemdex-core` → [core/AGENTS.md](packages/core/AGENTS.md).
- **Outcome feedback loop** (`report_outcome` + `recall`'s track-record line
  and opt-in trust re-ranking): a client-side ledger in `gemdex-core`
  (`stats/memory-stats-store.ts`, `~/.gemdex/stats.json`), consumed entirely
  from `gemdex-mcp` — zero `MemoryStore`/wire-contract changes, so it works
  identically local and remote (BYOI). Stats are per-client in v1.
- **Local vs remote** (per-process via `GEMDEX_MODE`; pools never merge; copy via
  `import-local-to-remote`): mcp + core.
- **The shared store** lives at `~/.gemdex` (LanceDB at `~/.gemdex/lance`, blob
  bytes at `~/.gemdex/blobs`, secrets in `~/.gemdex/.env` `0600`). The MCP
  process and the desktop sidecar share it, so a memory saved by one shows up in
  the other.
- **Sidecar handshake** (`PORT=<n> TOKEN=<hex>` on stdout; `127.0.0.1` + per-launch
  `X-Gemdex-Token`): mcp's `serve.ts` writes it, the app's `SidecarManager`
  reads it.
- **stdout is sacred in MCP mode** — it carries JSON-RPC frames; the handshake
  line is the one sanctioned raw-stdout write. See mcp.
- **BYOI wire contract / compat floor** (`/v1`, bearer auth, `minClientVersion`):
  server + [docs/BYOI_REMOTE_MODE.md](docs/BYOI_REMOTE_MODE.md).

## Six tools, no delete

The MCP surface is `save_memory`, `recall`, `update_memory`, the read-only
`list_memories` (browse summaries newest-first, optional substring filter — for
orienting and getting exact ids; `recall` remains the relevance-ranked path),
`report_outcome` (record whether a recalled memory `worked`/`failed`/`stale`
— the outcome feedback loop; per-client stats ledger, no LanceDB writes, opt-in
trust-weighted re-ranking via `GEMDEX_TRUST_RANKING`), and `read_attachment`
(fetch attachment/transcript bytes as UTF-8 or base64 for a memory id — used for
chat digests that store the full session as a non-embedded `file` blob; works
local + remote without `GEMINI_API_KEY`). **There is no agent delete tool by
design** — deletion is a deliberate human action (the sidecar/core
`DELETE /memories/:id` route exists; the MCP tools deliberately don't expose it).

The human delete surfaces are the desktop app and, for a self-hosted
deployment, the web manager (`packages/web`, behind its own login and a confirm
dialog). Keep it that way: making the surfaces "consistent" by adding a delete
tool to either MCP transport would discard the property on purpose here.

## Conventions (TS packages)

- TypeScript strict; **prefer `??` over `||`**; **never** add `eslint-disable`
  (fix the cause).
- **Required config fails fast at startup** — no silent fallback to a broken
  default.
- `packages/app` is Swift/SwiftUI — these rules don't apply there.

## Working in the monorepo

- pnpm workspace, Node ≥ 24, pnpm ≥ 10. `pnpm install` from the root.
- Per-package work: `pnpm --filter <name> <script>` (e.g. `build`, `dev`, `test`).
- Full local gate before pushing: `pnpm lint && pnpm typecheck && pnpm build &&
  pnpm -r test`. CI plan: `.github/workflows/ci.yml` (TS verify matrix +
  desktop-app build + BYOI Postgres integration + Docker compose smoke).
- `pnpm-workspace.yaml` pins the Jest family to `30.3.0` and lists
  `@lancedb/lancedb` under `onlyBuiltDependencies` (native build) — don't unpin
  casually.
