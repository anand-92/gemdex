# deploy/ — reference self-host stack

The full **remote-agent** stack: BYOI memory API, the Streamable HTTP MCP
endpoint, and the browser manager UI — with only the MCP endpoint and the UI
exposed publicly over HTTPS.

**Start here: [`docs/SELF_HOST_DEPLOY.md`](../docs/SELF_HOST_DEPLOY.md)** — the
step-by-step guide (Google OAuth, Cloudflare Tunnel / Caddy, rate limiting, and
the checks that prove Postgres and the BYOI bearer aren't public).

```sh
cd deploy
cp .env.example .env && chmod 600 .env   # then fill it in
docker compose up -d --build
```

## Contents

| Path | Role |
|------|------|
| `docker-compose.yml` | The stack: `postgres`, `gemdex-server` (loopback-only), `gemdex-mcp-http` (the agent surface), `gemdex-web` (the human surface). |
| `.env.example` | Every variable, with what it's for and how to generate it. |
| `scripts/ensure-up.sh` | Idempotent bring-up: waits for Docker (starts colima if needed), `up -d`, waits for health. Used by both boot units. |
| `launchd/com.gemdex.deploy.plist` | macOS always-on (Mac Mini). Runs at **login** — see the caveat in the guide. |
| `systemd/gemdex-deploy.service` | Linux always-on (VPS). Runs at boot. |

## How this differs from `packages/server/docker-compose.yml`

That one is the **BYOI-only** stack — what `npm run init` sets up and what the
desktop app talks to on a single machine. It stays as-is.

This one adds the MCP surface and is meant to sit behind a public edge. Separate
project name (`gemdex-deploy` vs `gemdex`) so both can run on one host, which
also means **separate volumes**: standing this up next to an existing BYOI stack
gives you an empty pool until you migrate the data. See
[Migrating an existing BYOI stack](../docs/SELF_HOST_DEPLOY.md#migrating-an-existing-byoi-stack).

## Two public surfaces, two audiences

| Service | Who it serves | Auth | Delete? |
|---------|---------------|------|---------|
| `gemdex-mcp-http` (`/mcp`) | AI agents | OAuth 2.1 resource server — the client brings a token | **No** — six tools, by design |
| `gemdex-web` (`/`) | you, in a browser | Google login → signed session cookie | **Yes** — the only delete surface |

Both gate on the same single `GEMDEX_ALLOWED_EMAIL` and can share one Google
OAuth client; each needs its own redirect URI registered. They are separate
containers because they authenticate different *kinds* of caller: a browser
cannot present a bearer token, and an agent should not be able to delete.

`gemdex-web` holds the BYOI bearer server-side and never sends it to the page —
that is what a backend-for-frontend is for. It is stateless (the session lives
in the browser's cookie), so it runs read-only with no volume.

## The one invariant

**Postgres and the BYOI are never publicly reachable.** `postgres` has no host
port; `gemdex-server`, `gemdex-mcp-http`, and `gemdex-web` all publish on
`127.0.0.1` only, and the edge connects over loopback.

The BYOI bearer is a single long-lived secret with full access to every memory
and no per-user identity, so it must never be internet-routable. If you change a
`ports:` line here, re-run the verification steps in the guide — `0.0.0.0` in
`docker compose ps` means exposed to your whole network, and Docker writes
firewall rules directly, so it can bypass a UFW rule you thought covered you.
