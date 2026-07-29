# syntax=docker/dockerfile:1
#
# gemdex-mcp-http — the Streamable HTTP MCP surface.
#
# Build context is the REPO ROOT (like packages/server/Dockerfile), so
# `docker build -f packages/mcp-http/Dockerfile .` from the repo root. This
# package is pure Python and does not depend on the pnpm workspace, but keeping
# the context consistent with the server image avoids two different conventions
# in one compose file.

FROM ghcr.io/astral-sh/uv:0.9.29-python3.13-bookworm-slim AS build

# Compile to .pyc at install time so the container doesn't pay it on first
# request, and copy rather than symlink so the venv survives the stage boundary.
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app

# Dependencies resolve from the lockfile alone, so copying just the manifests
# first keeps this layer cached across source-only edits. `--frozen` makes the
# build fail rather than silently re-resolve if uv.lock is stale — the exact
# fastmcp==4.0.0b1 prerelease pin is the whole point of committing the lock.
COPY packages/mcp-http/pyproject.toml packages/mcp-http/uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY packages/mcp-http/src ./src
COPY packages/mcp-http/README.md ./

# Install the project itself into the same venv (non-editable: the source tree
# is not present in the runtime stage).
RUN uv sync --frozen --no-dev --no-editable


FROM python:3.13-slim-bookworm AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH=/app/.venv/bin:$PATH \
    GEMDEX_MCP_HTTP_HOST=0.0.0.0 \
    GEMDEX_MCP_HTTP_PORT=8766

# Same uid/gid as the server image (10001) for consistency across the stack.
RUN groupadd --system --gid 10001 gemdex \
    && useradd --system --uid 10001 --gid gemdex --home-dir /nonexistent --shell /usr/sbin/nologin gemdex

WORKDIR /app
COPY --from=build --chown=gemdex:gemdex /app/.venv /app/.venv

# Create the state dir in the IMAGE, owned by gemdex. Docker seeds a fresh named
# volume from the image's content at that path — including ownership — so this is
# what stops the volume from mounting root-owned and denying writes to uid 10001.
# Without it the process dies at startup (FastMCP's OAuthProxy client store and
# the report_outcome ledger both need to write here), which is the same trap the
# server's blob volume hits.
RUN install -d -o gemdex -g gemdex -m 0700 /var/lib/gemdex
VOLUME /var/lib/gemdex

USER gemdex
EXPOSE 8766

# `/healthz` is deliberately unauthenticated (FastMCP exempts custom routes from
# auth middleware). A probe against /mcp would report unhealthy forever in
# google mode, where an unauthenticated call correctly returns 401.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=6 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8766/healthz',timeout=2).status==200 else 1)"]

CMD ["gemdex-mcp-http"]
