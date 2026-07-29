# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Self-hosting is now a first-class path: a remote HTTP MCP endpoint, a browser manager, and a one-line installer.** Gemdex was previously "local LanceDB, plus a bring-your-own-infrastructure backend if you're determined". It is now a stack you can stand up in one command and, if you want, expose to the internet safely.
  - **`gemdex-mcp-http`** — a Streamable HTTP MCP surface (FastMCP v4) at `/mcp` so agents on any machine can reach your memory layer without a local Gemini key or a local install. Auth is OAuth 2.1 with Google, narrowed to **exactly one** account: `SingleUserGoogleProvider.verify_token` re-checks the verified, `email_verified` identity against `GEMDEX_ALLOWED_EMAIL` on **every request**, so an already-issued token cannot outlive a change to the allowlist. A static shared-bearer mode remains for loopback/LAN use.
  - **`gemdex-web`** — a React/Vite SPA over a FastAPI backend-for-frontend: the human manage surface for a self-hosted pool. Google login (same one-email allowlist), browse/edit/**delete**, export/import, chat-session upload, and the memory-hygiene review flow. The BFF holds the BYOI bearer server-side; it never reaches browser JavaScript.
  - **`gemdex sync-history`** — `ingest-history` pointed at a remote host over its OAuth-protected `/mcp`. Each coding machine digests its own sessions with its own Gemini key and upserts the results; the host never reads your laptop's disk. Refresh token at `~/.gemdex/sync-auth.json` (`0600`); `--logout` forgets it.
  - **Host-side session upload** — hand raw `.jsonl`/`.zip` transcripts to the web manager and the deployment cleans and digests them on `gemdex-server` (the one process with the Gemini key, the ingest pipeline, and the database together). Covers machines that never ran the CLI. Both paths converge on the same deterministic `chat:<source>:<sessionId>` id, so mixing them **upserts instead of duplicating**.
  - **`deploy/`** — the reference Compose stack (Postgres/pgvector + BYOI server + MCP endpoint + web manager) with `/v1` and Postgres reachable only on the private network.
  - **`scripts/install.sh`** — one command brings up the whole stack, generates every secret, waits for migrations, **verifies a real save and recall**, and prints a ready-to-paste MCP client config. Loopback-only by default; `--lan` to reach it from your other devices. Re-running is the upgrade path: secrets are never regenerated and no volume is removed.
- **New documentation.** [Go further](docs/GO_FURTHER.md) (DNS + TLS, Render, Railway, a VPS, what stays local vs cloud, cost and sizing), [self-host security notes](docs/SECURITY_SELFHOST.md) (what is enforced, where in the code, and a pre-launch checklist), and [chat-history ingestion](docs/CHAT_HISTORY.md) (the three paths and a decision table).
- **`report_outcome` MCP tool + trust-weighted recall ranking.** A new tool records whether a recalled memory `worked`, `failed`, or was `stale`, tallied per-memory in a client-side ledger (`~/.gemdex/stats.json`, override via `GEMDEX_STATS_PATH`) — no LanceDB writes, no wire-contract change. `recall` now counts every surfacing and, when stats exist, shows each hit's track record (`recalled 7×, worked 3× (last: worked 2d ago)`, `⚠`-prefixed once it has failed or gone stale). Ranking itself stays pure relevance unless you opt in with `GEMDEX_TRUST_RANKING=true`, which over-fetches and re-ranks by a deterministic trust multiplier derived from worked/failed/stale counts. Backward compatible: with no stats recorded and the flag unset, recall output is unchanged.
- **Save-time similar-memory detection.** `save_memory` now checks the new memory against everything already stored, reusing the vectors the save already computed — zero extra embedding calls, one local ANN query plus a few filtered reads. Uses the same centroid-cosine math and default threshold (`0.90`) as memory hygiene. When a near-duplicate or conflicting memory is found, the response carries a `similar` field and a `⚠` advisory block naming it, so the agent can consolidate with `update_memory` on the spot instead of leaving both to be found weeks later by a hygiene scan. On by default; disable with `GEMDEX_SIMILAR_ON_SAVE=false` or adjust the bar with `GEMDEX_SIMILAR_THRESHOLD`. Local mode only in v1 — remote/BYOI saves are unaffected and carry no `similar` field yet.
- **Validated Gemini readiness in the macOS app.** Every sidecar launch now proves the configured local key with a real embedding request before the app unlocks. Missing, rejected, and temporarily unverifiable keys produce a prominent blocking alert instead of surfacing later as failed saves, searches, imports, or session ingestions. Candidate keys are validated before they are persisted, and Storage settings provides status, replacement, and retry controls (including in remote storage mode, where chat digestion still needs a local key).
- **`list_memories` MCP tool.** A read-only browse over the global pool: lists stored memories newest-first as compact summaries (title + id + relative age + preview + media counts), with an optional case-insensitive substring `filter` over title/preview and a `limit` (default 50, max 200). Complements `recall` (relevance-ranked, full content) for orienting and for retrieving an exact `id` to pass to `update_memory`. Deletion remains a human-only desktop action.
- **Richer `recall` output for agents.** Each hit now reports its relative age (`updated: 3d ago`, from `updatedAt`) and an `attachments:` line (kind + stable id + caption) so the agent can judge staleness and knows when media exists (fetch bytes via the sidecar's `GET /memories/:id/attachments/:attachmentId`).
- **Token-budgeted recall.** `recall` accepts `detail: "summary" | "full"` (default `full`); `summary` returns a ~200-char preview per hit instead of full content, so an agent can scan many results cheaply before pulling the one it needs.

- **Multimodal attachments (backend).** `save_memory` and `update_memory` accept an optional `attachments` array of inline base64 media (PNG/JPEG image, MP3/WAV audio, MP4/MOV video, PDF), embedded via `gemini-embedding-2` and recallable by text query. Each attachment is one embedding unit; its caption (or the memory title) backs the BM25 branch.
- On-disk blob storage for attachment bytes under `~/.gemdex/blobs` (a `FileBlobStore`), keeping the LanceDB table lean. Attachments round-trip through `export`/`import`.
- `gemdex serve` now accepts attachments on create/update and streams raw attachment bytes at `GET /memories/:id/attachments/:attachmentId`.
- Attachment validation (mimeType allowlist, per-modality count caps — ≤6 images, ≤1 audio, ≤1 video, ≤1 PDF — and a per-attachment byte ceiling) with a clear error when attachments are supplied to a non-multimodal embedding model.
- **Recall by media.** `recall` now accepts inline media (image/audio/video/PDF) alongside or instead of a text `query`. Each query attachment is embedded into the shared `gemini-embedding-2` space and runs its own similarity branch; text + media branches are fused with Reciprocal Rank Fusion. Exposed through the `recall` MCP tool and a new `POST /recall` route on `gemdex serve`.
- **Desktop app multimodal UI.** Create/edit memories with drag-and-drop or a file picker; per-attachment caption inputs; inline rendering of images, audio and video players, and native PDF preview; a media badge on list items; and a “Find similar” action on any attachment that runs recall-by-example (no free-text search box — keeping the app manage-only).

### Changed
- **The README and docs now lead with self-hosting.** The one-line installer is the headline path, `docs/` has a maproom in `AGENTS.md`, and the stale `docs/OPTION_C_DEPLOY.md` one-off runbook (which hardcoded a personal filesystem path) was removed — its durable content lives in the BYOI operations guide.
- **Chat-history ingestion is new-sessions-only.** The desktop checkbox and CLI `--new-only` flag were removed. The core engine, sidecar, desktop app, and CLI now treat previously ingested sessions as informational-only—even if their transcript later changes—so no client can accidentally re-digest or overwrite an existing session memory.
- `content` is now optional for `save_memory`/`update_memory` when at least one attachment is supplied; `update_memory` preserves omitted fields (text, title, attachments) instead of requiring `content`.
- `recall` (`MemoryStore` + MCP tool) now takes an optional media query; `query` is optional when at least one attachment is provided.

### Deprecated
- **The macOS desktop app is no longer the primary manage surface** — the [web manager](packages/web/README.md) is. The app manages a **local** `~/.gemdex` pool on one Mac; the web manager runs against your self-hosted pool from any browser. The app is in **maintenance mode**: it still ships, it still works, bugs still get fixed, and **nothing has been removed** — but new manage features land in `packages/web`. If you are local-only on a Mac, keep using it.

### Migration notes
- **Nothing breaks. Local mode is untouched.** If you use `npx gemdex-mcp` against embedded LanceDB, there is nothing to do.
- **From the desktop app:** no migration needed — it keeps working against `~/.gemdex`. To move to a self-hosted pool, stand up the stack (`scripts/install.sh`), then copy your existing memories with `gemdex import-local-to-remote <name> --attach-transcripts` (ids are preserved). The app can also point at a BYOI server from its Storage & Gemini panel. Note that chat-history digestion always runs locally and still needs a local Gemini key.
- **From a static remote-bearer MCP config:** the shared bearer still works — `GEMDEX_MCP_AUTH=static` is exactly what the installer configures for loopback and LAN use, and existing `GEMDEX_REMOTE_URL` + `GEMDEX_REMOTE_TOKEN` clients against `/v1` are unaffected. Move to `GEMDEX_MCP_AUTH=google` when you expose the endpoint publicly: a static token is a *password*, not an identity, with no per-client revocation or expiry. Set `GEMDEX_MCP_BASE_URL`, `GEMDEX_ALLOWED_EMAIL`, and a Google OAuth client per [the deploy guide](docs/SELF_HOST_DEPLOY.md), then re-run your client's auth once.
- **`GEMDEX_MCP_BASE_URL` is effectively permanent.** FastMCP advertises it as the OAuth issuer and clients cache it; changing it later forces every agent to re-authorize. Pick the final public origin before connecting clients.
- **Attachments over HTTP MCP are inline base64 only.** A local file `path` is rejected explicitly, because over HTTP it would resolve on the *host's* filesystem — either failing or silently reading an unrelated file. The stdio tools still accept paths, since they run on your machine.
- **Upgrading an existing BYOI stack** (including one deployed before `deploy/` existed): see [Migrating an existing BYOI stack](docs/SELF_HOST_DEPLOY.md#migrating-an-existing-byoi-stack). Migrations run at server startup, so a redeploy is the migration.

## [0.3.2] - 2026-06-02

### Added
- Desktop app first-launch setup for `GEMINI_API_KEY`, persisted locally in `~/.gemdex/.env`.
- README screenshots for the desktop setup and memory manager screens.

### Changed
- Desktop app sidecar startup now runs through the user's login shell so Finder/Dock launches inherit the expected Node/npm PATH.
- Refreshed frontend brand artwork and converted app illustration assets to transparent PNGs.
- Published `gemdex-core` and `gemdex-mcp` packages at `0.3.2`.

## [0.3.0] - 2026-06-02

Gemdex is a global, persistent memory layer for AI coding agents: deliberately save, recall, and update memories that persist across every repo and session, backed by Gemini embeddings and an embedded LanceDB hybrid store.

### Added
- **`gemdex-core`** — the memory engine: `GeminiEmbedding`, `LanceDBVectorDatabase` (hybrid dense + BM25, fused with Reciprocal Rank Fusion), and a `MemoryStore` with parent-document chunking. Long memories are split into retrieval chunks for sharp hybrid matching, but `recall` always resolves matches back to the full parent memory, deduped by id — never a fragment.
- **`gemdex-mcp`** — an MCP stdio server exposing three tools: `save_memory`, `recall`, and `update_memory`. Deletion is intentionally not an agent tool. Embedded LanceDB persists at `~/.gemdex/lance` by default (override with `LANCEDB_PATH`); no Docker, no daemon.
- **`gemdex serve`** — a localhost-only (`127.0.0.1`) HTTP/JSON sidecar (list/get/create/update/delete/export/import) backing the desktop manager app.
- **`packages/app`** — a [zero-native](https://www.npmjs.com/package/zero-native) desktop app to manage the memory layer (browse / create / edit / delete / export / import). The Zig shell spawns the sidecar on launch and kills it on exit; no user command required.
- **Claude Code plugin** — registers the `gemdex` MCP server and ships a `memory` skill that nudges the agent to save/recall/update **only when the user explicitly points at memory**.

[Unreleased]: https://github.com/anand-92/gemdex/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/anand-92/gemdex/compare/v0.3.0...v0.3.2
[0.3.0]: https://github.com/anand-92/gemdex/releases/tag/v0.3.0
