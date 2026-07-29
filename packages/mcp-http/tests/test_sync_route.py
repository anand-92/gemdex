"""The `POST /mcp/sync/records` route: auth enforcement and payload validation.

These go through the real ASGI app (not the in-memory MCP client), because the
two things worth testing here — that FastMCP's auth-exempt custom route
enforces auth itself, and that the route is mounted where the edge already
routes — only exist at the HTTP layer.
"""

from __future__ import annotations

import base64
from typing import Any

import pytest
from fastmcp import Client
from fastmcp.server.auth.auth import AccessToken

from gemdex_mcp_http.sync import (
    MAX_RECORDS_PER_REQUEST,
    SYNC_RECORDS_PATH,
    SyncRequestError,
    validate_records,
)

from .conftest import ALLOWED_EMAIL, FakeByoi, http_client, make_config, make_google_config

TRANSCRIPT = base64.b64encode(b"User: hi\n\nAssistant: hello").decode("ascii")


def make_record(**overrides: Any) -> dict[str, Any]:
    record = {
        "id": "chat:factory:session-1",
        "title": "Deployed the edge",
        "content": "## What was done\nRan deploy.sh.\n\nFull transcript: /home/me/s.jsonl",
        "createdAt": 1_700_000_000_000,
        "updatedAt": 1_700_000_100_000,
        "attachments": [
            {
                "id": "transcript",
                "mimeType": "text/plain",
                "data": TRANSCRIPT,
                "caption": "Full transcript (source file)",
            }
        ],
    }
    record.update(overrides)
    return record


# --- validation (pure) ---------------------------------------------------


def test_accepts_a_digest_record_with_a_transcript_attachment() -> None:
    [record] = validate_records({"records": [make_record()]})
    assert record["id"] == "chat:factory:session-1"
    assert record["attachments"][0]["id"] == "transcript"
    assert record["createdAt"] == 1_700_000_000_000


def test_drops_unknown_fields_rather_than_forwarding_them() -> None:
    """A client must not be able to smuggle extra keys into the BYOI payload."""
    [record] = validate_records({"records": [make_record(similar=[{"id": "x"}], extra="nope")]})
    assert "similar" not in record
    assert "extra" not in record


@pytest.mark.parametrize(
    "body,message",
    [
        ({"records": []}, "non-empty array"),
        ({"records": "nope"}, "non-empty array"),
        ({}, "non-empty array"),
        ({"records": [{"content": "x"}]}, "'id' is required"),
        ({"records": [make_record(content="  ")]}, "'content' is required"),
    ],
)
def test_rejects_malformed_payloads(body: dict[str, Any], message: str) -> None:
    with pytest.raises(SyncRequestError, match=message):
        validate_records(body)


def test_rejects_ids_outside_the_chat_namespace() -> None:
    """The route is the sync-history path, not a general upsert-by-id back door.

    Allowing an arbitrary id would let a client overwrite any memory by id —
    a write the six-tool surface deliberately does not offer.
    """
    with pytest.raises(SyncRequestError, match="must start with 'chat:'"):
        validate_records({"records": [make_record(id="mem-abc")]})


def test_rejects_more_records_than_the_batch_limit() -> None:
    records = [make_record(id=f"chat:factory:s{index}") for index in range(MAX_RECORDS_PER_REQUEST + 1)]
    with pytest.raises(SyncRequestError, match="per-request limit"):
        validate_records({"records": records})


def test_rejects_an_attachment_without_inline_data() -> None:
    record = make_record(attachments=[{"mimeType": "text/plain"}])
    with pytest.raises(SyncRequestError, match="base64 'data' is required"):
        validate_records({"records": [record]})


# --- HTTP: auth ----------------------------------------------------------


async def test_static_mode_rejects_a_missing_bearer(byoi: FakeByoi) -> None:
    async with http_client(make_config(client_token="sync-token"), byoi) as client:
        response = await client.post(SYNC_RECORDS_PATH, json={"records": [make_record()]})
    assert response.status_code == 401
    assert response.headers["www-authenticate"].startswith("Bearer")
    # The decisive assertion: nothing reached the memory pool.
    assert byoi.calls == []


async def test_static_mode_rejects_the_wrong_bearer(byoi: FakeByoi) -> None:
    async with http_client(make_config(client_token="sync-token"), byoi) as client:
        response = await client.post(
            SYNC_RECORDS_PATH,
            json={"records": [make_record()]},
            headers={"Authorization": "Bearer not-the-token"},
        )
    assert response.status_code == 401
    assert byoi.calls == []


async def test_static_mode_accepts_the_configured_bearer_and_imports(byoi: FakeByoi) -> None:
    async with http_client(make_config(client_token="sync-token"), byoi) as client:
        response = await client.post(
            SYNC_RECORDS_PATH,
            json={"records": [make_record()]},
            headers={"Authorization": "Bearer sync-token"},
        )
    assert response.status_code == 200
    assert response.json()["imported"] == 1
    assert byoi.payload_for("import_records")[0]["id"] == "chat:factory:session-1"


async def test_google_mode_rejects_a_non_allowlisted_identity(
    byoi: FakeByoi, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The single-user allowlist must gate this route, not just `/mcp`.

    Auth is enforced by calling the provider's own `verify_token`, so
    `SingleUserGoogleProvider`'s email + `email_verified` checks apply here
    unchanged — this test would fail if the route grew its own auth logic.
    """
    from gemdex_mcp_http.auth import SingleUserGoogleProvider

    async def fake_verify(_self: Any, _token: str) -> AccessToken | None:
        # What GoogleTokenVerifier would hand back for a different Google user.
        return AccessToken(
            token="upstream",
            client_id="google",
            scopes=["openid", "email"],
            claims={"email": "someone.else@gmail.com", "email_verified": True},
        )

    monkeypatch.setattr(
        SingleUserGoogleProvider, "verify_token", SingleUserGoogleProvider.verify_token
    )
    monkeypatch.setattr(
        "fastmcp.server.auth.providers.google.GoogleProvider.verify_token", fake_verify
    )
    async with http_client(make_google_config(), byoi) as client:
        response = await client.post(
            SYNC_RECORDS_PATH,
            json={"records": [make_record()]},
            headers={"Authorization": "Bearer fastmcp-jwt"},
        )
    assert response.status_code == 401
    assert byoi.calls == []


async def test_google_mode_accepts_the_allowlisted_identity(
    byoi: FakeByoi, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_verify(_self: Any, _token: str) -> AccessToken | None:
        return AccessToken(
            token="upstream",
            client_id="google",
            scopes=["openid", "email"],
            claims={"email": ALLOWED_EMAIL, "email_verified": True},
        )

    monkeypatch.setattr(
        "fastmcp.server.auth.providers.google.GoogleProvider.verify_token", fake_verify
    )
    async with http_client(make_google_config(), byoi) as client:
        response = await client.post(
            SYNC_RECORDS_PATH,
            json={"records": [make_record()]},
            headers={"Authorization": "Bearer fastmcp-jwt"},
        )
    assert response.status_code == 200
    assert response.json()["imported"] == 1


# --- HTTP: shape ---------------------------------------------------------


async def test_upstream_failure_is_reported_as_a_bad_gateway(byoi: FakeByoi) -> None:
    byoi.raise_on = "import_records"
    async with http_client(make_config(client_token="tok"), byoi) as client:
        response = await client.post(
            SYNC_RECORDS_PATH,
            json={"records": [make_record()]},
            headers={"Authorization": "Bearer tok"},
        )
    assert response.status_code == 502
    assert "Failed to sync records" in response.json()["error"]


async def test_invalid_json_is_a_400_not_a_crash(byoi: FakeByoi) -> None:
    async with http_client(make_config(client_token="tok"), byoi) as client:
        response = await client.post(
            SYNC_RECORDS_PATH,
            content=b"{not json",
            headers={"Authorization": "Bearer tok", "Content-Type": "application/json"},
        )
    assert response.status_code == 400
    assert byoi.calls == []


async def test_sync_route_adds_no_tool_to_the_agent_surface(client: Client) -> None:
    """The route must stay invisible to agents — six tools, no upsert-by-id."""
    async with client:
        names = [tool.name for tool in await client.list_tools()]
    assert not any("sync" in name or "import" in name for name in names)
    assert len(names) == 6


async def test_healthz_stays_unauthenticated(byoi: FakeByoi) -> None:
    """Guards against 'fixing' auth by putting a gate on all custom routes."""
    async with http_client(make_config(client_token="tok"), byoi) as client:
        assert (await client.get("/healthz")).status_code == 200
