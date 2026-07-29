# AGENTS.md — gemdex-core (engine internals)

`gemdex-core` is the memory engine: it turns a saved "memory" (text and/or
inline media) into embedded, hybrid-searchable rows and resolves a query back
to **whole parent memories, never fragments**. Everything sits behind one class,
`MemoryStore` (and the equivalent `MemoryBackend` interface). It is consumed by
`gemdex-mcp` (stdio tools + `gemdex serve` sidecar) and `gemdex-server` (BYOI
HTTP backend), and is usable standalone. This file explains *how the hard parts
work* so you can change them without re-reading the whole tree. Repo-wide build,
test, and style rules live in the root `AGENTS.md` — they are not repeated here.

## Module map (`src/`)

| Path | Key symbols | Role |
|------|-------------|------|
| `memory/memory-store.ts` | `MemoryStore` | The engine. Chunking, embedding orchestration, save/recall/update/import, parent-document resolution. The single source of memory behavior. |
| `memory/chunker.ts` | `chunkMemory`, `deriveTitle`, `DEFAULT_CHUNK_SIZE=1500`, `DEFAULT_CHUNK_OVERLAP=200` | Splits content into retrieval chunks; derives a title when none is given. |
| `memory/content-edits.ts` | `applyContentEdits`, `ContentEdit` | Pure literal find-and-replace over memory text (str-replace/MultiEdit semantics). Used by the MCP `update_memory` `edits` path; not part of the storage layer. |
| `memory/backend.ts` | `MemoryBackend`, `LocalMemoryBackend` | The storage boundary interface + the embedded adapter wrapping `MemoryStore`. |
| `memory/remote-backend.ts` | `RemoteMemoryBackend`, `RemoteMemoryError` | HTTP client implementing the same `MemoryBackend`; talks to a Gemdex Server (server owns embedding). |
| `memory/blob-store.ts` | `BlobStore`, `FileBlobStore` (default `~/.gemdex/blobs`), `S3BlobStore` | Raw attachment bytes, addressed by opaque `blobRef`; kept out of the vector table. |
| `memory/attachment-validator.ts` | `validateAttachments`, `DEFAULT_ATTACHMENT_LIMITS`, `SUPPORTED_MIME_TYPES`, `mimeToKind` | Decodes + validates inline media (type allowlist, per-modality caps, byte/duration/page limits). |
| `memory/types.ts` | `Memory`, `MemorySummary`, `MemoryRecallResult`, `SaveMemoryInput`, `UpdateMemoryInput`, `SaveResult`, `SimilarMemoryRef`, attachment types | Public memory model. `SaveResult` = `Memory` + optional `similar` (save-time detection candidates). |
| `embedding/gemini-embedding.ts` | `GeminiEmbedding` (`gemini-embedding-2`) | Multimodal Gemini embeddings; Matryoshka dimensions. |
| `embedding/base-embedding.ts` | `Embedding`, `EmbeddingContent`, `EmbeddingVector` | Abstract provider base; `embedContentBatch` is the text-or-inline-media entry point. |
| `vectordb/lancedb-vectordb.ts` | `LanceDBVectorDatabase`, `DEFAULT_RRF_K=60` | Embedded LanceDB: dense kNN + BM25/FTS fused with RRF; SQL-filter translation. |
| `vectordb/types.ts` | `VectorDatabase`, `VectorDocument`, `HybridSearchRequest/Result`, `HybridSubScores` | Generic vector-store contract used by the memory layer. |
| `hygiene/candidate-finder.ts` | `findCandidateClusters`, `DEFAULT_HYGIENE_THRESHOLD` (re-exported from `utils/centroid.ts`), `MAX_CLUSTER_MEMBERS=8`, `clusterIdFor` | Local vector clustering of similar memories (centroid cosine + size-capped greedy agglomeration). Zero API calls. |
| `hygiene/judge.ts` | `ClusterJudge`, `buildJudgePrompt`, `parseJudgeResponse` | Gemini LLM judge: per-memory keep/duplicate/superseded/contradicted verdicts with evidence. |
| `hygiene/hygiene-manager.ts` | `HygieneManager` | Orchestrates scan (clusters + cost estimate) → run (judge clusters) → apply (human-approved deletes) → dismiss. |
| `hygiene/hygiene-report.ts` | `HygieneReportStore` | Persisted report + dismissals ledger at `~/.gemdex/hygiene.json`. |
| `http/http-api.ts` | `handleMemoryApiRequest`, `createMemoryApiHandler` | The single shared memory HTTP API reused by *both* the mcp sidecar and the BYOI server. |
| `config/remote-config.ts` | `resolveMode`, `loadRemoteConfig`, `resolveRemoteConnection` | Local-vs-remote mode + remote URL/token resolution from env. |
| `config/version-compat.ts` | `checkServerCompatibility`, `CLIENT_VERSION`, `SUPPORTED_API_VERSION='v1'`, `SUPPORTED_PROTOCOL_VERSION=1` | Client↔server handshake gate (fails closed on bad/old versions). |
| `utils/env-manager.ts` | `EnvManager`, `envManager` | Env reads with priority `process.env` → `~/.gemdex/.env`. |
| `utils/centroid.ts` | `normalizedCentroid`, `cosine`, `DEFAULT_HYGIENE_THRESHOLD=0.90` | Shared L2-normalized-centroid + cosine math and the default similarity threshold, used by **both** memory hygiene clustering and save-time similar-memory detection — one definition of "similar" for the whole product. |
| `stats/memory-stats-store.ts` | `MemoryStatsStore`, `MemoryStats`, `MemoryOutcome` | Client-side outcome-feedback ledger (`~/.gemdex/stats.json` by default, `GEMDEX_STATS_PATH` override) for the `report_outcome` MCP tool: recall counts + worked/failed/stale tallies per memory id. Consumed entirely from `gemdex-mcp`; `MemoryStore`/`MemoryBackend` never touch it. |

All rows for all memories live in **one global collection** (default table
`memories`). Each stored row is *either* one text chunk *or* one attachment.

## 1. Parent-document retrieval ("small-to-big")

This is the core trick: index small for sharp matches, return big for full
context. A memory is split into chunks, each chunk becomes its own embedded
row, but recall always resolves a matching row back to the **complete parent
memory** and dedupes — the caller never receives a chunk fragment.

**Write side** (`MemoryStore.writeMemory`, the shared save/update/import path):

1. `chunkMemory(text)` greedily fills a ~1500-char window, preferring to break
   on a `\n\n`/`\n` boundary in the back half of the window; adjacent chunks
   overlap by 200 chars so a concept straddling a boundary stays discoverable.
   Memories ≤ 1500 chars are a single chunk.
2. Each chunk is embedded (`embedContentBatch`) and written as a `VectorDocument`.
   The generic vector columns are repurposed as typed slots:
   - `id` = `` `${parentId}::${chunkIndex}` `` (attachment rows use
     `` `${parentId}::att::${attachmentIndex}` ``)
   - `vector` = chunk embedding
   - `content` = the chunk text → **this is the BM25/FTS target**
   - `relativePath` = `parentId` → the filterable grouping key for get/list/delete
   - `startLine` = chunk/attachment index, `endLine` = count, `fileExtension` = `""` (unused)
   - `metadata` = JSON `{ title, fullContent, createdAt, updatedAt, attachments }`
     — **the full parent memory is duplicated into every one of its rows' metadata**, so any single matched row can rebuild the whole parent without a second lookup.
3. Title comes from `resolveTitle`: explicit `title` (trimmed) wins; else
   `deriveTitle(content)` (first non-empty line, stripped of markdown heading /
   list markers, truncated to 80 chars); for media-only memories it falls back
   to the first caption, then to a `"N image attachment(s)"`-style summary.

**Read side** (`recall` → `resolveHitsToParents`): ranked chunk/attachment rows
are grouped by `relativePath` (the parent id), keeping the **best-scoring row
per parent**, then re-sorted by that score and sliced to `limit`. Recall
over-fetches `chunkLimit = max(limit*4, 20)` rows precisely because many chunks
collapse to the same parent. Each result is a full `Memory` (rebuilt from the
winning row's `metadata`) plus a `score` (and `subScores` on the text path).

## 2. Attachments as first-class embedded rows

An attachment is **its own embedding unit** — it bypasses text chunking entirely
(one row per attachment, never split). In `writeMemory`:

- `validateAttachments` decodes base64, enforces the type allowlist and
  `DEFAULT_ATTACHMENT_LIMITS` (image ≤ 6, audio/video/pdf ≤ 1 each; ≤ 20 MiB
  each; audio ≤ 180 s, video ≤ 120 s when duration is detectable; PDF ≤ 6 pages).
- Each attachment is embedded via `embedContentBatch([{ inlineData: { mimeType,
  data } }])` — the **media bytes themselves** are the vector.
- Raw bytes are written to the `BlobStore` (`FileBlobStore` →
  `~/.gemdex/blobs/<parentId>/<attachmentId>`); the row stores only an opaque
  `blobRef`. Bytes are deliberately kept out of the LanceDB row (base64 media
  bloats the table badly).
- The attachment row's `content` (its BM25 text) is `caption ?? title` — so a
  media memory is keyword-findable by its caption, falling back to the memory's
  title when uncaptioned.

**Embedding-before-delete ordering:** `writeMemory` embeds *first*, then deletes
the prior rows/blobs for the id, then inserts. A failed (network) embed leaves
the existing memory intact rather than wiping it. Attachments require a
multimodal model — supplying media to a non-multimodal model throws.

**Save-time similar-memory detection reuses those same vectors (embed →
write → detect):** `MemoryStore.save` calls `writeMemory` (embed → delete →
insert, per above) and then — only on the `save` path, not `update` or
`importRecords` — runs `findSimilarParents(newVectors, excludeId)` with the
chunk/attachment vectors `writeMemory` already returned. That means detection
costs **zero extra embedding calls**: one local ANN `db.search` for candidate
discovery (score used only to shortlist parent ids, never as the reported
similarity) plus up to `SIMILAR_MAX_RESCORED` (8) filtered `db.query` reads to rebuild
each candidate's own centroid and score it exactly with `cosine` from
`utils/centroid.ts` — the same math and default threshold
(`DEFAULT_HYGIENE_THRESHOLD = 0.90`) as memory hygiene clustering. Wrapped in
try/catch: any detection failure degrades to "no `similar` field," never fails
or delays the save. Config: `GEMDEX_SIMILAR_ON_SAVE=false` disables it
entirely; `GEMDEX_SIMILAR_THRESHOLD` overrides the bar (fails fast outside
`(0, 1]`). Local-mode only in v1 — `RemoteMemoryBackend.save` passes through
whatever the BYOI server returns, which today never sets `similar`.

**Caption edits skip re-embedding:** `updateAttachmentCaptions` reads every row
back *with its `vector` column*, rewrites only the caption-derived `content` and
the shared `attachments`/`updatedAt` metadata, and re-inserts with the original
vectors. Editing a caption is pure metadata — no embedding round-trip, blobs
untouched.

**Export/import round-trip:** `exportAll` reads each blob back and inlines it as
base64 (`MemoryExportAttachment`), so a dump is self-contained without the blob
directory. `importRecords` upserts by id and **re-embeds** content + attachments
through the configured provider.

## 3. Hybrid retrieval + RRF fusion (two layers)

There are **two** distinct RRF fusions; don't conflate them.

**Layer A — inside LanceDB** (`LanceDBVectorDatabase.hybridSearch`): runs a
dense kNN (on `vector`) and a BM25/FTS query (on `content`) **in parallel**,
each over a candidate pool of `max(limit*4, 40)`, then fuses by Reciprocal Rank
Fusion: `score(id) = Σ 1/(k + rank)` (1-based rank, summed across the two
branches). `k` comes from `options.rerank.params.k`, falling back to
`DEFAULT_RRF_K = 60`. Returned hits carry `subScores` (`denseRank`,
`denseDistance`, `ftsRank`, `ftsScore`) for debugging. The FTS index on
`content` is built **lazily on first hybrid search** (LanceDB rejects training
on an empty table) and is deduped per process; if FTS fails (index still
training / empty table) the branch degrades gracefully to dense-only.

**Layer B — inside MemoryStore** (`fuseByRrf`): when `recall` has more than one
*query signal* (text + one or more query attachments for recall-by-media), each
signal produces its own ranked list and they are fused with RRF at the row level
before parent resolution. Scale-free fusion lets a dense media branch and a
fused text branch combine without score normalization.

`recall` paths:
- **Text only** → `searchText` (Layer A hybrid) → `resolveHitsToParents`. This
  is the fast path and preserves `subScores` on each hit.
- **Media present** (with or without text) → one ranked list per signal →
  `fuseByRrf` (Layer B) → `resolveHitsToParents`.

> Note: `recall` passes `RECALL_RRF_K = 100` as the `k` into both the Layer-A
> hybrid call and Layer-B fusion. `DEFAULT_RRF_K = 60` is only the vectordb
> fallback when no `k` is supplied — the live recall path runs at `k = 100`.

`HYBRID_MODE=false` (read via `envManager`) disables the FTS branch entirely:
`searchText` falls back to dense-only `db.search`, whose score is
`1/(1 + _distance)` (LanceDB returns `_distance`, smaller = closer).

## 4. Embedding model specifics

`GeminiEmbedding` defaults to **`gemini-embedding-2`**: multimodal (text, image,
audio, video, PDF mapped into one shared space), 8K-token context, **3072**
default dimensions. Matryoshka `supportedDimensions = [3072, 1536, 768, 256]`
selectable via `outputDimensionality`. `gemini-embedding-001` is text-only (2K
context) — `isMultimodal()` is true *only* for `gemini-embedding-2`, and media
saves/recalls assert multimodality and throw otherwise.

`embedContentBatch` wraps each input as `{ parts: [{ text }] }` or
`{ parts: [{ inlineData }] }`. The single-element wrapping is deliberate: a flat
string array would make the API aggregate inputs into *one* embedding; wrapping
each input forces one embedding per input, and the code asserts the returned
count matches the input count.

The embedding dimension is **fixed per collection at create time**:
`ensureCollection` calls `embedding.getDimension()` and builds a LanceDB schema
with a `FixedSizeList(dimension, Float32)` vector column. Changing model
dimensions requires a fresh collection.

## 5. Local vs remote backend abstraction

`MemoryBackend` is the storage boundary (`save`, `recall`, `update`,
`updateAttachmentCaptions`, `get`, `list`, `delete`, `exportAll`,
`importRecords`, `readAttachment`). Two interchangeable implementations:

- **`LocalMemoryBackend`** — thin adapter over `MemoryStore` (Gemini embeddings
  + LanceDB + `FileBlobStore`). Embeds client-side; needs `GEMINI_API_KEY`.
- **`RemoteMemoryBackend`** — HTTP client to a self-hosted Gemdex Server. It
  does **not embed client-side** — the server owns the Gemini key and does the
  embedding. Therefore remote-mode clients need *no* `GEMINI_API_KEY`. It accepts
  **inline base64 attachments only** (no local file paths — the calling
  integration must read files into base64 first). It enforces a 100 MiB
  request/response body cap and surfaces `RemoteMemoryError` with a `code`
  (`timeout` | `network` | `invalid_response` | `body_too_large`).

Because both satisfy the same interface, callers (mcp tools, the desktop app)
are written once against `MemoryBackend` and swapped by mode. Mode/URL/token are
resolved in `config/remote-config.ts` (`GEMDEX_MODE`, `GEMDEX_REMOTE_URL`,
`GEMDEX_REMOTE_TOKEN`), with `version-compat.ts` gating the client↔server
handshake (fails closed on an unparseable or too-old version).

## 6. The shared HTTP route handler

`http/http-api.ts` is **the single memory-API implementation**, reused verbatim
by *both* the `gemdex serve` localhost sidecar (in `gemdex-mcp`) and the BYOI
`gemdex-server`. Neither package reimplements these routes — this is a key
architectural fact: change a route's behavior here and both surfaces change.

`handleMemoryApiRequest(req, res, { store, corsHeaders })` returns `true` if it
owned the path, `false` otherwise (so a caller can layer its own routes —
`/config`, auth, bind address, CORS policy are intentionally *not* here).
`createMemoryApiHandler` wraps it into an `http.RequestListener` and handles the
`OPTIONS` preflight + a 404 fallback. The route shapes it owns (callers mount
them under a prefix — the BYOI server and `RemoteMemoryBackend` use `/v1`):

| Method + path | Backend call |
|---------------|--------------|
| `GET /memories` | `list` |
| `POST /memories` | `save` (text and/or inline media) |
| `GET /memories/:id` | `get` |
| `PUT`/`PATCH /memories/:id` | `update` |
| `DELETE /memories/:id` | `delete` |
| `PATCH /memories/:id/attachments` | `updateAttachmentCaptions` (no re-embed) |
| `GET /memories/:id/attachments/:attachmentId` | `readAttachment` (raw bytes) |
| `POST /recall` | `recall` (text and/or inline media) |
| `GET /export` / `POST /import` | `exportAll` / `importRecords` |

Route matching order matters: the attachment-bytes and captions routes are
matched **before** the greedy `/memories/:id` detail route. Body caps:
`DEFAULT_BODY_LIMIT = 50 MiB` for plain JSON; media-bearing routes (create,
update, import, recall) read with `ATTACHMENT_BODY_LIMIT = 100 MiB`. An
oversized body → HTTP 413; bad JSON → 400; attachment bytes are returned with
`X-Content-Type-Options: nosniff` and forced to `application/octet-stream` +
`Content-Disposition: attachment` for any non-allowlisted mime type.

## 7. Chat-history ingestion

`ingest/IngestManager` scans coding-agent transcript folders against the local
ledger, estimates Gemini digestion cost, and writes deterministic
`chat:<source>:<sessionId>` memories. **Runs are permanently new-sessions-only.**
`scan()` keeps `changedFiles` in its diagnostic buckets so the desktop and CLI
can explain what was found, but `pendingCount`, estimates, and
`processableFiles` cover only never-before-ingested sessions. `run()` always
selects only `buckets.newFiles`; there is no option that can re-enable changed
sessions. Preserve this invariant across standard and Batch API paths.

**The destination is an `IngestTarget`, not a `MemoryBackend`** (`ingest/types.ts`).
`IngestTarget` is `Pick<MemoryBackend, 'importRecords'>` — the only method
`run()`/`collect()` ever call on the destination. Narrowing it lets a *write-only*
destination be a legal ingest target: `gemdex sync-history` pushes digests to a
remote host over an OAuth-protected HTTP route and genuinely cannot recall, list,
or delete (see `packages/mcp/src/sync-target.ts`). Every `MemoryBackend` still
satisfies `IngestTarget` structurally, so existing callers are unaffected. Don't
widen the parameter back to `MemoryBackend` for convenience — that would grant
the sync path capabilities it deliberately lacks.

Ids are deterministic (`chat:<source>:<sessionId>`) precisely so ingestion is
**idempotent**: re-ingesting a session upserts the same row rather than
duplicating it, which is what makes syncing the same history from several
machines safe.

## 8. Memory hygiene

`hygiene/HygieneManager` finds stale/duplicate/contradicted memories in two
phases. **Phase 1 (`scan`) is free and local**: `MemoryStore.listParentsWithVectors()`
reads every parent's row vectors straight out of LanceDB, each parent gets an
L2-normalized centroid, and `findCandidateClusters` groups parents by centroid
cosine similarity (default `DEFAULT_HYGIENE_THRESHOLD = 0.90`) using
**size-capped greedy agglomeration**: above-threshold pairs are merged
strongest-first, a merge is skipped if it would exceed `MAX_CLUSTER_MEMBERS = 8`,
so overflow spills into sibling clusters instead of being dropped — lowering
the threshold can only add candidates. **Phase 2 (`run`) is the LLM judge**:
`ClusterJudge` (same single Gemini model/pricing as ingest: `gemini-3.5-flash-lite`) reads each cluster
oldest-first and returns a per-memory verdict (`keep` / `duplicate` /
`superseded` / `contradicted`) with `supersededBy`, quoted `evidence`, and
`confidence`; `parseJudgeResponse` guarantees a finding per member and forces
at least one `keep` per cluster. Results persist in `~/.gemdex/hygiene.json`
(`HygieneReportStore`), including a dismissals ledger keyed by stable
`clusterId` (sha256 of sorted member ids) so "keep both" decisions are never
re-flagged. `apply(ids, backend)` performs the deletes — **only ever invoked
from an explicit human approval in the desktop app**, never by an agent tool.

## Gotchas / invariants

- **LanceDB/DataFusion SQL quirks.** Unquoted identifiers are lowercased (so
  `relativePath` fails as `relativepath`); `translateFilter` backtick-quotes the
  camelCase columns (`relativePath`, `startLine`, `endLine`, `fileExtension`)
  and rewrites Python-style `==` → `=` (preserving `!=`/`<=`/`>=` and string
  literals). Preserve this when touching filters in `lancedb-vectordb.ts`.
- **Full parent metadata is duplicated into every row.** Any save/update that
  changes title/content/attachments must rewrite *all* of a parent's rows, or
  rows will disagree about the parent. `writeMemory` does this by deleting all
  rows for the id (matched on `relativePath`) and re-inserting.
- **Dimension is fixed per collection** at create time (`getDimension()`); you
  cannot change embedding dimensions without a new collection.
- **`@lancedb/lancedb` is a native dependency** (listed under
  `onlyBuiltDependencies` in the root `pnpm-workspace.yaml`); its install build
  script must be allowed to run.
- **Stores auto-create on construct.** `new LanceDBVectorDatabase()` creates
  `~/.gemdex/lance` (and logs to stdout); `FileBlobStore` creates
  `~/.gemdex/blobs` lazily on first write.
- **FTS index is lazy.** It is built on the first hybrid search, not at
  collection creation (LanceDB rejects training an FTS index on an empty table).
- **Empty memories are rejected** (no content *and* no attachments) — the guard
  runs *before* any destructive overwrite so an empty update can't wipe an
  existing memory.
- **No agent-facing delete in the API by design** beyond `DELETE /memories/:id`;
  deletion is a deliberate action, not part of recall/save flows.
- **`MemoryStatsStore` never touches LanceDB or `MemoryStore`.** The
  `report_outcome` feedback loop is a plain JSON sidecar ledger consumed by
  `gemdex-mcp` only — `recall`'s "pure relevance ranking" contract inside
  `gemdex-core` is untouched; ranking changes (when opted in) happen entirely
  in the MCP layer, above this package.
- **`save()`'s `SaveResult` widening is additive, not breaking.** `similar` is
  an optional field on top of `Memory`; with detection disabled or no
  candidates found, a `SaveResult` is structurally identical to the old
  `Memory` return, so existing callers that only read `Memory` fields keep
  working unmodified.
