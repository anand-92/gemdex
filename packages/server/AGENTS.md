# AGENTS.md — gemdex-server

`gemdex-server` is the self-hosted **BYOI** (Bring Your Own Infrastructure)
remote backend Gemdex clients talk to in remote mode. It is a deliberately
**thin** wrapper over `gemdex-core` (`workspace:*`): a plain `node:http` server
that owns only the edge concerns — the `/v1` prefix, bearer auth, CORS, config
loading, migrations, and Postgres/blob wiring — and delegates **all** memory
logic (save/recall/update/import, chunking, attachment validation, ranking) to
core's `handleMemoryApiRequest`. Production deploy is `npm run init` →
`scripts/init.sh` (generates secrets + `docker compose up`); ops live in
[`docs/BYOI_OPERATIONS.md`](../../docs/BYOI_OPERATIONS.md), the full wire
contract in [`docs/BYOI_REMOTE_MODE.md`](../../docs/BYOI_REMOTE_MODE.md).

## File map (`src/`)

| File | Key symbols | Role |
|------|-------------|------|
| `index.ts` | `main()` | `bin` entrypoint. Parses argv → `loadServerConfig` → validates blob store → runs `serve` (default) or `migrate`; SIGINT/SIGTERM shutdown. |
| `server.ts` | `createServer`, `startServer`, `createConfiguredStore` | HTTP server: health/version, CORS, bearer auth, then strips `/v1` and delegates to core. |
| `config.ts` | `loadServerConfig`, `ServerConfig`, `BlobStoreConfig` | Layered config resolution + fail-fast validation. |
| `postgres.ts` | `PostgresMemoryBackend`, `createPostgresPool`, `migrateDatabase` | Production `MemoryBackend` over Postgres+pgvector. |
| `postgres-migrations.ts` | `MIGRATIONS`, `SqlMigration` | Versioned, checksum-verified SQL migrations. |
| `blob-store.ts` | `createBlobStore` | Maps config → core's `FileBlobStore` / `S3BlobStore`. |
| `embedding.ts` | `createServerEmbedding`, `MissingServerEmbedding` | Server-owned Gemini embedding, or a throwing placeholder. |
| `session-ingest.ts` | `handleSessionIngestRequest`, `validateSessionFiles`, `SESSION_INGEST_PATH` | `POST /v1/sessions/ingest`: clean + digest + upsert uploaded chat transcripts. The one route with logic **not** in core's handler — see below. |

## Thin-server delegation (`server.ts`)

`createServer` handles exactly two routes itself — `GET /v1/health` and
`GET /v1/version` (both unauthenticated, no memory data). Everything else under
`/v1/*` is gated then handed off:

1. CORS origin check → `403` if a browser `Origin` isn't allow-listed.
2. Bearer check (`hasValidBearerToken`, constant-time `timingSafeEqual`) →
   `401`, unless `unsafeDevNoAuth`.
3. Backend presence → `503` if `store === null` (no DB configured).
4. **Strip the prefix in place** (`req.url = req.url.replace(/^\/v1/, '')`) and
   call `handleMemoryApiRequest(req, res, { store, corsHeaders })`. Core streams
   the body off the real request object, owns routing, and returns `handled`;
   `false` → `404`. Thrown `Request body too large` → `413`, `Invalid JSON
   body` → `400`.

So this package contains **no** memory routing or business logic — only the
mount-point plumbing around core's shared handler.

## The one route that isn't core's handler: `POST /v1/sessions/ingest`

`session-ingest.ts` is matched **after** the auth and store gates but **before**
the `/v1` prefix is stripped, so it is bearer-guarded like every data route and
core's handler never sees it.

It exists because uploaded chat transcripts have to be digested *somewhere*, and
this is the only process that already holds all three prerequisites at once:
core's ingest pipeline (`ingestUploadedSessions`), a `GEMINI_API_KEY`, and the
store. The caller is `packages/web`'s BFF, which is Python — it cannot import
core, and giving it a Gemini key would put the credential in a third container.
The full argument, including the rejected alternatives, is in
[`../web/AGENTS.md`](../web/AGENTS.md) §7.

Note what it is *not*: it is **not** in core's `handleMemoryApiRequest` and so
is **not** part of the shared HTTP API that `gemdex serve` also mounts. That is
deliberate — the sidecar's users have core in-process and a local ingest CLI
already; a session-upload endpoint there would be a second way to do what
`gemdex sync-history` does.

Route shape, and the reasons for it:

- **Always a per-file summary, HTTP 200.** Each file is one Gemini call, so a
  batch where two transcripts fail and eight succeed must report eight successes
  — a 500 would discard work already paid for. `{results, ingested, skipped,
  failed}` with per-file `status: ingested|skipped|failed`. Core's
  `ingestUploadedSessions` provides the per-file fault isolation.
- **`503` when there is no Gemini key**, checked up front rather than letting
  `MissingServerEmbedding` throw mid-batch. Digesting cannot work at all without
  a key, and the operator needs to be told that specifically.
- **`405` on a non-POST**, so `GET /v1/sessions/ingest` cannot fall through to
  core and be read as a memory-id lookup.
- **Filenames are basename-stripped in `validateSessionFiles`.** Nothing here
  writes to disk, but a filename reaches the digest's provenance line and the
  session-id fallback.
- Caps: 25 files per request, 40 MiB per file. The web BFF applies its own,
  tighter limits; these are the backstop for any other caller.

## Server-side embedding (`embedding.ts`)

The server owns `GEMINI_API_KEY`; **clients never need a Gemini key**.
`createServerEmbedding(config)` returns a real `GeminiEmbedding` when a key is
set, otherwise a `MissingServerEmbedding` placeholder whose `embed*` methods
**throw** `MISSING_KEY_ERROR`. Consequence: the server starts and serves
health/version **without** a key, but any save/recall/update/import that needs
an embedding fails at request time. (The placeholder still answers
`detectDimension`/`getDimension`/`isMultimodal`, defaulting to dim `3072`, model
`gemini-embedding-2`, multimodal.)

## Postgres + pgvector backend (`postgres.ts`)

`PostgresMemoryBackend` is the production analogue of core's local LanceDB
backend — it implements the same `MemoryBackend` contract, so core's handler
treats both identically. Layout (see `postgres-migrations.ts`):

- `gemdex_memory_documents` — the parent memories (full text, title, timestamps).
- `gemdex_memory_chunks` — text + attachment chunks with the dense vector in a
  pgvector `embedding_vector` column.
- `gemdex_memory_attachments` + `gemdex_attachment_blobs` — attachment metadata
  referencing an opaque `storage_key`; in production the bytes live in the blob
  store and the DB `data` column is `NULL` (provider = blob-store kind).

Recall mirrors core's hybrid retrieval: dense (`embedding_vector <=>` cosine) +
full-text (`to_tsvector`/`plainto_tsquery`) branches fused with **RRF**
(`fuseRanks`), scored up to the parent, then the **full parent memory** is
returned (small-to-big). Constructor seam — `pool`, `embedding`, and
`usePgVectorQueries` are all injectable. `usePgVectorQueries` defaults `true`;
when `false` the backend falls back to in-process cosine + lexical scoring
because `pg-mem` (tests) **cannot parse pgvector's `<=>` operator**. `IN (...)`
clauses use expanded scalar placeholders rather than `= ANY($1)` for the same
pg-mem-compatibility reason.

## Migrations (`postgres-migrations.ts`, `migrateDatabase`)

Migrations are versioned entries in `MIGRATIONS`, applied inside one
transaction and recorded in `gemdex_schema_migrations` with a SHA-256
**checksum**. On startup (when a DB URL is configured) `createConfiguredStore`
runs `migrateDatabase` **before** serving; failure rejects and the process
**exits non-zero** — never serves a partial schema. A standalone `migrate`
subcommand exists (`gemdex-server migrate`; errors if no DB URL).

> **Never edit an already-applied migration** — a checksum mismatch throws and
> blocks startup. Add a new versioned entry instead.

## Config resolution + fail-fast (`config.ts`)

`loadServerConfig` resolves each field by priority **env > CLI args > JSON
config file (`--config` / `GEMDEX_SERVER_CONFIG`) > defaults**. Key vars:
`GEMDEX_SERVER_TOKEN` (bearer), `GEMDEX_SERVER_DATABASE_URL` / `DATABASE_URL`
(Postgres), `GEMINI_API_KEY` (server-owned embeddings); host defaults
`127.0.0.1`, port `8765`, `BLOB_STORE=file`.

Fail-fast (mostly at boot, before any socket/DB open):

- Missing token **and** not `unsafeDevNoAuth` → startup error. (The
  `--unsafe-dev-no-auth` flag / `GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH=true` is the
  only way to skip auth — loopback dev only, never expose it.)
- `index.ts` calls `createBlobStore(config.blobStore)` **before** opening the DB
  or socket, so `BLOB_STORE=s3` without `S3_BUCKET` (or an invalid
  `BLOB_STORE`) fails immediately.
- Bad port (outside 1–65535), non-boolean booleans, or non-positive
  `EMBEDDING_DIMENSION` → error.
- Data routes still return **`503`** at runtime when no DB URL is set (auth and
  health are unaffected).

## Blob storage (`blob-store.ts`)

`createBlobStore` maps config to core's stores: `file` (on-disk, default,
container volume `/var/lib/gemdex/blobs`) or `s3` — any S3-compatible endpoint
(R2, MinIO) via `S3_ENDPOINT`/`S3_REGION`/`S3_FORCE_PATH_STYLE` path-style
addressing. DB rows hold only opaque blob keys, so **back up Postgres and the
blob store together** — restoring one without the other corrupts attachment
reads.

## The v1 surface

Unauthenticated: `GET /v1/health` (`{"ok":true}`), `GET /v1/version`
(`apiVersion`, `serverVersion` from `package.json`, `minClientVersion`,
`protocolVersion`, `capabilities`). Everything else is bearer-guarded and
delegated to core: `GET|POST /v1/memories`, `GET|PUT|PATCH|DELETE
/v1/memories/:id`, `GET /v1/memories/:id/attachments/:attachmentId`, `PATCH
/v1/memories/:id/attachments` (caption-only), `POST /v1/recall`, `GET
/v1/export`, `POST /v1/import`. One bearer-guarded route is handled *here*
rather than delegated: `POST /v1/sessions/ingest` (see above). Attachment bodies cap at **100 MiB** (core's
`ATTACHMENT_BODY_LIMIT`). `minClientVersion` is a hardcoded compat **floor** in
`server.ts` (`0.3.0`), bumped only when intentionally dropping older clients —
it is **not** the server version. The compose service binds `127.0.0.1` and
uses the `pgvector/pgvector` image.

## Gotchas / invariants

- **`503` without a DB** — `/v1/*` data routes fail until `databaseUrl` is set;
  green `/v1/health` does **not** mean storage works.
- **Embedding throws without a key** — server starts, but save/recall/import
  raises `MissingServerEmbedding` (`MISSING_KEY_ERROR`), and
  `POST /v1/sessions/ingest` answers `503` up front (it also needs the key to
  *generate*, not just embed).
- **Never edit an applied migration** — checksum mismatch blocks startup; add a
  new one.
- **Back up DB + blob store together** — rows reference opaque blob keys.
- **`pg-mem` ≠ production** — set `usePgVectorQueries: false` in tests (no
  `<=>`); don't assume the fallback query paths match prod.
- **`minClientVersion` is a floor**, hardcoded in `server.ts`, not
  `package.json`.
- **Binds `127.0.0.1` by default; CORS deny-by-default** — expose only behind a
  TLS proxy that forwards `Authorization`; origins are trailing-slash-normalized
  to match browser `Origin` headers, and trailing slashes are stripped from
  request paths.
