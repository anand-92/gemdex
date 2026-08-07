#!/usr/bin/env python
"""End-to-end smoke test over Streamable HTTP against a live BYOI server.

Starts this service on an ephemeral loopback port, connects a real MCP client
over Streamable HTTP with the static bearer, and runs the acceptance path:

    save_memory (with a transcript attachment) → recall → read_attachment

Requires a running `gemdex-server` (default `http://127.0.0.1:8765`) with
`GEMDEX_SERVER_TOKEN` available in the environment or `~/.gemdex/.env`. This
writes ONE real memory into the live pool, titled with a `SMOKE_TITLE_PREFIX`
so it is easy to spot and delete from the desktop app afterwards.

    uv run python scripts/smoke.py
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import secrets
import socket
import sys
import time

from fastmcp import Client
from fastmcp.client.auth import BearerAuth

from gemdex_mcp_http.byoi import ByoiClient, ByoiError
from gemdex_mcp_http.config import ConfigError, load_config
from gemdex_mcp_http.server import build_server

SMOKE_TITLE_PREFIX = "gemdex-mcp-http smoke"
TRANSCRIPT_TEXT = "line one\nline two\nline three — smoke transcript\n"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def step(message: str) -> None:
    print(f"  → {message}", flush=True)


async def wait_for_endpoint(url: str, timeout_s: float = 20.0) -> None:
    """Poll the MCP endpoint until uvicorn is accepting connections."""
    host, port = url.split("://", 1)[1].split("/", 1)[0].rsplit(":", 1)
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            _, writer = await asyncio.open_connection(host, int(port))
            writer.close()
            await writer.wait_closed()
            return
        except OSError:
            await asyncio.sleep(0.1)
    raise TimeoutError(f"{url} did not start within {timeout_s}s")


async def check_byoi_reachable(url: str, token: str) -> None:
    async with ByoiClient(url, token, timeout_ms=5_000) as client:
        await client.list()


async def run() -> int:
    port = free_port()
    client_token = secrets.token_hex(16)
    try:
        config = load_config(
            env={
                **os.environ,
                "GEMDEX_MCP_HTTP_TOKEN": client_token,
                "GEMDEX_MCP_HTTP_PORT": str(port),
                "GEMDEX_MCP_HTTP_HOST": "127.0.0.1",
                "GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH": "false",
            }
        )
    except ConfigError as error:
        print(f"smoke: {error}", file=sys.stderr)
        return 1

    print(f"BYOI:  {config.byoi_url}/v1")
    print(f"MCP:   {config.endpoint}\n")

    step("checking the BYOI server is reachable and the token authenticates")
    try:
        await check_byoi_reachable(config.byoi_url, config.byoi_token)
    except ByoiError as error:
        print(f"smoke: BYOI unreachable — {error}", file=sys.stderr)
        print("smoke: start gemdex-server first, or set GEMDEX_SERVER_URL.", file=sys.stderr)
        return 1

    mcp = build_server(config)
    server_task = asyncio.create_task(
        mcp.run_async(transport="http", host=config.host, port=config.port, show_banner=False)
    )
    try:
        await wait_for_endpoint(config.endpoint)
        step("MCP server is up; connecting a Streamable HTTP client")

        async with Client(config.endpoint, auth=BearerAuth(client_token)) as client:
            names = [tool.name for tool in await client.list_tools()]
            step(f"tools/list → {', '.join(names)}")
            assert names == [
                "save_memory",
                "recall",
                "get_memory",
                "update_memory",
                "report_outcome",
                "read_attachment",
            ], f"unexpected tool surface: {names}"

            marker = secrets.token_hex(4)
            title = f"{SMOKE_TITLE_PREFIX} {marker}"
            saved = await client.call_tool(
                "save_memory",
                {
                    "content": (
                        f"Smoke test memory {marker}. The gemdex-mcp-http service speaks "
                        "Streamable HTTP at /mcp and delegates every tool to the colocated BYOI /v1 API."
                    ),
                    "title": title,
                    "attachments": [
                        {
                            "mimeType": "text/plain",
                            "data": base64.b64encode(TRANSCRIPT_TEXT.encode()).decode(),
                            "caption": "Full transcript (source file)",
                        }
                    ],
                },
            )
            saved_text = saved.content[0].text
            step(f"save_memory → {saved_text.splitlines()[0]}")
            memory_id = next(
                line.removeprefix("id: ").strip()
                for line in saved_text.splitlines()
                if line.startswith("id: ")
            )
            step(f"saved id {memory_id}")

            recalled = await client.call_tool("recall", {"query": f"Smoke test memory {marker}"})
            recalled_text = recalled.content[0].text
            assert memory_id in recalled_text, f"recall did not surface {memory_id}:\n{recalled_text}"
            assert "titles only" in recalled_text, "recall must return the title index"
            assert "Scores: fused=" not in recalled_text, "title-index recall must not include score lines"
            step(f"recall → {recalled_text.splitlines()[0]}")

            opened = await client.call_tool("get_memory", {"id": memory_id})
            opened_text = opened.content[0].text
            assert f"Smoke test memory {marker}" in opened_text, (
                f"get_memory did not return full body:\n{opened_text}"
            )
            step(f"get_memory → {opened_text.splitlines()[0]}")

            attachment = await client.call_tool("read_attachment", {"memory_id": memory_id})
            attachment_text = attachment.content[0].text
            assert TRANSCRIPT_TEXT.strip() in attachment_text, (
                f"read_attachment did not return the transcript bytes:\n{attachment_text}"
            )
            step("read_attachment → transcript bytes returned as utf-8")

        # Auth must actually be enforced, not just configured.
        step("verifying a wrong bearer is rejected")
        try:
            async with Client(config.endpoint, auth=BearerAuth("not-the-token")) as bad_client:
                await bad_client.list_tools()
        except Exception:  # noqa: BLE001 - any rejection is a pass
            step("wrong bearer rejected")
        else:
            print("smoke: FAIL — an invalid bearer token was accepted", file=sys.stderr)
            return 1
    finally:
        # Cancelling uvicorn mid-lifespan logs a CancelledError traceback that
        # has nothing to do with the result; silence it so a PASS reads as a PASS.
        logging.getLogger("uvicorn.error").setLevel(logging.CRITICAL)
        server_task.cancel()
        try:
            await server_task
        except asyncio.CancelledError:
            pass

    print("\nPASS — save_memory → recall → get_memory → read_attachment over Streamable HTTP.")
    print(f"Note: left one real memory in the pool, titled '{SMOKE_TITLE_PREFIX} …'.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
