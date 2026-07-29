"""OAuth 2.1 resource server behavior: discovery, 401s, and the single-user allowlist.

These tests never talk to Google. `GoogleTokenVerifier` is the only component
that would, so it is stubbed to return the `AccessToken` Google's endpoints
*would* have produced — which is exactly the object the allowlist reads. What is
under test is our enforcement, and the real FastMCP wiring around it: the
provider's actual routes, the actual metadata documents, and the actual 401
headers, all driven through a real Starlette app.
"""

from __future__ import annotations

import time
from typing import Any

import pytest
from fastmcp.server.auth.auth import AccessToken
from fastmcp.server.auth.providers.jwt import StaticTokenVerifier
from starlette.testclient import TestClient

from gemdex_mcp_http.auth import SingleUserGoogleProvider, build_auth_provider
from gemdex_mcp_http.config import GOOGLE_SCOPES
from gemdex_mcp_http.server import build_server

from .conftest import ALLOWED_EMAIL, FakeByoi, make_config, make_google_config

OTHER_EMAIL = "someone.else@gmail.com"
MCP_REQUEST = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
MCP_HEADERS = {"Accept": "application/json, text/event-stream"}


def google_access_token(
    *,
    email: str | None = ALLOWED_EMAIL,
    # A STRING, matching what Google's `tokeninfo` endpoint actually returns —
    # not the boolean it would be tempting to assume. `GoogleTokenVerifier`
    # passes the claim through verbatim, and `tokeninfo`'s truthy `"true"`
    # short-circuits the `or` that would otherwise reach `userinfo`'s real
    # boolean. Defaulting to a bool here is what let a strict `is True` check
    # ship and reject every real login.
    email_verified: object = "true",
    **claims: Any,
) -> AccessToken:
    """The `AccessToken` `GoogleTokenVerifier` builds after a successful verify."""
    return AccessToken(
        token="upstream-google-token",
        client_id="google-sub-123",
        scopes=list(GOOGLE_SCOPES),
        expires_at=int(time.time()) + 3600,
        subject="google-sub-123",
        claims={
            "sub": "google-sub-123",
            "aud": "cid",
            "email": email,
            "email_verified": email_verified,
            **claims,
        },
    )


def provider(**overrides: Any) -> SingleUserGoogleProvider:
    built = build_auth_provider(make_google_config(**overrides))
    assert isinstance(built, SingleUserGoogleProvider)
    return built


def stub_upstream(monkeypatch: pytest.MonkeyPatch, result: AccessToken | None) -> None:
    """Make the OAuthProxy token swap resolve to `result` without Google or storage.

    Patches `OAuthProxy.verify_token` — the `super()` call our allowlist wraps —
    so the test exercises `SingleUserGoogleProvider.verify_token` for real.
    """

    async def fake_verify(self: Any, token: str) -> AccessToken | None:
        _ = (self, token)
        return result

    monkeypatch.setattr(
        "fastmcp.server.auth.oauth_proxy.OAuthProxy.verify_token", fake_verify
    )


# --- mode selection ------------------------------------------------------


def test_google_mode_builds_the_single_user_provider() -> None:
    assert isinstance(
        build_auth_provider(make_google_config()), SingleUserGoogleProvider
    )


def test_static_mode_is_unchanged_by_the_new_seam() -> None:
    """Regression: adding google mode must not perturb the loopback dev path."""
    built = build_auth_provider(make_config(client_token="tok"))
    assert isinstance(built, StaticTokenVerifier)
    assert list(built.tokens) == ["tok"]


def test_unsafe_no_auth_still_wins_over_google_mode() -> None:
    assert build_auth_provider(make_google_config(unsafe_no_auth=True)) is None


def test_issuer_equals_base_url() -> None:
    """If these ever diverge, every client is forced to re-authorize once."""
    built = provider()
    assert str(built.issuer_url).rstrip("/") == "https://mcp.example.com"


def test_requested_scopes_are_minimal() -> None:
    assert set(provider().required_scopes or []) <= {
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
    }


# --- the single-user allowlist -------------------------------------------


async def test_allowlisted_identity_is_accepted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stub_upstream(monkeypatch, google_access_token())
    result = await provider().verify_token("fastmcp-jwt")
    assert result is not None
    assert result.claims["email"] == ALLOWED_EMAIL


async def test_other_google_identity_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The whole point: Google authenticates everyone, we admit exactly one."""
    stub_upstream(monkeypatch, google_access_token(email=OTHER_EMAIL))
    assert await provider().verify_token("fastmcp-jwt") is None


async def test_email_match_is_case_insensitive(monkeypatch: pytest.MonkeyPatch) -> None:
    stub_upstream(monkeypatch, google_access_token(email=ALLOWED_EMAIL.upper()))
    assert await provider().verify_token("fastmcp-jwt") is not None


@pytest.mark.parametrize("verified", ["true", "True", " true ", True])
async def test_verified_email_is_accepted_in_either_shape(
    monkeypatch: pytest.MonkeyPatch, verified: object
) -> None:
    """Google sends `email_verified` as a string from `tokeninfo`, a bool from `userinfo`.

    Both are affirmative and both must be admitted. Comparing with `is True`
    accepts only the bool and locks the allowlisted user out entirely.
    """
    stub_upstream(monkeypatch, google_access_token(email_verified=verified))
    assert await provider().verify_token("fastmcp-jwt") is not None


@pytest.mark.parametrize("unverified", [False, "false", "False", None, "", 1, "yes"])
async def test_unverified_email_is_rejected(
    monkeypatch: pytest.MonkeyPatch, unverified: object
) -> None:
    """An unverified Google email is self-asserted — it could be anyone's.

    Anything that is not an explicit affirmative is rejected, including values a
    naive `bool()` coercion would wave through (`"false"` is a non-empty string,
    so `bool("false")` is `True`).
    """
    stub_upstream(monkeypatch, google_access_token(email_verified=unverified))
    assert await provider().verify_token("fastmcp-jwt") is None


async def test_missing_email_verified_claim_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = google_access_token()
    del token.claims["email_verified"]
    stub_upstream(monkeypatch, token)
    assert await provider().verify_token("fastmcp-jwt") is None


async def test_missing_email_claim_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    stub_upstream(monkeypatch, google_access_token(email=None))
    assert await provider().verify_token("fastmcp-jwt") is None


async def test_upstream_rejection_stays_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A token Google refuses must not be rescued by the allowlist check."""
    stub_upstream(monkeypatch, None)
    assert await provider().verify_token("bad-token") is None


async def test_allowlist_is_enforced_per_request_not_per_issuance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tightening the allowlist must invalidate already-issued tokens immediately."""
    stub_upstream(monkeypatch, google_access_token())
    assert await provider().verify_token("fastmcp-jwt") is not None
    assert (
        await provider(allowed_email="new.owner@gmail.com").verify_token("fastmcp-jwt")
        is None
    )


# --- RFC 9728 discovery + 401 challenge ----------------------------------


@pytest.fixture
def http() -> TestClient:
    """A real Starlette app for the google-mode server, with the BYOI faked."""
    server = build_server(make_google_config(), client=FakeByoi())
    return TestClient(server.http_app())


def test_unauthenticated_mcp_call_is_401_with_resource_metadata(
    http: TestClient,
) -> None:
    with http as client:
        response = client.post("/mcp", json=MCP_REQUEST, headers=MCP_HEADERS)
    assert response.status_code == 401
    challenge = response.headers["www-authenticate"]
    assert challenge.startswith("Bearer ")
    assert (
        'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"'
        in challenge
    )


def test_garbage_bearer_is_401(http: TestClient) -> None:
    with http as client:
        response = client.post(
            "/mcp",
            json=MCP_REQUEST,
            headers={**MCP_HEADERS, "Authorization": "Bearer not-a-real-token"},
        )
    assert response.status_code == 401


def test_static_token_does_not_work_in_google_mode(http: TestClient) -> None:
    """Config drops the static bearer in google mode; there is no second way in."""
    with http as client:
        response = client.post(
            "/mcp",
            json=MCP_REQUEST,
            headers={**MCP_HEADERS, "Authorization": "Bearer client-token"},
        )
    assert response.status_code == 401


def test_protected_resource_metadata_document(http: TestClient) -> None:
    """RFC 9728: resource identity + the AS that issues tokens for it."""
    with http as client:
        response = client.get("/.well-known/oauth-protected-resource/mcp")
    assert response.status_code == 200
    body = response.json()
    assert body["resource"] == "https://mcp.example.com/mcp"
    assert body["authorization_servers"] == ["https://mcp.example.com/"]
    assert body["bearer_methods_supported"] == ["header"]


def test_authorization_server_metadata_is_discoverable(http: TestClient) -> None:
    """The proxy fronts Google as a DCR-capable AS, which is why OAuthProxy exists."""
    with http as client:
        response = client.get("/.well-known/oauth-authorization-server")
    assert response.status_code == 200
    body = response.json()
    assert body["issuer"] == "https://mcp.example.com/"
    assert body["registration_endpoint"] == "https://mcp.example.com/register"
    assert "S256" in body["code_challenge_methods_supported"]


def test_authorize_endpoint_is_served(http: TestClient) -> None:
    with http as client:
        response = client.get("/authorize", follow_redirects=False)
    # Missing params, but the route exists — 404 would mean the flow is unreachable.
    assert response.status_code != 404


def test_tools_are_not_listable_without_auth(http: TestClient) -> None:
    """Fail closed: the tool surface must not leak to an unauthenticated caller."""
    with http as client:
        response = client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            headers=MCP_HEADERS,
        )
    assert response.status_code == 401
    assert "save_memory" not in response.text


# --- container healthcheck ----------------------------------------------


def test_healthz_is_reachable_without_auth(http: TestClient) -> None:
    """The Docker healthcheck has no token, so `/healthz` must bypass auth.

    Without this the container would be marked unhealthy forever in google mode,
    since every `/mcp` request correctly answers 401.
    """
    with http as client:
        response = client.get("/healthz")
    assert response.status_code == 200
    assert response.text == "ok"


def test_healthz_leaks_nothing(http: TestClient) -> None:
    """It is public, so it must not confirm the allowlisted identity or config."""
    with http as client:
        body = client.get("/healthz").text
    assert ALLOWED_EMAIL not in body
    assert "mcp.example.com" not in body
