"""The login gate. These are the security tests; treat a failure as a breach.

Two properties are asserted from opposite directions:

- **no session ⇒ no data** (401), and
- **wrong identity ⇒ no data**, whether that identity arrives as a fresh Google
  login or as a session cookie that was valid before the allowlist changed.
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from gemdex_web.app import SESSION_COOKIE, create_app
from gemdex_web.auth import (
    SESSION_EMAIL,
    SESSION_ISSUED_AT,
    AuthError,
    Identity,
    decode_id_token_claims,
    verify_google_identity,
)

from .conftest import (
    ALLOWED_EMAIL,
    CLIENT_ID,
    OTHER_EMAIL,
    FakeByoi,
    make_dev_config,
    make_google_config,
    memory,
)

#: Every route that must never answer without a session. Kept explicit so a
#: reviewer can see the whole protected surface in one list.
PROTECTED = [
    ("GET", "/api/memories"),
    ("GET", "/api/memories/mem-1"),
    ("POST", "/api/memories"),
    ("PATCH", "/api/memories/mem-1"),
    ("DELETE", "/api/memories/mem-1"),
    ("POST", "/api/recall"),
    ("GET", "/api/memories/mem-1/attachments/0"),
    ("GET", "/api/status"),
]


def google_client(fake_byoi: FakeByoi, **overrides: str) -> TestClient:
    """A client on an **https** origin.

    Not cosmetic: google mode sets `Secure` on the session cookie, and a
    `Secure` cookie is inert over plaintext — on the default `http://testserver`
    origin the logout test fails even though the server sends a correct
    expiring `Set-Cookie`. An https base URL matches how this mode actually
    runs.
    """
    app = create_app(make_google_config(**overrides), byoi=fake_byoi)
    return TestClient(app, base_url="https://testserver")


def sign_in(client: TestClient, email: str, issued_at: int | None = None) -> None:
    """Forge a *legitimately signed* session cookie for `email`.

    Uses the app's own SessionMiddleware to sign it, so this exercises the real
    cookie path rather than monkeypatching the identity check. That is what
    makes the "valid cookie, since-removed email" test meaningful.
    """
    from itsdangerous import TimestampSigner
    import base64
    import json

    from .conftest import SESSION_SECRET

    data = {SESSION_EMAIL: email, SESSION_ISSUED_AT: issued_at or int(time.time())}
    payload = base64.b64encode(json.dumps(data).encode())
    signed = TimestampSigner(SESSION_SECRET).sign(payload).decode()
    client.cookies.set(SESSION_COOKIE, signed)


# --- unauthenticated ------------------------------------------------------


@pytest.mark.parametrize("method,path", PROTECTED)
def test_no_session_is_401(method: str, path: str, fake_byoi: FakeByoi) -> None:
    response = google_client(fake_byoi).request(method, path, json={})
    assert response.status_code == 401
    # The 401 must arrive *before* any upstream call: an unauthenticated request
    # should not be able to make this server touch the memory pool at all.
    assert fake_byoi.calls == []


def test_unauthenticated_401_points_at_the_login_route(fake_byoi: FakeByoi) -> None:
    response = google_client(fake_byoi).get("/api/memories")
    assert response.headers["x-gemdex-login"] == "/auth/login"


def test_session_probe_is_reachable_without_a_session(fake_byoi: FakeByoi) -> None:
    """`/api/session` must answer anonymously — it is how the SPA learns to log in."""
    response = google_client(fake_byoi).get("/api/session")
    assert response.status_code == 200
    body = response.json()
    assert body["authenticated"] is False
    assert body["email"] is None
    # Must not disclose who *would* be allowed in.
    assert ALLOWED_EMAIL not in response.text


def test_healthz_is_unauthenticated(fake_byoi: FakeByoi) -> None:
    """The container healthcheck must work in google mode, where /api is all 401s."""
    response = google_client(fake_byoi).get("/healthz")
    assert response.status_code == 200
    assert response.text == "ok"
    # Liveness only — it must not have probed the BYOI.
    assert fake_byoi.calls == []


# --- authenticated --------------------------------------------------------


def test_allowlisted_session_can_read(fake_byoi: FakeByoi) -> None:
    fake_byoi.memories.append(memory())
    client = google_client(fake_byoi)
    sign_in(client, ALLOWED_EMAIL)
    response = client.get("/api/memories")
    assert response.status_code == 200
    assert len(response.json()["memories"]) == 1


def test_wrong_email_with_a_validly_signed_cookie_is_rejected(fake_byoi: FakeByoi) -> None:
    """A correctly signed session for a non-allowlisted address gets nothing.

    This is the case that matters most: the cookie's signature is genuine, so
    only the per-request allowlist check stands between the caller and the data.
    """
    client = google_client(fake_byoi)
    sign_in(client, OTHER_EMAIL)
    response = client.get("/api/memories")
    assert response.status_code == 401
    assert fake_byoi.calls == []


def test_session_for_a_since_removed_email_stops_working(fake_byoi: FakeByoi) -> None:
    """Changing the allowlist invalidates sessions it already issued.

    The browser analogue of mcp-http's `verify_token` lesson: identity is
    re-checked on every request, so revocation is immediate rather than "once
    the cookie expires".
    """
    client = google_client(fake_byoi)
    sign_in(client, ALLOWED_EMAIL)
    assert client.get("/api/memories").status_code == 200

    # Same signing key (so the cookie still verifies), different allowlist.
    reconfigured = create_app(make_google_config(GEMDEX_ALLOWED_EMAIL=OTHER_EMAIL), byoi=fake_byoi)
    with TestClient(reconfigured) as second:
        second.cookies = client.cookies
        assert second.get("/api/memories").status_code == 401


def test_expired_session_is_rejected(fake_byoi: FakeByoi) -> None:
    client = google_client(fake_byoi, GEMDEX_WEB_SESSION_TTL_SECONDS="60")
    sign_in(client, ALLOWED_EMAIL, issued_at=int(time.time()) - 3600)
    assert client.get("/api/memories").status_code == 401


def test_session_without_an_issued_at_is_rejected(fake_byoi: FakeByoi) -> None:
    """A cookie missing `iat` cannot be aged out, so it must not be honored."""
    import base64
    import json

    from itsdangerous import TimestampSigner

    from .conftest import SESSION_SECRET

    client = google_client(fake_byoi)
    payload = base64.b64encode(json.dumps({SESSION_EMAIL: ALLOWED_EMAIL}).encode())
    client.cookies.set(SESSION_COOKIE, TimestampSigner(SESSION_SECRET).sign(payload).decode())
    assert client.get("/api/memories").status_code == 401


def test_cookie_signed_with_another_key_is_rejected(fake_byoi: FakeByoi) -> None:
    import base64
    import json

    from itsdangerous import TimestampSigner

    client = google_client(fake_byoi)
    payload = base64.b64encode(json.dumps({SESSION_EMAIL: ALLOWED_EMAIL, SESSION_ISSUED_AT: int(time.time())}).encode())
    forged = TimestampSigner("an-attacker-controlled-key-" + "x" * 32).sign(payload).decode()
    client.cookies.set(SESSION_COOKIE, forged)
    assert client.get("/api/memories").status_code == 401


def login_via_google(client: TestClient, monkeypatch: pytest.MonkeyPatch, email: str) -> None:
    """Drive the **real** OAuth flow, stubbing only Google's token endpoint.

    Used instead of `sign_in` wherever the cookie's own lifecycle is under test:
    a cookie injected into the jar by hand is a different jar entry from the
    domain-scoped one the server sets, so the server's clearing `Set-Cookie`
    would not overwrite it and `logout` would look broken when it is not.
    Logging in for real means the jar holds exactly what a browser would.
    """
    from urllib.parse import parse_qs, urlparse

    import gemdex_web.app as app_module

    consent = client.get("/auth/login", follow_redirects=False)
    state = parse_qs(urlparse(consent.headers["location"]).query)["state"][0]

    async def fake_exchange(code: str, config: object, nonce: str | None, **_: object) -> Identity:
        return Identity(email=email)

    monkeypatch.setattr(app_module, "exchange_code_for_identity", fake_exchange)
    landed = client.get(
        f"/auth/google/callback?code=test-code&state={state}", follow_redirects=False
    )
    assert landed.status_code == 302, landed.text


def test_full_login_flow_grants_access(fake_byoi: FakeByoi, monkeypatch: pytest.MonkeyPatch) -> None:
    """End-to-end: consent redirect → callback → session cookie → data access."""
    client = google_client(fake_byoi)
    assert client.get("/api/memories").status_code == 401
    login_via_google(client, monkeypatch, ALLOWED_EMAIL)
    assert client.get("/api/session").json()["email"] == ALLOWED_EMAIL
    assert client.get("/api/memories").status_code == 200


def test_logout_clears_the_session(fake_byoi: FakeByoi, monkeypatch: pytest.MonkeyPatch) -> None:
    client = google_client(fake_byoi)
    login_via_google(client, monkeypatch, ALLOWED_EMAIL)
    assert client.get("/api/memories").status_code == 200

    response = client.post("/auth/logout")
    assert response.status_code == 200
    assert client.get("/api/memories").status_code == 401


def test_session_cookie_is_httponly_and_secure(fake_byoi: FakeByoi, monkeypatch: pytest.MonkeyPatch) -> None:
    """`HttpOnly` keeps XSS from reading the session; `Secure` keeps it off plaintext."""
    client = google_client(fake_byoi)

    from urllib.parse import parse_qs, urlparse

    import gemdex_web.app as app_module

    consent = client.get("/auth/login", follow_redirects=False)
    state = parse_qs(urlparse(consent.headers["location"]).query)["state"][0]

    async def fake_exchange(code: str, config: object, nonce: str | None, **_: object) -> Identity:
        return Identity(email=ALLOWED_EMAIL)

    monkeypatch.setattr(app_module, "exchange_code_for_identity", fake_exchange)
    landed = client.get(f"/auth/google/callback?code=c&state={state}", follow_redirects=False)

    set_cookie = landed.headers["set-cookie"].lower()
    assert "httponly" in set_cookie
    assert "secure" in set_cookie
    assert "samesite=lax" in set_cookie


# --- dev mode -------------------------------------------------------------


def test_dev_mode_allows_access_without_login(fake_byoi: FakeByoi) -> None:
    """The documented loopback escape hatch. Guarded by the bind check in config."""
    with TestClient(create_app(make_dev_config(), byoi=fake_byoi)) as client:
        assert client.get("/api/memories").status_code == 200
        assert client.get("/api/session").json()["authenticated"] is True


def test_dev_mode_has_no_oauth_callback(fake_byoi: FakeByoi) -> None:
    """Nothing should be able to establish a *real* session in dev mode."""
    with TestClient(create_app(make_dev_config(), byoi=fake_byoi)) as client:
        assert client.get("/auth/google/callback?code=x&state=y").status_code == 404


# --- ID token claim validation -------------------------------------------


def claims(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "iss": "https://accounts.google.com",
        "aud": CLIENT_ID,
        "exp": time.time() + 600,
        "email": ALLOWED_EMAIL,
        "email_verified": True,
        "nonce": "the-nonce",
    }
    base.update(overrides)
    return base


def test_valid_claims_yield_the_identity() -> None:
    identity = verify_google_identity(claims(), make_google_config(), "the-nonce")
    assert identity == Identity(email=ALLOWED_EMAIL)


@pytest.mark.parametrize(
    "overrides,reason",
    [
        ({"iss": "https://evil.example"}, "wrong issuer"),
        ({"aud": "another-client.apps.googleusercontent.com"}, "token minted for a different client"),
        ({"exp": time.time() - 1}, "expired"),
        ({"email_verified": False}, "unverified email is self-asserted"),
        ({"email_verified": "false"}, "unverified email as a string"),
        ({"email": OTHER_EMAIL}, "not the allowlisted account"),
        ({"email": None}, "no email claim"),
        ({"nonce": "a-different-nonce"}, "replayed from another login"),
    ],
)
def test_invalid_claims_are_rejected(overrides: dict[str, object], reason: str) -> None:
    with pytest.raises(AuthError):
        verify_google_identity(claims(**overrides), make_google_config(), "the-nonce")


def test_email_comparison_is_case_insensitive() -> None:
    identity = verify_google_identity(claims(email=ALLOWED_EMAIL.upper()), make_google_config(), "the-nonce")
    assert identity.email == ALLOWED_EMAIL


def test_rejection_does_not_disclose_the_allowlisted_address() -> None:
    """The error a stranger sees must not tell them which account to target."""
    with pytest.raises(AuthError) as caught:
        verify_google_identity(claims(email=OTHER_EMAIL), make_google_config(), "the-nonce")
    assert ALLOWED_EMAIL not in caught.value.detail


def test_malformed_id_token_is_an_auth_error() -> None:
    for bad in ["", "not-a-jwt", "a.b", "a.!!!!.c"]:
        with pytest.raises(AuthError):
            decode_id_token_claims(bad)


# --- open redirect --------------------------------------------------------


@pytest.mark.parametrize(
    "target",
    ["https://evil.example", "//evil.example", "http://evil.example/x"],
)
def test_login_refuses_offsite_next_targets(target: str, fake_byoi: FakeByoi) -> None:
    """An unchecked `?next=` would be a phishing primitive on a real login page."""
    client = google_client(fake_byoi)
    response = client.get(f"/auth/login?next={target}", follow_redirects=False)
    assert response.status_code == 302
    # The offsite target must not survive into the Google consent URL's state.
    assert "evil.example" not in response.headers["location"]


def test_callback_without_prior_state_is_rejected(fake_byoi: FakeByoi) -> None:
    """CSRF defense: a callback the user did not initiate cannot log them in."""
    client = google_client(fake_byoi)
    response = client.get("/auth/google/callback?code=stolen&state=guessed", follow_redirects=False)
    assert response.status_code == 403
    assert fake_byoi.calls == []
