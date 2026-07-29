# AGENTS.md — gemdex-web

The **human** management surface: a React SPA plus a FastAPI
backend-for-frontend. Repo-wide context is in the root `AGENTS.md`; the sibling
Python service is [`../mcp-http/AGENTS.md`](../mcp-http/AGENTS.md), and this
package borrows heavily from its config and client patterns.

Read this before editing. Operational setup (env vars, how to run) lives in the
[README](README.md) and is not repeated here.

## Where this sits

A **fourth client shell** over the same engine, and like the others it owns no
memory logic:

```
   browser ──cookie──▶ gemdex-web ──/v1 bearer──▶ gemdex-server ──▶ gemdex-core
             session   (this package)            (BYOI, :8765)      (the engine)
```

It is the *only* surface with delete, and the only one that authenticates a
**person** rather than a **program**.

## The architectural idea: two credentials that never meet

```
   browser  ──── signed session cookie ────▶  BFF  ──── BYOI bearer ────▶  gemdex-server
            (identifies a human, 12h TTL)         (full pool access, no identity)
```

The browser never receives the BYOI bearer, and the user's Google token is
discarded the moment their identity is verified — it is never forwarded
anywhere. This is the whole reason the BFF exists rather than the SPA calling
`/v1` with CORS: the BYOI bearer is one long-lived secret with full access to
every memory and no per-user identity, so it must not live in a browser.

**Consequence for any new route:** it must not accept a caller-supplied upstream
URL, token, or header. `byoi.py` is the only module that talks to the network,
and it always uses the configured token.

## File map

| File | Role |
|------|------|
| `src/gemdex_web/config.py` | `load_config()` — env → frozen `Config`, fail-fast. Mirrors mcp-http's `EnvSource` precedence. |
| `src/gemdex_web/byoi.py` | `ByoiClient` — the async `/v1` client. **The only module that touches the network.** Has `delete()`, which mcp-http's deliberately does not. |
| `src/gemdex_web/auth.py` | **The single auth seam.** Google authorization-code flow, ID-token claim validation, the email allowlist, the `require_identity` dependency. |
| `src/gemdex_web/routes.py` | The `/api` router. Every route sits behind `require_identity`. Owns search, pagination, and response projection. |
| `src/gemdex_web/app.py` | `create_app()` — session middleware, auth routes, API, SPA serving. |
| `src/gemdex_web/server.py` | `main()` entrypoint: resolve config, print posture, run uvicorn. |
| `frontend/src/api.ts` | The SPA's only `fetch` call site, plus the types that mirror the BFF's projections. |
| `frontend/src/router.ts` | ~50-line hash router. **Extension point for GEM2-7/8.** |

## Invariants that are easy to break

### 1. This is an OAuth *client*; mcp-http is a *resource server*

They are different halves of the protocol and the difference is not cosmetic:

|  | `mcp-http` | `gemdex-web` |
|--|-----------|--------------|
| Role | resource server | client (relying party) |
| Credential in | bearer token the client already has | session cookie this app issued |
| Verified by | `OAuthProxy.verify_token` per call | `current_identity` per request |
| Redirect URI | `/auth/callback` | `/auth/google/callback` |

Browsers cannot present bearer tokens, which is why a cookie exists at all. One
Google OAuth client serves both because a client may hold several redirect URIs.

### 2. The allowlist is re-checked on every request, not just at login

`current_identity` compares the cookie's email against `GEMDEX_ALLOWED_EMAIL` on
**every** request. This is the browser analogue of the `verify_token` lesson in
mcp-http: sessions outlive configuration, so removing an address from the
allowlist must invalidate the sessions it already issued. Checking only at login
would leave a valid cookie working for up to the full TTL after revocation.
`test_session_for_a_since_removed_email_stops_working` guards it.

### 3. ID-token signature verification is skipped *deliberately and narrowly*

`decode_id_token_claims` does not verify the JWT signature. That is sanctioned by
OpenID Connect Core §3.1.3.7 item 6 **only because** the token is read straight
from Google's token endpoint over TLS, authenticated with our client secret —
there is no untrusted intermediary who could substitute it.

This becomes a vulnerability the moment an ID token arrives from anywhere else
(a fragment, a `postMessage`, a client-supplied assertion). If you add such a
path, you must add real JWKS verification.

The semantic checks TLS does *not* make for us are all still required, and each
fails closed: `iss`, `aud`, `nonce`, `exp`, `email_verified`, `email`. The `aud`
check specifically prevents accepting a token minted for a different OAuth
client — the classic confused-deputy on ID tokens.

`email_verified` matters for the same reason as in mcp-http: an unverified Google
email is self-asserted, so accepting it would let anyone claim the allowlisted
address.

### 4. Delete lives here and must not migrate to MCP

Root `AGENTS.md`: "six tools, no delete." Deletion is irreversible, so it is a
deliberate human act behind an authenticated UI and a confirm dialog. Do not add
a delete tool to `packages/mcp-http` to make the surfaces symmetric — the
asymmetry is the design.

### 5. Search is server-side because the BYOI has no search route

There is **no substring-search route** on the BYOI: `GET /v1/memories` returns
every summary and `POST /v1/recall` is semantic (embedding-based), which is a
different feature. So literal search has to happen in a shell, and it happens in
the BFF: measured against the real pool, the full list is ~1300 records / ~540 KB
— trivial for the BFF over loopback (~36 ms), absurd to re-download into the
browser on every keystroke.

Both search modes are exposed because they answer different questions: `?q=`
finds a remembered phrase, `/api/recall` finds related meaning. The filter's
fields (title + preview) match the `list_memories` MCP tool's `filter`, so the
two surfaces agree on what "search" means literally.

### 6. Responses are explicit projections, not forwarded upstream objects

`_summary`/`_detail`/`_attachment` in `routes.py` name every field that reaches
the browser. This is why a new BYOI field cannot silently start leaking, and why
the frontend's types are a contract with *this* service. Keep them in sync with
`frontend/src/api.ts`.

**`/v1/recall` returns hits flat** — the memory's fields with a numeric `score`
alongside, *not* nested under a `memory` key like `/v1/memories/:id`.
`_recall_result` normalizes that into `{memory, score}` so the SPA renders filter
and recall results through one path. This cost a real bug: the first
implementation read `result["memory"]`, which does not exist, and every recall
hit reached the browser as `null` — invisible to the mocked test suite because
the fake had the same wrong shape. The fake now mirrors the live response, and
`test_recall_normalizes_the_flat_upstream_shape` pins it.

## Other gotchas

- **`httpx2`, not `httpx`** — same as mcp-http. An `except httpx.…` will import
  fine and then silently never match.
- **A BYOI 401/403 becomes a 502, not a 401.** It means *our* bearer is wrong, a
  server misconfiguration; relaying it would make the SPA bounce the user
  through a login that cannot fix it. Upstream 5xx text is swallowed too — it can
  name internal hosts.
- **Attachments: `nosniff` always, inline only for known-safe types.** This
  origin holds the session cookie, so an inline `text/html` attachment would be
  stored XSS against the session that fetched it. Filenames are sanitized because
  ids come from the URL path and an unescaped quote is a header injection.
- **`_safe_next` exists because an unchecked `?next=` is a phishing primitive** —
  authenticate for real, land on a lookalike. Only single-slash relative paths
  pass; `//host` is protocol-relative and rejected.
- **`/healthz` must stay unauthenticated and must not probe the BYOI.** In google
  mode every `/api` call is a 401 until a browser signs in, so an authenticated
  probe would report unhealthy forever; probing the BYOI would make an
  unauthenticated endpoint a backend availability oracle.
- **dev mode refuses a non-loopback bind** unless
  `GEMDEX_WEB_UNSAFE_DEV_BIND=true`. It has no login at all, so a routable bind
  would publish unauthenticated delete. The opt-in exists because `0.0.0.0`
  inside a container is the namespace edge, not an exposure — compose publishes
  on 127.0.0.1.
- **The SPA fallback must not swallow `/api` or `/auth`.** Returning
  `index.html` for a typo'd endpoint makes a `fetch` fail at JSON parsing
  instead of on the status code. Traversal is blocked by re-resolving against the
  static root — without it, `/../.env` would serve the BYOI token.
- **The session cookie needs `SameSite=Lax`, not `Strict`.** `Strict` drops the
  cookie on the redirect back from Google, so login silently never completes.
- **The frontend is in the pnpm workspace via an explicit entry** in
  `pnpm-workspace.yaml` — `packages/*` does not match `packages/web/frontend`.
  Root `pnpm lint`/`typecheck` still do not cover it (the root eslint config is
  `**/*.ts` with Node globals); use `pnpm --filter gemdex-web build`, which runs
  `tsc --noEmit` first.
- **`pnpm build` writes into `src/gemdex_web/static/`**, which is gitignored and
  packaged into the wheel. The Dockerfile builds it in a Node stage; Node does
  not reach the runtime image.
- **This service is stateless** — no volume, `read_only: true`. The session is a
  signed cookie in the browser. Unlike mcp-http, there is no `FASTMCP_HOME`
  equivalent to keep writable.
- **`pytest` mocks the BYOI entirely** and never touches the network. The auth
  tests were mutation-checked: neutering the email comparison, the
  `email_verified` guard, or the `aud` check each makes them fail.
