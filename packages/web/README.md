# gemdex-web

The **web manager**: a browser UI for managing a Gemdex memory pool — list,
search, read, create, edit, **delete**, and download transcript attachments —
gated by the same single-user Google login as
[`gemdex-mcp-http`](../mcp-http/README.md).

It replaces the SwiftUI desktop app as the primary human surface for a
self-hosted deployment, and it is the **only** place deletion is exposed. The
agent-facing MCP tools deliberately have no delete (see the root `AGENTS.md`).

```
   browser ──session cookie──▶ gemdex-web ──/v1 bearer──▶ gemdex-server ──▶ gemdex-core
   (Google login)              (this package:            (BYOI, :8765)      (the engine)
                                React SPA + FastAPI BFF)
```

Internals and the reasoning behind the design are in [AGENTS.md](AGENTS.md).
This file is operational: how to configure and run it.

## The one thing to understand

**The browser never gets the BYOI token.** The backend is a
*backend-for-frontend*: the SPA authenticates to it with a session cookie, and
it authenticates to the BYOI with a server-side bearer that never appears in a
response. The two credentials are completely separate, and the user's Google
token is discarded the moment their identity is verified — it is never
forwarded anywhere.

That is why this is not "a static site plus CORS": the BYOI bearer is a single
long-lived secret granting full access to the entire memory pool, with no
per-user identity. Anything holding it must not be a browser.

## Layout

| Path | What |
|------|------|
| `src/gemdex_web/` | The FastAPI BFF (Python). |
| `frontend/` | The React + Vite + TypeScript SPA. |
| `tests/` | `pytest` suite for the BFF. |

In production the built SPA is served *by* the BFF from a single origin, so
there is no CORS configuration and the cookie is same-origin by construction.

## Configuration

Read from the process environment first, then `~/.gemdex/.env` — the same
precedence as every other Gemdex component. **Required values fail fast**: a
missing setting is a startup error naming what is missing, never a silent
fallback.

| Variable | Required | Default | Meaning |
|----------|----------|---------|---------|
| `GEMDEX_SERVER_TOKEN` | **yes** | — | Bearer for the BYOI `/v1` API. Server-side only. |
| `GEMDEX_SERVER_URL` | no | `http://127.0.0.1:8765` | Where the BYOI server is. |
| `GEMDEX_WEB_AUTH` | no | `dev` | `dev` (no login, loopback only) or `google`. |
| `GEMDEX_WEB_HOST` | no | `127.0.0.1` | Bind address. `dev` mode refuses anything but loopback. |
| `GEMDEX_WEB_PORT` | no | `8767` | Bind port. |
| `GEMDEX_WEB_TIMEOUT_MS` | no | `30000` | BYOI request timeout. |
| `GEMDEX_WEB_STATIC_DIR` | no | bundled `static/` | Built SPA to serve. Unset and absent ⇒ API only. |

### `google` mode also requires

| Variable | Meaning |
|----------|---------|
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth 2.0 **Web application** client ID. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Its secret (`GOCSPX-…`). |
| `GEMDEX_WEB_BASE_URL` | Public base URL. https required off-loopback. |
| `GEMDEX_ALLOWED_EMAIL` | The one Google account allowed in. |
| `GEMDEX_WEB_SESSION_SECRET` | Signs session cookies. ≥32 chars; `openssl rand -hex 32`. |
| `GEMDEX_WEB_SESSION_TTL_SECONDS` | Optional, default `43200` (12 h). |

## Reusing the mcp-http Google client

You do **not** need a second OAuth client. One client can hold several
authorized redirect URIs, and the two services use different paths:

| Service | Redirect URI |
|---------|--------------|
| `gemdex-mcp-http` | `https://<mcp-host>/auth/callback` |
| `gemdex-web` | `https://<web-host>/auth/google/callback` |

Add the web one under **APIs & Services → Credentials → your OAuth client →
Authorized redirect URIs**. Google matches these by exact string — no
wildcards, no trailing-slash tolerance. The running server prints the exact
value to register at startup.

As with mcp-http: **the OAuth client cannot be created from any CLI.** It is
console-only. Don't spend time looking for a `gcloud` verb — see the mcp-http
README for the three dead ends.

## Running it

### Development (two processes, no login)

```bash
# 1. the BFF, against a BYOI on loopback
cd packages/web
GEMDEX_SERVER_TOKEN=<byoi-token> uv run gemdex-web

# 2. the SPA, with hot reload, proxying /api and /auth to the BFF
cd packages/web/frontend
pnpm install && pnpm dev      # http://127.0.0.1:5173
```

`GEMDEX_WEB_AUTH` defaults to `dev`, which skips login entirely. It is the
analogue of mcp-http's `static` mode: a loopback convenience. The config layer
**refuses to bind a non-loopback address in `dev` mode**, because doing so
would publish unauthenticated delete to the network.

### Production (one process, real login)

```bash
cd packages/web/frontend && pnpm install && pnpm build   # → ../src/gemdex_web/static
cd packages/web && uv run gemdex-web
```

with `GEMDEX_WEB_AUTH=google` and the variables above set. The BFF serves the
built SPA and the API from one origin.

The supported deployment is the container in [`deploy/`](../../deploy/README.md),
which does both build steps for you.

## Tests

```bash
cd packages/web && uv run pytest          # BFF: auth gate, proxying, leak checks
cd packages/web/frontend && pnpm typecheck && pnpm build
```

The pytest suite mocks the BYOI entirely and never touches the network. It
includes a test that enumerates every `/api` route and asserts each one is
behind the auth dependency, so a new route cannot be added unauthenticated by
omission.

## Not in scope here

- **Attachment upload** is GEM2-7. Create/edit are text-only for now; the
  existing attachments on a memory are readable and downloadable.
- **Ingest / hygiene status** is GEM2-8. The status page reports BYOI health,
  version, and capabilities.
