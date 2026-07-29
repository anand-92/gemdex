"""Configuration for the Streamable HTTP MCP service.

Required values fail fast at startup (repo convention: no silent fallback to a
broken default). Reads the process environment first, then `~/.gemdex/.env`,
matching the precedence of `gemdex-core`'s `EnvManager` so a token already
persisted there works without re-exporting it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_BYOI_URL = "http://127.0.0.1:8765"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8766
DEFAULT_TIMEOUT_MS = 30_000

#: `static` = one shared bearer, loopback dev only. `google` = OAuth 2.1
#: resource server delegating to Google, restricted to a single allowlisted
#: email. There is deliberately no "any Google account" mode.
AUTH_MODES = ("static", "google")
DEFAULT_AUTH_MODE = "static"

#: Google requires at least one scope; `openid` + email is the minimum that
#: still yields the identity the allowlist is checked against.
GOOGLE_SCOPES = ("openid", "email")

_TRUE_VALUES = {"1", "true", "yes", "on"}
_FALSE_VALUES = {"0", "false", "no", "off"}


class ConfigError(Exception):
    """Startup configuration is missing or invalid."""


def _read_dotenv(path: Path) -> dict[str, str]:
    """Parse `~/.gemdex/.env` the same way `EnvManager` does: `KEY=rest-of-line`."""
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
    byoi_token: str
    host: str
    port: int
    timeout_ms: int
    """Static bearer clients must present. `None` unless `auth_mode == "static"`."""
    client_token: str | None
    unsafe_no_auth: bool
    trust_ranking: bool
    #: Which provider `build_auth_provider` builds. One of `AUTH_MODES`.
    auth_mode: str
    """Google OAuth client credentials. Non-`None` iff `auth_mode == "google"`."""
    google_client_id: str | None
    google_client_secret: str | None
    """Public base URL of this service — the OAuth issuer and resource identity.
    Non-`None` iff `auth_mode == "google"`."""
    public_base_url: str | None
    """The single Google account permitted to use this server. Non-`None` iff
    `auth_mode == "google"`."""
    allowed_email: str | None

    @property
    def endpoint(self) -> str:
        return f"http://{self.host}:{self.port}/mcp"

    @property
    def redirect_uri(self) -> str | None:
        """The exact URI to register in the Google Cloud console, or `None` in static mode.

        FastMCP's `OAuthProxy` serves the upstream callback at `/auth/callback`
        under `base_url`; Google matches redirect URIs exactly, so this string
        must be registered verbatim.
        """
        if self.public_base_url is None:
            return None
        return f"{self.public_base_url}/auth/callback"


def _parse_bool(value: str | None, name: str, default: bool) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in _TRUE_VALUES:
        return True
    if normalized in _FALSE_VALUES:
        return False
    raise ConfigError(f"Invalid {name} '{value}': must be true or false.")


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


@dataclass(frozen=True)
class _GoogleConfig:
    """The four values google mode cannot boot without."""

    client_id: str
    client_secret: str
    base_url: str
    allowed_email: str


def _require(source: EnvSource, name: str, why: str) -> str:
    value = source.get(name)
    if not value:
        raise ConfigError(f"{name} is required when GEMDEX_MCP_AUTH=google: {why}")
    return value.strip()


def _is_loopback(url: str) -> bool:
    host = url.split("://", 1)[1].split("/", 1)[0].rsplit(":", 1)[0].strip("[]")
    return host in {"localhost", "127.0.0.1", "::1"}


def _load_google(source: EnvSource) -> _GoogleConfig:
    """Resolve google-mode config, or raise `ConfigError` naming what is missing."""
    client_id = _require(
        source,
        "GOOGLE_OAUTH_CLIENT_ID",
        "the OAuth 2.0 Web application client ID from the Google Cloud console "
        "(ends in .apps.googleusercontent.com).",
    )
    client_secret = _require(
        source,
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "the client secret for that OAuth client (starts with GOCSPX-).",
    )
    base_url = _require(
        source,
        "GEMDEX_MCP_BASE_URL",
        "the public base URL clients reach this server at. It is the OAuth issuer "
        "and the resource identity, so it must match exactly what clients use.",
    ).rstrip("/")
    if not base_url.startswith(("http://", "https://")):
        raise ConfigError(f"Invalid GEMDEX_MCP_BASE_URL '{base_url}': must start with http:// or https://.")
    # A non-loopback plaintext base_url means bearer tokens cross the network in
    # the clear, and Google refuses to register such a redirect URI anyway.
    if base_url.startswith("http://") and not _is_loopback(base_url):
        raise ConfigError(
            f"Invalid GEMDEX_MCP_BASE_URL '{base_url}': https is required for non-loopback hosts. "
            "Google only permits plaintext redirect URIs on localhost/127.0.0.1."
        )

    allowed_email = _require(
        source,
        "GEMDEX_ALLOWED_EMAIL",
        "the single Google account permitted to use this server. This server is "
        "single-user by design; every other identity is rejected.",
    ).lower()
    if "@" not in allowed_email:
        raise ConfigError(f"Invalid GEMDEX_ALLOWED_EMAIL '{allowed_email}': must be an email address.")

    return _GoogleConfig(
        client_id=client_id, client_secret=client_secret, base_url=base_url, allowed_email=allowed_email
    )


def load_config(env: dict[str, str] | None = None, dotenv_path: Path | None = None) -> Config:
    """Resolve configuration or raise `ConfigError`. Never returns a half-valid Config."""
    source = EnvSource(env, dotenv_path)

    byoi_token = source.get("GEMDEX_SERVER_TOKEN")
    if not byoi_token:
        raise ConfigError(
            "GEMDEX_SERVER_TOKEN is required: it is the bearer token for the colocated "
            "BYOI server's /v1 API. Use the same value gemdex-server was started with."
        )

    byoi_url = (source.get("GEMDEX_SERVER_URL") or DEFAULT_BYOI_URL).rstrip("/")
    if not byoi_url.startswith(("http://", "https://")):
        raise ConfigError(f"Invalid GEMDEX_SERVER_URL '{byoi_url}': must start with http:// or https://.")

    unsafe_no_auth = _parse_bool(
        source.get("GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH"), "GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH", default=False
    )
    auth_mode = (source.get("GEMDEX_MCP_AUTH") or DEFAULT_AUTH_MODE).strip().lower()
    if auth_mode not in AUTH_MODES:
        raise ConfigError(f"Invalid GEMDEX_MCP_AUTH '{auth_mode}': must be one of {', '.join(AUTH_MODES)}.")

    google = _load_google(source) if auth_mode == "google" else None

    client_token = source.get("GEMDEX_MCP_HTTP_TOKEN")
    if auth_mode == "static" and not client_token and not unsafe_no_auth:
        raise ConfigError(
            "GEMDEX_MCP_HTTP_TOKEN is required: it is the static bearer MCP clients must "
            "present. Set a strong token, set GEMDEX_MCP_AUTH=google for OAuth, or "
            "explicitly set GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH=true for loopback development only."
        )
    # A static bearer would be a second, weaker way in that bypasses the
    # allowlist entirely, so google mode drops it rather than honoring both.
    if auth_mode == "google":
        client_token = None

    return Config(
        byoi_url=byoi_url,
        byoi_token=byoi_token.strip(),
        host=source.get("GEMDEX_MCP_HTTP_HOST") or DEFAULT_HOST,
        port=_parse_port(source.get("GEMDEX_MCP_HTTP_PORT"), "GEMDEX_MCP_HTTP_PORT", DEFAULT_PORT),
        timeout_ms=_parse_positive_int(
            source.get("GEMDEX_MCP_HTTP_TIMEOUT_MS"), "GEMDEX_MCP_HTTP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS
        ),
        client_token=client_token.strip() if client_token else None,
        unsafe_no_auth=unsafe_no_auth,
        # Same opt-in flag as the TS stdio server; anything but "true" is off.
        trust_ranking=(source.get("GEMDEX_TRUST_RANKING") or "").strip().lower() == "true",
        auth_mode=auth_mode,
        google_client_id=google.client_id if google else None,
        google_client_secret=google.client_secret if google else None,
        public_base_url=google.base_url if google else None,
        allowed_email=google.allowed_email if google else None,
    )
