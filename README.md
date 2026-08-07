<div align="center">

<img src="assets/logo-wordmark.jpg" alt="Gemdex — a memory layer for AI coding agents" width="780" />

### A global, persistent memory layer for AI coding agents — Gemini embeddings × LanceDB × MCP

[![npm version](https://img.shields.io/npm/v/gemdex-mcp?color=cf6a4c&label=gemdex-mcp&logo=npm)](https://www.npmjs.com/package/gemdex-mcp)
[![npm downloads](https://img.shields.io/npm/dm/gemdex-mcp?color=cf6a4c&label=downloads&logo=npm)](https://www.npmjs.com/package/gemdex-mcp)
[![GitHub stars](https://img.shields.io/github/stars/anand-92/gemdex?style=flat&color=e9b949&logo=github)](https://github.com/anand-92/gemdex/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-7a9e7e.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524-7a9e7e.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-cf6a4c)](https://modelcontextprotocol.io)
[![Powered by Gemini](https://img.shields.io/badge/embeddings-Gemini-4285F4?logo=google)](https://ai.google.dev/)
[![Powered by LanceDB](https://img.shields.io/badge/vector_db-LanceDB-9933ff)](https://lancedb.com/)

**[⭐ Star on GitHub](https://github.com/anand-92/gemdex)** · **[📦 npm](https://www.npmjs.com/package/gemdex-mcp)** · **[💬 Discussions](https://github.com/anand-92/gemdex/discussions)** · **[🐛 Issues](https://github.com/anand-92/gemdex/issues)**

</div>

<p align="center">
  <img src="assets/gemdex-hyperframes.gif" alt="Gemdex overview: global memory across agents, repos, local storage, parent-document recall, and desktop management" width="100%" />
</p>

## Why Gemdex

> Your agent re-learns everything every session. You explained your deploy flow
> last week; today it has no idea. Gemdex gives it **durable memory** you write
> on purpose — once, recallable everywhere.

A memory layer is a **deliberately written, persistent store** that is the
source of truth. You teach your agent something once, and it remembers forever,
across every repo and every session.

- 🧠 **You decide what to remember** — explicit `save_memory` / `recall` /
  `update_memory`. No silent capture, no background recall.
- 🌍 **One global pool** — every memory is searchable from everywhere. No
  scopes, no folders, no tags; embeddings do the disambiguation.
- 🔎 **Sharp recall, whole answers** — hybrid semantic + BM25 over internal
  chunks, but recall always returns the **full memory, never a fragment**.
- 🔌 **Plug-and-play** — speaks MCP over stdio, so any compatible client
  (Claude Code, Cursor, Codex CLI, Windsurf, Cline, Continue, Zed…) works
  instantly.
- 🪶 **Local by default, self-hosted when you want more** — start with embedded
  LanceDB at `~/.gemdex`, or run the whole stack on infrastructure you own with
  [one command](#self-host-the-whole-stack-one-command) and share one memory
  pool across every machine.
- 🌐 **Browser manager** — the self-hosted stack ships a web UI (behind your
  Google login) to browse / edit / delete / export / import, and to upload chat
  transcripts.

## The motivating workflows

```
During a session:
  "We just figured out how to wire up the Junie review workflow — save that to memory."

Weeks later, a different repo:
  "Set up the Junie review workflow here — check your memory layer for how we do it."

Different machine, different app:
  "Notarize and sign this build — the credentials and steps are in my memory layer."
```

## Two ways to run it

|  | **Local** | **Self-hosted** |
|---|---|---|
| Store | Embedded LanceDB at `~/.gemdex` | Postgres/pgvector + blob storage you own |
| Setup | Point your agent at `npx gemdex-mcp` | [One command](#self-host-the-whole-stack-one-command) |
| Needs a Gemini key on each machine | Yes | **No** — the server embeds |
| Shared across machines | No, one pool per machine | Yes, one pool for everything |
| Human manage surface | The [macOS app](#the-desktop-app-maintenance-only) | The web manager in your browser |
| Remote agents | stdio only | HTTPS MCP endpoint, OAuth-gated |

Start local; move to self-hosted when you want one pool across machines or agents
that aren't on your laptop. Both speak the same MCP tools, so nothing about how
you use Gemdex changes.

## Quickstart — local (under a minute)

There's **no setup step** for the store — LanceDB is embedded and persists at
`~/.gemdex/lance` automatically the first time you save a memory.

### Wire Gemdex into your agent

**Claude Code:**

```bash
claude mcp add gemdex \
  -e GEMINI_API_KEY=your-key \
  -- npx -y gemdex-mcp@latest
```

**Any other MCP client** (Cursor, Codex CLI, Windsurf, Cline, Continue, Zed…):

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

### Save and recall

```
Save how we set up the Junie review workflow to memory.
```

…later, in any repo on any machine:

```
Set up the Junie review workflow here — check your memory layer.
```

Done. Your agent now has a tiny, durable knowledge store it writes on purpose
and reads on command.

### Nudge your agent to actually use it (the single biggest thing you can do)

> Agents won't reach for a new MCP tool on their own. Tell your agent, at the
> top of every session, that it exists and when to use it.

**For Claude Code** — drop this into `CLAUDE.md` at the repo root (or
`~/.claude/CLAUDE.md` to apply globally):

```markdown
## Memory layer (Gemdex)

`gemdex` MCP exposes `save_memory`, `recall`, `get_memory`, `update_memory`,
`report_outcome`, and `read_attachment` — a global, durable memory store shared
across every repo and session.

- `recall(query)` freely / by default at the start of a task. Returns a cheap
  ranked **title index** (top 10: title + id only). Most recalls need no follow-up.
- `get_memory(id)` only when a title looks clearly task-relevant — the only path
  that returns full body text.
- `save_memory(content, title?)` when you learn something durable and reusable.
- `update_memory(id, content?, edits?, title?)` to revise a stored memory —
  `edits` for a targeted find-and-replace, or `content` for a full rewrite.
- `report_outcome(id, outcome, note?)` right after you act on a fetched memory
  and the result is clear (`worked` / `failed` / `stale`).
- `read_attachment(memory_id, …)` for transcript/attachment bytes after
  `get_memory` shows media.

There's no delete tool — deletion is a human action in the Gemdex desktop app
or web manager. If these tools aren't in your toolset, the MCP isn't connected.
```

**For Codex CLI, Cursor, Windsurf, Cline, Continue, Zed** — paste the same
snippet into your client's root instructions file (conventionally `AGENTS.md`).

## The 6 MCP tools

| Tool | Input | Returns | When the agent calls it |
|------|-------|---------|-------------------------|
| `save_memory` | `content` and/or `attachments`, `title` (optional) | new `id` + resolved title (+ a ⚠ similar-memories warning when a near-duplicate is already stored) | when learning something durable/reusable |
| `recall` | `query` (required) | top 10 titles + ids ranked by relevance (+ track-record when stats exist) | freely / by default before work — cheap title index, never bodies |
| `get_memory` | `id` (required) | full parent body (+ age, attachments metadata, track-record) | only when a `recall` title is clearly task-relevant |
| `update_memory` | `id` (required); `content` **or** `edits`, `title`, `attachments` (optional — at least one required) | updated `id` + title | to revise a stored memory (`edits` = partial find-and-replace; `content` = full rewrite) |
| `report_outcome` | `id` (required), `outcome` (`worked`\|`failed`\|`stale`, required), `note` (optional) | confirmation + updated track record | right after acting on a fetched memory, whenever the outcome is clear |
| `read_attachment` | `memory_id` (required); `attachment_id`, `max_chars` (optional) | attachment bytes as UTF-8 or base64 | after `get_memory` shows attachments (e.g. chat transcripts) |

Deletion is intentionally **not** an agent tool — it's a deliberate human action
in the desktop app or web manager. Embeddings apply where content is written or
searched (`get_memory`, `report_outcome`, and `read_attachment` don't embed).
Local mode requires `GEMINI_API_KEY`; remote mode uses the Gemdex Server owner's
key.

### Multimodal attachments

`save_memory` and `update_memory` accept an optional `attachments` array of
inline media — `{ mimeType, data (base64), caption? }` — embedded into the same
space as text by `gemini-embedding-2`. Supported types and per-memory caps:
PNG/JPEG images (≤ 6), MP3/WAV audio (≤ 1), MP4/MOV video (≤ 1), and PDF (≤ 1).
Each attachment is embedded as
its own unit; its `caption` (or the memory title) backs the keyword branch. Raw
bytes are stored as blobs under `~/.gemdex/blobs` and round-trip through
export/import. Attachments require the `gemini-embedding-2` model — supplying
them to a text-only model returns a clear error.

`recall` works both ways: query by text, by media, or both. Each query
attachment is embedded into the shared space and runs its own similarity branch,
fused with the text branch via Reciprocal Rank Fusion — so you can recall a
memory from a screenshot, an audio clip, or a PDF as easily as from a phrase.

### Outcome feedback

`recall` is fire-and-forget by default — no signal about whether a memory
actually helped ever flows back. `report_outcome(id, outcome, note?)` closes
that loop: right after acting on a recalled memory, tell gemdex whether it
`worked`, `failed` (its info was wrong or broken), or was `stale` (clearly
outdated — rotated credentials, moved paths). Every `recall` hit then shows a
track record (`recalled 7×, worked 3× (last: worked 2d ago)`, prefixed with
`⚠` once it has failed or gone stale before) so you can judge trustworthiness
at a glance.

Stats live in a small per-client ledger (`~/.gemdex/stats.json` by default,
override with `GEMDEX_STATS_PATH`) — never written into the memory rows
themselves, and never shared across machines in v1. Track-record *display* is
always on; actually changing recall **ranking** by trust is opt-in via
`GEMDEX_TRUST_RANKING=true` (pure relevance ranking otherwise, exactly as
before).

## How it works

<p align="center">
  <img src="assets/architecture.jpg" alt="Gemdex pipeline: save memory → chunker → Gemini embed → LanceDB → recall via MCP" width="100%" />
</p>

1. **Save** — `content` is split into retrieval **chunks**; each chunk is
   embedded with Gemini and stored with a `parent_id` pointing back to the whole
   memory.
2. **Recall** — hybrid search (dense vector + BM25, fused with Reciprocal Rank
   Fusion) ranks **chunks**, then each match resolves to its **full parent
   memory** and results are deduped by `parent_id`. So a query that matches one
   paragraph of a 300-line playbook gets the entire playbook back, in one shot.
3. **Store** — everything lives in a single global LanceDB table under
   `~/.gemdex`. The agent's MCP process and the desktop app's sidecar share the
   same store, so a memory saved by one shows up in the other.

This is the well-worn **parent-document retriever** ("small-to-big") pattern:
sharp matching on long content, but the agent always gets the whole memory.

### Save-time conflict detection

Memory hygiene (below) finds duplicate/contradicted memories **after the
fact** — weeks later, in a manual desktop scan. `save_memory` now checks **at
the moment of save** instead: the new memory's vectors are already computed
before insert, so checking for near-duplicates costs zero extra
embedding/network calls — just one local ANN query plus a handful of filtered
reads, reusing the exact same centroid-cosine math and default threshold
(`0.90`) as hygiene clustering. When something similar is already stored, the
`save_memory` response carries a `similar` field and a `⚠` advisory block
naming the existing memory — advisory only, the save always succeeds. On by
default; disable with `GEMDEX_SIMILAR_ON_SAVE=false` or loosen/tighten the bar
with `GEMDEX_SIMILAR_THRESHOLD`. Local mode only in v1 — a BYOI remote save
simply carries no `similar` field yet.

## The desktop app (maintenance-only)

> **The macOS app is no longer the primary manage surface.** It still works and
> is still shipped, but it manages a **local** `~/.gemdex` pool on one Mac. New
> work goes into the [web manager](packages/web/README.md), which runs against
> your self-hosted pool from any browser, behind your Google login, and is the
> surface that gets features like session upload and memory hygiene at
> deployment scale. The app is in maintenance mode: bug fixes, no new features.
>
> Use the app if you're local-only on a Mac and want a native window. Otherwise
> [self-host](#self-host-the-whole-stack-one-command) and use the browser.

A native, **manage-only** SwiftUI app for macOS (Apple Silicon) that opens
straight into your memory layer:

- Browse / list all memories (sorted by recency).
- View, create, edit, and delete memories — including inline media attachments
  (drag-and-drop or pick image / audio / video / PDF, caption them, and preview
  them in place).
- "Find similar" on any attachment to recall related memories by media.
- Export all memories to a portable JSONL file; import them back.
- Distill coding-agent chat history into one memory per **new** session. Once a session is ingested, Gemdex never reprocesses it—even if the transcript later changes.
- **Memory hygiene** — find stale, duplicate, or contradicted memories. A free
  local scan clusters similar memories using the vectors already in LanceDB;
  a Gemini judge then marks each cluster member keep / duplicate / superseded /
  contradicted with quoted evidence. You review the findings and approve every
  deletion by hand — dismissed clusters are never flagged again.

There's **no free-text search box** — recall is an agent/MCP capability; the app
is a fast local manager (the only recall it surfaces is "Find similar", i.e.
recall-by-example from an existing attachment). On launch the app spawns its own Node sidecar
(`gemdex serve`) over localhost and opens directly into the manager. **You never
run a sidecar command.**

### First launch

The app will not unlock local memory operations until `GEMINI_API_KEY` is both
present **and verified with a real Gemini embedding request**. Missing, rejected,
or temporarily unverifiable keys produce a prominent blocking screen with retry
and replacement controls; an untested candidate is never saved. After Gemini
accepts the key, Gemdex stores it locally in `~/.gemdex/.env`.

Remote storage can open the memory manager without a local embedding key because
the server owns memory embeddings. Chat-history digestion still runs on this Mac,
so remote-mode users see a persistent red warning and ingestion remains disabled
until a local Gemini key is verified.

<p align="center">
  <img src="assets/app-screenshot-setup.png" alt="Gemdex Memory first-launch API key setup screen" width="100%" />
</p>

### Memory manager

After setup, the app opens into the local manager for browsing, editing,
exporting, and importing memories.

<p align="center">
  <img src="assets/app-screenshot-manager.png" alt="Gemdex Memory desktop manager showing stored memories and the empty detail state" width="100%" />
</p>

```bash
# from packages/app — requires a Swift 5.9+ toolchain (no Xcode needed)
cd packages/app
bash macos/build-app.sh                 # assemble build/Gemdex Memory.app
open "build/Gemdex Memory.app"          # launch it
```

Download a signed, notarized DMG from the
[latest release](https://github.com/anand-92/gemdex/releases/latest) — it bundles
its own Node runtime, so it runs with zero manual dependency installation.

The sidecar is the same package as the MCP server:

```bash
npx gemdex serve --port 0   # localhost HTTP/JSON manager API; --port 0 = auto-pick
```

| Method + path | Purpose |
|---|---|
| `GET /health` | readiness probe |
| `GET /memories` | list (sorted by `updatedAt` desc) |
| `GET /memories/:id` | full memory |
| `POST /memories` | create (embeds via Gemini) |
| `PUT /memories/:id` | edit (re-chunk + re-embed) |
| `DELETE /memories/:id` | delete |
| `GET /export` · `POST /import` | portable backup / restore (upsert by id) |

The sidecar binds `127.0.0.1` only — it's a single-user local app.

## Self-hosted remote mode (BYOI)

Run Gemdex Server with Postgres/pgvector and file or S3-compatible attachment
storage, then connect MCP, CLI, and desktop clients to the same global memory
pool. Embedding runs on the server, so remote clients do not need a Gemini key.

### Self-host the whole stack (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/anand-92/gemdex/main/scripts/install.sh | bash
```

Brings up Postgres, the memory API, the [Streamable HTTP MCP
endpoint](packages/mcp-http/README.md) and the [web manager](packages/web/README.md);
generates every secret; waits for migrations; **verifies a real save and recall**;
then prints a ready-to-paste MCP client config. It asks for one thing — a free
[Google AI Studio key](https://aistudio.google.com/apikey) — or reads
`GEMINI_API_KEY` from the environment.

Loopback-only by default. Add `--lan` to reach it from your other devices:

```bash
curl -fsSL https://raw.githubusercontent.com/anand-92/gemdex/main/scripts/install.sh | bash -s -- --lan
```

Re-running is safe and is the upgrade path: existing secrets are never
regenerated and no volume is removed. `--help` lists the flags (alternate ports,
install directory, pinned ref).

Then, when you want more than localhost:

| Guide | What it covers |
|-------|----------------|
| [Self-host deploy](docs/SELF_HOST_DEPLOY.md) | The canonical end-to-end setup: Compose stack, Google OAuth, public HTTPS edge, and a proof that the memory plane isn't exposed |
| [Go further](docs/GO_FURTHER.md) | DNS + TLS, running on Render or Railway, a VPS, what stays local vs cloud, and cost/sizing |
| [Security notes](docs/SECURITY_SELFHOST.md) | What is actually enforced, where in the code, and the pre-launch checklist |
| [Chat history](docs/CHAT_HISTORY.md) | The three ingestion paths and which to use |

### Or just the memory server

If you only want the BYOI backend — no MCP endpoint, no web manager — it's two
commands. On the server host:

```bash
git clone https://github.com/anand-92/gemdex.git
cd gemdex/packages/server && npm run init   # generates secrets, starts Docker, prints the token
```

On each client (paste the token when prompted; add `--import-local` to bring
your existing local memories along):

```bash
npx -y gemdex-mcp@latest init-remote myserver https://memory.example.com
```

`init-remote` verifies the server, switches the client to remote mode, and
prints the agent command. You can also run a **local and a remote pool side by
side** — see the operations guide.

Start with the [`BYOI operations guide`](docs/BYOI_OPERATIONS.md). The
[`remote mode contract`](docs/BYOI_REMOTE_MODE.md) defines the v1 API, auth,
attachment handling, compatibility checks, ranking invariants, and non-goals.

## Use as a library

Skip the MCP server and embed the memory store directly:

```ts
import { MemoryStore, LanceDBVectorDatabase, GeminiEmbedding } from 'gemdex-core';

const embedding = new GeminiEmbedding({
  apiKey: process.env.GEMINI_API_KEY!,
  model: 'gemini-embedding-2',
});

// Pass nothing to use the default ~/.gemdex/lance directory.
const vectorDatabase = new LanceDBVectorDatabase();
const memory = new MemoryStore({ embedding, vectorDatabase });

const { id } = await memory.save({
  content: 'Notarize with: xcrun notarytool submit …',
  title: 'macOS notarization',
});

const hits = await memory.recall('how do we notarize builds', 5);
console.log(hits[0].content); // the full memory, never a fragment
```

## Packages

| Package | Description |
|---------|-------------|
| [`gemdex-core`](packages/core) | Memory store (parent-document chunking), Gemini embedding client, embedded LanceDB hybrid retrieval |
| [`gemdex-mcp`](packages/mcp) | MCP server (`save_memory`/`recall`/`get_memory`/`update_memory`/`report_outcome`/`read_attachment`) + `gemdex serve` localhost sidecar |
| [`gemdex-server`](packages/server) | Self-hosted BYOI HTTP backend using Postgres/pgvector and file or S3-compatible blobs |
| [`gemdex-mcp-http`](packages/mcp-http) | Python. Streamable HTTP MCP endpoint (`/mcp`) for remote agents; OAuth 2.1 single-user auth |
| [`gemdex-web`](packages/web) | Python + React. Browser manager for a self-hosted pool: Google login, CRUD, session upload, hygiene |
| [`packages/app`](packages/app) | native SwiftUI macOS app to manage a local pool (maintenance-only) |

## Configuration

<details>
<summary>All environment variables</summary>

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | yes | — | Google AI Studio API key (needed to embed on save/recall/update) |
| `LANCEDB_PATH` | no | `~/.gemdex/lance` | Filesystem path for the embedded memory store |
| `EMBEDDING_MODEL` | no | `gemini-embedding-2` | Override Gemini embedding model |
| `EMBEDDING_DIMENSION` | no | model default | Force Matryoshka-resized dimension (256/768/1536/3072) |
| `GEMINI_BASE_URL` | no | Google default | Custom Gemini endpoint |
| `HYBRID_MODE` | no | `true` | Disable to use dense-only recall |
| `GEMDEX_SERVE_PORT` | no | auto (0) | Default port for `gemdex serve` (the app picks one automatically) |
| `GEMDEX_MODE` | no | `local` | Select the embedded `local` backend or a configured `remote` backend |
| `GEMDEX_REMOTE_URL` | remote only | — | Gemdex Server root URL |
| `GEMDEX_REMOTE_TOKEN` | remote only | — | Gemdex Server bearer token |
| `GEMDEX_STATS_PATH` | no | `~/.gemdex/stats.json` | Where the `report_outcome` feedback ledger is stored |
| `GEMDEX_TRUST_RANKING` | no | `false` | Set `true` to re-rank `recall` results by track record (worked/failed/stale); display of the track-record line stays on either way |
| `GEMDEX_SIMILAR_ON_SAVE` | no | `true` | Set `false` to disable save-time similar-memory detection |
| `GEMDEX_SIMILAR_THRESHOLD` | no | `0.90` | Centroid cosine-similarity bar for save-time detection (same scale as memory hygiene) |

</details>

## Privacy & safety

Gemdex is a **power-dev tool with zero guardrails by design**. You may store API
keys, credentials, and account details in plaintext. There is no secret
redaction, encryption mandate, or safety enforcement. In local mode, records
stay on the client except content sent to Gemini for embedding. In BYOI mode,
records live in your server/database/blob infrastructure and embedding payloads
are sent from that server to Gemini. Gemdex provides no hosted custody or
account service. See the [BYOI security model](docs/BYOI_OPERATIONS.md#security-and-custody),
and — if you plan to expose a deployment publicly —
[the self-host security notes](docs/SECURITY_SELFHOST.md).

## Build from source

```bash
git clone https://github.com/anand-92/gemdex.git
cd gemdex
pnpm install
pnpm build
```

The MCP entry point lands at `packages/mcp/dist/index.js`. Point your MCP client
at `node /absolute/path/to/packages/mcp/dist/index.js` to run a local build.

## Roadmap

- [ ] Optional encryption-at-rest for sensitive memories
- [ ] Packaged desktop app binaries (macOS / Linux / Windows)
- [ ] Multi-machine sync service (beyond export/import)
- [ ] Memory linking / references
- [ ] CLI (`gemdex recall "..."`) for non-MCP workflows

Have an idea? [Open a discussion](https://github.com/anand-92/gemdex/discussions/new).

## Contributing

First time contributors very welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for
the dev loop, then check the `good-first-issue` label.

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=anand-92/gemdex&type=Date)](https://star-history.com/#anand-92/gemdex&Date)

---

<p align="center">
  <img src="assets/star-cta.jpg" alt="If Gemdex gave your agent a memory, drop a star" width="60%" />
</p>

<div align="center">

If Gemdex makes your agent remember, **[give it a ⭐](https://github.com/anand-92/gemdex)** — it's the single biggest thing that helps the project grow.

</div>

## License

MIT. See [LICENSE](LICENSE).
