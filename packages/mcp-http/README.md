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
| `GEMDEX_MCP_AUTH` | no | `static` | Auth mode: `static` (shared bearer, loopback dev) or `google` (OAuth 2.1 resource server). |
| `GEMDEX_MCP_HTTP_TOKEN` | **yes**¹ | — | Static bearer token MCP clients must present. `static` mode only. |
| `GOOGLE_OAUTH_CLIENT_ID` | **yes**² | — | OAuth 2.0 Web application client ID (`….apps.googleusercontent.com`). |
| `GOOGLE_OAUTH_CLIENT_SECRET` | **yes**² | — | Client secret for that OAuth client (`GOCSPX-…`). |
| `GEMDEX_MCP_BASE_URL` | **yes**² | — | Public base URL clients reach this server at. Becomes the OAuth issuer and resource identity, so it must match exactly. |
| `GEMDEX_ALLOWED_EMAIL` | **yes**² | — | The **single** Google account allowed to use this server. Every other identity is rejected. |
| `GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH` | no | `false` | Explicitly disable client auth. Loopback dev only — never expose. |
| `GEMDEX_SERVER_URL` | no | `http://127.0.0.1:8765` | Base URL of the BYOI server (no `/v1` suffix). |
| `GEMDEX_MCP_HTTP_HOST` | no | `127.0.0.1` | Bind address. Loopback by default; see the bind note below. |
| `GEMDEX_MCP_HTTP_PORT` | no | `8766` | Bind port. |
| `GEMDEX_MCP_HTTP_TIMEOUT_MS` | no | `30000` | Per-request timeout against the BYOI API. |
| `GEMDEX_TRUST_RANKING` | no | `false` | Opt-in trust-weighted `recall` re-ranking, same flag as the stdio server. |

¹ Required in `static` mode unless `GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH=true`. Ignored
in `google` mode — see below.
² Required when `GEMDEX_MCP_AUTH=google`; startup fails naming whichever is missing.

Values are read from the process environment first, then from `~/.gemdex/.env`
(the same precedence `gemdex-core`'s `EnvManager` uses), so a token already
stored there works without re-exporting it.

## Auth

Two modes, both built by the single seam `auth.py::build_auth_provider(config)`.
Nothing in `server.py` or `tools.py` branches on the mode.

### `static` (default) — shared bearer, loopback only

One token verified by FastMCP's `StaticTokenVerifier`, with the server bound to
`127.0.0.1`. Deliberately the weakest thing that is still safe on a single host:
no identity, no expiry, no rotation. If you bind anything other than loopback in
this mode, put it behind a TLS proxy that forwards `Authorization`.

### `google` — OAuth 2.1 resource server, one user

```bash
GEMDEX_MCP_AUTH=google \
GEMDEX_SERVER_TOKEN=<byoi-bearer> \
GOOGLE_OAUTH_CLIENT_ID=<…>.apps.googleusercontent.com \
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-<…> \
GEMDEX_MCP_BASE_URL=https://gemdex.example.com \
GEMDEX_ALLOWED_EMAIL=you@gmail.com \
uv run gemdex-mcp-http
```

This makes `/mcp` a spec-compliant resource server per
[MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
A compliant MCP client needs only the URL: it discovers where to authenticate,
runs the flow in a browser, and stores the resulting token itself.

**Google is the identity provider, but Google is not the authorization decision.**
Google will happily authenticate *every* Google account, so the provider alone is
an open door. `GEMDEX_ALLOWED_EMAIL` is what closes it: the verified email on
every request must equal it, or the request is rejected. This server is
single-user by design — there is no tenancy, no roles, no invite flow.

Three properties worth knowing:

- **Enforcement is per request, not per login.** The allowlist is checked every
  time a token is presented, so shrinking it takes effect immediately instead of
  waiting for already-issued tokens to expire.
- **An unverified Google email is not accepted as identity.** Google's
  `email_verified` must be true; an unverified address is self-asserted and could
  name someone else's account.
- **The static bearer is dropped in this mode**, even if `GEMDEX_MCP_HTTP_TOKEN`
  is still set in the environment. Honoring both would leave a second way in that
  skips the allowlist entirely.

Because Google lacks Dynamic Client Registration, FastMCP fronts it with
`OAuthProxy`: this server advertises itself as a DCR-capable authorization
server, accepts client registrations, and swaps its own tokens for the stored
Google credentials behind the scenes. What clients see:

| Endpoint | Purpose |
|----------|---------|
| `/.well-known/oauth-protected-resource/mcp` | Protected Resource Metadata (RFC 9728) — resource identity + issuing AS. |
| `/.well-known/oauth-authorization-server` | AS metadata: `/authorize`, `/token`, `/register`, PKCE `S256`. |
| `/authorize`, `/token`, `/register` | The proxied OAuth 2.1 flow. |
| `/auth/callback` | Where Google returns. **This exact URI is what you register.** |

An unauthenticated call to `/mcp` returns `401` with the discovery pointer, which
is what lets a client bootstrap from the URL alone:

```
WWW-Authenticate: Bearer scope="openid https://www.googleapis.com/auth/userinfo.email",
  resource_metadata="https://gemdex.example.com/.well-known/oauth-protected-resource/mcp"
```

### Setting up the Google OAuth client

**This cannot be scripted** — verified, not assumed. All three plausible CLI
paths are dead ends:

- `gcloud iam oauth-clients create` manages **Workforce Identity Federation**
  clients, a different system. It does not produce an
  `…apps.googleusercontent.com` "Sign in with Google" client.
- `gcloud alpha iap oauth-brands` / `oauth-clients` was the one real programmatic
  API, and Google **permanently shut it down on 2026-03-19**. The command still
  exists and only fails once invoked.
- The **Firebase CLI** has no OAuth-client commands at all; its `auth:*` verbs
  (`auth:export`, `auth:import`) manage end-user accounts, not clients.

So the console is the only route, and these steps are manual by necessity. It is
a one-time setup.

1. **Pick or create a project** at
   [console.cloud.google.com](https://console.cloud.google.com/projectcreate).
2. **Configure the consent screen** — *APIs & Services → OAuth consent screen*.
   Choose **External**, fill in the app name and your support email. Leave it in
   **Testing**; do not publish. A published app is available to every Google
   account, and while `GEMDEX_ALLOWED_EMAIL` still rejects them, keeping it in
   Testing means Google refuses them a step earlier.
3. **Add yourself as a test user** — the same address as
   `GEMDEX_ALLOWED_EMAIL`. In Testing mode only listed test users can complete
   the flow, which is a second lock on the same door.
4. **Create the client** — *APIs & Services → Credentials → + Create credentials
   → OAuth client ID*:
   - **Application type:** Web application
   - **Authorized redirect URIs:** `<GEMDEX_MCP_BASE_URL>/auth/callback` —
     e.g. `https://gemdex.example.com/auth/callback`
   Google matches this string **exactly**: no trailing slash, no path drift, and
   the scheme/host/port must be identical to `GEMDEX_MCP_BASE_URL`. Getting it
   wrong surfaces as `redirect_uri_mismatch` at the end of the flow.
5. **Copy the credentials** into `GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET`. Prefer `~/.gemdex/.env` (mode `0600`) over a
   shell command, which lands in your history.

No API needs enabling: token and profile verification use Google's public
`tokeninfo` and `userinfo` endpoints.

For local testing, set `GEMDEX_MCP_BASE_URL=http://localhost:8766` and register
`http://localhost:8766/auth/callback`. Loopback is the only host for which plain
HTTP is allowed — anything else is rejected at startup, because a plaintext
base URL would put bearer tokens on the wire in the clear and Google will not
register such a redirect URI anyway.

### Scopes and what this server does *not* do

Requested scopes are the minimum needed to learn who you are: `openid` and
`userinfo.email`. No Gmail, Drive, or Calendar access is requested, and the
Google token is **never forwarded to the BYOI server** — that hop keeps using its
own `GEMDEX_SERVER_TOKEN`. Nothing user-scoped is passed through to third-party
APIs.

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
- **FastMCP's auth module is explicitly exempt from semver stability**, so a
  patch-level bump can change provider internals. `google` mode depends on two
  of them: that `OAuthProxy.verify_token` is the choke point every authenticated
  request passes through, and that Google's verified `email` claim survives the
  token swap into `AccessToken.claims`. If either changes, the allowlist could
  silently stop being consulted — which fails *open*. `tests/test_auth_oauth.py`
  covers both; **re-run it on every FastMCP upgrade**, and treat a failure there
  as a security regression rather than a flaky test.
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
prefixed `gemdex-mcp-http smoke`) — it is an end-to-end check, not a dry run. It
exercises `static` mode, since `google` mode needs a browser.

`tests/test_auth_oauth.py` covers `google` mode without contacting Google: it
drives real FastMCP routes through a Starlette app to assert the actual 401
challenge and metadata documents, and stubs only the upstream Google call so the
allowlist itself runs for real.

## File map

| File | Role |
|------|------|
| `src/gemdex_mcp_http/config.py` | `load_config()` — env → `Config`, fail-fast on missing required values. `~/.gemdex/.env` fallback. |
| `src/gemdex_mcp_http/byoi.py` | `ByoiClient` — async HTTP client for the BYOI `/v1` API. The only module that talks to the network. |
| `src/gemdex_mcp_http/formatting.py` | Pure render helpers ported 1:1 from the TS `handlers.ts` (relative age, score line, track record, previews). |
| `src/gemdex_mcp_http/stats.py` | `MemoryStatsStore` — the `~/.gemdex/stats.json` outcome ledger, same file/format as the TS store. |
| `src/gemdex_mcp_http/tools.py` | The six tool wrappers: arg validation, BYOI delegation, result formatting. Mirrors `handlers.ts`. |
| `src/gemdex_mcp_http/descriptions.py` | Tool descriptions, copied from the TS `index.ts` so agents see identical guidance. |
| `src/gemdex_mcp_http/auth.py` | `build_auth_provider()` — the auth seam: static bearer, or the OAuth 2.1 Google provider plus the single-user allowlist. |
| `src/gemdex_mcp_http/server.py` | `build_server()` + `main()` — registers tools, runs `mcp.run(transport="http", …)`. |
