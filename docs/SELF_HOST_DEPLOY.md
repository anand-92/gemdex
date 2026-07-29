# Self-host deploy — public HTTPS MCP endpoint

How to run Gemdex on a machine you own (Mac Mini, VPS) and expose **only** the
MCP endpoint and the manager UI to the internet over HTTPS, so agents on any
machine can reach your memory layer — and you can manage it from a browser —
while the memory plane itself stays unreachable.

The end state: `https://gemdex.example.com/mcp` serves agents,
`https://gemdex.example.com/` serves you, and Postgres and the BYOI bearer are
not routable from the internet.

## The shape

```
   internet
      │  HTTPS + rate limiting
      ▼
   ┌─────────────────────────────────────────────┐
   │  edge (Cloudflare Tunnel or Caddy)          │  ← the ONLY public surface
   │  routes by path:  /mcp → MCP    / → web     │
   └─────────────────────────────────────────────┘
      │  127.0.0.1:8766            │  127.0.0.1:8767
      │  (plaintext, never leaves the host)
      ▼                            ▼
   ┌──────────────────────────┐  ┌──────────────────────────┐
   │  gemdex-mcp-http  /mcp   │  │  gemdex-web         /    │
   │  OAuth 2.1 resource      │  │  Google login → session  │
   │  server. Agents.         │  │  cookie. You, a human.   │
   │  Six tools, NO delete.   │  │  Full CRUD incl. delete. │
   └──────────────────────────┘  └──────────────────────────┘
      │                            │
      │  http://gemdex-server:8765 (compose network only)
      ▼                            ▼
   ┌─────────────────────────────────────────────┐
   │  gemdex-server     /v1                      │  BYOI. 127.0.0.1 only.
   └─────────────────────────────────────────────┘
      │  postgres:5432  (compose network only, NO host port)
      ▼
   ┌─────────────────────────────────────────────┐
   │  postgres + pgvector                        │
   └─────────────────────────────────────────────┘
```

Two rules the stack enforces, and the reasoning:

1. **The BYOI bearer never becomes internet-reachable.** It is one long-lived
   secret with full read/write access to every memory and no per-user identity.
   So `gemdex-server` publishes on `127.0.0.1` only, and the two front-ends
   reach it over the compose network instead. `gemdex-web` does hold that bearer
   — server-side, never sent to the browser. That is what makes it a
   backend-for-frontend rather than a CORS hole.
2. **Only the edge is public.** Both front-ends bind loopback; the edge
   terminates TLS and connects over `127.0.0.1`. Publishing `0.0.0.0:8766` or
   `0.0.0.0:8767` would expose plaintext HTTP directly, bypassing the edge's TLS
   *and* its rate limiting.

**Why two containers rather than one.** They authenticate different kinds of
caller. A browser cannot present a bearer token, so the UI needs a server-side
session; and deletion is deliberately absent from the agent surface (root
`AGENTS.md`: "six tools, no delete"), so folding the UI into MCP would mean
either giving agents delete or leaving the UI unable to delete.

## Why `deploy/` and not `packages/server/docker-compose.yml`

The existing `packages/server/docker-compose.yml` stays as-is: it is the
**BYOI-only** stack, the thing `npm run init` sets up, and it is what the
desktop app talks to on a single machine. `deploy/` is the **full remote-agent
stack** — it adds the MCP surface and the public edge, and is a deployment
concern spanning two packages rather than a property of either.

They use different compose project names (`gemdex` vs `gemdex-deploy`), so both
can exist on one host without colliding. That also means **different volumes**:
migrating from a BYOI-only deployment is a data move, not a config switch — see
[Migrating an existing BYOI stack](#migrating-an-existing-byoi-stack).

## Prerequisites

- Docker Engine + Compose v2. On macOS, [colima](https://github.com/abiosoft/colima)
  (`brew install colima docker docker-compose && colima start`).
- A domain you control.
- A Google account for OAuth — the deploy is single-user.
- `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey).
  The **server** owns embedding, so clients need no key.

## 1. Configure

```sh
git clone https://github.com/nikships/gemdex.git
cd gemdex/deploy
cp .env.example .env
chmod 600 .env
```

Generate the three secrets and put them in `.env`:

```sh
openssl rand -hex 32   # → GEMDEX_SERVER_TOKEN
openssl rand -hex 32   # → POSTGRES_PASSWORD
openssl rand -hex 32   # → GEMDEX_WEB_SESSION_SECRET
```

`GEMDEX_WEB_SESSION_SECRET` signs the browser session cookie. Anyone who can
guess it can forge a signed session and bypass the email allowlist entirely, so
it is a real secret, not a salt — the service refuses to start on anything
shorter than 32 characters.

Then set `GEMINI_API_KEY`, and both public URLs to what you are about to create
(no trailing slash):

```
GEMDEX_MCP_BASE_URL=https://gemdex.example.com      # the /mcp endpoint
GEMDEX_WEB_BASE_URL=https://gemdex.example.com      # the UI (same host, path-routed)
```

They may be the same host (the edge routes `/mcp` → MCP, `/` → web) or separate
subdomains — whichever you configure at the edge in step 4.

`GEMDEX_MCP_BASE_URL` is the OAuth **issuer** and the **resource identity**, not
just a display string. It must match what clients use and what you register with
Google. Changing it later forces every client to re-authorize once.

## 2. Create the Google OAuth client

Set up the OAuth client and put the ID/secret plus `GEMDEX_ALLOWED_EMAIL` into
`.env`. Full click-path and the reason it can't be scripted:
[`packages/mcp-http/README.md`](../packages/mcp-http/README.md#setting-up-the-google-oauth-client).

**One OAuth client serves both services** — a client may hold several authorized
redirect URIs. Register *both*, exactly:

```
<GEMDEX_MCP_BASE_URL>/auth/callback           ← the MCP endpoint
<GEMDEX_WEB_BASE_URL>/auth/google/callback    ← the manager UI
```

Google matches these byte-for-byte; a trailing slash or an `http`/`https`
mismatch shows up as `redirect_uri_mismatch` at the end of the login flow. Both
services print the exact string they expect at startup, so
`docker compose logs gemdex-web | grep 'redirect URI'` is the fastest way to
check what to paste.

`GEMDEX_ALLOWED_EMAIL` is the real authorization boundary, shared by both
surfaces. Google will authenticate *every* Google account; that one address is
what makes this deployment yours.

## 3. Start the stack

```sh
cd deploy
docker compose up -d --build      # first run builds all three images
docker compose ps                 # all four should reach "healthy"
```

Verify locally before exposing anything:

```sh
curl -fsS http://127.0.0.1:8765/v1/health   # {"ok":true}
curl -fsS http://127.0.0.1:8766/healthz     # ok   (MCP)
curl -fsS http://127.0.0.1:8767/healthz     # ok   (web)
```

The UI answering **401** on its API without a session is correct — it fails
closed:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8767/api/memories   # 401
```

`/mcp` answering **401** is correct — it means the OAuth resource server is
running and refusing unauthenticated calls:

```sh
curl -s -i -X POST http://127.0.0.1:8766/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -5
# HTTP/1.1 401 Unauthorized
# www-authenticate: Bearer ... resource_metadata="https://…/.well-known/oauth-protected-resource/mcp"
```

That `resource_metadata` pointer is how a compliant MCP client bootstraps the
login flow from the URL alone.

## 4a. Public edge — Cloudflare Tunnel (preferred)

Preferred because it needs **no port forwarding, no static IP, and no inbound
firewall rule** — the tunnel dials out. That suits a home Mac Mini behind NAT,
and it means there is no open port to find. TLS terminates at Cloudflare's edge.

```sh
brew install cloudflared            # macOS
# Linux: see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

cloudflared tunnel login
cloudflared tunnel create gemdex
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: gemdex
credentials-file: /Users/CHANGEME/.cloudflared/<TUNNEL-UUID>.json

ingress:
  # Path-routed: /mcp to the agent surface, everything else to the UI. Anything
  # not matched 404s at the edge, so the BYOI stays unreachable even if
  # something later publishes it on the host by mistake.
  #
  # cloudflared matches ingress rules in order and `path` is a regex, so the
  # /mcp rule must come first — otherwise the catch-all hostname rule below
  # would swallow it.
  - hostname: gemdex.example.com
    path: ^/mcp
    service: http://127.0.0.1:8766
  - hostname: gemdex.example.com
    service: http://127.0.0.1:8767
  - service: http_status:404
```

The MCP endpoint also serves OAuth discovery at
`/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`,
plus `/authorize`, `/token`, `/register`, and `/auth/callback`. With the rules
above those land on the **web** service, which does not serve them — so if you
path-route, add them to the MCP rule:

```yaml
  - hostname: gemdex.example.com
    path: ^/(mcp|authorize|token|register|auth/callback|\.well-known/oauth)
    service: http://127.0.0.1:8766
```

**Simpler and less error-prone: give each service its own hostname.** Then no
path regex has to be exactly right, and the two OAuth callback paths cannot
collide:

```yaml
ingress:
  - hostname: gemdex.example.com          # agents  → GEMDEX_MCP_BASE_URL
    service: http://127.0.0.1:8766
  - hostname: app.gemdex.example.com      # browser → GEMDEX_WEB_BASE_URL
    service: http://127.0.0.1:8767
  - service: http_status:404
```

Set `GEMDEX_MCP_BASE_URL` and `GEMDEX_WEB_BASE_URL` to match whichever you pick,
and register the matching redirect URIs with Google. Remember to
`cloudflared tunnel route dns` each hostname.

Whichever you choose, check the routing before trusting it — `cloudflared` tests
a URL against every rule and prints the one that wins:

```sh
cloudflared tunnel ingress validate
cloudflared tunnel ingress rule https://gemdex.example.com/mcp
cloudflared tunnel ingress rule https://gemdex.example.com/auth/google/callback
```

The path-routed config above was checked this way. The case worth confirming
yourself is the near-miss pair, since both services own an `/auth/*` route:

| URL | Goes to |
|-----|---------|
| `/mcp` | `:8766` MCP |
| `/.well-known/oauth-authorization-server` | `:8766` MCP |
| `/auth/callback` | `:8766` MCP |
| `/auth/google/callback` | `:8767` web |
| `/api/memories`, `/` | `:8767` web |

Route DNS and run it:

```sh
cloudflared tunnel route dns gemdex gemdex.example.com
cloudflared tunnel run gemdex                      # foreground test
sudo cloudflared service install                   # then install as a service
```

### Rate limiting (Cloudflare)

The OAuth endpoints are the ones worth protecting: `/authorize` and `/token` are
unauthenticated by necessity, so they are where brute-force and abuse land.

In the dashboard: **Security → WAF → Rate limiting rules**.

| Rule | Match | Limit | Action |
|------|-------|-------|--------|
| MCP calls | `http.request.uri.path eq "/mcp"` | 600 / 1 min per IP | Block 1 min |
| OAuth flow | `http.request.uri.path in {"/authorize" "/token" "/register"}` | 20 / 1 min per IP | Block 5 min |
| Web login | `http.request.uri.path in {"/auth/login" "/auth/google/callback"}` | 20 / 1 min per IP | Block 5 min |
| Web API | `starts_with(http.request.uri.path, "/api/")` | 300 / 1 min per IP | Block 1 min |

Keep the `/mcp` ceiling generous: a single agent session legitimately makes many
tool calls in a burst, and a limit tuned for humans will break real work. The
`/api/` ceiling can be far lower — it is one human clicking, and the UI debounces
its search — but not *too* low: the memory list plus a status poll can fire
several requests per page view.

Worth adding, since this deployment has exactly one user:

- **Geo / ASN rules** restricting `/authorize` to the countries you use.
- **Cloudflare Access** in front of the hostname for a second, independent
  identity check before requests ever reach the origin.

## 4b. Public edge — Caddy + DNS (alternative)

Use this if you'd rather not depend on Cloudflare, or you already run a reverse
proxy. It needs a **public IP with ports 80/443 reachable** (port-forward on home
NAT) — the tradeoff versus the tunnel. Caddy gets automatic Let's Encrypt certs.

`Caddyfile`:

```caddyfile
gemdex.example.com {
	encode gzip

	# Requires the rate_limit module:
	#   xcaddy build --with github.com/mholt/caddy-ratelimit
	rate_limit {
		zone mcp {
			match {
				path /mcp
			}
			key    {remote_host}
			events 600
			window 1m
		}
		zone oauth {
			match {
				path /authorize /token /register /auth/*
			}
			key    {remote_host}
			events 20
			window 1m
		}
	}

	# Order matters: Caddy evaluates handle blocks by specificity, but making the
	# split explicit keeps it obvious which origin serves what.
	#
	# The MCP endpoint owns OAuth discovery and the token endpoints as well as
	# /mcp itself — route them together or client bootstrap breaks.
	handle /mcp* {
		# Streamable HTTP keeps long-lived responses open; the default write
		# timeout would sever them mid-stream.
		reverse_proxy 127.0.0.1:8766 {
			flush_interval -1
		}
	}
	handle /.well-known/oauth-* {
		reverse_proxy 127.0.0.1:8766
	}
	handle /authorize* {
		reverse_proxy 127.0.0.1:8766
	}
	handle /token* {
		reverse_proxy 127.0.0.1:8766
	}
	handle /register* {
		reverse_proxy 127.0.0.1:8766
	}
	handle /auth/callback* {
		reverse_proxy 127.0.0.1:8766
	}

	# Everything else is the manager UI, including /auth/google/callback.
	handle {
		reverse_proxy 127.0.0.1:8767
	}
}
```

The path split above is fiddly precisely because both services own an `/auth/*`
route. **Two hostnames avoid the whole problem** and are the better default:

```caddyfile
gemdex.example.com {          # agents  → GEMDEX_MCP_BASE_URL
	encode gzip
	reverse_proxy 127.0.0.1:8766 {
		flush_interval -1
	}
}

app.gemdex.example.com {      # browser → GEMDEX_WEB_BASE_URL
	encode gzip
	reverse_proxy 127.0.0.1:8767
}
```

```sh
caddy validate --config Caddyfile
sudo caddy start --config Caddyfile
```

HTTPS is non-negotiable either way: OAuth bearer tokens cross this hop, and
Google refuses to register a non-loopback `http://` redirect URI.

## 5. Connect a client

Point any OAuth-capable MCP client at `https://gemdex.example.com/mcp`. It
discovers the authorization server, opens a browser, you sign in with the
allowlisted Google account, and it stores the token itself. No bearer to paste.

```jsonc
// Claude Code: .mcp.json
{
  "mcpServers": {
    "gemdex": { "type": "http", "url": "https://gemdex.example.com/mcp" }
  }
}
```

### Sync chat history from each machine

Agents read and write memories through `/mcp`. To also feed this deployment your
**coding-agent chat history**, run `sync-history` on each machine you code on:

```sh
export GEMDEX_SYNC_URL=https://gemdex.example.com/mcp
npx gemdex sync-history --source claude --dry-run   # scan + cost estimate
npx gemdex sync-history --source claude
```

It authorizes in the browser once (same allowlisted Google account), then posts
each digest to `POST /mcp/sync/records` — under `/mcp`, so the edge rules you
already wrote cover it, and it is authenticated by the same allowlist as the
tools. Digests are generated on the client with that machine's `GEMINI_API_KEY`;
session ids are deterministic, so running it repeatedly (or from five machines)
upserts rather than duplicates.

### Or upload sessions from the browser

The web manager's **Upload sessions** page is the other half of the same
feature, for the cases the CLI cannot cover: a machine where you will not install
the CLI, a transcript someone exported and sent you, or a laptop with no Gemini
key of its own.

Drop `.jsonl` transcripts (or a `.zip` of them) and **this deployment** does the
cleaning and digesting, using the `GEMINI_API_KEY` you already set for
`gemdex-server`. Nothing else to configure — and note that no key is added to
`gemdex-web`: it forwards the transcripts to `gemdex-server`, which is the only
container that has the ingest pipeline, the key, and the database together.

Both routes converge on the same `chat:<source>:<sessionId>` memory, so a session
you upload after having synced it is **updated, not duplicated** — mixing the two
paths is safe. If uploads answer `503`, `GEMINI_API_KEY` is missing from
`gemdex-server`'s environment (recall and browsing keep working; only digesting
needs it).

## 6. Verify the memory plane is NOT public

Do this from a **different machine**, not the host. These are the checks that
substantiate the security claim; run them after any change to the compose file.

```sh
PUBLIC=gemdex.example.com

# 1. The MCP endpoint is reachable and fails closed (401, never 200).
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://$PUBLIC/mcp" \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# → 401

# 2. The BYOI /v1 API must NOT be routable. Anything but a failure or 404 is a
#    finding: /v1 accepts the bearer and speaks the full memory API.
curl -s -o /dev/null -w '%{http_code}\n' "https://$PUBLIC/v1/health"     # → 404 (edge) or failure
curl -s -o /dev/null -w '%{http_code}\n' "http://$PUBLIC:8765/v1/health" # → failure

# 3. Postgres must not answer at all.
nc -zv "$PUBLIC" 5432    # → refused / timeout

# 4. The manager UI is reachable but fails closed — its API must never serve
#    data without a session. A 200 here would mean unauthenticated CRUD,
#    including delete.
curl -s -o /dev/null -w '%{http_code}\n' "https://$PUBLIC/api/memories"   # → 401
curl -s -o /dev/null -w '%{http_code}\n' "https://$PUBLIC/api/status"     # → 401

#    And confirm login mode is not `dev`. This must NOT say "dev":
curl -s "https://$PUBLIC/api/session"     # → {"authenticated":false,...,"authMode":"google"}
```

If `authMode` reports `dev`, stop: the deployment has **no login at all** and
anyone who can reach the URL can delete every memory.

On the host itself, confirm the bindings are loopback-scoped:

```sh
cd deploy

# Every published port must show 127.0.0.1, never 0.0.0.0.
docker compose ps --format '{{.Service}}\t{{.Ports}}'
docker port gemdex-deploy-gemdex-server-1     # 8765/tcp -> 127.0.0.1:8765
docker port gemdex-deploy-gemdex-mcp-http-1   # 8766/tcp -> 127.0.0.1:8766
docker port gemdex-deploy-gemdex-web-1        # 8767/tcp -> 127.0.0.1:8767

# Postgres has no published ports at all — this prints nothing.
docker port gemdex-deploy-postgres-1

# And prove it from the host's own LAN address (substitute your interface).
LANIP=$(ipconfig getifaddr en0)                       # macOS
curl -m 4 -s -o /dev/null -w '%{http_code}\n' "http://$LANIP:8765/v1/health"   # → 000
curl -m 4 -s -o /dev/null -w '%{http_code}\n' "http://$LANIP:8766/healthz"     # → 000
curl -m 4 -s -o /dev/null -w '%{http_code}\n' "http://$LANIP:8767/healthz"     # → 000
nc -z -G 3 "$LANIP" 5432 && echo OPEN-BAD || echo closed-good
```

`0.0.0.0` in `docker compose ps` means the port is exposed to your whole
network. Note that Docker publishes by writing firewall rules directly, so on
Linux a `0.0.0.0` publish can bypass a UFW rule you assumed was protecting you —
which is why the bind address, not the firewall, is the control here.

## 7. Always-on

Boot-time supervision, so the stack returns after a reboot or power cut:

- **macOS:** [`deploy/launchd/com.gemdex.deploy.plist`](../deploy/launchd/com.gemdex.deploy.plist)
- **Linux:** [`deploy/systemd/gemdex-deploy.service`](../deploy/systemd/gemdex-deploy.service)

Both run [`deploy/scripts/ensure-up.sh`](../deploy/scripts/ensure-up.sh), which
waits for the Docker daemon (starting colima if needed), brings the stack up, and
exits non-zero unless both health endpoints answer — so the supervisor sees a
real failure rather than a false success. Install instructions are in the header
comments of each file; both need absolute paths edited in.

**macOS caveat:** colima's VM runs as your user, so this must be a LaunchAgent,
not a root LaunchDaemon — meaning the stack starts at **login**, not at boot. On
a headless Mini, enable automatic login or it will not come back on its own.

## Operating it

```sh
cd deploy

docker compose logs -f gemdex-mcp-http    # MCP + auth decisions
docker compose logs -f gemdex-server      # memory API
docker compose ps                         # health

docker compose up -d --build              # deploy a new version
docker compose restart gemdex-mcp-http    # apply an .env auth change
```

Rejected logins are logged by `gemdex-mcp-http` with the email that was refused —
the first place to look when a client cannot authenticate.

### Backups

Back up **Postgres and the blob store together**. Rows reference opaque blob
keys, so restoring one without the other corrupts attachment reads.

```sh
docker compose exec -T postgres pg_dump -U gemdex gemdex | gzip > gemdex-$(date +%F).sql.gz
docker run --rm -v gemdex-deploy_gemdex-blobs:/blobs -v "$PWD":/out alpine \
  tar czf /out/gemdex-blobs-$(date +%F).tar.gz -C /blobs .
```

## Migrating an existing BYOI stack

`deploy/` uses its own volumes, so bringing it up next to a `packages/server`
stack gives you an **empty** memory pool — the old data is still in the old
volumes, untouched. To move it, dump from the old stack and restore into the new
one (`pg_dump` + the blob tarball above), or point `deploy/` at the existing
volumes by adding `external: true` under `volumes:`.

Whichever you choose, **stop the old stack first**. Two servers writing one
Postgres volume is not something either of them expects.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| `redirect_uri_mismatch` after Google login | The registered URI isn't exactly `<GEMDEX_MCP_BASE_URL>/auth/callback` — check scheme, trailing slash, port. |
| Client loops through login forever | `GEMDEX_MCP_BASE_URL` doesn't match the URL the client uses, so the issuer it discovers isn't the one it returns to. |
| `403` / access denied after a successful Google sign-in | You signed in with an account other than `GEMDEX_ALLOWED_EMAIL`. Check `docker compose logs gemdex-mcp-http`. |
| `/mcp` returns 401 with a valid-looking token | Expected if the token expired or the allowlist changed — it is re-checked on every request, not just at login. |
| `503` from a tool call, health still green | No database configured, or Postgres is unhealthy. Green `/v1/health` does not mean storage works. |
| Saves fail, health green | `GEMINI_API_KEY` missing or invalid — the server owns embedding and only fails at request time. |
| Session upload returns `503` | Same cause: `gemdex-server` has no `GEMINI_API_KEY`, so it cannot digest. Digesting happens there, not in `gemdex-web`. |
| Session upload says a file was "skipped" | Not an error. Either the file is not an agent transcript (`unparseable`) or the session is too short to be worth a digest (`trivial`). No Gemini call was made. |
| Uploaded a session that was already synced | Expected to be a no-op-ish update: both paths derive the same `chat:<source>:<sessionId>` id, so it upserts. |
| `mcp-http` restart-loops on a permission error | Its state volume is root-owned. The image pre-creates `/var/lib/gemdex` as uid 10001 to prevent this; a volume created by an older image predates that fix — `docker compose down -v` (destroys MCP state only) or `chown -R 10001:10001` inside it. |
| Stack didn't come back after reboot (macOS) | LaunchAgents run at login. Enable automatic login on a headless host. |
