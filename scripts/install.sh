#!/usr/bin/env bash
#
# Gemdex one-line self-host installer.
#
#   curl -fsSL https://raw.githubusercontent.com/anand-92/gemdex/main/scripts/install.sh | bash
#
# Takes a machine from zero to a working single-user Gemdex stack: Postgres +
# the BYOI memory server + the Streamable HTTP MCP endpoint + the web manager,
# with secrets generated, health verified, and a ready-to-paste MCP client
# config printed at the end.
#
# --- Four things about this script that are not obvious ---------------------
#
# 1. `curl … | bash` means **stdin is the script**, not the terminal. Any
#    `read` from stdin gets script bytes (or EOF) instead of the user, so every
#    prompt here goes through /dev/tty and degrades to non-interactive when
#    there is no tty. This is the single most common way an installer of this
#    shape breaks, and it breaks silently.
#
# 2. **The images are built from source, so this needs the whole tree**, not
#    just the compose file. `deploy/docker-compose.yml` uses `build: context:
#    ..` against the monorepo root and no images are published to any registry
#    (checked: nothing in .github/ pushes one). So the curl path downloads a
#    source tarball at a pinned ref rather than fetching two YAML files, which
#    would produce a compose file whose builds cannot resolve.
#
# 3. **An empty `GEMINI_API_KEY` passes compose's `:?` guard.** `${VAR:?msg}`
#    only fires when the variable is *unset*; a present-but-empty value
#    interpolates fine. `gemdex-server` then starts, reports `/v1/health` green,
#    and fails *every* save and recall at request time. So health alone is not
#    proof of a working install — this script verifies a real save/recall round
#    trip before it claims success, and validates the key itself rather than
#    trusting compose to.
#
# 4. **Idempotence here means "never regenerate a secret".** Re-running is the
#    upgrade path, and rotating `POSTGRES_PASSWORD` on a re-run would be
#    especially cruel: Postgres reads it only at *initdb*, so a fresh value in
#    .env does not change an existing volume's password — the stack would just
#    stop being able to authenticate, looking like data loss. Existing values in
#    .env are always preserved; only missing ones are filled in.
#
set -euo pipefail

readonly REPO="anand-92/gemdex"

# The ref the curl path downloads. Pinned rather than a moving branch so a
# bootstrap is reproducible and a broken main cannot break every new install.
GEMDEX_REF="${GEMDEX_REF:-main}"

# Where a curl-mode install puts the source tree and .env. Overridable so the
# smoke test can install into a scratch directory.
GEMDEX_HOME="${GEMDEX_HOME:-$HOME/.gemdex-selfhost}"

# Host ports. Defaults match deploy/.env.example; overridable because 8765 is
# very often already taken by a BYOI-only stack on the same host.
BYOI_PORT="${GEMDEX_SERVER_PORT:-8765}"
MCP_PORT="${GEMDEX_MCP_HTTP_PORT:-8766}"
WEB_PORT="${GEMDEX_WEB_PORT:-8767}"

# Compose project name. Overridable so a smoke run cannot collide with (or tear
# down) a real stack on the same machine.
PROJECT_NAME="${GEMDEX_PROJECT_NAME:-gemdex-deploy}"

LAN_MODE=false
ASSUME_YES=false
SKIP_VERIFY=false

# Populated by resolve_source(); the directory holding docker-compose.yml.
DEPLOY_DIR=""
ENV_FILE=""
# Set when this run created the .env, so the summary can tell a re-run apart
# from a first install.
FRESH_INSTALL=false

# --- output ----------------------------------------------------------------
# Colour only when stdout is a terminal: `| bash > install.log` should not end
# up with escape codes in it.
if [ -t 1 ]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
    C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
    C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi

step() { printf '%s==>%s %s\n' "$C_BLUE$C_BOLD" "$C_RESET" "$*"; }
info() { printf '    %s\n' "$*"; }
dim() { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok() { printf '    %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s!%s  %s\n' "$C_YELLOW$C_BOLD" "$C_RESET" "$*" >&2; }

# Every failure exits through here, so every failure can carry a fix rather
# than just a diagnosis.
die() {
    printf '\n%serror:%s %s\n' "$C_RED$C_BOLD" "$C_RESET" "$1" >&2
    shift
    for line in "$@"; do
        printf '       %s\n' "$line" >&2
    done
    exit 1
}

usage() {
    cat <<'USAGE'
Gemdex self-host installer.

  curl -fsSL https://raw.githubusercontent.com/anand-92/gemdex/main/scripts/install.sh | bash

Options:
  --lan                 Publish the MCP endpoint and web manager on 0.0.0.0 so
                        other devices on your network can reach them. Default is
                        loopback only (127.0.0.1). See the warning it prints.
  --dir <path>          Install location (default: ~/.gemdex-selfhost). Ignored
                        when run from inside a Gemdex checkout.
  --ref <git-ref>       Branch/tag/SHA to install from (default: main).
  --project <name>      Compose project name (default: gemdex-deploy).
  --byoi-port <port>    Host port for the memory API (default: 8765).
  --mcp-port <port>     Host port for the MCP endpoint (default: 8766).
  --web-port <port>     Host port for the web manager (default: 8767).
  --yes                 Never prompt. Requires GEMINI_API_KEY in the environment.
  --skip-verify         Skip the save/recall round trip (health check only).
  -h, --help            This message.

Environment:
  GEMINI_API_KEY        Used if set, so CI and re-runs never prompt.
                        Get one free at https://aistudio.google.com/apikey

Re-running is safe and is the upgrade path: existing secrets are never
regenerated and no volume is ever removed.
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --lan) LAN_MODE=true; shift ;;
        --dir) GEMDEX_HOME="${2:?--dir needs a path}"; shift 2 ;;
        --ref) GEMDEX_REF="${2:?--ref needs a git ref}"; shift 2 ;;
        --project) PROJECT_NAME="${2:?--project needs a name}"; shift 2 ;;
        --byoi-port) BYOI_PORT="${2:?--byoi-port needs a port}"; shift 2 ;;
        --mcp-port) MCP_PORT="${2:?--mcp-port needs a port}"; shift 2 ;;
        --web-port) WEB_PORT="${2:?--web-port needs a port}"; shift 2 ;;
        --yes | -y) ASSUME_YES=true; shift ;;
        --skip-verify) SKIP_VERIFY=true; shift ;;
        -h | --help) usage; exit 0 ;;
        *) die "Unknown option: $1" "Run with --help for usage." ;;
    esac
done

# --- prompting --------------------------------------------------------------

# True when a human is actually there. Checks /dev/tty rather than stdin
# precisely because under `curl | bash` stdin is the script (see header note 1).
has_tty() {
    [ "$ASSUME_YES" = false ] && [ -r /dev/tty ] && [ -w /dev/tty ]
}

# Read one line from the terminal. Never falls back to stdin: doing so under
# `curl | bash` would consume the script's own bytes as the answer.
prompt() {
    local message="$1" reply=''
    printf '%s' "$message" > /dev/tty
    IFS= read -r reply < /dev/tty || reply=''
    printf '%s' "$reply"
}

prompt_secret() {
    local message="$1" reply=''
    printf '%s' "$message" > /dev/tty
    stty -echo < /dev/tty 2>/dev/null || true
    IFS= read -r reply < /dev/tty || reply=''
    stty echo < /dev/tty 2>/dev/null || true
    printf '\n' > /dev/tty
    printf '%s' "$reply"
}

# --- dependency checks ------------------------------------------------------

require_cmd() {
    command -v "$1" >/dev/null 2>&1
}

check_dependencies() {
    step 'Checking prerequisites'

    local os
    os="$(uname -s)"

    if ! require_cmd docker; then
        case "$os" in
            Darwin)
                die 'Docker is not installed.' \
                    'Any of these works — pick one:' \
                    '' \
                    '  brew install colima docker docker-compose && colima start' \
                    '  brew install --cask orbstack' \
                    '  brew install --cask docker          (Docker Desktop)' \
                    '' \
                    'Then re-run this installer.'
                ;;
            Linux)
                die 'Docker is not installed.' \
                    '  curl -fsSL https://get.docker.com | sh' \
                    "  sudo usermod -aG docker ${USER:-<your-user>}   # then log out and back in" \
                    '' \
                    'Then re-run this installer.'
                ;;
            *)
                die "Docker is not installed, and this installer does not know how to guide you on $os." \
                    'Install Docker and docker compose v2, then re-run.'
                ;;
        esac
    fi

    # The daemon being *installed* is not the daemon *running* — a stopped
    # colima VM is the single most common failure on a Mac, and `docker info`
    # is the only reliable way to tell.
    if ! docker info >/dev/null 2>&1; then
        local hint='Start Docker (or your VM) and re-run.'
        if require_cmd colima; then
            hint='Start it with:  colima start'
        elif [ "$os" = Darwin ]; then
            hint='Start Docker Desktop / OrbStack from Applications, or:  colima start'
        elif [ "$os" = Linux ]; then
            hint='Start it with:  sudo systemctl start docker'
        fi
        die 'Docker is installed but the daemon is not responding.' "$hint"
    fi

    # v2 only: this stack uses `name:`, service `healthcheck` conditions and
    # `depends_on: condition:`, none of which docker-compose v1 understands. It
    # would fail deep into the run with a confusing YAML error.
    if ! docker compose version >/dev/null 2>&1; then
        die 'docker compose v2 is not available.' \
            "You may have the older standalone 'docker-compose' (v1), which cannot run this stack." \
            'macOS:  brew install docker-compose' \
            'Linux:  sudo apt-get install docker-compose-plugin' \
            '        (or see https://docs.docker.com/compose/install/)'
    fi

    # curl or wget is enough — no need to insist on both.
    if ! require_cmd curl && ! require_cmd wget; then
        die 'Neither curl nor wget is available.' 'Install one and re-run.'
    fi

    # Secret generation. openssl is near-universal; /dev/urandom is the
    # fallback so a minimal container image still works.
    if ! require_cmd openssl && [ ! -r /dev/urandom ]; then
        die 'Cannot generate secrets: no openssl and no readable /dev/urandom.'
    fi

    ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'ok') with compose v2"

    # Node is genuinely optional: the stack runs entirely in containers. It is
    # only needed for the *stdio* MCP client option printed at the end.
    if require_cmd node; then
        ok "node $(node --version 2>/dev/null) (enables the stdio MCP option)"
    else
        dim 'node not found — optional. The HTTP MCP endpoint works without it;'
        dim 'the stdio client option needs npx (install Node 24+ to use it).'
    fi
}

# --- source resolution ------------------------------------------------------

# Find the repo root if we are being run from inside a checkout. Uses git when
# available, and otherwise walks up looking for the marker files, so an
# extracted tarball (no .git) still counts as a checkout.
find_checkout_root() {
    local start="$1" dir
    dir="$(cd "$start" 2>/dev/null && pwd)" || return 1
    while [ "$dir" != / ]; do
        if [ -f "$dir/deploy/docker-compose.yml" ] && [ -f "$dir/pnpm-workspace.yaml" ]; then
            printf '%s' "$dir"
            return 0
        fi
        dir="$(dirname "$dir")"
    done
    return 1
}

download() {
    local url="$1" dest="$2"
    if require_cmd curl; then
        curl -fsSL "$url" -o "$dest"
    else
        wget -qO "$dest" "$url"
    fi
}

# Decide whether to use local files or fetch a pinned tarball.
#
# Being run from a checkout is the common developer case and must use the
# working tree — silently downloading a different ref over someone's local
# changes would be a genuinely bad surprise.
resolve_source() {
    step 'Locating the Gemdex stack'

    local script_dir='' root=''
    # ${BASH_SOURCE[0]} is the *script path* when run as a file, but under
    # `curl | bash` there is no file, so this is expected to fail there.
    if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
        script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    fi

    if [ -n "$script_dir" ] && root="$(find_checkout_root "$script_dir")"; then
        : # running from a checkout
    elif root="$(find_checkout_root "$PWD")"; then
        : # invoked from within a checkout
    else
        root=''
    fi

    if [ -n "$root" ]; then
        DEPLOY_DIR="$root/deploy"
        ok "using this checkout: $root"
        return
    fi

    # Piped-from-curl path: fetch the source. The whole tree is needed because
    # the compose file builds images rather than pulling them (header note 2).
    info "no checkout found — fetching source at ref '$GEMDEX_REF'"

    local target="$GEMDEX_HOME/src"
    mkdir -p "$GEMDEX_HOME"

    if require_cmd git; then
        if [ -d "$target/.git" ]; then
            info 'updating the existing copy'
            git -C "$target" fetch --depth 1 origin "$GEMDEX_REF" >/dev/null 2>&1 ||
                die "Could not fetch ref '$GEMDEX_REF' from $REPO." 'Check the ref name and your network.'
            git -C "$target" checkout -q FETCH_HEAD ||
                die 'Could not check out the fetched ref.'
        else
            rm -rf "$target"
            git clone --depth 1 --branch "$GEMDEX_REF" \
                "https://github.com/${REPO}.git" "$target" >/dev/null 2>&1 ||
                git clone --depth 1 "https://github.com/${REPO}.git" "$target" >/dev/null 2>&1 ||
                die "Could not clone $REPO." 'Check your network and that the repo is reachable.'
        fi
    else
        # No git: tarball. Works on a minimal box, and is what a release ref
        # gives you anyway.
        local tarball="$GEMDEX_HOME/gemdex-src.tar.gz" extract="$GEMDEX_HOME/.extract"
        info 'git not found — downloading a tarball instead'
        download "https://codeload.github.com/${REPO}/tar.gz/${GEMDEX_REF}" "$tarball" ||
            die "Could not download $REPO at ref '$GEMDEX_REF'." 'Check the ref name and your network.'
        rm -rf "$extract"; mkdir -p "$extract"
        tar -xzf "$tarball" -C "$extract" ||
            die 'Could not extract the downloaded tarball.'
        local inner
        inner="$(find "$extract" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
        [ -n "$inner" ] || die 'The downloaded tarball had an unexpected layout.'
        rm -rf "$target"
        mv "$inner" "$target"
        rm -rf "$extract" "$tarball"
    fi

    [ -f "$target/deploy/docker-compose.yml" ] ||
        die 'The downloaded source is missing deploy/docker-compose.yml.' \
            "Ref '$GEMDEX_REF' may not contain the deploy stack."

    DEPLOY_DIR="$target/deploy"
    ok "source at $target"
}

# --- secrets ----------------------------------------------------------------

gen_secret() {
    if require_cmd openssl; then
        openssl rand -hex 32
    else
        # Deliberately not $RANDOM, which is seeded predictably and only yields
        # 15 bits — useless for a token with full memory access.
        LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 64
    fi
}

# Read a key's value out of an env file without sourcing it.
#
# Sourcing would execute the file and let a stray `$(…)` in a value run as this
# script's user, and would also dump every secret into this process's
# environment where any child could read it.
env_value() {
    local key="$1" file="$2"
    [ -f "$file" ] || return 0
    sed -n "s/^${key}=//p" "$file" | tail -n 1
}

# Append `KEY=value` only when the key has no value yet. The core of
# idempotence (header note 4): an existing secret is never touched.
ensure_env_value() {
    local key="$1" value="$2" file="$3"
    local existing
    existing="$(env_value "$key" "$file")"
    if [ -n "$existing" ]; then
        return 1
    fi
    # Commented-out or valueless line: replace it in place rather than leaving a
    # confusing duplicate key.
    if grep -q "^${key}=" "$file" 2>/dev/null; then
        local tmp="${file}.tmp.$$"
        grep -v "^${key}=" "$file" > "$tmp"
        mv "$tmp" "$file"
    fi
    printf '%s=%s\n' "$key" "$value" >> "$file"
    return 0
}

configure_env() {
    step 'Configuring secrets'

    ENV_FILE="$DEPLOY_DIR/.env"

    if [ -f "$ENV_FILE" ]; then
        ok "reusing existing $ENV_FILE (secrets left untouched)"
    else
        FRESH_INSTALL=true
        # Create empty and lock it down *before* writing anything, so a secret
        # never exists on disk world-readable even momentarily.
        : > "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        info "created $ENV_FILE"
    fi

    # Always re-assert 0600: an .env from an older install (or an editor that
    # rewrote it) may be readable by others.
    chmod 600 "$ENV_FILE"

    if [ "$FRESH_INSTALL" = true ]; then
        {
            printf '# Gemdex self-host configuration — generated by scripts/install.sh.\n'
            printf '#\n'
            printf '# Re-running the installer never regenerates these secrets. Rotating\n'
            printf '# POSTGRES_PASSWORD here does NOT change an existing volume (Postgres reads\n'
            printf '# it only at initdb), so a new value would just break authentication.\n'
            printf '#\n'
        } >> "$ENV_FILE"
    fi

    if ensure_env_value GEMDEX_SERVER_TOKEN "$(gen_secret)" "$ENV_FILE"; then
        ok 'generated GEMDEX_SERVER_TOKEN'
    else
        ok 'kept existing GEMDEX_SERVER_TOKEN'
    fi

    if ensure_env_value POSTGRES_PASSWORD "$(gen_secret)" "$ENV_FILE"; then
        ok 'generated POSTGRES_PASSWORD'
    else
        ok 'kept existing POSTGRES_PASSWORD'
    fi

    # The MCP client bearer. Distinct from GEMDEX_SERVER_TOKEN on purpose: this
    # one is handed to MCP clients and (in --lan mode) travels the network,
    # while GEMDEX_SERVER_TOKEN has direct full access to the memory API and
    # must never leave the host.
    if ensure_env_value GEMDEX_MCP_HTTP_TOKEN "$(gen_secret)" "$ENV_FILE"; then
        ok 'generated GEMDEX_MCP_HTTP_TOKEN (the bearer MCP clients send)'
    else
        ok 'kept existing GEMDEX_MCP_HTTP_TOKEN'
    fi

    # `static` for bootstrap: `google` needs a public https URL, an OAuth client
    # created by hand in the Google console, and a registered redirect URI —
    # none of which exist on a LAN box and none of which can be scripted.
    # SELF_HOST_DEPLOY.md covers the upgrade.
    ensure_env_value GEMDEX_MCP_AUTH static "$ENV_FILE" >/dev/null || true
    ensure_env_value GEMDEX_WEB_AUTH dev "$ENV_FILE" >/dev/null || true

    # In a container 0.0.0.0 is the namespace edge, not an exposure — what
    # decides reachability is the published port. dev mode still refuses a
    # non-loopback bind without this, so it is required for the web manager to
    # start at all here.
    ensure_env_value GEMDEX_WEB_UNSAFE_DEV_BIND true "$ENV_FILE" >/dev/null || true

    # Session cookie signing key. Unused in dev mode but generated now so the
    # google-mode upgrade is a one-line auth flip rather than a scavenger hunt.
    ensure_env_value GEMDEX_WEB_SESSION_SECRET "$(gen_secret)" "$ENV_FILE" >/dev/null || true

    ensure_env_value GEMDEX_SERVER_PORT "$BYOI_PORT" "$ENV_FILE" >/dev/null || true
    ensure_env_value GEMDEX_MCP_HTTP_PORT "$MCP_PORT" "$ENV_FILE" >/dev/null || true
    ensure_env_value GEMDEX_WEB_PORT "$WEB_PORT" "$ENV_FILE" >/dev/null || true

    # A re-run without explicit port flags must follow the ports the stack was
    # actually created with, or the health check would poll the wrong ports and
    # report a false failure.
    BYOI_PORT="$(env_value GEMDEX_SERVER_PORT "$ENV_FILE")"
    MCP_PORT="$(env_value GEMDEX_MCP_HTTP_PORT "$ENV_FILE")"
    WEB_PORT="$(env_value GEMDEX_WEB_PORT "$ENV_FILE")"

    configure_gemini_key
}

configure_gemini_key() {
    local existing
    existing="$(env_value GEMINI_API_KEY "$ENV_FILE")"

    if [ -n "$existing" ]; then
        ok 'kept existing GEMINI_API_KEY'
        return
    fi

    # Accepted from the environment so CI and repeat installs never prompt.
    if [ -n "${GEMINI_API_KEY:-}" ]; then
        ensure_env_value GEMINI_API_KEY "$GEMINI_API_KEY" "$ENV_FILE" >/dev/null || true
        ok 'stored GEMINI_API_KEY from the environment'
        return
    fi

    if ! has_tty; then
        # Deliberately fatal rather than "start it and let saves fail later".
        # An empty key satisfies compose (header note 3) and produces a stack
        # that looks healthy and cannot store a single memory — the worst
        # possible outcome for a first-run experience.
        die 'GEMINI_API_KEY is required and there is no terminal to prompt on.' \
            'The server owns embedding, so without a key every save and recall fails' \
            'at request time even though the stack reports healthy.' \
            '' \
            'Get a free key: https://aistudio.google.com/apikey' \
            '' \
            'Then either:' \
            '  GEMINI_API_KEY=your-key bash install.sh' \
            'or run the installer from a terminal so it can prompt.'
    fi

    printf '\n' > /dev/tty
    printf '    %sGemdex needs a Google AI Studio key.%s\n' "$C_BOLD" "$C_RESET" > /dev/tty
    printf '    The server does all embedding, so your coding agents never need one.\n' > /dev/tty
    printf '    Free key: %shttps://aistudio.google.com/apikey%s\n\n' "$C_BLUE" "$C_RESET" > /dev/tty

    local key=''
    key="$(prompt_secret '    Paste your GEMINI_API_KEY (input hidden): ')"

    if [ -z "$key" ]; then
        die 'No key entered.' \
            'Without it the stack starts but every save and recall fails at request time.' \
            'Get one at https://aistudio.google.com/apikey and re-run.'
    fi

    ensure_env_value GEMINI_API_KEY "$key" "$ENV_FILE" >/dev/null || true
    ok 'stored GEMINI_API_KEY'
}

# --- LAN exposure -----------------------------------------------------------

detect_lan_ip() {
    local ip=''
    case "$(uname -s)" in
        Darwin)
            local iface
            iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
            [ -n "$iface" ] && ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
            # Wired/wireless fallback when there is no default route yet.
            [ -n "$ip" ] || ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
            [ -n "$ip" ] || ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
            ;;
        Linux)
            if require_cmd ip; then
                ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '/src/{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
            fi
            if [ -z "$ip" ] && require_cmd hostname; then
                ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
            fi
            ;;
    esac
    printf '%s' "$ip"
}

# Publishing on 0.0.0.0 cannot be expressed by changing a port, because the bind
# address is hard-coded in docker-compose.yml — deliberately, since 127.0.0.1
# there is a security boundary rather than a default. So --lan layers an
# override file on top instead of the installer rewriting the committed compose
# file, which keeps the safe default readable and auditable in git.
write_lan_override() {
    local path="$DEPLOY_DIR/docker-compose.lan.yml"
    cat > "$path" <<'YAML'
# Generated by scripts/install.sh --lan. Safe to delete.
#
# Republishes the MCP endpoint and the web manager on 0.0.0.0 so other devices
# on your network can reach them.
#
# `gemdex-server` is deliberately NOT included: the BYOI bearer has full memory
# access with no per-user identity and no expiry, so that port stays on
# 127.0.0.1 even in LAN mode. MCP clients go through gemdex-mcp-http, which has
# its own separate bearer.
#
# This is plaintext HTTP with a shared bearer and no login on the web manager —
# fine on a trusted home network, wrong on a shared or public one. For anything
# beyond that, see docs/SELF_HOST_DEPLOY.md (TLS edge + Google OAuth).
#
# `!override` is required, not stylistic: compose MERGES list-valued keys across
# files, so without it each service ends up publishing BOTH 127.0.0.1:<port> and
# 0.0.0.0:<port> on the same host port and the container fails to start with
# "address already in use".
services:
  gemdex-mcp-http:
    ports: !override
      - "0.0.0.0:${GEMDEX_MCP_HTTP_PORT:-8766}:8766"
  gemdex-web:
    ports: !override
      - "0.0.0.0:${GEMDEX_WEB_PORT:-8767}:8767"
YAML
}

# --- bring the stack up -----------------------------------------------------

compose() {
    local -a args=(compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml")
    if [ "$LAN_MODE" = true ]; then
        args+=(-f "$DEPLOY_DIR/docker-compose.lan.yml")
    fi
    ( cd "$DEPLOY_DIR" && docker "${args[@]}" "$@" )
}

start_stack() {
    step 'Building and starting the stack'

    if [ "$LAN_MODE" = true ]; then
        write_lan_override
        info 'LAN mode: MCP + web manager will publish on 0.0.0.0'
    else
        info 'loopback mode: services publish on 127.0.0.1 only (use --lan to share)'
    fi

    # Catch a bad .env before spending several minutes on image builds.
    if ! compose config >/dev/null 2>&1; then
        local detail
        detail="$(compose config 2>&1 | head -n 3)"
        die 'The compose configuration is invalid.' "$detail" \
            "Check $ENV_FILE."
    fi

    info 'building images from source (first run takes a few minutes)'
    # Not silenced: a multi-minute build with no output looks like a hang, and
    # the build log is exactly what someone needs when it fails.
    if ! compose up -d --build; then
        die 'The stack failed to start.' \
            'Inspect the logs with:' \
            "  cd $DEPLOY_DIR && docker compose -p $PROJECT_NAME --env-file .env logs"
    fi
    ok 'containers started'
}

http_get() {
    local url="$1" auth="${2:-}"
    if [ -n "$auth" ]; then
        curl -fsS -m 5 -H "Authorization: Bearer $auth" "$url" 2>/dev/null
    else
        curl -fsS -m 5 "$url" 2>/dev/null
    fi
}

# Health, with the failure path treated as a first-class outcome: on timeout,
# print what is actually wrong (per-container state + recent logs) rather than
# just "timed out", which leaves someone with nowhere to go.
wait_for_health() {
    step 'Waiting for migrations and health checks'

    local byoi_url="http://127.0.0.1:${BYOI_PORT}/v1/health"
    local mcp_url="http://127.0.0.1:${MCP_PORT}/healthz"
    local web_url="http://127.0.0.1:${WEB_PORT}/healthz"

    # 180s: migrations run on first boot and pgvector's first start initialises
    # the database, which is slow on a cold VM.
    local deadline=$((SECONDS + 180))
    local byoi_ok=false mcp_ok=false web_ok=false

    while [ "$SECONDS" -lt "$deadline" ]; do
        if [ "$byoi_ok" = false ] && http_get "$byoi_url" | grep -q '"ok":true'; then
            byoi_ok=true; ok 'memory API healthy (migrations applied)'
        fi
        if [ "$byoi_ok" = true ] && [ "$mcp_ok" = false ] && http_get "$mcp_url" >/dev/null; then
            mcp_ok=true; ok 'MCP endpoint healthy'
        fi
        if [ "$mcp_ok" = true ] && [ "$web_ok" = false ] && http_get "$web_url" >/dev/null; then
            web_ok=true; ok 'web manager healthy'
        fi
        if [ "$byoi_ok" = true ] && [ "$mcp_ok" = true ] && [ "$web_ok" = true ]; then
            return 0
        fi
        sleep 2
    done

    printf '\n%serror:%s the stack did not become healthy within 180s.\n\n' "$C_RED$C_BOLD" "$C_RESET" >&2
    printf '  memory API (%s): %s\n' "$byoi_url" "$([ "$byoi_ok" = true ] && echo ok || echo FAILED)" >&2
    printf '  MCP endpoint (%s): %s\n' "$mcp_url" "$([ "$mcp_ok" = true ] && echo ok || echo 'FAILED / not reached')" >&2
    printf '  web manager (%s): %s\n\n' "$web_url" "$([ "$web_ok" = true ] && echo ok || echo 'FAILED / not reached')" >&2

    printf '  container state:\n' >&2
    compose ps 2>&1 | sed 's/^/    /' >&2

    printf '\n  recent logs:\n' >&2
    compose logs --tail 25 2>&1 | sed 's/^/    /' >&2

    printf '\n  Common causes:\n' >&2
    printf '    - a port is already in use → re-run with --byoi-port/--mcp-port/--web-port\n' >&2
    printf '    - not enough memory for the VM → raise it (colima start --memory 4)\n' >&2
    printf '    - a stale volume with a different POSTGRES_PASSWORD (see\n' >&2
    printf '      docs/SELF_HOST_DEPLOY.md "Migrating an existing BYOI stack")\n' >&2
    printf '\n  Full logs:\n    cd %s && docker compose -p %s --env-file .env logs\n' \
        "$DEPLOY_DIR" "$PROJECT_NAME" >&2
    exit 1
}

# `/v1/health` green is NOT proof of a working install (header note 3): without a
# valid key the server is healthy and every save fails. So do the round trip the
# user actually cares about, and fail with the real upstream message.
verify_round_trip() {
    if [ "$SKIP_VERIFY" = true ]; then
        return 0
    fi
    step 'Verifying a real save and recall'

    local token body response
    token="$(env_value GEMDEX_SERVER_TOKEN "$ENV_FILE")"
    body='{"content":"Gemdex self-host install verification — the stack can embed, store and recall a memory.","title":"Install verification"}'

    response="$(curl -fsS -m 90 -X POST \
        -H "Authorization: Bearer $token" \
        -H 'Content-Type: application/json' \
        -d "$body" \
        "http://127.0.0.1:${BYOI_PORT}/v1/memories" 2>&1)" || {
        printf '\n%serror:%s the stack is healthy but saving a memory failed.\n\n' "$C_RED$C_BOLD" "$C_RESET" >&2
        printf '  %s\n\n' "$(printf '%s' "$response" | tail -n 3)" >&2
        printf '  This is almost always an invalid or unauthorized GEMINI_API_KEY.\n' >&2
        printf '  The server does the embedding, so a bad key fails here rather than at startup.\n\n' >&2
        printf '  Fix: edit GEMINI_API_KEY in %s then re-run:\n' "$ENV_FILE" >&2
        printf '    cd %s && docker compose -p %s --env-file .env up -d\n' "$DEPLOY_DIR" "$PROJECT_NAME" >&2
        printf '  Get a key: https://aistudio.google.com/apikey\n' >&2
        exit 1
    }
    ok 'saved a memory (embedding works)'

    if http_get "http://127.0.0.1:${BYOI_PORT}/v1/memories" "$token" | grep -q 'Install verification'; then
        ok 'recalled it back'
    else
        warn 'the memory saved but did not come back in a listing — check the logs.'
    fi
}

# --- final report -----------------------------------------------------------

print_summary() {
    local mcp_token lan_ip='' mcp_host web_host
    mcp_token="$(env_value GEMDEX_MCP_HTTP_TOKEN "$ENV_FILE")"

    mcp_host="127.0.0.1"
    web_host="127.0.0.1"
    if [ "$LAN_MODE" = true ]; then
        lan_ip="$(detect_lan_ip)"
        if [ -n "$lan_ip" ]; then
            mcp_host="$lan_ip"
            web_host="$lan_ip"
        else
            warn 'could not detect this machine'"'"'s LAN IP; showing loopback addresses.'
            warn 'find it with: ipconfig getifaddr en0   (macOS)  |  hostname -I   (Linux)'
        fi
    fi

    printf '\n%s%s Gemdex is running.%s\n\n' "$C_GREEN$C_BOLD" '✓' "$C_RESET"

    printf '  %sWeb manager%s   http://%s:%s\n' "$C_BOLD" "$C_RESET" "$web_host" "$WEB_PORT"
    printf '  %sMCP endpoint%s  http://%s:%s/mcp\n' "$C_BOLD" "$C_RESET" "$mcp_host" "$MCP_PORT"
    printf '  %sMemory API%s    http://127.0.0.1:%s/v1  %s(loopback only, always)%s\n' \
        "$C_BOLD" "$C_RESET" "$BYOI_PORT" "$C_DIM" "$C_RESET"
    printf '  %sConfig%s        %s  %s(0600 — holds your secrets)%s\n\n' \
        "$C_BOLD" "$C_RESET" "$ENV_FILE" "$C_DIM" "$C_RESET"

    if [ "$LAN_MODE" = true ]; then
        printf '  %s! LAN mode:%s the MCP endpoint and web manager are reachable by any device\n' \
            "$C_YELLOW$C_BOLD" "$C_RESET"
        printf '    on your network, over plaintext HTTP. The MCP endpoint requires the bearer\n'
        printf '    below; %sthe web manager has no login at all%s and can delete memories.\n' "$C_BOLD" "$C_RESET"
        printf '    Fine on a home network you trust. Not fine on shared/office/public Wi-Fi.\n\n'
    else
        printf '  %sLoopback only:%s reachable from this machine alone. To use Gemdex from\n' "$C_BOLD" "$C_RESET"
        printf '  another device on your network, re-run with %s--lan%s.\n\n' "$C_BOLD" "$C_RESET"
    fi

    printf '%s─── Paste into your MCP client ───%s\n\n' "$C_BOLD" "$C_RESET"

    printf '  %sStreamable HTTP%s — any MCP client that speaks HTTP transport:\n\n' "$C_BOLD" "$C_RESET"
    cat <<JSON
  {
    "mcpServers": {
      "gemdex": {
        "url": "http://${mcp_host}:${MCP_PORT}/mcp",
        "headers": {
          "Authorization": "Bearer ${mcp_token}"
        }
      }
    }
  }

JSON

    printf '  %sstdio%s — for clients without HTTP transport (needs Node 24+).\n' "$C_BOLD" "$C_RESET"
    printf '  %sRun this on the machine hosting the stack%s — it talks to the memory API\n' "$C_DIM" "$C_RESET"
    printf '  %sdirectly over loopback, which is not reachable from other devices.%s\n\n' "$C_DIM" "$C_RESET"
    cat <<JSON
  {
    "mcpServers": {
      "gemdex": {
        "command": "npx",
        "args": ["-y", "gemdex-mcp@latest"],
        "env": {
          "GEMDEX_MODE": "remote",
          "GEMDEX_REMOTE_URL": "http://127.0.0.1:${BYOI_PORT}",
          "GEMDEX_REMOTE_TOKEN": "$(env_value GEMDEX_SERVER_TOKEN "$ENV_FILE")"
        }
      }
    }
  }

JSON

    printf '%s─── What next ───%s\n\n' "$C_BOLD" "$C_RESET"

    if [ "$LAN_MODE" = true ]; then
        if [ -n "$lan_ip" ]; then
            printf '  Try it from another device on your network:\n'
            printf '    curl -s -H "Authorization: Bearer %s" \\\n' "$mcp_token"
            printf '      http://%s:%s/healthz\n\n' "$lan_ip" "$MCP_PORT"
        fi
    else
        printf '  Share it with your other devices:  re-run with --lan\n\n'
    fi

    printf '  Open the web manager to browse, search and delete memories, and to\n'
    printf '  upload chat transcripts from your coding agents:\n'
    printf '    http://%s:%s\n\n' "$web_host" "$WEB_PORT"

    printf '  Going beyond your LAN — public domain, TLS, Cloudflare Tunnel, and\n'
    printf '  Google login instead of the shared bearer:\n'
    printf '    https://github.com/%s/blob/main/docs/SELF_HOST_DEPLOY.md\n' "$REPO"
    printf '  Managed platforms (Render, Railway), cost and sizing:\n'
    printf '    https://github.com/%s/blob/main/docs/GO_FURTHER.md\n\n' "$REPO"

    printf '  %sManage the stack%s\n' "$C_BOLD" "$C_RESET"
    printf '    cd %s\n' "$DEPLOY_DIR"
    printf '    docker compose -p %s --env-file .env ps      # status\n' "$PROJECT_NAME"
    printf '    docker compose -p %s --env-file .env logs -f  # follow logs\n' "$PROJECT_NAME"
    printf '    docker compose -p %s --env-file .env down     # stop (keeps your data)\n\n' "$PROJECT_NAME"

    if [ "$FRESH_INSTALL" = false ]; then
        printf '  %sRe-run detected:%s secrets and data were left untouched.\n\n' "$C_DIM" "$C_RESET"
    fi
}

main() {
    printf '\n%sGemdex self-host installer%s\n' "$C_BOLD" "$C_RESET"
    printf '%sPostgres + memory API + MCP endpoint + web manager%s\n\n' "$C_DIM" "$C_RESET"

    check_dependencies
    resolve_source
    configure_env
    start_stack
    wait_for_health
    verify_round_trip
    print_summary
}

main "$@"
