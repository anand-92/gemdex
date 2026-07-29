# gemdex-mcp-http

Streamable HTTP MCP transport for Gemdex. A [FastMCP](https://gofastmcp.com) v4
service that re-exposes the six Gemdex tools — `save_memory`, `recall`,
`update_memory`, `list_memories`, `report_outcome`, `read_attachment` — over
**Streamable HTTP** at `/mcp`, so remote agents can reach the memory layer over
a URL instead of a local stdio pipe.

This package owns **no memory logic**. Every tool is a thin wrapper that
delegates to the colocated BYOI server's `/v1` HTTP API (`gemdex-server`), which
is the single source of memory behavior — the same relationship the TS stdio
`gemdex-mcp` package has to `gemdex-core`. One memory pool backs both surfaces.

```
   remote agent  ──Streamable HTTP──▶  gemdex-mcp-http  ──/v1 bearer──▶  gemdex-server
   (MCP client)        /mcp            (this package)                    (BYOI, :8765)
```

## Run it

```bash
cd packages/mcp-http
uv sync

GEMDEX_SERVER_TOKEN=<byoi-bearer> \
GEMDEX_MCP_HTTP_TOKEN=<static-bearer-clients-send> \
uv run gemdex-mcp-http
```

The MCP endpoint is then `http://127.0.0.1:8766/mcp`. Point a client at it:

```python
from fastmcp import Client
from fastmcp.client.auth import BearerAuth

async with Client("http://127.0.0.1:8766/mcp", auth=BearerAuth(token)) as client:
    await client.call_tool("recall", {"query": "deploy steps"})
```

## Configuration

Required config **fails fast at startup** (repo convention) — the process exits
non-zero rather than booting into a broken state.

| Variable | Required | Default | Meaning |
|----------|----------|---------|---------|
| `GEMDEX_SERVER_TOKEN` | **yes** | — | Bearer token for the colocated BYOI `/v1` API. Same value `gemdex-server` was started with. |
| `GEMDEX_MCP_HTTP_TOKEN` | **yes**¹ | — | Static bearer token MCP clients must present. Interim auth; OAuth lands in GEM2-3. |
| `GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH` | no | `false` | Explicitly disable client auth. Loopback dev only — never expose. |
| `GEMDEX_SERVER_URL` | no | `http://127.0.0.1:8765` | Base URL of the BYOI server (no `/v1` suffix). |
| `GEMDEX_MCP_HTTP_HOST` | no | `127.0.0.1` | Bind address. Loopback by default; see the bind note below. |
| `GEMDEX_MCP_HTTP_PORT` | no | `8766` | Bind port. |
| `GEMDEX_MCP_HTTP_TIMEOUT_MS` | no | `30000` | Per-request timeout against the BYOI API. |
| `GEMDEX_TRUST_RANKING` | no | `false` | Opt-in trust-weighted `recall` re-ranking, same flag as the stdio server. |

¹ Required unless `GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH=true`.

Values are read from the process environment first, then from `~/.gemdex/.env`
(the same precedence `gemdex-core`'s `EnvManager` uses), so a token already
stored there works without re-exporting it.

## Interim auth: static bearer + loopback bind

Client auth today is a **static bearer token** verified by FastMCP's
`StaticTokenVerifier`, and the server binds `127.0.0.1` by default. That is
deliberately the weakest thing that is still safe on a single host: it ships
before OAuth so the transport and tool surface can be validated independently.

OAuth 2.1 Resource Server support is **GEM2-3**. The auth wiring is isolated in
`auth.py` behind one function, `build_auth_provider(config)`, returning a
FastMCP `AuthProvider | None` — GEM2-3 swaps that one seam and touches nothing
else. Do not scatter auth decisions into `server.py` or `tools.py`.

Until OAuth lands: if you bind anything other than loopback, put it behind a TLS
proxy that forwards `Authorization`, and treat the static token as a shared
secret with no expiry, no rotation, and no per-client identity.

## Attachment paths are host-local — remote agents must not send them

The TS stdio tools accept an attachment as either inline base64 `data` **or** a
local file `path`, and prefer `path` because the MCP server runs on the same
machine as the agent, so it can read the bytes off disk itself.

**That assumption does not hold here.** This service is reached over HTTP from a
potentially different machine. A `path` is resolved (if at all) on the *service
host's* filesystem, not the agent's laptop — so a laptop path either fails to
resolve or, worse, silently resolves to an unrelated file on the host.

Consequences for remote agents:

- **Sending attachments:** inline base64 `data` + `mimeType` only. `path` is
  rejected with an explicit error rather than quietly read from the host.
- **Reading attachments:** use `read_attachment` (bytes come from the BYOI blob
  store over HTTP). Do **not** try to open a `Full transcript:` filesystem path
  from a digest — that path refers to the machine that ingested the session.

`read_attachment` needs no `GEMINI_API_KEY` on either side: the BYOI server owns
embedding, and attachment reads don't embed anything.

## Beta caveats

- **FastMCP 4 is a prerelease** (`4.0.0b1`, "Fourgone Conclusion", 2026-07-28).
  The version is pinned **exactly** in `pyproject.toml`. Expect sharp edges and
  do not float the pin.
- uv only allows prereleases for packages you name, and `fastmcp-slim` arrives
  transitively at the same version — hence
  `[tool.uv] constraint-dependencies = ["fastmcp-slim==4.0.0b1"]`. Do **not**
  pin the `mcp` SDK to a prerelease: it ships stable, and a prerelease pin fails
  to satisfy FastMCP's own `mcp>=2.0.0` requirement, breaking resolution.
- **Watch for v4 stable.** When it lands, move the pin (both `fastmcp` and the
  `fastmcp-slim` constraint) and re-run the smoke test — the constraint entry
  becomes unnecessary once prereleases are out of the picture.
- v4 runs on MCP Python SDK v2 and answers **both** the sessionless `2026-07-28`
  protocol era and the older session-based handshake, negotiated per connection.
  Both client generations work against this one server; the smoke test exercises
  the modern path.

## Tests

```bash
uv run pytest                       # wrapper-layer unit tests, BYOI mocked
uv run python scripts/smoke.py      # live: needs a real BYOI on :8765
```

`scripts/smoke.py` starts this service on an ephemeral port, connects a real MCP
client over Streamable HTTP, and runs `save_memory` → `recall` →
`read_attachment` against the live BYOI pool. It writes one real memory (title
prefixed `gemdex-mcp-http smoke`) — it is an end-to-end check, not a dry run.

## File map

| File | Role |
|------|------|
| `src/gemdex_mcp_http/config.py` | `load_config()` — env → `Config`, fail-fast on missing required values. `~/.gemdex/.env` fallback. |
| `src/gemdex_mcp_http/byoi.py` | `ByoiClient` — async HTTP client for the BYOI `/v1` API. The only module that talks to the network. |
| `src/gemdex_mcp_http/formatting.py` | Pure render helpers ported 1:1 from the TS `handlers.ts` (relative age, score line, track record, previews). |
| `src/gemdex_mcp_http/stats.py` | `MemoryStatsStore` — the `~/.gemdex/stats.json` outcome ledger, same file/format as the TS store. |
| `src/gemdex_mcp_http/tools.py` | The six tool wrappers: arg validation, BYOI delegation, result formatting. Mirrors `handlers.ts`. |
| `src/gemdex_mcp_http/descriptions.py` | Tool descriptions, copied from the TS `index.ts` so agents see identical guidance. |
| `src/gemdex_mcp_http/auth.py` | `build_auth_provider()` — the pluggable auth seam (static bearer today, OAuth in GEM2-3). |
| `src/gemdex_mcp_http/server.py` | `build_server()` + `main()` — registers tools, runs `mcp.run(transport="http", …)`. |
