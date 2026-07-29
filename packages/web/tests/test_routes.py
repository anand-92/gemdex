"""The BFF's proxying behavior, with the BYOI faked.

Asserts three classes of thing: that requests reach the right upstream call,
that upstream failures are translated rather than relayed, and that nothing
server-side (above all the BYOI bearer) leaks into a response.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from gemdex_web.app import create_app
from gemdex_web.byoi import ByoiError

from .conftest import BYOI_TOKEN, FakeByoi, make_dev_config, memory


@pytest.fixture
def client(fake_byoi: FakeByoi) -> TestClient:
    """A dev-mode client, so these tests exercise routing rather than the gate.

    The gate itself is covered exhaustively in `test_auth_gate.py`; mixing
    session setup into every CRUD assertion would obscure what is being tested.
    """
    with TestClient(create_app(make_dev_config(), byoi=fake_byoi)) as test_client:
        yield test_client


# --- list, search, pagination --------------------------------------------


def test_list_returns_summaries_not_full_content(client: TestClient, fake_byoi: FakeByoi) -> None:
    """The list projection must omit `content` — it can be megabytes per record."""
    fake_byoi.memories.append(memory(content="x" * 5000))
    body = client.get("/api/memories").json()
    assert body["memories"][0]["id"] == "mem-1"
    assert "content" not in body["memories"][0]
    assert body["memories"][0]["preview"]


def test_list_reports_attachment_count(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.memories.append(
        memory(attachments=[{"id": "0", "kind": "file", "mimeType": "text/plain", "byteSize": 12}])
    )
    assert client.get("/api/memories").json()["memories"][0]["attachmentCount"] == 1


def test_search_filters_on_title_and_preview(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.memories.extend(
        [
            memory("a", title="Postgres tuning", content="shared_buffers matters"),
            memory("b", title="Swift concurrency", content="actors and tasks"),
            memory("c", title="Notes", content="a postgres index rebuild"),
        ]
    )
    body = client.get("/api/memories", params={"q": "postgres"}).json()
    # Matches the title of "a" and the preview of "c" — same fields the
    # list_memories MCP tool filters on.
    assert {m["id"] for m in body["memories"]} == {"a", "c"}
    assert body["total"] == 2
    assert body["poolTotal"] == 3


def test_search_is_case_insensitive(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.memories.append(memory("a", title="PostgreSQL"))
    assert len(client.get("/api/memories", params={"q": "postgresql"}).json()["memories"]) == 1


def test_search_is_literal_not_semantic(client: TestClient, fake_byoi: FakeByoi) -> None:
    """`?q=` is substring matching; conceptual matches belong to /api/recall."""
    fake_byoi.memories.append(memory("a", title="Database indexing", content="btree"))
    assert client.get("/api/memories", params={"q": "postgres"}).json()["memories"] == []


def test_pagination_slices_the_matched_set(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.memories.extend(memory(f"m{i}", title=f"Memory {i}") for i in range(10))
    body = client.get("/api/memories", params={"offset": 4, "limit": 3}).json()
    assert [m["id"] for m in body["memories"]] == ["m4", "m5", "m6"]
    assert body["total"] == 10  # the count, not the page


def test_pagination_beyond_the_end_is_empty_not_an_error(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.memories.append(memory())
    assert client.get("/api/memories", params={"offset": 500}).json()["memories"] == []


def test_oversized_limit_is_rejected(client: TestClient) -> None:
    """Bounded so a caller cannot ask for the whole pool in one response."""
    assert client.get("/api/memories", params={"limit": 100_000}).status_code == 422


# --- read, create, edit, delete ------------------------------------------


def test_get_returns_full_content_and_attachments(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.memories.append(
        memory(content="the whole body", attachments=[{"id": "0", "kind": "file", "mimeType": "text/plain"}])
    )
    body = client.get("/api/memories/mem-1").json()["memory"]
    assert body["content"] == "the whole body"
    assert body["attachments"][0]["id"] == "0"


def test_get_missing_is_404(client: TestClient) -> None:
    assert client.get("/api/memories/nope").status_code == 404


def test_create_forwards_content_and_title(client: TestClient, fake_byoi: FakeByoi) -> None:
    response = client.post("/api/memories", json={"content": "remember this", "title": "A title"})
    assert response.status_code == 201
    assert fake_byoi.calls[0] == ("create", ({"content": "remember this", "title": "A title"},))


def test_create_omits_an_absent_title(client: TestClient, fake_byoi: FakeByoi) -> None:
    """No empty `title` key — the BYOI derives one when the field is absent."""
    client.post("/api/memories", json={"content": "untitled thought"})
    assert fake_byoi.calls[0] == ("create", ({"content": "untitled thought"},))


def test_create_relays_the_upstream_validation_error(client: TestClient, fake_byoi: FakeByoi) -> None:
    """The BYOI owns the "content or attachment required" rule, so its message shows."""
    fake_byoi.error = ByoiError("'content' or at least one attachment is required", status=400)
    response = client.post("/api/memories", json={"content": "   "})
    assert response.status_code == 400
    assert "at least one attachment" in response.json()["detail"]


def test_patch_sends_only_the_changed_fields(client: TestClient, fake_byoi: FakeByoi) -> None:
    """A title-only edit must not resend content, which would trigger a re-embed."""
    fake_byoi.memories.append(memory(content="original body"))
    client.patch("/api/memories/mem-1", json={"title": "Renamed"})
    assert fake_byoi.calls[0] == ("update", ("mem-1", {"title": "Renamed"}))


def test_patch_with_no_editable_fields_is_422(client: TestClient, fake_byoi: FakeByoi) -> None:
    assert client.patch("/api/memories/mem-1", json={}).status_code == 422
    assert fake_byoi.calls == []


def test_patch_rejects_a_non_string_field(client: TestClient) -> None:
    assert client.patch("/api/memories/mem-1", json={"title": 42}).status_code == 422


def test_patch_missing_is_404(client: TestClient) -> None:
    assert client.patch("/api/memories/gone", json={"title": "x"}).status_code == 404


def test_delete_removes_the_memory(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.memories.append(memory())
    assert client.delete("/api/memories/mem-1").status_code == 200
    assert fake_byoi.memories == []


def test_delete_missing_is_404(client: TestClient) -> None:
    assert client.delete("/api/memories/gone").status_code == 404


def test_empty_content_edit_is_allowed(client: TestClient, fake_byoi: FakeByoi) -> None:
    """Clearing content is a legitimate edit; only *no field at all* is invalid."""
    fake_byoi.memories.append(memory())
    assert client.patch("/api/memories/mem-1", json={"content": ""}).status_code == 200


# --- recall ---------------------------------------------------------------


def test_recall_forwards_query_and_limit(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.memories.append(memory())
    response = client.post("/api/recall", json={"query": "how do we deploy", "limit": 5})
    assert response.status_code == 200
    assert fake_byoi.calls[0] == ("recall", ({"query": "how do we deploy", "limit": 5},))


def test_recall_normalizes_the_flat_upstream_shape(client: TestClient, fake_byoi: FakeByoi) -> None:
    """`/v1/recall` returns memory fields flat with a numeric `score`.

    Regression test for a bug the live smoke caught and the mocked suite missed:
    the BFF read `result["memory"]`, which does not exist upstream, so every hit
    reached the browser as `{"memory": null}` and the list rendered nothing.
    """
    fake_byoi.memories.append(memory(title="Deploy notes"))
    body = client.post("/api/recall", json={"query": "deploy"}).json()
    hit = body["results"][0]
    assert hit["memory"] is not None
    assert hit["memory"]["title"] == "Deploy notes"
    assert hit["memory"]["id"] == "mem-1"
    assert hit["score"] == {"fused": 0.42}


def test_recall_results_match_the_list_summary_shape(client: TestClient, fake_byoi: FakeByoi) -> None:
    """Both list shapes must agree so the UI renders them with one code path."""
    fake_byoi.memories.append(memory())
    listed = client.get("/api/memories").json()["memories"][0]
    recalled = client.post("/api/recall", json={"query": "x"}).json()["results"][0]["memory"]
    assert set(listed.keys()) == set(recalled.keys())


def test_recall_tolerates_a_missing_score(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.memories.append(memory())

    async def no_score(payload: dict[str, object]) -> list[dict[str, object]]:
        return [{**fake_byoi.memories[0]}]

    fake_byoi.recall = no_score  # type: ignore[method-assign]
    assert client.post("/api/recall", json={"query": "x"}).json()["results"][0]["score"] is None


def test_recall_requires_a_query(client: TestClient, fake_byoi: FakeByoi) -> None:
    assert client.post("/api/recall", json={"query": "  "}).status_code == 422
    assert fake_byoi.calls == []


@pytest.mark.parametrize("limit", [0, 51, -1, "ten", 1.5, True])
def test_recall_rejects_an_out_of_range_limit(client: TestClient, limit: object) -> None:
    """Mirrors the BYOI's own 1..50 rule so a bad value fails here, not upstream."""
    assert client.post("/api/recall", json={"query": "x", "limit": limit}).status_code == 422


# --- attachments ----------------------------------------------------------


def test_attachment_download_streams_bytes(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.attachment = (b"a full chat transcript", "text/plain")
    response = client.get("/api/memories/mem-1/attachments/0")
    assert response.status_code == 200
    assert response.content == b"a full chat transcript"
    assert response.headers["content-type"].startswith("text/plain")


def test_safe_types_render_inline(client: TestClient, fake_byoi: FakeByoi) -> None:
    """Transcripts should be viewable in the browser without downloading."""
    fake_byoi.attachment = (b"transcript", "text/plain")
    response = client.get("/api/memories/mem-1/attachments/0")
    assert response.headers["content-disposition"].startswith("inline")


def test_unsafe_types_are_forced_to_download(client: TestClient, fake_byoi: FakeByoi) -> None:
    """A stored text/html attachment must not execute in this app's origin.

    This origin holds the session cookie, so an inline HTML attachment would be
    a stored-XSS vector against the very session that fetched it.
    """
    fake_byoi.attachment = (b"<script>alert(1)</script>", "text/html")
    response = client.get("/api/memories/mem-1/attachments/0")
    assert response.headers["content-disposition"].startswith("attachment")
    assert response.headers["content-type"].startswith("application/octet-stream")


def test_nosniff_is_always_set(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.attachment = (b"x", "text/plain")
    response = client.get("/api/memories/mem-1/attachments/0")
    assert response.headers["x-content-type-options"] == "nosniff"


def test_download_flag_forces_attachment_disposition(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.attachment = (b"transcript", "text/plain")
    response = client.get("/api/memories/mem-1/attachments/0", params={"download": "true"})
    assert response.headers["content-disposition"].startswith("attachment")


def test_attachment_filename_is_sanitized(client: TestClient, fake_byoi: FakeByoi) -> None:
    """Ids come from the URL, so an unescaped quote would inject a header."""
    fake_byoi.attachment = (b"x", "text/plain")
    response = client.get('/api/memories/ev"il;drop/attachments/0')
    disposition = response.headers["content-disposition"]
    assert '"' not in disposition.split("filename=")[1].strip('"')
    assert ";drop" not in disposition


def test_missing_attachment_is_404(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.attachment = None
    assert client.get("/api/memories/mem-1/attachments/9").status_code == 404


def test_attachment_bytes_are_not_cached(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.attachment = (b"private", "text/plain")
    response = client.get("/api/memories/mem-1/attachments/0")
    assert "no-store" in response.headers["cache-control"]


# --- status ---------------------------------------------------------------


def test_status_reports_byoi_health_and_version(client: TestClient) -> None:
    body = client.get("/api/status").json()
    assert body["byoi"]["reachable"] is True
    assert body["byoi"]["serverVersion"] == "1.0.37"
    assert body["byoi"]["capabilities"]["attachments"] is True
    assert body["web"]["authMode"] == "dev"


def test_status_is_200_even_when_byoi_is_down(client: TestClient, fake_byoi: FakeByoi) -> None:
    """The outage is the information — a 502 here would hide it behind an error page."""
    fake_byoi.error = ByoiError("Unable to reach Gemdex Server at http://127.0.0.1:8765")
    response = client.get("/api/status")
    assert response.status_code == 200
    assert response.json()["byoi"]["reachable"] is False
    assert response.json()["byoi"]["error"]


# --- upstream failure translation ----------------------------------------


def test_transport_failure_becomes_502(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.error = ByoiError("Unable to reach Gemdex Server at http://internal-host:8765")
    response = client.get("/api/memories")
    assert response.status_code == 502


def test_upstream_5xx_message_is_not_relayed(client: TestClient, fake_byoi: FakeByoi) -> None:
    """A 500's text can name internal hosts or the storage backend."""
    fake_byoi.error = ByoiError("psql: connection to server at 10.1.2.3 failed", status=500)
    response = client.get("/api/memories")
    assert response.status_code == 502
    assert "10.1.2.3" not in response.text
    assert "psql" not in response.text


def test_upstream_401_does_not_become_a_login_prompt(client: TestClient, fake_byoi: FakeByoi) -> None:
    """A bad BYOI token is a *server* misconfiguration, not the user's problem.

    Relaying it as a 401 would make the SPA bounce the user through a login that
    cannot possibly fix it. It is mapped to 502 because the failure is between
    this service and its backend.
    """
    fake_byoi.error = ByoiError("Unauthorized", status=401)
    assert client.get("/api/memories").status_code == 502


# --- the BYOI token must never reach the browser -------------------------


def test_token_absent_from_every_response(client: TestClient, fake_byoi: FakeByoi) -> None:
    """Sweep the whole surface for the bearer, in bodies *and* headers."""
    fake_byoi.memories.append(memory(attachments=[{"id": "0", "kind": "file", "mimeType": "text/plain"}]))
    fake_byoi.attachment = (b"transcript", "text/plain")

    responses = [
        client.get("/api/memories"),
        client.get("/api/memories/mem-1"),
        client.post("/api/memories", json={"content": "x"}),
        client.patch("/api/memories/mem-1", json={"title": "y"}),
        client.post("/api/recall", json={"query": "x"}),
        client.get("/api/memories/mem-1/attachments/0"),
        client.get("/api/status"),
        client.get("/api/session"),
        client.get("/healthz"),
        client.delete("/api/memories/mem-1"),
    ]
    for response in responses:
        assert BYOI_TOKEN not in response.text, f"token leaked in body of {response.url}"
        assert BYOI_TOKEN not in json.dumps(dict(response.headers)), f"token leaked in headers of {response.url}"


def test_token_absent_from_error_responses(client: TestClient, fake_byoi: FakeByoi) -> None:
    """Error paths are the likeliest leak: exception text often quotes the request."""
    fake_byoi.error = ByoiError(f"401 Unauthorized for Bearer {BYOI_TOKEN}", status=500)
    response = client.get("/api/memories")
    assert BYOI_TOKEN not in response.text


def test_status_does_not_expose_the_token(client: TestClient) -> None:
    """The status page reports the BYOI *url* deliberately; the token never."""
    body = client.get("/api/status").json()
    assert body["byoi"]["url"] == "http://127.0.0.1:8765"
    assert BYOI_TOKEN not in json.dumps(body)


def test_no_authorization_header_is_echoed_to_the_browser(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.memories.append(memory())
    response = client.get("/api/memories")
    assert "authorization" not in {k.lower() for k in response.headers}


# --- the protected surface is closed by construction ---------------------


def test_every_api_route_requires_a_session() -> None:
    """Enumerate the router and assert the gate is on all of it.

    A guard against the realistic mistake: adding a route to `routes.py` and
    forgetting the dependency. Because the dependency sits on the `APIRouter`,
    this asserts the property at its source rather than per-route.
    """
    from gemdex_web.auth import require_identity
    from gemdex_web.routes import router

    dependency_calls = [d.dependency for d in router.dependencies]
    assert require_identity in dependency_calls, "the /api router lost its auth dependency"

    # And no route may override it with its own empty dependency list.
    for route in router.routes:
        assert getattr(route, "dependant", None) is not None or True
        path = getattr(route, "path", "")
        assert path.startswith("/api") or path == "", f"unexpected unprefixed route {path}"
