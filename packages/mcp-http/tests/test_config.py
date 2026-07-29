"""Config resolution + fail-fast behavior."""

from __future__ import annotations

from pathlib import Path

import pytest

from gemdex_mcp_http.config import DEFAULT_BYOI_URL, DEFAULT_PORT, ConfigError, load_config


def test_missing_byoi_token_fails_fast() -> None:
    with pytest.raises(ConfigError, match="GEMDEX_SERVER_TOKEN is required"):
        load_config(env={}, dotenv_path=Path("/nonexistent"))


def test_missing_client_token_fails_fast() -> None:
    with pytest.raises(ConfigError, match="GEMDEX_MCP_HTTP_TOKEN is required"):
        load_config(env={"GEMDEX_SERVER_TOKEN": "t"}, dotenv_path=Path("/nonexistent"))


def test_unsafe_no_auth_allows_missing_client_token() -> None:
    config = load_config(
        env={"GEMDEX_SERVER_TOKEN": "t", "GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH": "true"},
        dotenv_path=Path("/nonexistent"),
    )
    assert config.unsafe_no_auth is True
    assert config.client_token is None


def test_defaults() -> None:
    config = load_config(
        env={"GEMDEX_SERVER_TOKEN": "t", "GEMDEX_MCP_HTTP_TOKEN": "c"},
        dotenv_path=Path("/nonexistent"),
    )
    assert config.byoi_url == DEFAULT_BYOI_URL
    assert config.port == DEFAULT_PORT
    assert config.host == "127.0.0.1"
    assert config.trust_ranking is False
    assert config.endpoint == f"http://127.0.0.1:{DEFAULT_PORT}/mcp"


def test_trailing_slash_stripped_from_byoi_url() -> None:
    config = load_config(
        env={"GEMDEX_SERVER_TOKEN": "t", "GEMDEX_MCP_HTTP_TOKEN": "c", "GEMDEX_SERVER_URL": "http://host:9/"},
        dotenv_path=Path("/nonexistent"),
    )
    assert config.byoi_url == "http://host:9"


def test_non_http_byoi_url_rejected() -> None:
    with pytest.raises(ConfigError, match="must start with http"):
        load_config(
            env={"GEMDEX_SERVER_TOKEN": "t", "GEMDEX_MCP_HTTP_TOKEN": "c", "GEMDEX_SERVER_URL": "ftp://host"},
            dotenv_path=Path("/nonexistent"),
        )


def test_invalid_port_rejected() -> None:
    with pytest.raises(ConfigError, match="between 1 and 65535"):
        load_config(
            env={"GEMDEX_SERVER_TOKEN": "t", "GEMDEX_MCP_HTTP_TOKEN": "c", "GEMDEX_MCP_HTTP_PORT": "70000"},
            dotenv_path=Path("/nonexistent"),
        )


def test_invalid_boolean_rejected() -> None:
    with pytest.raises(ConfigError, match="must be true or false"):
        load_config(
            env={"GEMDEX_SERVER_TOKEN": "t", "GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH": "maybe"},
            dotenv_path=Path("/nonexistent"),
        )


def test_dotenv_fallback(tmp_path: Path) -> None:
    dotenv = tmp_path / ".env"
    dotenv.write_text("# comment\nGEMDEX_SERVER_TOKEN=from-file\nGEMDEX_MCP_HTTP_TOKEN=client-from-file\n")
    config = load_config(env={}, dotenv_path=dotenv)
    assert config.byoi_token == "from-file"
    assert config.client_token == "client-from-file"


def test_process_env_wins_over_dotenv(tmp_path: Path) -> None:
    dotenv = tmp_path / ".env"
    dotenv.write_text("GEMDEX_SERVER_TOKEN=from-file\n")
    config = load_config(env={"GEMDEX_SERVER_TOKEN": "from-env", "GEMDEX_MCP_HTTP_TOKEN": "c"}, dotenv_path=dotenv)
    assert config.byoi_token == "from-env"


# --- google auth mode ----------------------------------------------------

GOOGLE_ENV = {
    "GEMDEX_SERVER_TOKEN": "t",
    "GEMDEX_MCP_AUTH": "google",
    "GOOGLE_OAUTH_CLIENT_ID": "123.apps.googleusercontent.com",
    "GOOGLE_OAUTH_CLIENT_SECRET": "GOCSPX-secret",
    "GEMDEX_MCP_BASE_URL": "https://mcp.example.com",
    "GEMDEX_ALLOWED_EMAIL": "owner@gmail.com",
}


def google_env(**overrides: str | None) -> dict[str, str]:
    env = dict(GOOGLE_ENV)
    for key, value in overrides.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    return env


def test_google_mode_resolves() -> None:
    config = load_config(env=google_env(), dotenv_path=Path("/nonexistent"))
    assert config.auth_mode == "google"
    assert config.allowed_email == "owner@gmail.com"
    assert config.public_base_url == "https://mcp.example.com"
    assert config.redirect_uri == "https://mcp.example.com/auth/callback"


def test_static_is_the_default_mode() -> None:
    config = load_config(
        env={"GEMDEX_SERVER_TOKEN": "t", "GEMDEX_MCP_HTTP_TOKEN": "c"}, dotenv_path=Path("/nonexistent")
    )
    assert config.auth_mode == "static"
    assert config.allowed_email is None
    assert config.redirect_uri is None


def test_unknown_auth_mode_rejected() -> None:
    with pytest.raises(ConfigError, match="Invalid GEMDEX_MCP_AUTH"):
        load_config(env=google_env(GEMDEX_MCP_AUTH="okta"), dotenv_path=Path("/nonexistent"))


@pytest.mark.parametrize(
    "missing",
    ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GEMDEX_MCP_BASE_URL", "GEMDEX_ALLOWED_EMAIL"],
)
def test_google_mode_fails_fast_without_each_required_var(missing: str) -> None:
    with pytest.raises(ConfigError, match=f"{missing} is required when GEMDEX_MCP_AUTH=google"):
        load_config(env=google_env(**{missing: None}), dotenv_path=Path("/nonexistent"))


def test_google_mode_needs_no_static_token() -> None:
    """The static bearer is a static-mode concept; requiring it here would be noise."""
    config = load_config(env=google_env(), dotenv_path=Path("/nonexistent"))
    assert config.client_token is None


def test_static_token_is_dropped_in_google_mode() -> None:
    """A lingering static bearer would be a second way in that skips the allowlist."""
    config = load_config(
        env=google_env(GEMDEX_MCP_HTTP_TOKEN="left-over-token"), dotenv_path=Path("/nonexistent")
    )
    assert config.client_token is None


def test_plaintext_base_url_rejected_for_non_loopback() -> None:
    with pytest.raises(ConfigError, match="https is required for non-loopback"):
        load_config(
            env=google_env(GEMDEX_MCP_BASE_URL="http://mcp.example.com"), dotenv_path=Path("/nonexistent")
        )


def test_plaintext_base_url_allowed_on_loopback() -> None:
    """Google permits http redirect URIs on localhost, which makes local dev possible."""
    config = load_config(
        env=google_env(GEMDEX_MCP_BASE_URL="http://localhost:8766"), dotenv_path=Path("/nonexistent")
    )
    assert config.redirect_uri == "http://localhost:8766/auth/callback"


def test_non_http_base_url_rejected() -> None:
    with pytest.raises(ConfigError, match="must start with http"):
        load_config(env=google_env(GEMDEX_MCP_BASE_URL="mcp.example.com"), dotenv_path=Path("/nonexistent"))


def test_base_url_trailing_slash_stripped() -> None:
    """Otherwise the registered redirect URI gets a double slash and stops matching."""
    config = load_config(
        env=google_env(GEMDEX_MCP_BASE_URL="https://mcp.example.com/"), dotenv_path=Path("/nonexistent")
    )
    assert config.redirect_uri == "https://mcp.example.com/auth/callback"


def test_allowed_email_normalized_to_lowercase() -> None:
    config = load_config(env=google_env(GEMDEX_ALLOWED_EMAIL="Owner@Gmail.com"), dotenv_path=Path("/nonexistent"))
    assert config.allowed_email == "owner@gmail.com"


def test_malformed_allowed_email_rejected() -> None:
    with pytest.raises(ConfigError, match="must be an email address"):
        load_config(env=google_env(GEMDEX_ALLOWED_EMAIL="not-an-email"), dotenv_path=Path("/nonexistent"))


def test_google_credentials_readable_from_dotenv(tmp_path: Path) -> None:
    """Secrets belong in ~/.gemdex/.env (0600), not a shell history."""
    dotenv = tmp_path / ".env"
    dotenv.write_text(
        "GEMDEX_SERVER_TOKEN=t\nGOOGLE_OAUTH_CLIENT_ID=123.apps.googleusercontent.com\n"
        "GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-from-file\nGEMDEX_MCP_BASE_URL=https://mcp.example.com\n"
        "GEMDEX_ALLOWED_EMAIL=owner@gmail.com\n"
    )
    config = load_config(env={"GEMDEX_MCP_AUTH": "google"}, dotenv_path=dotenv)
    assert config.google_client_secret == "GOCSPX-from-file"


def test_trust_ranking_only_true_enables() -> None:
    for value, expected in [("true", True), ("TRUE", True), ("1", False), ("yes", False), ("", False)]:
        config = load_config(
            env={"GEMDEX_SERVER_TOKEN": "t", "GEMDEX_MCP_HTTP_TOKEN": "c", "GEMDEX_TRUST_RANKING": value},
            dotenv_path=Path("/nonexistent"),
        )
        assert config.trust_ranking is expected, value
