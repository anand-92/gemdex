"""The pluggable auth seam.

Everything auth-related lives behind `build_auth_provider(config)`. Today it
returns a `StaticTokenVerifier` over the single configured bearer token — the
interim scheme that lets this service ship before OAuth. GEM2-3 replaces the
body of this one function with an OAuth 2.1 Resource Server provider; nothing in
`server.py` or `tools.py` should ever branch on the auth mode.
"""

from __future__ import annotations

from fastmcp.server.auth import AuthProvider
from fastmcp.server.auth.providers.jwt import StaticTokenVerifier

from .config import Config

#: `client_id` claim attached to the interim static token. Once OAuth lands the
#: real client identity arrives from the authorization server instead.
STATIC_CLIENT_ID = "gemdex-mcp-http-static"


def build_auth_provider(config: Config) -> AuthProvider | None:
    """The configured auth provider, or `None` when auth is explicitly disabled.

    `None` is only reachable via `GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH=true` — the
    config layer refuses to boot an authless server otherwise.
    """
    if config.unsafe_no_auth:
        return None
    # config.client_token is non-None whenever unsafe_no_auth is False.
    assert config.client_token is not None
    return StaticTokenVerifier(
        tokens={config.client_token: {"client_id": STATIC_CLIENT_ID, "scopes": []}},
    )
