"""The login gate: Google authorization-code flow, narrowed to one email.

**This is the whole auth surface of the package.** Nothing in `app.py` or
`routes.py` may branch on the auth mode; if you find yourself writing
`if config.auth_mode` outside this module, the seam is leaking (the same rule
`gemdex-mcp-http`'s `auth.py` follows).

The browser flow, and why it is a *different* mechanism from mcp-http's:

    mcp-http  is an OAuth 2.1 **resource server** — an MCP client brings its own
              token and FastMCP verifies it on every call.
    this app  is an OAuth **client** (relying party) — it runs the
              authorization-code flow itself, then keeps its own signed session
              cookie. Browsers cannot present bearer tokens, so a cookie is the
              only thing that survives a page load.

Both end at the same check: is the verified Google email exactly
`GEMDEX_ALLOWED_EMAIL`.
"""

from __future__ import annotations

import base64
import binascii
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any

import httpx2
from fastapi import HTTPException, Request

from .config import (
    GOOGLE_AUTH_ENDPOINT,
    GOOGLE_SCOPES,
    GOOGLE_TOKEN_ENDPOINT,
    Config,
)

#: Session keys. `email` is the identity; `iat` is when the login happened.
SESSION_EMAIL = "email"
SESSION_ISSUED_AT = "iat"
#: Transient keys for the in-flight OAuth handshake, cleared on completion.
SESSION_STATE = "oauth_state"
SESSION_NONCE = "oauth_nonce"
SESSION_RETURN_TO = "return_to"

#: The identity `dev` mode reports. Not an address anyone can receive mail at,
#: so it cannot collide with a real allowlisted account in logs or the UI.
DEV_EMAIL = "dev@localhost"

GOOGLE_ISSUERS = {"https://accounts.google.com", "accounts.google.com"}


class AuthError(Exception):
    """The login attempt failed. `detail` is safe to show the user."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


@dataclass(frozen=True)
class Identity:
    """A verified, allowlisted user."""

    email: str


def _b64url_decode(segment: str) -> bytes:
    """Decode a JWT segment, restoring the stripped base64url padding."""
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


def decode_id_token_claims(id_token: str) -> dict[str, Any]:
    """Return the claim set of a Google ID token **without** verifying its signature.

    This is deliberate and spec-sanctioned, not a shortcut. OpenID Connect Core
    §3.1.3.7 item 6 permits skipping signature validation when the ID token is
    received *directly from the token endpoint over a TLS-protected channel* —
    which is exactly this flow: we POST the authorization code plus our client
    secret to `oauth2.googleapis.com` and read the response body. There is no
    untrusted party in between who could have substituted the token, so the TLS
    channel plus proof of client authentication is the integrity guarantee.

    The caller MUST still check `iss`, `aud`, `exp`, and `email_verified` — those
    are semantic checks that TLS does not make for us. `verify_google_identity`
    does all four.

    If this ever changes to accept an ID token from anywhere else (a browser
    postMessage, an implicit-flow fragment, a client-supplied assertion), this
    function becomes unsafe and real JWKS signature verification is required.
    """
    parts = id_token.split(".")
    if len(parts) != 3:
        raise AuthError("Google returned a malformed ID token.")
    try:
        claims = json.loads(_b64url_decode(parts[1]))
    except (ValueError, binascii.Error) as error:
        raise AuthError("Google returned an ID token with an unreadable payload.") from error
    if not isinstance(claims, dict):
        raise AuthError("Google returned an ID token whose payload is not an object.")
    return claims


def verify_google_identity(claims: dict[str, Any], config: Config, expected_nonce: str | None) -> Identity:
    """Validate ID-token claims and enforce the single-user allowlist.

    Every check here fails *closed*. The order is cheapest-first, but each is
    independently required:

    - `iss` — the token must be Google's.
    - `aud` — it must have been minted for *our* client, not another site's.
      Without this, a token issued to any other Google OAuth client would be
      accepted (the classic confused-deputy on ID tokens).
    - `nonce` — binds the token to the session that started this login, so a
      token captured from another flow cannot be replayed into ours.
    - `exp` — expiry, with no grace window.
    - `email_verified` — an unverified Google email is self-asserted, so
      accepting it would let anyone claim the allowlisted address. (The same
      guard, for the same reason, as mcp-http's `SingleUserGoogleProvider`.)
    - `email` — must equal the allowlist exactly, compared case-insensitively.
    """
    if claims.get("iss") not in GOOGLE_ISSUERS:
        raise AuthError("ID token was not issued by Google.")

    audience = claims.get("aud")
    if audience != config.google_client_id:
        raise AuthError("ID token was issued for a different OAuth client.")

    if expected_nonce is not None and claims.get("nonce") != expected_nonce:
        raise AuthError("ID token nonce did not match this login attempt.")

    expires_at = claims.get("exp")
    if not isinstance(expires_at, (int, float)) or expires_at <= time.time():
        raise AuthError("ID token is expired or has no expiry.")

    # Google sends this as a real bool, but it arrives as the string "true"
    # through some paths; accept both and nothing else.
    verified = claims.get("email_verified")
    if verified is not True and str(verified).lower() != "true":
        raise AuthError("Google account email is not verified.")

    email = claims.get("email")
    if not isinstance(email, str) or not email.strip():
        raise AuthError("ID token carries no email claim.")

    normalized = email.strip().lower()
    if normalized != config.allowed_email:
        # Deliberately does not echo the allowlisted address back — that would
        # tell an attacker which account to go after.
        raise AuthError("This Google account is not permitted to use this Gemdex instance.")

    return Identity(email=normalized)


def build_authorization_url(config: Config, state: str, nonce: str) -> str:
    """The Google consent URL to redirect the browser to."""
    from urllib.parse import urlencode

    params = {
        "client_id": config.google_client_id or "",
        "redirect_uri": config.redirect_uri or "",
        "response_type": "code",
        "scope": " ".join(GOOGLE_SCOPES),
        "state": state,
        "nonce": nonce,
        # Single-user app: skip the account chooser when only one session
        # exists, but still allow switching if the wrong account is signed in.
        "prompt": "select_account",
    }
    return f"{GOOGLE_AUTH_ENDPOINT}?{urlencode(params)}"


async def exchange_code_for_identity(
    code: str,
    config: Config,
    expected_nonce: str | None,
    client: httpx2.AsyncClient | None = None,
) -> Identity:
    """Trade an authorization code for a verified, allowlisted identity.

    The Google access token that comes back is used for **nothing** and is not
    retained: the ID token carries the identity, and this app authenticates to
    the BYOI with its own server-side bearer. Keeping the user's Google token
    would be a credential we have no use for and would have to protect.
    """
    owns_client = client is None
    http = client if client is not None else httpx2.AsyncClient(timeout=config.timeout_ms / 1000)
    try:
        response = await http.post(
            GOOGLE_TOKEN_ENDPOINT,
            data={
                "code": code,
                "client_id": config.google_client_id or "",
                "client_secret": config.google_client_secret or "",
                "redirect_uri": config.redirect_uri or "",
                "grant_type": "authorization_code",
            },
            headers={"Accept": "application/json"},
        )
    except httpx2.HTTPError as error:
        raise AuthError(f"Could not reach Google to complete sign-in: {error}") from error
    finally:
        if owns_client:
            await http.aclose()

    if not response.is_success:
        # Google's body here can include the client_secret in an echoed request
        # on some error paths, so report only the status.
        raise AuthError(f"Google rejected the sign-in code (HTTP {response.status_code}).")

    try:
        payload = response.json()
    except ValueError as error:
        raise AuthError("Google returned an unreadable token response.") from error

    id_token = payload.get("id_token") if isinstance(payload, dict) else None
    if not isinstance(id_token, str) or not id_token:
        raise AuthError("Google's token response carried no ID token.")

    return verify_google_identity(decode_id_token_claims(id_token), config, expected_nonce)


def start_login(request: Request, config: Config, return_to: str | None = None) -> str:
    """Begin the OAuth handshake; returns the URL to redirect to.

    `state` is stored in the session and compared on return — the CSRF defense
    for the callback. Without it, an attacker could feed the victim's browser a
    callback URL bearing the attacker's own code and log them into the wrong
    account.
    """
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    request.session[SESSION_STATE] = state
    request.session[SESSION_NONCE] = nonce
    if return_to:
        request.session[SESSION_RETURN_TO] = return_to
    return build_authorization_url(config, state, nonce)


def consume_login_state(request: Request, received_state: str | None) -> str | None:
    """Validate the returned `state` and pop the handshake keys.

    Returns the stored nonce. Raises `AuthError` on any mismatch. The stored
    values are cleared either way, so a state cannot be replayed.
    """
    expected_state = request.session.pop(SESSION_STATE, None)
    nonce = request.session.pop(SESSION_NONCE, None)

    if not expected_state:
        raise AuthError("No sign-in was in progress. Start again from the login page.")
    if not received_state or not secrets.compare_digest(received_state, expected_state):
        raise AuthError("Sign-in state did not match. Start again from the login page.")
    return nonce if isinstance(nonce, str) else None


def establish_session(request: Request, identity: Identity) -> None:
    """Mark the session as logged in as `identity`."""
    request.session[SESSION_EMAIL] = identity.email
    request.session[SESSION_ISSUED_AT] = int(time.time())


def clear_session(request: Request) -> None:
    request.session.clear()


def current_identity(request: Request, config: Config) -> Identity | None:
    """The logged-in, still-allowlisted identity, or `None`.

    Re-checks the allowlist on **every request** rather than trusting that the
    session was allowlisted when it was created. This is the browser analogue of
    the `verify_token` lesson from mcp-http: sessions outlive configuration, so
    removing an address from `GEMDEX_ALLOWED_EMAIL` must invalidate the sessions
    it already has, not just block future logins.
    """
    if config.auth_mode == "dev":
        return Identity(email=DEV_EMAIL)

    email = request.session.get(SESSION_EMAIL)
    if not isinstance(email, str) or not email:
        return None
    if email.strip().lower() != config.allowed_email:
        return None

    # Enforce the TTL here as well as via SessionMiddleware's `max_age`.
    # Starlette's signer already rejects a cookie older than `max_age`, so this
    # is a second check of the same rule — kept because the failure mode is
    # asymmetric: if the middleware is ever constructed without `max_age`, the
    # cookie becomes effectively immortal and nothing would notice, whereas a
    # redundant check costs one comparison.
    issued_at = request.session.get(SESSION_ISSUED_AT)
    if not isinstance(issued_at, (int, float)):
        return None
    if time.time() - issued_at > config.session_ttl_seconds:
        return None

    return Identity(email=email)


def require_identity(request: Request) -> Identity:
    """FastAPI dependency: 401 unless the caller holds a valid session.

    Fails closed — every data route depends on this, so a route that forgets it
    is the only way to get an unauthenticated read, which the tests check for by
    enumerating the router.
    """
    config: Config = request.app.state.config
    identity = current_identity(request, config)
    if identity is None:
        raise HTTPException(
            status_code=401,
            detail="Not signed in.",
            # Tells the SPA where to send the user without hardcoding the path
            # in the frontend.
            headers={"X-Gemdex-Login": "/auth/login"},
        )
    return identity
