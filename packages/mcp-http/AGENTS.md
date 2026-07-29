# AGENTS.md — gemdex-mcp-http

The **Streamable HTTP** surface of Gemdex: a FastMCP v4 (Python) service that
re-exposes the six MCP tools over a URL instead of a stdio pipe, so agents on
other machines can reach the memory layer. Repo-wide context is in the root
`AGENTS.md`; the TS tool contract this package mirrors is in
[`../mcp/AGENTS.md`](../mcp/AGENTS.md).

Read this before editing. Operational setup (env vars, how to run, beta pin
rationale) lives in the [README](README.md) and is not repeated here.

## Where this sits

This is a **third client shell** over the same engine, alongside the TS stdio
server and the desktop sidecar — and like them it owns **no memory logic**:

```
   remote agent ──Streamable HTTP──▶ gemdex-mcp-http ──/v1 bearer──▶ gemdex-server ──▶ gemdex-core
                       /mcp          (this package,                 (BYOI, :8765)     (the engine)
                                      Python)
```

The critical consequence: **this package is Python and talks HTTP, not
`workspace:*`.** It cannot import `gemdex-core`. Every behavior the TS handlers
get for free from a shared library — content edits, relative ages, score lines,
the stats ledger — is **re-implemented here and must be kept in sync by hand**.

## File map (`src/gemdex_mcp_http/`)

| File | Role |
|------|------|
| `config.py` | `load_config()` — env → frozen `Config`. Fail-fast: raises `ConfigError` rather than booting broken. `EnvSource` mirrors core's `EnvManager` precedence (`process.env` → `~/.gemdex/.env`). |
| `byoi.py` | `ByoiClient` — the async `/v1` client. **The only module that touches the network.** Python analogue of core's `RemoteMemoryBackend`. |
| `formatting.py` | Pure render helpers ported 1:1 from TS `handlers.ts` (+ `apply_content_edits` from core's `content-edits.ts`). No I/O, no state. |
| `stats.py` | `MemoryStatsStore` — the `~/.gemdex/stats.json` outcome ledger, same file/format as core's TS store. |
| `tools.py` | `GemdexTools` — the six wrappers: validate args → call BYOI → render. Mirrors `handlers.ts`. |
| `descriptions.py` | Tool descriptions copied from TS `index.ts`, with the attachment-path caveat swapped in. |
| `auth.py` | `build_auth_provider()` — **the single auth seam.** |
| `server.py` | `build_server()` + `main()`. Registers tools, runs `mcp.run(transport="http", …)`. |

## Three invariants that are easy to break

### 1. Output text is a mirror of `handlers.ts` — change both or neither

`formatting.py` is a deliberate line-for-line port. An agent must get the same
bytes from `recall` whether it connected over stdio or HTTP, because the tool
descriptions teach it to read those exact lines (`Scores: fused=…`, `⚠ track
record: …`, `updated: 3d ago`). If you change a render rule in one package,
change it in the other in the same commit. The unit tests here assert on the
literal strings for exactly this reason.

Same applies to `apply_content_edits` (ported from core's `content-edits.ts`) and
`stats.py` (ported from core's `memory-stats-store.ts` — same on-disk file, so a
format divergence corrupts the ledger the TS server also reads).

### 2. Attachment `path` is rejected, not resolved

The TS tools accept a local file `path` and prefer it, because agent and server
share a machine. **Here they do not.** A `path` would resolve on the *service
host's* filesystem — failing, or silently reading an unrelated file. So
`_validate_attachments` raises a `ToolError` naming the constraint rather than
attempting a host read, and every description says inline base64 only. Do not
"fix" this by adding path support; the fix is `read_attachment`.

### 3. Auth lives in `auth.py` and nowhere else

`build_auth_provider(config) -> AuthProvider | None` is the whole auth surface.
Today: `StaticTokenVerifier` over one configured bearer, loopback bind. GEM2-3
replaces that function body with an OAuth 2.1 Resource Server provider. Nothing
in `server.py` or `tools.py` may branch on the auth mode — if you find yourself
adding `if config.unsafe_no_auth` outside `auth.py`/`main()`, the seam is leaking.

`None` is only reachable via `GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH=true`; the config
layer refuses to boot an authless server otherwise, so the seam can't be
bypassed by simply omitting a token.

## Other gotchas

- **Six tools, no delete** — same as the stdio surface, same reason (deletion is
  a human action in the desktop app). `test_no_delete_tool` guards it.
- **`ToolError`, never a raw exception.** Matches the TS handlers' "never throw
  to the protocol" rule; `GemdexTools._call` wraps every BYOI call so a transport
  failure becomes a readable tool error, not a crash.
- **The HTTP client is `httpx2`, not `httpx`.** MCP SDK v2 ships httpx2, and
  FastMCP raises httpx2 exceptions. An `except httpx.…` will import fine (httpx
  is often present transitively) and then silently never match.
- **`fastmcp==4.0.0b1` is a prerelease pin** with a `[tool.uv]
  constraint-dependencies` entry for `fastmcp-slim`. Never pin the `mcp` SDK to a
  prerelease — it breaks resolution. See the README's beta caveats.
- **Trust ranking is opt-in and off by default** (`GEMDEX_TRUST_RANKING=true`,
  read once at startup into `Config`). Off: fetch exactly `limit`, backend order
  untouched, no `trust=` in the score line — byte-identical to the flag-off TS
  path.
- **`scripts/smoke.py` writes a real memory** into the live BYOI pool (titled
  `gemdex-mcp-http smoke …`). It is an end-to-end acceptance check, not a dry
  run; `uv run pytest` is the offline suite and mocks the BYOI entirely.
- **This package is outside the pnpm workspace.** `pnpm lint`/`typecheck`/`build`
  do not see it; use `uv run pytest`.
