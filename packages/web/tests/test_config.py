"""Configuration resolution. Every required value must fail fast, not default."""

from __future__ import annotations

import pytest

from gemdex_web.config import ConfigError, load_config

from .conftest import ALLOWED_EMAIL, BYOI_TOKEN, NO_DOTENV, make_dev_config, make_google_config


def load(**env: str) -> object:
    return load_config(env=env, dotenv_path=NO_DOTENV)


# --- required values ------------------------------------------------------


def test_missing_byoi_token_fails_fast() -> None:
    with pytest.raises(ConfigError, match="GEMDEX_SERVER_TOKEN"):
        load()


def test_defaults_are_loopback_and_dev() -> None:
    config = make_dev_config()
    assert config.byoi_url == "http://127.0.0.1:8765"
    assert config.host == "127.0.0.1"
    assert config.port == 8767
    assert config.auth_mode == "dev"


@pytest.mark.parametrize("value", ["ftp://x", "127.0.0.1:8765", ""])
def test_byoi_url_must_be_http(value: str) -> None:
    with pytest.raises(ConfigError):
        load(GEMDEX_SERVER_TOKEN=BYOI_TOKEN, GEMDEX_SERVER_URL=value or "nope")


@pytest.mark.parametrize("value", ["0", "70000", "abc", "-1"])
def test_invalid_port_is_rejected(value: str) -> None:
    with pytest.raises(ConfigError):
        load(GEMDEX_SERVER_TOKEN=BYOI_TOKEN, GEMDEX_WEB_PORT=value)


def test_unknown_auth_mode_is_rejected() -> None:
    with pytest.raises(ConfigError, match="GEMDEX_WEB_AUTH"):
        load(GEMDEX_SERVER_TOKEN=BYOI_TOKEN, GEMDEX_WEB_AUTH="none")


# --- the dev-mode bind guard ---------------------------------------------


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.11", "::"])
def test_dev_mode_refuses_a_non_loopback_bind(host: str) -> None:
    """dev mode has no login, so a routable bind would publish delete to the LAN."""
    with pytest.raises(ConfigError, match="refuses to bind"):
        load(GEMDEX_SERVER_TOKEN=BYOI_TOKEN, GEMDEX_WEB_HOST=host)


def test_dev_mode_non_loopback_bind_requires_explicit_optin() -> None:
    """The container case: `0.0.0.0` inside a namespace whose port is published
    on loopback only. Allowed, but it must be asked for by name."""
    config = load(
        GEMDEX_SERVER_TOKEN=BYOI_TOKEN,
        GEMDEX_WEB_HOST="0.0.0.0",
        GEMDEX_WEB_UNSAFE_DEV_BIND="true",
    )
    assert config.host == "0.0.0.0"  # type: ignore[attr-defined]


def test_google_mode_may_bind_any_address() -> None:
    """The guard is about *unauthenticated* exposure, so it does not apply here."""
    assert make_google_config(GEMDEX_WEB_HOST="0.0.0.0").host == "0.0.0.0"


@pytest.mark.parametrize("value", ["maybe", "1.5"])
def test_invalid_boolean_is_rejected(value: str) -> None:
    with pytest.raises(ConfigError):
        load(GEMDEX_SERVER_TOKEN=BYOI_TOKEN, GEMDEX_WEB_UNSAFE_DEV_BIND=value)


# --- google mode ----------------------------------------------------------


@pytest.mark.parametrize(
    "missing",
    [
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "GEMDEX_WEB_BASE_URL",
        "GEMDEX_ALLOWED_EMAIL",
        "GEMDEX_WEB_SESSION_SECRET",
    ],
)
def test_google_mode_requires_each_value(missing: str) -> None:
    env = {
        "GEMDEX_SERVER_TOKEN": BYOI_TOKEN,
        "GEMDEX_WEB_AUTH": "google",
        "GOOGLE_OAUTH_CLIENT_ID": "cid.apps.googleusercontent.com",
        "GOOGLE_OAUTH_CLIENT_SECRET": "GOCSPX-x",
        "GEMDEX_WEB_BASE_URL": "https://gemdex.example",
        "GEMDEX_ALLOWED_EMAIL": ALLOWED_EMAIL,
        "GEMDEX_WEB_SESSION_SECRET": "s" * 48,
    }
    del env[missing]
    with pytest.raises(ConfigError, match=missing):
        load_config(env=env, dotenv_path=NO_DOTENV)


def test_short_session_secret_is_rejected() -> None:
    """A guessable key means forgeable cookies, which defeats the allowlist."""
    with pytest.raises(ConfigError, match="too short"):
        make_google_config(GEMDEX_WEB_SESSION_SECRET="tooshort")


def test_plaintext_base_url_is_rejected_off_loopback() -> None:
    """https or the session cookie crosses the network in the clear."""
    with pytest.raises(ConfigError, match="https is required"):
        make_google_config(GEMDEX_WEB_BASE_URL="http://gemdex.example")


def test_plaintext_loopback_base_url_is_allowed() -> None:
    """Local OAuth testing: Google permits plaintext redirect URIs on localhost."""
    config = make_google_config(GEMDEX_WEB_BASE_URL="http://127.0.0.1:8767")
    assert config.cookie_secure is False


def test_email_must_look_like_an_address() -> None:
    with pytest.raises(ConfigError, match="must be an email"):
        make_google_config(GEMDEX_ALLOWED_EMAIL="not-an-email")


def test_allowed_email_is_normalized_to_lowercase() -> None:
    assert make_google_config(GEMDEX_ALLOWED_EMAIL="NIK@Example.COM").allowed_email == "nik@example.com"


def test_redirect_uri_is_the_exact_path_google_must_have() -> None:
    """Google matches redirect URIs by exact string, so this is a contract.

    It differs from mcp-http's `/auth/callback`, which is what lets one OAuth
    client serve both services.
    """
    assert make_google_config().redirect_uri == "https://gemdex.example/auth/google/callback"


def test_base_url_trailing_slash_does_not_double_up() -> None:
    config = make_google_config(GEMDEX_WEB_BASE_URL="https://gemdex.example/")
    assert config.redirect_uri == "https://gemdex.example/auth/google/callback"


def test_cookie_secure_follows_the_scheme() -> None:
    assert make_google_config().cookie_secure is True


def test_dev_mode_has_no_session_secret_or_google_values() -> None:
    """Nothing google-shaped should be half-set in dev mode."""
    config = make_dev_config()
    assert config.session_secret is None
    assert config.google_client_id is None
    assert config.allowed_email is None
    assert config.redirect_uri is None


# --- env precedence -------------------------------------------------------


def test_dotenv_supplies_values_absent_from_the_process_env(tmp_path: object) -> None:
    """Mirrors core's EnvManager: `~/.gemdex/.env` is a fallback, not an override."""
    from pathlib import Path

    dotenv = Path(str(tmp_path)) / ".env"
    dotenv.write_text("GEMDEX_SERVER_TOKEN=from-dotenv\n", encoding="utf-8")

    assert load_config(env={}, dotenv_path=dotenv).byoi_token == "from-dotenv"
    # Process env wins.
    assert load_config(env={"GEMDEX_SERVER_TOKEN": "from-env"}, dotenv_path=dotenv).byoi_token == "from-env"


def test_empty_string_counts_as_unset() -> None:
    with pytest.raises(ConfigError):
        load(GEMDEX_SERVER_TOKEN="")
