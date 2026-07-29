# Go further — from localhost to a real deployment

You ran the [one-line installer](../scripts/install.sh) and have a working
loopback stack. This guide covers what comes after: a real domain with TLS,
Google login instead of a shared bearer, and — if you don't want to own a box —
running it on a managed platform.

Read [the deploy guide](SELF_HOST_DEPLOY.md) for the canonical end-to-end Compose
setup and [the security notes](SECURITY_SELFHOST.md) before exposing anything.

## Decide what actually needs to be public

Most people over-expose. Only two surfaces should ever be reachable:

| Surface | Audience | Public? |
|---------|----------|---------|
| `/mcp` (`gemdex-mcp-http`) | Remote agents | **Yes** — that's the point |
| Web manager (`gemdex-web`) | You, in a browser | Usually yes; loopback + SSH tunnel is a valid alternative |
| BYOI `/v1` (`gemdex-server`) | The two services above | **Never** |
| Postgres | `gemdex-server` | **Never** |

If your agents all run on machines you control and you're happy with an SSH
tunnel or Tailscale, you don't need a public edge at all — that's the cheapest
and safest option, and the installer's `--lan` mode plus a VPN covers it.

## What stays local vs what moves to the cloud

Even with a fully hosted stack, some work stays on your machines:

| Concern | Where it runs | Why |
|---------|---------------|-----|
| Memory storage, embedding, recall | Host | The whole point of BYOI |
| Agent tool calls | Your machine → host over `/mcp` | Agents are wherever you code |
| **Chat-history digestion (path A)** | **Each laptop** | `gemdex sync-history` reads that laptop's disk and uses its own Gemini key — the host never sees your filesystem. See [chat history](CHAT_HISTORY.md) |
| Chat-history digestion (path B) | Host | Browser upload; the host digests |
| `report_outcome` stats | Each client | The ledger is per-client (`~/.gemdex/stats.json`) in v1 |
| Desktop app | Your Mac | Local sidecar over `~/.gemdex`; **not** a manager for your remote pool |

That last row surprises people: the macOS app manages a *local* pool. For a
self-hosted deployment, the browser manager is the human surface.

## Step 1 — DNS + TLS

Pick **one** hostname per public surface, e.g. `memory.example.com` for `/mcp`
and `manage.example.com` for the web UI. You can also use one host and route by
path.

> **`GEMDEX_MCP_BASE_URL` is effectively permanent.** FastMCP advertises it as
> the OAuth issuer and clients cache it. Changing it later forces every agent to
> re-authorize. Choose the final public origin before you connect clients.

Two supported edges, both detailed in the deploy guide:

- **[Cloudflare Tunnel](SELF_HOST_DEPLOY.md#4a-public-edge--cloudflare-tunnel-preferred)**
  (preferred) — the origin opens **no inbound port**; the tunnel dials out. Best
  option behind NAT or a residential connection, and it brings WAF and rate
  limiting.
- **[Caddy + DNS](SELF_HOST_DEPLOY.md#4b-public-edge--caddy--dns-alternative)** —
  automatic certificates, for a VPS with a real public IP.

Then add [rate limits](SELF_HOST_DEPLOY.md#rate-limiting-cloudflare) on the
OAuth and login endpoints.

## Step 2 — Google OAuth for both public surfaces

Swap the installer's shared bearer (`GEMDEX_MCP_AUTH=static`) for real identity:

```dotenv
GEMDEX_MCP_AUTH=google
GEMDEX_MCP_BASE_URL=https://memory.example.com
GEMDEX_WEB_BASE_URL=https://manage.example.com
GEMDEX_ALLOWED_EMAIL=you@example.com
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GEMDEX_WEB_SESSION_SECRET=...
```

One Google client can serve both surfaces; register **both** redirect URIs.
Step-by-step: [create the Google OAuth client](SELF_HOST_DEPLOY.md#2-create-the-google-oauth-client).

`GEMDEX_ALLOWED_EMAIL` is the entire authorization model — it is re-checked on
every request on both surfaces, so changing it immediately invalidates existing
tokens. See [single-user enforcement](SECURITY_SELFHOST.md#single-user-enforcement).

## Step 3 — pick a home

### Option 1 — A VPS you own (recommended)

The reference [`deploy/`](../deploy/README.md) stack runs as-is: four services,
three volumes, one `docker compose up -d`. A 2 vCPU / 4 GB instance is
comfortable. You get real volumes, no platform quirks, and the documented upgrade
path. Pair it with Cloudflare Tunnel and you never open a port.

This is the only option where the Compose file *is* the deployment, so it stays
the best-supported one.

### Option 2 — Render

Workable, with real constraints you should know before you start.

**Postgres + pgvector.** Render Postgres supports `pgvector` on PostgreSQL 13+.
Enable it once via psql — note the extension name is `vector`, not `pgvector`:

```sql
CREATE EXTENSION vector;
```

**Services.** Deploy `gemdex-server` from `packages/server/Dockerfile` and
`gemdex-mcp-http` from `packages/mcp-http/Dockerfile` (plus
`packages/web/Dockerfile` for the manager). Render injects `DATABASE_URL`, which
`gemdex-server` reads natively. Bind to the platform's port and `0.0.0.0` via
`GEMDEX_SERVER_HOST` / `GEMDEX_SERVER_PORT` and the matching
`GEMDEX_MCP_HTTP_*` / `GEMDEX_WEB_*` vars.

Keep `gemdex-server` a **private service** so `/v1` is never public, and put only
`/mcp` and the manager on public web services.

**Attachment blobs — the real decision.** Render's filesystem is *ephemeral* by
default: without a persistent disk, blob bytes vanish on every deploy and
restart. Persistent disks come with constraints:

- Available on **paid** web services, private services, and background workers
  only.
- Only data under the mount path persists.
- A disk is reachable by exactly **one instance** — you cannot scale to multiple
  instances, and it is unavailable during build, pre-deploy commands, and
  one-off jobs.
- Attaching one **disables zero-downtime deploys** (old instance stops before the
  new one starts) — a deliberate safeguard against two versions writing the same
  disk.
- For a Docker service the mount path is relative to the Dockerfile's `WORKDIR`
  (commonly `/app`), e.g. `/app/storage`. `/`, `/opt`, `/opt/render*`, `/home`,
  `/etc`, and `/etc/secrets` cannot be exact mount points.
- Disks are encrypted at rest with automatic daily snapshots kept ≥7 days. Size
  can grow but never shrink.

**Because of all that, prefer S3-compatible blob storage on Render** — set
`BLOB_STORE=s3` with `S3_BUCKET` and credentials (R2, B2, or S3 all work) and
skip disks entirely. That also restores zero-downtime deploys.

### Option 3 — Railway

Also workable; the differences from Render are worth knowing.

**Postgres + pgvector.** Railway's default Postgres template is deliberately
**extension-free** — the docs state extensions are not being added to the default
templates. Use the marketplace **pgvector** template instead of the plain
Postgres one, or fork the `postgres-ssl` image and add the extension. These
templates are **unmanaged**: configuration and maintenance are yours.

Connect from another service by referencing its variables (`DATABASE_URL`,
`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`). External access goes
through the TCP Proxy (enabled by default, billed as network egress) — you should
not need it in normal operation.

**Attachment blobs.** Railway volumes are genuine persistent storage. Gotchas:

- Mount paths are absolute; for code writing to a relative `./data`, mount at
  `/app/data` (Railway puts app files in `/app`).
- Volumes mount at **container start** — not during build, not during
  pre-deploy. Anything written at build time is not persisted.
- Volumes mount as **root**. If the image runs as a non-root user, set
  `RAILWAY_RUN_UID=0`.
- `RAILWAY_VOLUME_NAME` and `RAILWAY_VOLUME_MOUNT_PATH` are injected
  automatically.
- Live resize (grow) is available on paid plans; a volume at 100% capacity
  triggers an offline resize with brief downtime.
- Services with volumes support manual and automated backups.

S3-compatible storage (`BLOB_STORE=s3`) remains a clean alternative here too.

### Platform caveats that apply to both

- **Scale to exactly one instance of `gemdex-server`.** It is a single-user
  design, and with a disk/volume the platform enforces one instance anyway.
- **Don't publish `/v1`.** Private service (Render) or internal-only networking
  (Railway).
- **Free tiers sleep.** A cold start makes the first agent tool call fail or hang;
  use a paid instance for anything you rely on.
- **Migrations run at server startup**, so a deploy is the migration.
- The pinned local Postgres image is `pgvector/pgvector:0.8.2-pg16-bookworm` —
  match major version 16 where you can.
- Verify pricing on the provider's own pricing page before committing; plan names
  and limits change and are not restated here.

## Cost and sizing

Rough shape for a single-user deployment — dominated by the always-on compute,
not by storage:

| Component | Sizing |
|-----------|--------|
| `gemdex-server` | 0.5–1 vCPU, 512 MB–1 GB RAM |
| `gemdex-mcp-http` + `gemdex-web` | Small; a few hundred MB each |
| Postgres | Smallest paid tier is plenty; single user, modest QPS |
| Blobs | Only as large as your attachments (transcripts are text and compress well) |
| Gemini embedding | Pay-per-use; the free tier covers light use |

Storage math: memory text plus chunks is small, but each embedding is 3072
dimensions by default (`gemini-embedding-2`). A few thousand memories is still
well under a gigabyte. Bulk chat-history ingestion is the one operation that
costs real money — use `--dry-run` for an estimate first and `--batch` for 50%
off ([chat history](CHAT_HISTORY.md#a--gemdex-sync-history-the-normal-path)).

A self-hosted stack is always-on compute: on a VPS that's one small instance; on
a PaaS it's one paid instance per public service plus a database.

## Security checklist before going public

The full list with the reasoning is
[here](SECURITY_SELFHOST.md#checklist-before-you-go-public), and the executable
version is [step 6 of the deploy guide](SELF_HOST_DEPLOY.md#6-verify-the-memory-plane-is-not-public).
The short version:

- [ ] HTTPS on every published hostname.
- [ ] `GEMDEX_MCP_AUTH=google`; no static bearer, no `UNSAFE_NO_AUTH`.
- [ ] `/mcp` returns 401 without a token; `/v1` and Postgres are unroutable.
- [ ] The manager's API refuses requests without a session; login mode is not
      `dev`.
- [ ] `GEMDEX_ALLOWED_EMAIL` set, and another Google account is actually refused.
- [ ] Rate limits on `/authorize`, `/token`, and the login routes.
- [ ] A restore-tested backup.
