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
    """Static bearer clients must present. `None` only when auth is explicitly disabled."""
    client_token: str | None
    unsafe_no_auth: bool
    trust_ranking: bool

    @property
    def endpoint(self) -> str:
        return f"http://{self.host}:{self.port}/mcp"


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
    client_token = source.get("GEMDEX_MCP_HTTP_TOKEN")
    if not client_token and not unsafe_no_auth:
        raise ConfigError(
            "GEMDEX_MCP_HTTP_TOKEN is required: it is the static bearer MCP clients must "
            "present. Set a strong token, or explicitly set "
            "GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH=true for loopback development only."
        )

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
    )
