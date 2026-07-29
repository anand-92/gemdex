# deploy/ — reference self-host stack

The full **remote-agent** stack: BYOI memory API + the Streamable HTTP MCP
endpoint, with only `/mcp` exposed publicly over HTTPS.

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
| `docker-compose.yml` | The stack: `postgres`, `gemdex-server` (loopback-only), `gemdex-mcp-http`, and a commented `gemdex-web` placeholder (GEM2-5). |
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

## The one invariant

**Only `gemdex-mcp-http` is ever publicly reachable.** `postgres` has no host
port; `gemdex-server` and `gemdex-mcp-http` publish on `127.0.0.1` only, and the
edge connects over loopback.

The BYOI bearer is a single long-lived secret with full access to every memory
and no per-user identity, so it must never be internet-routable. If you change a
`ports:` line here, re-run the verification steps in the guide — `0.0.0.0` in
`docker compose ps` means exposed to your whole network, and Docker writes
firewall rules directly, so it can bypass a UFW rule you thought covered you.
