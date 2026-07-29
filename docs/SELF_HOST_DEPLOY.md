# Self-host deploy — public HTTPS MCP endpoint

How to run Gemdex on a machine you own (Mac Mini, VPS) and expose **only** the
MCP endpoint to the internet over HTTPS, so agents on any machine can reach your
memory layer while the memory plane itself stays unreachable.

The end state: `https://gemdex.example.com/mcp` works from anywhere, and
Postgres and the BYOI bearer are not routable from the internet.

## The shape

```
   internet
      │  HTTPS + rate limiting
      ▼
   ┌─────────────────────────────┐
   │  edge (Cloudflare Tunnel    │  ← the ONLY public surface
   │        or Caddy)            │
   └─────────────────────────────┘
      │  127.0.0.1:8766  (plaintext, never leaves the host)
      ▼
   ┌─────────────────────────────┐
   │  gemdex-mcp-http   /mcp     │  OAuth 2.1 resource server, single user
   └─────────────────────────────┘
      │  http://gemdex-server:8765  (compose network only)
      ▼
   ┌─────────────────────────────┐
   │  gemdex-server     /v1      │  BYOI. Host publish is 127.0.0.1 only.
   └─────────────────────────────┘
      │  postgres:5432  (compose network only, NO host port)
      ▼
   ┌─────────────────────────────┐
   │  postgres + pgvector        │
   └─────────────────────────────┘
```

Two rules the stack enforces, and the reasoning:

1. **The BYOI bearer never becomes internet-reachable.** It is one long-lived
   secret with full read/write access to every memory and no per-user identity.
   So `gemdex-server` publishes on `127.0.0.1` only, and `gemdex-mcp-http`
   reaches it over the compose network instead.
2. **Only `/mcp` is public, and only through the edge.** `gemdex-mcp-http` also
   binds loopback; the edge terminates TLS and connects over `127.0.0.1`.
   Publishing `0.0.0.0:8766` would expose plaintext HTTP directly, bypassing the
   edge's TLS *and* its rate limiting.

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

Generate the two secrets and put them in `.env`:

```sh
openssl rand -hex 32   # → GEMDEX_SERVER_TOKEN
openssl rand -hex 32   # → POSTGRES_PASSWORD
```

Then set `GEMINI_API_KEY`, and `GEMDEX_MCP_BASE_URL` to the public URL you are
about to create (e.g. `https://gemdex.example.com`, no trailing slash).

`GEMDEX_MCP_BASE_URL` is the OAuth **issuer** and the **resource identity**, not
just a display string. It must match what clients use and what you register with
Google. Changing it later forces every client to re-authorize once.

## 2. Create the Google OAuth client

Set up the OAuth client and put the ID/secret plus `GEMDEX_ALLOWED_EMAIL` into
`.env`. Full click-path and the reason it can't be scripted:
[`packages/mcp-http/README.md`](../packages/mcp-http/README.md#setting-up-the-google-oauth-client).

The redirect URI must be exactly `<GEMDEX_MCP_BASE_URL>/auth/callback`. Google
matches it byte-for-byte; a trailing slash or an `http`/`https` mismatch shows up
as `redirect_uri_mismatch` at the end of the login flow.

`GEMDEX_ALLOWED_EMAIL` is the real authorization boundary. Google will
authenticate *every* Google account; that one address is what makes this
deployment yours.

## 3. Start the stack

```sh
cd deploy
docker compose up -d --build      # first run builds both images
docker compose ps                 # all three should reach "healthy"
```

Verify locally before exposing anything:

```sh
curl -fsS http://127.0.0.1:8765/v1/health   # {"ok":true}
curl -fsS http://127.0.0.1:8766/healthz     # ok
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
  # Only the MCP service. Everything else 404s at the edge, so the BYOI is
  # unreachable even if something later publishes it on the host by mistake.
  - hostname: gemdex.example.com
    service: http://127.0.0.1:8766
  - service: http_status:404
```

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

Keep the `/mcp` ceiling generous: a single agent session legitimately makes many
tool calls in a burst, and a limit tuned for humans will break real work.

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
				path /authorize /token /register
			}
			key    {remote_host}
			events 20
			window 1m
		}
	}

	# Streamable HTTP keeps long-lived responses open; the default write timeout
	# would sever them mid-stream.
	reverse_proxy 127.0.0.1:8766 {
		flush_interval -1
	}
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
```

On the host itself, confirm the bindings are loopback-scoped:

```sh
cd deploy

# Every published port must show 127.0.0.1, never 0.0.0.0.
docker compose ps --format '{{.Service}}\t{{.Ports}}'
docker port gemdex-deploy-gemdex-server-1     # 8765/tcp -> 127.0.0.1:8765
docker port gemdex-deploy-gemdex-mcp-http-1   # 8766/tcp -> 127.0.0.1:8766

# Postgres has no published ports at all — this prints nothing.
docker port gemdex-deploy-postgres-1

# And prove it from the host's own LAN address (substitute your interface).
LANIP=$(ipconfig getifaddr en0)                       # macOS
curl -m 4 -s -o /dev/null -w '%{http_code}\n' "http://$LANIP:8765/v1/health"   # → 000
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
| `mcp-http` restart-loops on a permission error | Its state volume is root-owned. The image pre-creates `/var/lib/gemdex` as uid 10001 to prevent this; a volume created by an older image predates that fix — `docker compose down -v` (destroys MCP state only) or `chown -R 10001:10001` inside it. |
| Stack didn't come back after reboot (macOS) | LaunchAgents run at login. Enable automatic login on a headless host. |
