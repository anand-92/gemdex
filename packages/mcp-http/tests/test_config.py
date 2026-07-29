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


def test_trust_ranking_only_true_enables() -> None:
    for value, expected in [("true", True), ("TRUE", True), ("1", False), ("yes", False), ("", False)]:
        config = load_config(
            env={"GEMDEX_SERVER_TOKEN": "t", "GEMDEX_MCP_HTTP_TOKEN": "c", "GEMDEX_TRUST_RANKING": value},
            dotenv_path=Path("/nonexistent"),
        )
        assert config.trust_ranking is expected, value
