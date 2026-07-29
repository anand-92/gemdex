# syntax=docker/dockerfile:1
#
# gemdex-web — the manager UI (React SPA) and its FastAPI BFF.
#
# Build context is the REPO ROOT, like the other two images:
# `docker build -f packages/web/Dockerfile .`
#
# Three stages, because this is the one image in the stack that needs *both*
# toolchains: Node to compile the SPA, Python to run the server that serves it.
# Node does not survive into the runtime stage — the built assets do.

# --- 1. build the SPA -----------------------------------------------------

FROM node:24-bookworm-slim AS frontend

# Pinned rather than `corepack enable`: the repo has no `packageManager` field,
# so corepack would install whatever pnpm is latest at build time and the image
# would drift from the version the workspace lockfile was written by.
RUN npm install --global pnpm@10.19.0

WORKDIR /build

# Manifests first so the install layer stays cached across source-only edits.
# The workspace root files come along because the lockfile lives there and
# `--frozen-lockfile` needs it: that is what makes dependency resolution in this
# image identical to the one that was tested, rather than "whatever resolved
# today".
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/web/frontend/package.json ./packages/web/frontend/
RUN pnpm install --frozen-lockfile --filter gemdex-web

COPY packages/web/frontend/ ./packages/web/frontend/
# `pnpm build` runs `tsc --noEmit && vite build`, so a type error fails the
# image build rather than shipping a broken UI.
# Vite's outDir is ../src/gemdex_web/static relative to the frontend dir, so the
# output lands at /build/packages/web/src/gemdex_web/static.
RUN pnpm --filter gemdex-web build


# --- 2. resolve Python dependencies --------------------------------------

FROM ghcr.io/astral-sh/uv:0.9.29-python3.13-bookworm-slim AS build

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app

# `--frozen` fails the build on a stale lockfile rather than silently
# re-resolving, so the image matches what was tested.
COPY packages/web/pyproject.toml packages/web/uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY packages/web/src ./src
COPY packages/web/README.md ./

# The SPA is copied in *before* the project install so it is packaged into the
# wheel as part of gemdex_web, which is what makes the default
# `<package>/static` lookup in config.py resolve at runtime with no env var.
COPY --from=frontend /build/packages/web/src/gemdex_web/static ./src/gemdex_web/static

RUN uv sync --frozen --no-dev --no-editable


# --- 3. runtime -----------------------------------------------------------

FROM python:3.13-slim-bookworm AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH=/app/.venv/bin:$PATH \
    GEMDEX_WEB_HOST=0.0.0.0 \
    GEMDEX_WEB_PORT=8767

# Same uid/gid (10001) as the server and mcp-http images.
RUN groupadd --system --gid 10001 gemdex \
    && useradd --system --uid 10001 --gid gemdex --home-dir /nonexistent --shell /usr/sbin/nologin gemdex

WORKDIR /app
COPY --from=build --chown=gemdex:gemdex /app/.venv /app/.venv

# No VOLUME here, unlike mcp-http. This service is deliberately stateless: the
# session lives in a signed cookie in the browser, so there is nothing on disk
# to preserve and the container can run with a read-only rootfs.
USER gemdex
EXPOSE 8767

# Unauthenticated by necessity — in google mode every /api call is a 401 until
# a browser completes the OAuth flow, so an authenticated probe would report
# unhealthy forever. Liveness only; it does not probe the BYOI.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=6 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8767/healthz',timeout=2).status==200 else 1)"]

CMD ["gemdex-web"]
