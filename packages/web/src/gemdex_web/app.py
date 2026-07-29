"""FastAPI application factory: session middleware, auth routes, API, SPA.

`create_app(config)` is the whole wiring. `server.py` is only an entrypoint.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    RedirectResponse,
)
from starlette.middleware.sessions import SessionMiddleware
from starlette.staticfiles import StaticFiles

from .auth import (
    SESSION_RETURN_TO,
    AuthError,
    clear_session,
    consume_login_state,
    current_identity,
    establish_session,
    exchange_code_for_identity,
    start_login,
)
from .byoi import ByoiClient
from .config import Config
from .routes import router as api_router

#: Cookie name. The `__Host-` prefix would be stronger, but it mandates
#: `Secure`, which cannot be set on the plaintext loopback origin that `dev`
#: mode and local `google` testing use — so the name stays plain and
#: `cookie_secure` carries the flag where it applies.
SESSION_COOKIE = "gemdex_session"


def create_app(config: Config, byoi: ByoiClient | None = None) -> FastAPI:
    """Build the configured app. Pass `byoi` to inject a fake client in tests."""
    owns_client = byoi is None
    client = byoi if byoi is not None else ByoiClient(config.byoi_url, config.byoi_token, config.timeout_ms)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            if owns_client:
                await client.aclose()

    app = FastAPI(
        title="Gemdex web manager",
        description="Human management surface for a Gemdex memory pool.",
        # No interactive docs: they would enumerate the API for anyone who finds
        # the origin, and this app has exactly one human user who does not need
        # them.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.config = config
    app.state.byoi = client

    # In dev mode there is no session at all, so no signing key is needed — and
    # `SessionMiddleware` cannot be installed without one. `current_identity`
    # short-circuits before touching `request.session`, so the attribute is
    # never read in that mode.
    if config.session_secret is not None:
        app.add_middleware(
            SessionMiddleware,
            secret_key=config.session_secret,
            session_cookie=SESSION_COOKIE,
            # Expiry is the only revocation mechanism a signed cookie has.
            max_age=config.session_ttl_seconds,
            same_site="lax",  # "strict" would drop the cookie on the OAuth return.
            https_only=config.cookie_secure,
        )

    _register_auth_routes(app, config)
    app.include_router(api_router)
    _register_health(app)
    _register_spa(app, config)
    return app


def _register_health(app: FastAPI) -> None:
    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> PlainTextResponse:
        """Liveness probe for the container healthcheck and the edge.

        Unauthenticated by necessity and liveness-only by choice — the same
        reasoning as mcp-http's `/healthz`: an authenticated probe would report
        unhealthy forever in `google` mode, and probing the BYOI from here would
        make an unauthenticated endpoint a backend availability oracle and take
        this container down for another service's outage.
        """
        return PlainTextResponse("ok")


def _register_auth_routes(app: FastAPI, config: Config) -> None:
    @app.get("/auth/login", include_in_schema=False)
    async def login(request: Request, next: str = "/") -> RedirectResponse:
        if config.auth_mode == "dev":
            return RedirectResponse(url=_safe_next(next), status_code=302)
        url = start_login(request, config, return_to=_safe_next(next))
        return RedirectResponse(url=url, status_code=302)

    @app.get("/auth/google/callback", include_in_schema=False)
    async def callback(
        request: Request,
        code: str | None = None,
        state: str | None = None,
        error: str | None = None,
    ) -> Any:
        if config.auth_mode == "dev":
            raise HTTPException(status_code=404, detail="Not found.")
        # Google reports user-side failures (e.g. access_denied) as a query
        # param, not an HTTP error.
        if error:
            return _login_error_page("Google reported: " + error, status_code=400)
        if not code:
            return _login_error_page("Google did not return an authorization code.", status_code=400)

        try:
            nonce = consume_login_state(request, state)
            identity = await exchange_code_for_identity(code, config, nonce)
        except AuthError as auth_error:
            # A rejected login must not leave a half-built session behind.
            clear_session(request)
            return _login_error_page(auth_error.detail, status_code=403)

        return_to = request.session.pop(SESSION_RETURN_TO, "/")
        establish_session(request, identity)
        return RedirectResponse(url=_safe_next(return_to), status_code=302)

    @app.post("/auth/logout", include_in_schema=False)
    async def logout(request: Request) -> JSONResponse:
        clear_session(request)
        return JSONResponse({"ok": True})

    @app.get("/api/session", include_in_schema=False)
    async def session(request: Request) -> JSONResponse:
        """Who am I — the SPA's bootstrap call.

        Deliberately outside the `/api` router (which requires a session), since
        its entire job is to answer "is there a session?" without a 401. It
        reveals only the auth mode and the signed-in address, never the
        allowlist of an anonymous caller.
        """
        identity = current_identity(request, config)
        return JSONResponse(
            {
                "authenticated": identity is not None,
                "email": identity.email if identity else None,
                "authMode": config.auth_mode,
                "loginUrl": "/auth/login",
            }
        )


def _safe_next(target: str | None) -> str:
    """Constrain post-login redirects to this app's own paths.

    An unchecked `?next=` is an open redirect: an attacker sends
    `/auth/login?next=https://evil.example`, the victim authenticates for real,
    and lands on a copy of this UI that asks them to "sign in again". Only
    single-slash-prefixed relative paths pass; `//host` is rejected because
    browsers read it as protocol-relative and it would leave the origin.
    """
    if not target or not target.startswith("/") or target.startswith("//"):
        return "/"
    return target


def _login_error_page(detail: str, status_code: int) -> HTMLResponse:
    """A minimal self-contained failure page.

    Plain HTML rather than a redirect into the SPA: a login failure can happen
    before any session exists, and bouncing to an app that immediately
    re-attempts login would loop. `detail` is escaped — it can contain
    Google-supplied text.
    """
    from html import escape

    body = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign-in failed — Gemdex</title>
<style>
 body {{ font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0; min-height: 100vh; display: grid; place-items: center;
        background: #0f1115; color: #e6e8eb; padding: 24px; }}
 .card {{ max-width: 34rem; background: #171a21; border: 1px solid #262b36;
         border-radius: 10px; padding: 28px 32px; }}
 h1 {{ font-size: 1.1rem; margin: 0 0 12px; }}
 p {{ margin: 0 0 18px; color: #a8b0bd; }}
 a {{ color: #6ea8fe; }}
</style></head>
<body><div class="card">
<h1>Sign-in failed</h1>
<p>{escape(detail)}</p>
<p><a href="/auth/login">Try again</a></p>
</div></body></html>"""
    return HTMLResponse(body, status_code=status_code)


def _register_spa(app: FastAPI, config: Config) -> None:
    """Serve the built SPA, if one is present.

    Hashed assets under `/assets` are immutable and long-cached; `index.html` is
    always revalidated so a deploy is picked up without a hard refresh. Unknown
    paths fall back to `index.html` so client-side routes survive a reload —
    but only for GET/HEAD of non-API paths, so a typo'd API call still 404s as
    JSON instead of returning HTML that a fetch would fail to parse.
    """
    static_dir = config.static_dir
    if static_dir is None:
        @app.get("/", include_in_schema=False)
        async def no_ui() -> JSONResponse:
            return JSONResponse(
                {
                    "service": "gemdex-web",
                    "ui": "not built",
                    "hint": "Run `pnpm --filter gemdex-web build`, or set GEMDEX_WEB_STATIC_DIR.",
                }
            )
        return

    assets_dir = static_dir / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    index_file = static_dir / "index.html"

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str) -> Any:
        if full_path.startswith(("api/", "auth/")):
            raise HTTPException(status_code=404, detail="Not found.")
        # A real file (favicon, manifest) wins over the SPA fallback. Resolved
        # and re-checked against the root so `..` in the URL cannot escape.
        candidate = (static_dir / full_path).resolve()
        if full_path and candidate.is_file() and candidate.is_relative_to(static_dir.resolve()):
            return FileResponse(candidate)
        if not index_file.is_file():
            raise HTTPException(status_code=404, detail="UI is not built.")
        return FileResponse(index_file, headers={"Cache-Control": "no-cache"})
