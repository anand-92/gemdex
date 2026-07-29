# Security notes — self-hosted Gemdex

What a public Gemdex deployment actually enforces, where each control lives in
the code, and what it deliberately does **not** do. Read this before you point a
DNS record at your stack.

The threat model is narrow and worth stating plainly: **a single-user memory
store on the public internet.** The memory pool holds whatever you told your
agent to remember — plausibly API keys, deploy runbooks, and account details in
plaintext (see [Privacy & safety](../README.md#privacy--safety)). So the goal is
not defence in depth against a targeted adversary; it is that no unauthenticated
request, and no *authenticated request from the wrong Google account*, can ever
read or write memories.

## The one property to preserve

> Two surfaces are public — `/mcp` for agents and the web manager for you.
> **The BYOI `/v1` API and Postgres must never be routable.**

`/v1` is bearer-only by design and speaks the entire memory API, including
delete. It is meant to be reachable *only* over the private Compose network. The
public edge terminates at `/mcp` and the web manager; everything else stays
inside. [The deploy guide's step 6](SELF_HOST_DEPLOY.md#6-verify-the-memory-plane-is-not-public)
is a copy-pasteable proof of this — run it after every edge change, not just the
first time.

## Single-user enforcement

Google will happily authenticate *every* Google account. An OAuth provider alone
is therefore an open door, not a gate. Both public surfaces re-check the verified
identity against a one-email allowlist on **every request**, not just at login.

| Surface | Where | Mechanism |
|---------|-------|-----------|
| `/mcp` (agents) | `packages/mcp-http/src/gemdex_mcp_http/auth.py` — `SingleUserGoogleProvider.verify_token` | Overrides `verify_token`, the single choke point every authenticated request passes through. |
| Web manager (humans) | `packages/web/src/gemdex_web/auth.py` | The session's email is re-normalised and compared per request. |

`SingleUserGoogleProvider.verify_token` rejects a token when **any** of these
hold, returning `None` (FastMCP's "not authenticated" signal, surfaced as a 401
with the `WWW-Authenticate` discovery header the MCP spec wants):

- there is no email claim — identity cannot be enforced without one;
- `email_verified` is not exactly `true` — an unverified Google email is
  self-asserted and could be *anyone's* address, so trusting it would let an
  attacker simply claim your address;
- the email is not the allowlisted one (both sides lowercased and stripped).

Why override token verification rather than filter during the OAuth flow: the
token a client presents is a FastMCP-issued JWT that `OAuthProxy` swaps for the
stored upstream Google token on each call. Checking at the verification step
means **an already-issued token cannot outlive a change to the allowlist** —
edit `GEMDEX_ALLOWED_EMAIL`, restart, and every previously issued token stops
working. Had the check run only at authorization time, a token minted for the old
address would keep working until it expired.

## Server identity, and what is *not* validated

There is **no separate audience check** in `mcp-http`, and you should not expect
one. Identity of the resource server comes from a single configured origin:
`build_auth_provider()` passes `config.public_base_url` as *both* `base_url` and
`issuer_url`.

Those two must stay equal. FastMCP derives the advertised issuer from them, and
that value ends up in each client's stored authorization-server metadata —
**change it later and every client is forced to re-authorize.** Treat
`GEMDEX_MCP_BASE_URL` as permanent once agents are connected; it is the public
HTTPS origin, never an internal hostname or port.

The rest of the provider configuration:

| Setting | Value | Why |
|---------|-------|-----|
| `required_scopes` | `GOOGLE_SCOPES` | Tokens must carry the scopes needed to resolve an email at all. |
| `require_authorization_consent` | `"external"` | Google runs its own consent screen; a second FastMCP-rendered one adds a click without adding a decision. |

Two escape hatches exist and both are dangerous in public:

- `GEMDEX_MCP_AUTH=static` swaps Google for a `StaticTokenVerifier` holding one
  shared bearer. Fine on loopback or a trusted LAN — it is what the
  [one-line installer](../scripts/install.sh) configures — but it is a
  *password*, not an identity: no per-client revocation, no expiry, and anyone
  who reads it anywhere is you. Do not expose it publicly.
- `GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH=true` disables auth entirely. The config layer
  refuses to boot an authless server without it. Never set it on anything
  routable.

## HTTPS only

Non-negotiable for the public path, for reasons specific to this design:

- OAuth 2.1 requires it, and clients will refuse plaintext discovery.
- Every `/mcp` request carries a bearer token in a header. Over HTTP that token
  is readable by every hop, and it grants the full memory pool.
- The web manager's session cookie authenticates a surface that **has delete**.

Get TLS from the edge, not from the app: Cloudflare Tunnel (the origin needs no
open inbound port at all) or Caddy with automatic certificates. Both are in
[the deploy guide](SELF_HOST_DEPLOY.md#4a-public-edge--cloudflare-tunnel-preferred).
Publish only `/mcp` and the manager hostname.

## Rate limits

The OAuth endpoints are unauthenticated by necessity, so they are where
brute-force and abuse land. Concrete Cloudflare rules — including why `/mcp`
needs a *generous* ceiling (one agent session legitimately bursts many tool
calls, and a human-tuned limit breaks real work) while `/api/` can be much
lower — are in
[Rate limiting](SELF_HOST_DEPLOY.md#rate-limiting-cloudflare).

## Attachment paths are host-local

Over the HTTP MCP transport, attachments are **inline base64 only**. A local
file `path` is rejected explicitly by `_validate_attachments()` in
`packages/mcp-http/src/gemdex_mcp_http/tools.py`.

This differs from the stdio tools on purpose. The TS stdio server runs on *your*
machine, so reading a path off disk is exactly right — it resolves local
attachment paths into inline base64 before sending. Over HTTP that assumption
inverts: the path would resolve on the **host's** filesystem, either failing or
silently reading an unrelated file. A clear error beats a confusing success, so
`path` is refused rather than quietly host-resolved.

## What is not protected

Be honest with yourself about these:

- **No encryption at rest.** Memories, attachment bytes, and tokens are
  plaintext in your database and blob store. Use encrypted disks/volumes and
  provider access controls per your threat model.
- **No secret redaction.** Gemdex stores what you tell it to store.
- **Embedding leaves your infrastructure.** Memory text and media go to the
  Gemini API when an operation needs an embedding.
- **One user, no roles.** No accounts, tenants, ACLs, or audit log. The
  allowlist is the entire authorization model.
- **`report_outcome` stats are per-client**, not host-side.

Fuller custody discussion: [BYOI security model](BYOI_OPERATIONS.md#security-and-custody).

## Checklist before you go public

Run [step 6 of the deploy guide](SELF_HOST_DEPLOY.md#6-verify-the-memory-plane-is-not-public)
for the executable version. In summary:

- [ ] `/mcp` answers **401**, never 200, without a token.
- [ ] `/v1` is not routable from the internet at all.
- [ ] Postgres does not answer from anywhere but the Compose network.
- [ ] The manager's API returns 401/redirect without a session — a 200 means
      unauthenticated CRUD, **including delete**.
- [ ] Web login mode is not `dev`.
- [ ] Every published port binds `127.0.0.1`, never `0.0.0.0` — verified from
      the host's own LAN address, not just from the host itself.
- [ ] `GEMDEX_ALLOWED_EMAIL` is the account you intend, and a login with any
      other Google account is refused.
- [ ] `GEMDEX_MCP_AUTH=google` (not `static`) and no `UNSAFE_NO_AUTH` anywhere.
- [ ] Rate-limiting rules exist on the OAuth and login endpoints.
- [ ] TLS covers every published hostname.
- [ ] You have a restore-tested backup — see
      [Backups](SELF_HOST_DEPLOY.md#backups).
