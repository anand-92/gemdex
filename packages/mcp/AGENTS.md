# AGENTS.md — gemdex-mcp

Architecture quick-reference for coding agents. This package is the **client-side
surface** of Gemdex: it turns one binary into the MCP server agents talk to, the
localhost sidecar the desktop app talks to, and the CLI that wires a client to a
self-hosted server. It owns *no* memory logic — backends, embeddings, and the
HTTP memory router all live in `gemdex-core` (`workspace:*`). This package is the
plumbing: process entry, mode routing, auth, the MCP tool schemas, and remote
config persistence.

Read this to understand *how the moving parts connect* before editing. Generic
build/test/lint/style rules are repo-wide — see the root `AGENTS.md`.

## File map

| File | Role |
|------|------|
| `src/index.ts` | The single entry point + `bin`. Reroutes console→stderr, decides which of the three modes to run, defines the five MCP tool **schemas/descriptions**, constructs the `MemoryStatsStore`, runs the stdio server. |
| `src/serve.ts` | `gemdex serve` localhost HTTP sidecar: bind/token/origin auth + sidecar-only `/config` & `/settings*` routes; delegates data routes to core. |
| `src/handlers.ts` | MCP tool **logic** (`save_memory`/`recall`/`get_memory`/`update_memory`/`report_outcome`/`read_attachment`): arg validation, attachment resolution, title-index recall + full `get_memory`, stats bump on open, track-record rendering + opt-in trust re-ranking, save-time similar-memory advisory rendering, transcript/blob text fetch. Never throws to the protocol. |
| `src/cli.ts` | CLI verbs (`init-remote`, `remote …`, `mode …`, `status`, `import-local-to-remote`, `ingest-history`, `sync-history`). `runHistoryPipeline` is the shared scan→digest→upsert body behind the last two. |
| `src/sync-target.ts` | `RemoteSyncTarget` — an `IngestTarget` that POSTs digests to a remote host's `/mcp/sync/records` in batches of 25, refreshing the token exactly once on a 401. Write-only: it cannot recall or delete. |
| `src/sync-auth.ts` | The OAuth client for `sync-history`: `LoopbackReceiver` (RFC 8252 §7.3 loopback redirect) + `SyncOAuthClientProvider` + `authorizeSync()`, which drives the MCP SDK's `auth()` (DCR → PKCE → refresh) and only opens a browser when the SDK says `'REDIRECT'`. |
| `src/sync-config.ts` | `SyncCredentialStore` — per-host OAuth state in `~/.gemdex/sync-auth.json` (`0600`, dir `0700`): client registration, tokens, discovery. Keyed by MCP URL so `--logout` is scoped to one host. |
| `src/config.ts` | `createConfig()` — turns env into a `GemdexConfig`; `resolveMode` picks local vs remote. Also `--help`. |
| `src/memory.ts` | `createMemoryBackend(config)` — the one place that picks `LocalMemoryBackend` vs `RemoteMemoryBackend`. |
| `src/cli-config.ts` | `ClientConfigStore` — reads/writes `~/.gemdex/config.json` (named remotes) and `~/.gemdex/.env` (tokens, `0600`). |
| `src/embedding.ts` | `createEmbeddingInstance` — **throws if no `GEMINI_API_KEY`** in local mode. |
| `src/tool-names.ts` | The frozen tuple `['save_memory','recall','get_memory','update_memory','report_outcome','read_attachment']`; indices are referenced positionally in `index.ts`. |
| `integration/byoi.mjs` | End-to-end BYOI harness (real server + built mcp dist + Postgres/pgvector). |

## One binary, three modes — how `main()` routes

`src/index.ts` is both `bin` names (`gemdex` and `gemdex-mcp` point at the same
`dist/index.js`). `main()` dispatches on `process.argv` in this exact order:

1. `--help`/`-h` → `showHelpMessage()` then exit 0.
2. `argv[0] === 'serve'` → `runServe(args.slice(1))` → **HTTP sidecar**; returns (never starts MCP).
3. `runCli(args)` → if `argv[0]` is a known CLI verb (`remote`/`mode`/`status`/`init-remote`/`import-local-to-remote`) it handles it and returns an exit code; **otherwise it returns `null`** to signal "not a CLI command, fall through".
4. Fallthrough (no subcommand) → `createConfig()` + `new GemdexMemoryServer().start()` → **MCP stdio server** (the default).

So the mode is decided purely by the first argv token; there is no flag. Adding a
new CLI verb means adding it to `CLI_COMMANDS` in `cli.ts` **and** handling it, or
`runCli` returns `null` and it silently boots the MCP server instead.

## stdout is sacred in MCP mode

The very first statements in `index.ts` (before any import) monkey-patch
`console.log`/`console.warn` to write to **stderr** (`console.error` already does).
Reason: in MCP mode stdout carries the **JSON-RPC protocol frames** — any stray
byte corrupts the stream and breaks the client. Rule: never `process.stdout.write`
or un-redirected `console.log` from handler/tool code.

There is exactly **one deliberate raw-stdout write** in the whole package: the
sidecar's handshake. After `server.listen`, `runServe` writes a single line
`PORT=<n> TOKEN=<hex>\n` to the real stdout so the desktop shell can discover the
chosen port and the per-launch token. Everything else in serve mode goes to
stderr via `console.error`. (Sidecar mode doesn't speak MCP, so this is safe.)

## The `gemdex serve` sidecar

The sidecar exists to back the desktop manager app over localhost HTTP (chosen
over the Zig bridge to dodge a 16 KiB request/response cap). The **data routes are
not reimplemented here** — `serve.ts` calls `handleMemoryApiRequest` from
`gemdex-core`, the *same* router the BYOI server uses. The sidecar only adds four
things on top:

- **Bind**: `127.0.0.1` only.
- **Per-launch token**: 32 random bytes → 64 hex, minted in `runServe`, required
  in the `X-Gemdex-Token` header on every data/settings route, compared with
  `crypto.timingSafeEqual`.
- **Origin allow-list**: `Origin` header (when present) must equal
  `allowedOrigin` (`GEMDEX_WEBVIEW_ORIGIN`, default `zero://app`). **Absent**
  `Origin` is allowed — a browser always sets it on cross-origin requests, so its
  absence reliably means a same-origin WebView / non-browser caller.
- **Sidecar-only routes**: `/config` and `/settings*` (mode/remote management) —
  these are management concerns the shared core router intentionally does not mount.

### Route table (sidecar-local vs delegated-to-core)

| Method | Path | Token? | Source | Notes |
|--------|------|--------|--------|-------|
| `GET` | `/health` | no | sidecar | `{ ok: true }`; polled before a token exists |
| `GET` | `/config` | no | sidecar | Backend summary plus Gemini readiness (`missing`, `checking`, `valid`, `invalid`, `unavailable`) |
| `POST` | `/config` | no | sidecar | Validate candidate `GEMINI_API_KEY` with a real embedding call; persist and rebuild only on success |
| `POST` | `/config/validate` | no | sidecar | Retry validation of the saved key |
| `GET` | `/settings` | yes | sidecar | Mode + configured remotes |
| `POST` | `/settings/remotes` | yes | sidecar | Add/update named remote `{name,url,token?}` |
| `DELETE` | `/settings/remotes/:name` | yes | sidecar | Remove a remote |
| `POST` | `/settings/mode` | yes | sidecar | Switch `{mode:'local'\|'remote', name?}` |
| `POST` | `/settings/test` | yes | sidecar | Probe a remote's reachability + auth |
| `POST` | `/settings/import-local` | yes | sidecar | Copy local memories into a remote (by id) |
| `GET` | `/memories` | yes | **core** | List summaries |
| `POST` | `/memories` | yes | **core** | Create (content and/or attachments) |
| `GET` | `/memories/:id` | yes | **core** | Fetch one full memory |
| `PUT`/`PATCH` | `/memories/:id` | yes | **core** | Update content/title/attachments |
| `DELETE` | `/memories/:id` | yes | **core** | Delete (desktop-only path) |
| `GET` | `/memories/:id/attachments/:attachmentId` | yes | **core** | Raw bytes |
| `PATCH` | `/memories/:id/attachments` | yes | **core** | Caption-only edit (no re-embed) |
| `POST` | `/recall` | yes | **core** | Relevance search (text and/or inline media) |
| `GET` | `/export` | yes | **core** | Dump all records |
| `POST` | `/import` | yes | **core** | Upsert records by id |

Auth precedence inside `createServer`: reject bad `Origin` (403) → `OPTIONS`
preflight (204, no token) → `/health` and `/config*` (no token) → token gate (401
on miss) → `/settings*` → **validated-local-key gate** → store-null gate → core
data routes.

**`503 {needsKey:true}`**: the production sidecar validates any saved local key
on every launch with a small real embedding request. Local data routes remain
blocked while the key is missing, checking, rejected, or temporarily
unverifiable. `POST /config` validates a candidate before writing
`~/.gemdex/.env`, so a rejected key never replaces the current value;
`POST /config/validate` retries the saved key. Settings routes and remote memory
routes continue to work without a validated local key. Body cap is 100 MiB on
attachment-carrying core routes (50 MiB default elsewhere) → `413`; malformed
JSON → `400`.

## MCP tool contract

Schemas/descriptions live in `index.ts`; logic in `handlers.ts`. Six tools.
**Handlers never throw to the protocol** — on failure they return
`{ content:[…], isError:true }` with a human-readable message.

| Tool | Required | Optional | Returns |
|------|----------|----------|---------|
| `save_memory` | `content` **OR** ≥1 attachment | `content`, `title`, `attachments` | `Saved memory.` + `id:` + `title:` (+ `attachments:` count) (+ a `⚠ similar existing memories already stored:` advisory block when the backend's save-time detection found candidates) |
| `recall` | `query` | — | Header + top **10** hits as title + id only (+ `track record: …` when stats already exist). **Never bodies.** |
| `get_memory` | `id` | — | Full parent: title, id, `updated: <age>`, optional track-record + attachments metadata, and the full content. Bumps recall stats. |
| `update_memory` | `id` + ≥1 of `content`/`edits`/`title`/`attachments` | `content`, `edits`, `title`, `attachments` | `Updated memory.` + `id:` + `title:` |
| `report_outcome` | `id`, `outcome` (`worked`\|`failed`\|`stale`) | `note` (≤500 chars) | `Recorded outcome for "<title>".` + `id:` + `track record: recalled N×, worked N×, failed N×, stale N×` |
| `read_attachment` | `memory_id` | `attachment_id`, `max_chars` | Attachment bytes as UTF-8 or base64 |

Invariants:
- **No delete tool — by design.** Deletion is a deliberate human action in the
  desktop app; the *sidecar/core* exposes `DELETE /memories/:id`, the MCP surface
  deliberately does not.
- `recall` is a **title index only** (hybrid dense+BM25 fused in core). Fixed
  top 10; no `limit`/`detail`/media-query params. Agents open useful hits with
  `get_memory`. Core/BYOI `/v1/recall` still returns full content for web/desktop.
- `get_memory` is the **only** MCP path that returns a full parent body. It is
  also what bumps per-client `recallCount` (title-index hits do not).
- `update_memory` preserves omitted fields; **`attachments:[]` clears** media,
  while omitting `attachments` keeps existing media.
- **`edits` is the partial-update path, applied client-side in `handlers.ts`.**
  `update_memory` accepts either `content` (full replacement) or `edits` (an
  array of `{ oldText, newText, replaceAll? }`), never both. For `edits` the
  handler does `get(id)` → `applyContentEdits` (from `gemdex-core`) → the normal
  `update(id, { content })`, so the agent sends only the changed snippets and the
  HTTP/storage layers are unchanged. `oldText` must match exactly and be unique
  unless `replaceAll` is set. This read-modify-write is **last-write-wins**: a
  concurrent edit landing between the `get` and the `update` is overwritten.
- Attachments are either a local file `path` (preferred — `resolveAttachmentInputs`
  reads + base64-encodes the bytes so no megabytes ride in tool-call args) or
  inline `data`+`mimeType`. Media requires the **`gemini-embedding-2`** model.
  Per-modality caps: ≤6 images, ≤1 PDF, ≤1 audio, ≤1 video.
- **`report_outcome` validates the id against the backend first** (`store.get`,
  works on both local and remote) so a junk id can never pollute the stats
  ledger; only then does it call `MemoryStatsStore.recordOutcome`. This is the
  one gemdex tool an agent is told to call proactively (right after a clear
  worked/failed/stale outcome), not only when the user points at memory.
- **Stats bump lives on `get_memory`, not title-index `recall`.** Opening a body
  counts as a recall; scanning titles does not. `statsStore.get` (track-record
  line + trust ranking) and `statsStore.recordRecall` (on get) are each wrapped
  so a stats-store failure degrades rather than breaking the tool.
- **Trust-weighted re-ranking is opt-in** (`GEMDEX_TRUST_RANKING=true`, read
  once per call via `envManager`; anything else, including unset, is off).
  Off: `recall` fetches exactly 10 from the backend and returns backend order
  unchanged. On: over-fetches `fetchLimit = min(max(10*2, 10+5), 100)`,
  multiplies each hit's score by a deterministic `trustMultiplier(stats)` in
  `[0.6, 1.4]` (1 for an untracked memory), re-sorts, then slices to 10. The
  title index does not render a `trust=×…` line — only order changes.
  `MemoryStore.recall`'s "pure relevance" contract is untouched.
- **Save-time similar-memory detection is core's job, MCP only renders it.**
  `handleSaveMemory` appends the `⚠ similar existing memories already stored:`
  block purely from `SaveResult.similar` when non-empty; it never calls back
  into detection logic. Full ids are shown (not truncated) since the advisory
  text tells the agent to pass one straight into `update_memory`.

## Local vs remote is per-process

`GEMDEX_MODE` (via `resolveMode` in `createConfig`) selects the backend in
`createMemoryBackend`: `local` → `LocalMemoryBackend` over embedded LanceDB
(`~/.gemdex/lance`), `remote` → `RemoteMemoryBackend` over HTTP to a self-hosted
Gemdex Server. **The choice is fixed per process** — run two processes for two
independent pools; the local and remote pools never merge.

- **Remote mode needs no client `GEMINI_API_KEY`** — the server embeds. (Local
  mode requires it; see the startup-vs-lazy gotcha below.)
- **Named remotes** live in `~/.gemdex/config.json` (`{url, tokenEnvVar}` per
  name). **Tokens never go in that file** — they live in `~/.gemdex/.env`
  (`0600`, dir `0700`) under `GEMDEX_REMOTE_TOKEN_<NAME>` and are never printed.
  `ClientConfigStore.getEnv` resolves `process.env` first, then `~/.gemdex/.env`.
- **Activating** a remote (`mode remote <name>` / `init-remote`) writes
  `GEMDEX_MODE`, `GEMDEX_REMOTE_NAME`, `GEMDEX_REMOTE_URL`,
  `GEMDEX_REMOTE_TOKEN_ENV_VAR` into `~/.gemdex/.env` so future processes inherit it.
- **Copy paths** (one-directional, local→remote, upsert by id):
  `gemdex import-local-to-remote [name]` or `gemdex init-remote <name> <url> --import-local`.
  `init-remote` is the one-shot client setup: store remote+token → verify the
  server is reachable **and version-compatible** (`checkServerCompatibility`) →
  confirm the token authenticates (`.list()`) → optional import → activate.

## `sync-history`: laptop digests → a remote host

`gemdex sync-history` is `ingest-history` pointed at **someone else's pool**: the
same scan/digest/ledger pipeline, but each digest is upserted into a self-hosted
host over its OAuth-protected `/mcp` surface. The point is many coding machines,
one searchable pool — the host never reads a laptop's disk.

```
laptop: scan ~/.claude … → digest via Gemini (local key) → RemoteSyncTarget
                                                             │ POST /mcp/sync/records
                                                             │ Bearer <OAuth access token>
                                              host: mcp-http → BYOI /v1/import (upsert by id)
```

**Digests are generated client-side even though the destination is remote.** The
session files only exist on the laptop; digesting on the host would mean
uploading every raw transcript and moving the Gemini spend onto the host. So
`sync-history` needs a local `GEMINI_API_KEY` — unlike remote *mode*, which needs
none.

**Why a custom route and not an MCP tool.** The ticket's preferred shape was
"zero new server surface — just call the existing tools," and that is not
possible: `save_memory` mints a **random** id (`MemoryStore.newId()`) and
`update_memory` requires the id to already exist. Sync needs *upsert on a
deterministic id* (`chat:<source>:<sessionId>`, so re-syncing a session updates
in place instead of duplicating) while preserving `createdAt`. Only `/v1/import`
does that, and it is deliberately absent from the six-tool agent surface. Hence
the documented fallback: one auth-guarded ingest route, authenticated with the
**standard MCP OAuth flow** rather than a static bearer, so no long-lived
full-access secret is ever copied onto a laptop.

**Auth is the SDK's, not ours.** `authorizeSync()` hands the MCP SDK's `auth()`
an `OAuthClientProvider`; the SDK owns discovery, dynamic client registration,
PKCE, and refresh. We supply only storage (`SyncCredentialStore`) and the
loopback redirect. Consequences worth knowing:

- **The browser opens only on first authorization.** A stored refresh token is
  redeemed silently; `auth()` returns `'AUTHORIZED'` without any redirect.
- **The loopback receiver is single-use and state-matched** — it binds
  `127.0.0.1:0` (kernel-assigned port), rejects a mismatched `state`, times out
  after 5 minutes, and is always closed in a `finally`.
- **Tokens live in `~/.gemdex/sync-auth.json` (`0600`), keyed by MCP URL.** The
  refresh token is the sensitive part; treat it like the BYOI bearer and never
  print it. `--logout` clears one host, not all of them.
- **A 401 triggers exactly one refresh, then fails.** `RemoteSyncTarget` retries
  the batch once with a force-refreshed token; a second 401 surfaces as a failed
  record. Never loop — a revoked allowlist entry must be visible, not retried
  forever.

## Gotchas / invariants

- **Never write to stdout in MCP mode** (it's the JSON-RPC channel). The sidecar's
  `PORT=… TOKEN=…` handshake is the *only* sanctioned raw-stdout write.
- **`sync-history` needs a local Gemini key; remote *mode* does not.** Digestion
  is client-side (see above). The two "remote" concepts are unrelated:
  `GEMDEX_MODE=remote` swaps this process's backend, while `sync-history` pushes
  to a host over OAuth and leaves the active mode alone.
- **`sync-history` refuses plaintext `http` off-loopback.** The access token
  would otherwise cross the network in the clear. Loopback is exempt so the
  reference stack can be smoke-tested without TLS.
- **`RemoteSyncTarget` is an `IngestTarget`, not a `MemoryBackend`** — deliberately
  write-only, so the sync path cannot read or delete the host's memories. Don't
  "simplify" it by widening it to `MemoryBackend`.
- **MCP local mode fails fast on a missing key; the sidecar boots into a repairable gate.** The stdio server builds the backend at startup, so `createEmbeddingInstance` throws `GEMINI_API_KEY is required` and the process exits non-zero. The sidecar starts its management routes, validates a saved key asynchronously, and serves `503 {needsKey:true}` for local data work until readiness is `valid`.
- **History ingestion is permanently new-sessions-only.** The core manager runs only ledger-new files. Changed previously ingested sessions may appear in scan diagnostics but are never passed to standard or batch digestion; the sidecar ignores legacy `newOnly` request fields and the CLI exposes no override.
- **Tool routing is positional**: `index.ts` switches on `MCP_TOOL_NAMES[0..5]`.
  Reordering `tool-names.ts` silently rewires the handlers. Adding a tool means
  appending to the tuple, defining its schema in `index.ts`, adding a `case`,
  and a `handle*` method in `handlers.ts`.
- **`runCli` returning `null` means "not mine, fall through to MCP."** A new verb
  that isn't added to `CLI_COMMANDS` will boot the stdio server instead of erroring.
- **No MCP delete tool**, but `DELETE /memories/:id` exists in the
  sidecar/core router — don't "add" delete to MCP to mirror it.
- **`attachments:[]` clears media; omitting it preserves media** — the two are not
  the same. Same semantics in MCP `update_memory` and core `PUT/PATCH`.
- The sidecar reuses the **core** router for data routes — fix a memory-API bug in
  `gemdex-core/src/http/http-api.ts`, not here; this layer only owns auth/bind and
  the `/config*` + `/settings*` management routes.
