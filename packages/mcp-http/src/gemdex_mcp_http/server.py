"""FastMCP v4 server exposing the six Gemdex tools over Streamable HTTP.

`build_server()` wires config → BYOI client → tool wrappers → FastMCP instance;
`main()` is the `gemdex-mcp-http` entrypoint and runs the HTTP transport, which
serves the MCP endpoint at `/mcp`.
"""

from __future__ import annotations

import sys
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse

from .auth import build_auth_provider
from .byoi import ByoiClient
from .config import Config, ConfigError, load_config
from .descriptions import (
    LIST_MEMORIES,
    READ_ATTACHMENT,
    RECALL,
    REPORT_OUTCOME,
    SAVE_MEMORY,
    UPDATE_MEMORY,
)
from .stats import MemoryStatsStore
from .sync import SYNC_RECORDS_PATH, handle_sync_records
from .tools import GemdexTools

SERVER_NAME = "gemdex"

INSTRUCTIONS = """
Gemdex is a global, persistent memory layer for AI coding agents. Save durable
knowledge once and recall it across every repo, session, and machine.

Use `recall` proactively before solving a problem or asking the user something
they may have already told you, and `save_memory` the moment you learn something
reusable. `report_outcome` after acting on a recalled memory. Attachments must be
inline base64 over this transport — local file paths refer to a different machine.
"""

#: Tool registration order matches the frozen tuple in
#: `packages/mcp/src/tool-names.ts`. There is deliberately NO delete tool:
#: deletion is a human action in the desktop app.
_TOOL_DESCRIPTIONS = {
    "save_memory": SAVE_MEMORY,
    "recall": RECALL,
    "update_memory": UPDATE_MEMORY,
    "list_memories": LIST_MEMORIES,
    "report_outcome": REPORT_OUTCOME,
    "read_attachment": READ_ATTACHMENT,
}


def build_server(config: Config, client: ByoiClient | None = None) -> FastMCP:
    """Build the configured FastMCP server.

    Pass `client` to inject a pre-built (or fake) BYOI client; otherwise one is
    created from `config` and closed when the server's lifespan ends.
    """
    owns_client = client is None
    byoi = client if client is not None else ByoiClient(config.byoi_url, config.byoi_token, config.timeout_ms)
    tools = GemdexTools(byoi, MemoryStatsStore(), trust_ranking=config.trust_ranking)

    @asynccontextmanager
    async def lifespan(_server: FastMCP) -> AsyncIterator[None]:
        try:
            yield
        finally:
            if owns_client:
                await byoi.aclose()

    auth = build_auth_provider(config)
    mcp = FastMCP(
        name=SERVER_NAME,
        instructions=INSTRUCTIONS.strip(),
        auth=auth,
        lifespan=lifespan,
    )

    for name, description in _TOOL_DESCRIPTIONS.items():
        mcp.tool(getattr(tools, name), name=name, description=description.strip())

    @mcp.custom_route("/healthz", methods=["GET"])
    async def healthz(_request: Request) -> PlainTextResponse:
        """Liveness probe for the container healthcheck and the edge.

        Deliberately unauthenticated — FastMCP exempts custom routes from auth
        middleware by design, which is what makes this usable as a Docker
        healthcheck in `google` mode where every `/mcp` call is a 401.

        Liveness only: it says this process is serving, not that the BYOI is
        reachable. Probing BYOI from here would make an unauthenticated endpoint
        a backend availability oracle, and would take the MCP container down for
        a failure that belongs to a different service's healthcheck.
        """
        return PlainTextResponse("ok")

    @mcp.custom_route(SYNC_RECORDS_PATH, methods=["POST"])
    async def sync_records(request: Request) -> JSONResponse:
        """Upsert chat-history digests by deterministic id (`gemdex sync-history`).

        Not a tool — agents never see it (see `sync.py` for why upsert-by-id
        cannot be a tool). Unlike `/healthz` this route enforces auth itself,
        because FastMCP exempts custom routes from its auth middleware and this
        one writes to the memory pool.
        """
        return await handle_sync_records(request, byoi, auth)

    return mcp


def main() -> int:
    """`gemdex-mcp-http` entrypoint. Fails fast (non-zero) on bad configuration."""
    try:
        config = load_config()
    except ConfigError as error:
        print(f"gemdex-mcp-http: {error}", file=sys.stderr)
        return 1

    if config.unsafe_no_auth:
        print(
            "gemdex-mcp-http: WARNING — client auth is DISABLED "
            "(GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH=true). Loopback development only.",
            file=sys.stderr,
        )
    elif config.auth_mode == "google":
        print(
            f"gemdex-mcp-http: auth=google (OAuth 2.1), single user {config.allowed_email}, "
            f"issuer {config.public_base_url}",
            file=sys.stderr,
        )
    else:
        print("gemdex-mcp-http: auth=static bearer", file=sys.stderr)
    print(f"gemdex-mcp-http: BYOI {config.byoi_url}/v1 → MCP {config.endpoint}", file=sys.stderr)

    mcp = build_server(config)
    mcp.run(transport="http", host=config.host, port=config.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
