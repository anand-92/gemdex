#!/usr/bin/env bash
#
# Bring the Gemdex deploy stack up and wait until it is actually serving.
#
# Written for boot-time supervision (macOS LaunchAgent / Linux systemd), where
# three things differ from an interactive `docker compose up -d`:
#
#   1. PATH is minimal — launchd gives you almost nothing, so docker/colima are
#      not found unless we add the usual install prefixes ourselves.
#   2. The Docker daemon may not be up yet. On macOS the VM (colima) can still be
#      booting, so we wait for it and start it if needed, rather than failing.
#   3. "Started" is not "ready". We exit non-zero unless /v1/health answers, so
#      the supervisor sees a real failure instead of a false success.
#
# Idempotent: safe to run on an already-healthy stack.
#
#   deploy/scripts/ensure-up.sh
#
set -euo pipefail

# Homebrew (Apple silicon + Intel) and standard prefixes. launchd does not
# source your shell profile.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"

log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

if [ ! -f "$DEPLOY_DIR/.env" ]; then
    log "FATAL: $DEPLOY_DIR/.env is missing. Copy .env.example and fill it in."
    exit 1
fi

# --- Wait for the Docker daemon ---------------------------------------------
# On a Mac Mini this script usually runs before the colima VM has finished
# booting. Try to start it, then poll; ~3 minutes is enough for a cold VM.
log "waiting for the Docker daemon…"
for _ in $(seq 1 90); do
    if docker info >/dev/null 2>&1; then
        break
    fi
    if command -v colima >/dev/null 2>&1; then
        colima status >/dev/null 2>&1 || colima start >/dev/null 2>&1 || true
    fi
    sleep 2
done

if ! docker info >/dev/null 2>&1; then
    log "FATAL: the Docker daemon did not become available."
    exit 1
fi

# Harmless on Linux/Docker Desktop where this context doesn't exist.
docker context use colima >/dev/null 2>&1 || true
log "docker is available"

# --- Bring the stack up ------------------------------------------------------
# No --build: boot is not the time to discover a broken build. Build
# deliberately when deploying (see docs/SELF_HOST_DEPLOY.md).
log "starting the compose stack…"
docker compose up -d

# --- Wait for health ---------------------------------------------------------
# Ports are read from .env so this follows a non-default configuration.
# Sourced in a subshell so .env secrets never leak into this script's env.
# shellcheck source=/dev/null
BYOI_PORT="$(. ./.env >/dev/null 2>&1; printf '%s' "${GEMDEX_SERVER_PORT:-8765}")"
# shellcheck source=/dev/null
MCP_PORT="$(. ./.env >/dev/null 2>&1; printf '%s' "${GEMDEX_MCP_HTTP_PORT:-8766}")"

wait_for() {
    local label="$1" url="$2"
    for _ in $(seq 1 60); do
        if curl -fsS -o /dev/null "$url"; then
            log "$label is healthy"
            return 0
        fi
        sleep 2
    done
    log "FATAL: $label did not become healthy ($url)"
    log "  inspect with: cd $DEPLOY_DIR && docker compose logs"
    return 1
}

wait_for "gemdex-server" "http://127.0.0.1:${BYOI_PORT}/v1/health"
wait_for "gemdex-mcp-http" "http://127.0.0.1:${MCP_PORT}/healthz"

log "stack is up"
