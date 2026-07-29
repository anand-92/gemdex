"""Startup configuration for the web manager BFF.

Deliberately a near-copy of `gemdex_mcp_http.config`'s shape — same `EnvSource`
precedence (`process.env` → `~/.gemdex/.env`), same fail-fast `ConfigError`
convention, same `AUTH_MODES` tuple idea. The two services are separate
processes and this package cannot import that one, so the duplication is real;
it is preferred over a shared library because the *values* differ (this service
has a session secret and no MCP transport) and a premature abstraction would
couple two deployables that are meant to be independently runnable.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_BYOI_URL = "http://127.0.0.1:8765"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8767
DEFAULT_TIMEOUT_MS = 30_000

#: How long a browser session stays valid before re-authentication. Short by
#: design: the cookie is a bearer credential for the whole memory pool, and
#: there is no revocation list — expiry is the only way a stolen cookie stops
#: working.
DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60

#: `dev` = no login at all, loopback only (the analogue of mcp-http's `static`
#: mode: a development convenience, never for a published deployment).
#: `google` = Google authorization-code login restricted to one email.
AUTH_MODES = ("dev", "google")
DEFAULT_AUTH_MODE = "dev"

#: Minimum scopes that still yield the verified identity the allowlist checks.
#: Matches mcp-http's GOOGLE_SCOPES.
GOOGLE_SCOPES = ("openid", "email")

GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"

_TRUE_VALUES = {"1", "true", "yes", "on"}
_FALSE_VALUES = {"0", "false", "no", "off"}


class ConfigError(Exception):
    """Startup configuration is missing or invalid."""


def _read_dotenv(path: Path) -> dict[str, str]:
    """Parse `~/.gemdex/.env` the same way core's `EnvManager` does."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    values: dict[str, str] = {}
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        values[key.strip()] = value
    return values


class EnvSource:
    """`process.env` first, then `~/.gemdex/.env`. Empty strings count as unset."""

    def __init__(self, env: dict[str, str] | None = None, dotenv_path: Path | None = None) -> None:
        self._env = dict(os.environ) if env is None else dict(env)
        self._dotenv_path = dotenv_path if dotenv_path is not None else Path.home() / ".gemdex" / ".env"
        self._dotenv: dict[str, str] | None = None

    def get(self, name: str) -> str | None:
        value = self._env.get(name)
        if value:
            return value
        if self._dotenv is None:
            self._dotenv = _read_dotenv(self._dotenv_path)
        fallback = self._dotenv.get(name)
        return fallback if fallback else None


@dataclass(frozen=True)
class Config:
    """Resolved, validated startup configuration."""

    byoi_url: str
    #: The BYOI bearer. Server-side only — see `AGENTS.md`: this value must
    #: never appear in a response body, a redirect, or a template.
    byoi_token: str
    host: str
    port: int
    timeout_ms: int
    #: Which login gate `require_session` enforces. One of `AUTH_MODES`.
    auth_mode: str
    #: Signs the session cookie. Non-`None` iff `auth_mode == "google"`.
    session_secret: str | None
    session_ttl_seconds: int
    #: Google OAuth client credentials. Non-`None` iff `auth_mode == "google"`.
    google_client_id: str | None
    google_client_secret: str | None
    #: Public base URL of this service, used to build the OAuth redirect URI.
    #: Non-`None` iff `auth_mode == "google"`.
    public_base_url: str | None
    #: The single Google account permitted to sign in. Non-`None` iff
    #: `auth_mode == "google"`.
    allowed_email: str | None
    #: Directory holding the built SPA. `None` runs API-only (Vite dev server
    #: serves the UI in development).
    static_dir: Path | None

    @property
    def redirect_uri(self) -> str | None:
        """The exact URI to register in the Google Cloud console, or `None` in dev mode.

        Google matches redirect URIs by exact string, so this must be registered
        verbatim. It is a *different path* from mcp-http's `/auth/callback`,
        which is why the same OAuth client can serve both: one client may hold
        several authorized redirect URIs.
        """
        if self.public_base_url is None:
            return None
        return f"{self.public_base_url}/auth/google/callback"

    @property
    def cookie_secure(self) -> bool:
        """Whether to set the `Secure` flag on the session cookie.

        Derived from the scheme of the public URL rather than configured
        separately: `Secure` on a plaintext origin makes the cookie
        un-settable, which would break loopback development in a way that looks
        like a login bug. Any non-loopback deployment is https (enforced in
        `_load_google`), so this is `True` wherever it matters.
        """
        if self.public_base_url is None:
            return False
        return self.public_base_url.startswith("https://")


def _parse_bool(value: str | None, name: str, default: bool) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in _TRUE_VALUES:
        return True
    if normalized in _FALSE_VALUES:
        return False
    raise ConfigError(f"Invalid {name} '{value}': must be true or false.")


def _is_loopback_host(host: str) -> bool:
    """Whether a *bind address* (not a URL) is loopback-only."""
    return host.strip().strip("[]") in {"127.0.0.1", "localhost", "::1"}


def _parse_port(value: str | None, name: str, default: int) -> int:
    if value is None:
        return default
    try:
        port = int(value)
    except ValueError as error:
        raise ConfigError(f"Invalid {name} '{value}': must be an integer between 1 and 65535.") from error
    if not 1 <= port <= 65535:
        raise ConfigError(f"Invalid {name} '{value}': must be an integer between 1 and 65535.")
    return port


def _parse_positive_int(value: str | None, name: str, default: int) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError as error:
        raise ConfigError(f"Invalid {name} '{value}': must be a positive integer.") from error
    if parsed < 1:
        raise ConfigError(f"Invalid {name} '{value}': must be a positive integer.")
    return parsed


def _is_loopback(url: str) -> bool:
    host = url.split("://", 1)[1].split("/", 1)[0].rsplit(":", 1)[0].strip("[]")
    return host in {"localhost", "127.0.0.1", "::1"}


@dataclass(frozen=True)
class _GoogleConfig:
    """The five values google mode cannot boot without."""

    client_id: str
    client_secret: str
    base_url: str
    allowed_email: str
    session_secret: str


def _require(source: EnvSource, name: str, why: str) -> str:
    value = source.get(name)
    if not value:
        raise ConfigError(f"{name} is required when GEMDEX_WEB_AUTH=google: {why}")
    return value.strip()


def _load_google(source: EnvSource) -> _GoogleConfig:
    """Resolve google-mode config, or raise `ConfigError` naming what is missing."""
    client_id = _require(
        source,
        "GOOGLE_OAUTH_CLIENT_ID",
        "the OAuth 2.0 Web application client ID from the Google Cloud console "
        "(ends in .apps.googleusercontent.com). The same client as gemdex-mcp-http "
        "may be reused by adding this service's redirect URI to it.",
    )
    client_secret = _require(
        source,
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "the client secret for that OAuth client (starts with GOCSPX-).",
    )
    base_url = _require(
        source,
        "GEMDEX_WEB_BASE_URL",
        "the public base URL browsers reach this app at. It builds the OAuth "
        "redirect URI, which Google matches exactly.",
    ).rstrip("/")
    if not base_url.startswith(("http://", "https://")):
        raise ConfigError(f"Invalid GEMDEX_WEB_BASE_URL '{base_url}': must start with http:// or https://.")
    # Plaintext off-loopback would send the session cookie in the clear, and
    # Google refuses to register such a redirect URI anyway.
    if base_url.startswith("http://") and not _is_loopback(base_url):
        raise ConfigError(
            f"Invalid GEMDEX_WEB_BASE_URL '{base_url}': https is required for non-loopback hosts. "
            "Google only permits plaintext redirect URIs on localhost/127.0.0.1."
        )

    allowed_email = _require(
        source,
        "GEMDEX_ALLOWED_EMAIL",
        "the single Google account permitted to sign in. This app is single-user "
        "by design; every other identity is rejected.",
    ).lower()
    if "@" not in allowed_email:
        raise ConfigError(f"Invalid GEMDEX_ALLOWED_EMAIL '{allowed_email}': must be an email address.")

    session_secret = _require(
        source,
        "GEMDEX_WEB_SESSION_SECRET",
        "the key that signs session cookies. Generate one with "
        "`openssl rand -hex 32`. Changing it invalidates all sessions.",
    )
    # A guessable secret means forgeable sessions, which defeats the allowlist
    # entirely — so this is a hard floor, not a warning.
    if len(session_secret) < 32:
        raise ConfigError(
            "GEMDEX_WEB_SESSION_SECRET is too short: at least 32 characters are required, because "
            "anyone who can guess it can forge a signed session cookie and bypass the email allowlist. "
            "Generate one with `openssl rand -hex 32`."
        )

    return _GoogleConfig(
        client_id=client_id,
        client_secret=client_secret,
        base_url=base_url,
        allowed_email=allowed_email,
        session_secret=session_secret,
    )


def _load_static_dir(source: EnvSource) -> Path | None:
    """Resolve the built-SPA directory, or `None` to run API-only."""
    configured = source.get("GEMDEX_WEB_STATIC_DIR")
    if configured:
        path = Path(configured)
        # An explicit path that does not exist is a deployment mistake (a
        # mistyped volume or a skipped frontend build) and would otherwise
        # surface as a 404 on every page load, so fail fast instead.
        if not path.is_dir():
            raise ConfigError(
                f"GEMDEX_WEB_STATIC_DIR '{configured}' is not a directory. It must point at the built "
                "frontend (the output of `pnpm --filter gemdex-web build`), or be unset to run API-only."
            )
        return path
    # Convention for the container image and `pip install -e .` layouts: the
    # build lands next to the package as `static/`.
    bundled = Path(__file__).resolve().parent / "static"
    return bundled if bundled.is_dir() else None


def load_config(env: dict[str, str] | None = None, dotenv_path: Path | None = None) -> Config:
    """Resolve configuration or raise `ConfigError`. Never returns a half-valid Config."""
    source = EnvSource(env, dotenv_path)

    byoi_token = source.get("GEMDEX_SERVER_TOKEN")
    if not byoi_token:
        raise ConfigError(
            "GEMDEX_SERVER_TOKEN is required: it is the bearer token for the BYOI server's /v1 API. "
            "Use the same value gemdex-server was started with. It stays server-side and is never "
            "sent to the browser."
        )

    byoi_url = (source.get("GEMDEX_SERVER_URL") or DEFAULT_BYOI_URL).rstrip("/")
    if not byoi_url.startswith(("http://", "https://")):
        raise ConfigError(f"Invalid GEMDEX_SERVER_URL '{byoi_url}': must start with http:// or https://.")

    auth_mode = (source.get("GEMDEX_WEB_AUTH") or DEFAULT_AUTH_MODE).strip().lower()
    if auth_mode not in AUTH_MODES:
        raise ConfigError(f"Invalid GEMDEX_WEB_AUTH '{auth_mode}': must be one of {', '.join(AUTH_MODES)}.")

    google = _load_google(source) if auth_mode == "google" else None

    host = source.get("GEMDEX_WEB_HOST") or DEFAULT_HOST
    # dev mode has no login whatsoever, so a non-loopback bind would publish
    # unauthenticated full CRUD (including delete) to the network. Refuse unless
    # the operator explicitly opts in.
    #
    # The escape hatch exists because inside a container `0.0.0.0` is normal and
    # not itself an exposure: the network namespace is the boundary, and
    # `deploy/docker-compose.yml` publishes the port on 127.0.0.1. Without it,
    # dev mode would be unusable in the image for local UI work. It is named
    # UNSAFE and must be set deliberately, mirroring
    # GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH in mcp-http.
    unsafe_bind = _parse_bool(
        source.get("GEMDEX_WEB_UNSAFE_DEV_BIND"), "GEMDEX_WEB_UNSAFE_DEV_BIND", default=False
    )
    if auth_mode == "dev" and not _is_loopback_host(host) and not unsafe_bind:
        raise ConfigError(
            f"GEMDEX_WEB_AUTH=dev refuses to bind {host}: dev mode has no login at all, so binding a "
            "non-loopback address would expose unauthenticated memory CRUD (including delete) to the "
            "network. Use GEMDEX_WEB_AUTH=google, keep GEMDEX_WEB_HOST on loopback, or set "
            "GEMDEX_WEB_UNSAFE_DEV_BIND=true if the port is genuinely not reachable (e.g. a container "
            "whose port is published only on 127.0.0.1)."
        )

    return Config(
        byoi_url=byoi_url,
        byoi_token=byoi_token.strip(),
        host=host,
        port=_parse_port(source.get("GEMDEX_WEB_PORT"), "GEMDEX_WEB_PORT", DEFAULT_PORT),
        timeout_ms=_parse_positive_int(
            source.get("GEMDEX_WEB_TIMEOUT_MS"), "GEMDEX_WEB_TIMEOUT_MS", DEFAULT_TIMEOUT_MS
        ),
        auth_mode=auth_mode,
        session_secret=google.session_secret if google else None,
        session_ttl_seconds=_parse_positive_int(
            source.get("GEMDEX_WEB_SESSION_TTL_SECONDS"),
            "GEMDEX_WEB_SESSION_TTL_SECONDS",
            DEFAULT_SESSION_TTL_SECONDS,
        ),
        google_client_id=google.client_id if google else None,
        google_client_secret=google.client_secret if google else None,
        public_base_url=google.base_url if google else None,
        allowed_email=google.allowed_email if google else None,
        static_dir=_load_static_dir(source),
    )
