"""The pluggable auth seam.

Everything auth-related lives behind `build_auth_provider(config)`, which returns
whatever FastMCP `AuthProvider` the configured mode calls for. Nothing in
`server.py` or `tools.py` branches on the auth mode.

Two modes:

- **`static`** — one shared bearer verified by `StaticTokenVerifier`. No
  identity, no expiry, no rotation. Loopback development only.
- **`google`** — a spec-compliant OAuth 2.1 resource server (MCP Authorization,
  2025-11-25). FastMCP's `GoogleProvider` runs the flow; a single-user allowlist
  wrapped around it is what makes this *ours* rather than "any Google account".
"""

from __future__ import annotations

from fastmcp.server.auth import AuthProvider
from fastmcp.server.auth.auth import AccessToken
from fastmcp.server.auth.providers.google import GoogleProvider
from fastmcp.server.auth.providers.jwt import StaticTokenVerifier
from fastmcp.utilities.logging import get_logger

from .config import GOOGLE_SCOPES, Config

logger = get_logger(__name__)

#: `client_id` claim attached to the interim static token. In google mode the
#: real client identity arrives from Google instead.
STATIC_CLIENT_ID = "gemdex-mcp-http-static"


def _is_email_verified(token: AccessToken) -> bool:
    """Whether Google asserts the token's email is verified.

    The claim arrives in **two different shapes** and both must be accepted, or
    auth fails closed for a perfectly valid account:

    - Google's `tokeninfo` endpoint returns the JSON **string** `"true"`.
    - The v2 `userinfo` endpoint returns a real **boolean** `True` (as
      `verified_email`).

    `GoogleTokenVerifier` builds the claim as
    `token_data.get("email_verified") or user_data.get("verified_email")`, so
    whenever `tokeninfo` answers, its truthy `"true"` short-circuits the `or` and
    the boolean from `userinfo` is never reached. A strict `is True` check
    therefore rejects every real Google login.

    Anything that is not an affirmative is treated as unverified: `False`,
    `"false"`, `None`, a missing claim, or an unexpected type. An unverified
    email is self-asserted and could name someone else's account, so this must
    stay deny-by-default rather than coercing with `bool()` — `bool("false")` is
    `True`.
    """
    value = (token.claims or {}).get("email_verified")
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() == "true"
    return False


def _email_of(token: AccessToken) -> str | None:
    """The verified Google email on an access token, or `None` if absent.

    `GoogleTokenVerifier` puts `email`/`email_verified` in `claims`, sourced from
    Google's `tokeninfo` and `userinfo` endpoints. `OAuthProxy` returns that same
    verifier's `AccessToken` from its own `verify_token`, so the claim survives
    the FastMCP-JWT-to-upstream-token swap.
    """
    claims = token.claims or {}
    email = claims.get("email")
    return email.strip().lower() if isinstance(email, str) and email.strip() else None


class SingleUserGoogleProvider(GoogleProvider):
    """`GoogleProvider` narrowed to exactly one Google account.

    Google will happily authenticate *every* Google account, so the provider
    alone is an open door. This subclass re-checks the verified identity on every
    request and rejects anything that is not the allowlisted email.

    Why override `verify_token` rather than filter during the OAuth flow: the
    token a client presents is a FastMCP-issued JWT that `OAuthProxy` swaps for
    the stored upstream Google token on each call. `verify_token` is therefore
    the single choke point that every authenticated request passes through, so an
    already-issued token cannot outlive a change to the allowlist. Returning
    `None` is FastMCP's "not authenticated" signal and surfaces as a 401 with the
    `WWW-Authenticate` discovery header, which is what the MCP spec wants.

    Requiring `email_verified` matters: an unverified Google email is
    self-asserted and could be *anyone's* address, so treating it as identity
    would let an attacker claim the allowlisted account. See `_is_email_verified`
    for why that claim cannot be compared with `is True`.
    """

    def __init__(self, *, allowed_email: str, **kwargs: object) -> None:
        self._allowed_email = allowed_email.strip().lower()
        super().__init__(**kwargs)  # ty: ignore[invalid-argument-type]

    async def verify_token(self, token: str) -> AccessToken | None:
        access_token = await super().verify_token(token)
        if access_token is None:
            return None

        email = _email_of(access_token)
        if email is None:
            logger.warning(
                "Rejected a Google token with no email claim; cannot enforce the "
                "single-user allowlist without a verified identity."
            )
            return None

        if not _is_email_verified(access_token):
            logger.warning(
                "Rejected Google identity %s: email is not verified by Google.", email
            )
            return None

        if email != self._allowed_email:
            logger.warning(
                "Rejected Google identity %s: this server is single-user and only %s is allowed.",
                email,
                self._allowed_email,
            )
            return None

        return access_token


def build_auth_provider(config: Config) -> AuthProvider | None:
    """The configured auth provider, or `None` when auth is explicitly disabled.

    `None` is only reachable via `GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH=true` — the
    config layer refuses to boot an authless server otherwise.
    """
    if config.unsafe_no_auth:
        return None

    if config.auth_mode == "google":
        # load_config guarantees these four are present in google mode.
        assert config.google_client_id is not None
        assert config.google_client_secret is not None
        assert config.public_base_url is not None
        assert config.allowed_email is not None
        return SingleUserGoogleProvider(
            allowed_email=config.allowed_email,
            client_id=config.google_client_id,
            client_secret=config.google_client_secret,
            base_url=config.public_base_url,
            # issuer_url must equal base_url: FastMCP derives the advertised
            # issuer from it, and changing it later invalidates every client's
            # stored authorization server metadata, forcing a re-auth.
            issuer_url=config.public_base_url,
            required_scopes=list(GOOGLE_SCOPES),
            # Google runs its own consent screen; a second FastMCP-rendered one
            # adds a click without adding a decision.
            require_authorization_consent="external",
        )

    # config.client_token is non-None whenever static mode is not authless.
    assert config.client_token is not None
    return StaticTokenVerifier(
        tokens={config.client_token: {"client_id": STATIC_CLIENT_ID, "scopes": []}},
    )
