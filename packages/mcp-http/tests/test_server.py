"""Server wiring: the tool surface an MCP client actually sees, and the auth seam."""

from __future__ import annotations

import pytest
from fastmcp import Client
from fastmcp.server.auth.providers.jwt import StaticTokenVerifier

from gemdex_mcp_http.auth import build_auth_provider
from gemdex_mcp_http.server import build_server

from .conftest import FakeByoi, make_config, make_memory

EXPECTED_TOOLS = [
    "save_memory",
    "recall",
    "update_memory",
    "list_memories",
    "report_outcome",
    "read_attachment",
]


async def test_exposes_exactly_the_six_tools_in_order(client: Client) -> None:
    async with client:
        names = [tool.name for tool in await client.list_tools()]
    assert names == EXPECTED_TOOLS


async def test_no_delete_tool(client: Client) -> None:
    """No agent-facing delete, by design — deletion is a human action in the app."""
    async with client:
        names = [tool.name for tool in await client.list_tools()]
    assert not any("delete" in name for name in names)


async def test_required_fields_match_the_stdio_schemas(client: Client) -> None:
    async with client:
        schemas = {tool.name: tool.input_schema for tool in await client.list_tools()}
    assert schemas["save_memory"].get("required") in (None, [])
    assert schemas["recall"].get("required") in (None, [])
    assert schemas["list_memories"].get("required") in (None, [])
    assert schemas["update_memory"]["required"] == ["id"]
    assert sorted(schemas["report_outcome"]["required"]) == ["id", "outcome"]
    assert schemas["read_attachment"]["required"] == ["memory_id"]


async def test_recall_over_mcp_returns_rendered_text(client: Client, byoi: FakeByoi) -> None:
    byoi.recall_results = [{**make_memory(), "score": 0.25}]
    async with client:
        result = await client.call_tool("recall", {"query": "deploy"})
    assert 'Recalled 1 memory for "deploy":' in result.content[0].text


async def test_tool_error_is_reported_not_raised_as_crash(client: Client) -> None:
    async with client:
        result = await client.call_tool("save_memory", {}, raise_on_error=False)
    assert result.is_error
    assert "provide 'content' or at least one attachment" in result.content[0].text


async def test_attachments_field_documents_the_host_local_constraint(client: Client) -> None:
    async with client:
        schemas = {tool.name: tool.input_schema for tool in await client.list_tools()}
    description = schemas["save_memory"]["properties"]["attachments"]["description"]
    assert "'path' is NOT supported over this HTTP transport" in description
    assert "inline base64 'data'" in description


async def test_lifespan_closes_an_owned_byoi_client() -> None:
    """A server that built its own client must close it; an injected one is the caller's."""
    injected = FakeByoi()
    async with Client(build_server(make_config(unsafe_no_auth=True, client_token=None), client=injected)):
        pass
    assert ("aclose", None) not in injected.calls


# --- auth seam -----------------------------------------------------------


def test_static_bearer_is_the_default_provider() -> None:
    provider = build_auth_provider(make_config(client_token="tok"))
    assert isinstance(provider, StaticTokenVerifier)


def test_unsafe_no_auth_yields_no_provider() -> None:
    assert build_auth_provider(make_config(unsafe_no_auth=True, client_token=None)) is None


@pytest.mark.parametrize("token", ["tok-a", "tok-b"])
def test_configured_token_is_the_only_accepted_one(token: str) -> None:
    provider = build_auth_provider(make_config(client_token=token))
    assert isinstance(provider, StaticTokenVerifier)
    assert list(provider.tokens) == [token]
