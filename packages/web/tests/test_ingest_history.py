"""Ingest history and hygiene status.

The interesting assertions here are about *derivation*, because this view has no
upstream endpoint behind it — it reconstructs "what was ingested" from the
memories themselves. So the tests pin the two things that could silently rot:
the id/header parsing that turns a memory back into a session, and the framing
that keeps the page from claiming to know when ingestion happened.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from gemdex_web.app import create_app
from gemdex_web.byoi import ByoiError
from gemdex_web.ingest_history import collect_sessions, describe_session, parse_chat_memory_id

from .conftest import BYOI_TOKEN, FakeByoi, make_dev_config, memory


@pytest.fixture
def client(fake_byoi: FakeByoi) -> TestClient:
    with TestClient(create_app(make_dev_config(), byoi=fake_byoi)) as test_client:
        yield test_client


def chat_memory(
    source: str = "claude",
    session_id: str = "sess-1",
    repo: str | None = "/Users/nik/app",
    branch: str | None = "main",
    date: str = "2026-07-12",
    title: str = "Fixed the auth bug",
    updated_at: int = 1_700_000_001_000,
    with_transcript: bool = True,
) -> dict[str, Any]:
    """A digest memory as the BYOI's list route returns it.

    The `preview` is built the way `renderDigestMemory` builds the memory's first
    line, because that header *is* the data source for repo and branch — a fake
    that omitted it would test nothing.
    """
    header = f"Source: {source.title()}"
    if repo:
        header += f" · Repo: {repo}{f' ({branch})' if branch else ''}"
    header += f" · {date}"

    record = memory(memory_id=f"chat:{source}:{session_id}", title=title)
    record["preview"] = f"{header}\nWhat happened in the session."
    record["updatedAt"] = updated_at
    record["attachments"] = [{"id": "transcript", "kind": "file"}] if with_transcript else []
    return record


# --- id parsing -----------------------------------------------------------


def test_parses_the_deterministic_chat_id() -> None:
    assert parse_chat_memory_id("chat:claude:abc-123") == ("claude", "abc-123")


def test_session_ids_may_contain_colons() -> None:
    """Only the first two segments are the prefix and source; the rest is the id."""
    assert parse_chat_memory_id("chat:custom:host:2026:run7") == ("custom", "host:2026:run7")


@pytest.mark.parametrize(
    "memory_id",
    [
        "mem-1",  # a hand-written memory
        "chat:claude",  # no session id
        "chat::abc",  # no source
        "chat:",
    ],
)
def test_non_session_ids_are_not_history(memory_id: str) -> None:
    assert parse_chat_memory_id(memory_id) is None


def test_handwritten_memories_are_excluded_from_history() -> None:
    sessions = collect_sessions([memory(memory_id="mem-1"), chat_memory()])
    assert [s.memory_id for s in sessions] == ["chat:claude:sess-1"]


# --- header parsing -------------------------------------------------------


def test_repo_and_branch_come_from_the_digest_header() -> None:
    session = describe_session(chat_memory(repo="/Users/nik/app", branch="feature/x"))
    assert session is not None
    assert session.repo == "/Users/nik/app"
    assert session.branch == "feature/x"


def test_header_without_a_repo_is_fine() -> None:
    """A session with no cwd renders a header with no `Repo:` part."""
    session = describe_session(chat_memory(repo=None))
    assert session is not None
    assert session.repo is None
    assert session.branch is None


def test_truncated_branch_still_groups_under_its_repo() -> None:
    """Previews are cut at 100 chars, which can slice the header mid-branch.

    Without this, one repo splits into several summary rows — which is exactly
    what happened against the real pool: `/Users/nikhilanand/agent` appeared
    twice (390 + 170) instead of once (565).
    """
    record = chat_memory()
    record["preview"] = "Source: Claude Code · Repo: /Users/nik/dva-sys-agent (fix/email-recipient-templ"
    session = describe_session(record)
    assert session is not None
    assert session.repo == "/Users/nik/dva-sys-agent"
    # Reported as unknown rather than as a half-written branch name.
    assert session.branch is None


def test_source_comes_from_the_id_not_the_header_prose() -> None:
    """The id's source segment is authoritative — the label is truncatable prose."""
    record = chat_memory(source="factory", session_id="s9")
    record["preview"] = "Source: Claude Code · Repo: /x · 2026-01-01\nbody"
    session = describe_session(record)
    assert session is not None
    assert session.source == "factory"
    assert session.source_label == "Factory CLI"


def test_unknown_source_falls_back_to_a_generic_label() -> None:
    session = describe_session(chat_memory(source="somethingnew"))
    assert session is not None
    assert session.source_label == "Coding agent"


# --- the route ------------------------------------------------------------


def test_history_is_derived_from_one_list_call(client: TestClient, fake_byoi: FakeByoi) -> None:
    """No per-session fetch: the header is in the preview, so one call suffices."""
    fake_byoi.memories.extend([chat_memory(session_id=f"s{i}") for i in range(3)])
    response = client.get("/api/ingest/history")
    assert response.status_code == 200
    assert fake_byoi.method_names() == ["list"]


def test_history_reports_sessions_against_the_whole_pool(
    client: TestClient, fake_byoi: FakeByoi
) -> None:
    fake_byoi.memories.extend([chat_memory(session_id="s1"), chat_memory(session_id="s2")])
    fake_byoi.memories.append(memory(memory_id="mem-hand-written"))

    body = client.get("/api/ingest/history").json()
    assert body["total"] == 2
    assert body["poolTotal"] == 3


def test_sessions_are_newest_activity_first(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.memories.extend(
        [
            chat_memory(session_id="old", updated_at=1_000),
            chat_memory(session_id="new", updated_at=9_000),
            chat_memory(session_id="mid", updated_at=5_000),
        ]
    )
    body = client.get("/api/ingest/history").json()
    assert [s["sessionId"] for s in body["sessions"]] == ["new", "mid", "old"]


def test_response_says_timestamps_are_session_activity(
    client: TestClient, fake_byoi: FakeByoi
) -> None:
    """The one claim this page must not make is "ingested at".

    A digest keeps the transcript's own timestamps, so the host genuinely cannot
    know when a laptop ran sync. The caveat ships in the payload so the UI cannot
    render the numbers without it.
    """
    fake_byoi.memories.append(chat_memory())
    body = client.get("/api/ingest/history").json()
    assert "not when it was ingested" in body["timestampMeaning"]


def test_per_source_totals(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.memories.extend(
        [
            chat_memory(source="claude", session_id="a"),
            chat_memory(source="claude", session_id="b"),
            chat_memory(source="factory", session_id="c"),
        ]
    )
    body = client.get("/api/ingest/history").json()
    assert body["sources"] == [
        {"source": "claude", "label": "Claude Code", "sessions": 2, "lastActiveAt": 1_700_000_001_000},
        {"source": "factory", "label": "Factory CLI", "sessions": 1, "lastActiveAt": 1_700_000_001_000},
    ]


def test_repo_totals_are_ranked(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.memories.extend(
        [
            chat_memory(session_id="a", repo="/work/busy"),
            chat_memory(session_id="b", repo="/work/busy"),
            chat_memory(session_id="c", repo="/work/quiet"),
        ]
    )
    body = client.get("/api/ingest/history").json()
    assert body["repos"] == [
        {"repo": "/work/busy", "sessions": 2},
        {"repo": "/work/quiet", "sessions": 1},
    ]


def test_history_paginates(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.memories.extend(
        [chat_memory(session_id=f"s{i}", updated_at=1_000 + i) for i in range(10)]
    )
    body = client.get("/api/ingest/history?offset=4&limit=3").json()
    assert len(body["sessions"]) == 3
    # Totals describe the whole set, not the page.
    assert body["total"] == 10
    assert body["offset"] == 4


def test_history_reports_transcript_availability(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.memories.extend(
        [
            chat_memory(session_id="with", with_transcript=True, updated_at=2_000),
            chat_memory(session_id="without", with_transcript=False, updated_at=1_000),
        ]
    )
    body = client.get("/api/ingest/history").json()
    assert [s["hasTranscript"] for s in body["sessions"]] == [True, False]


def test_history_does_not_leak_the_byoi_token(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.memories.append(chat_memory())
    assert BYOI_TOKEN not in client.get("/api/ingest/history").text


def test_history_translates_an_upstream_failure(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.error = ByoiError("pgvector exploded: password=hunter2", status=500)
    response = client.get("/api/ingest/history")
    assert response.status_code == 502
    assert "hunter2" not in response.text


# --- hygiene status -------------------------------------------------------


def test_hygiene_reports_unavailable_with_a_reason(client: TestClient) -> None:
    """Unavailable is the honest answer, and it must come with the why.

    Clustering needs per-memory vectors from a local LanceDB store; a
    Postgres-backed deployment has no equivalent read and `/v1` exposes no
    vector-listing route.
    """
    body = client.get("/api/hygiene/status").json()
    assert body["available"] is False
    assert body["reason"]


def test_hygiene_status_needs_no_upstream_call(client: TestClient, fake_byoi: FakeByoi) -> None:
    """It is a statement about this deployment's architecture, not a live probe.

    Which also means it keeps answering when the pool is down — the same reason
    `/api/status` reports an outage instead of 502-ing on one.
    """
    assert client.get("/api/hygiene/status").status_code == 200
    assert fake_byoi.calls == []


def test_hygiene_names_the_protections_that_are_actually_active(client: TestClient) -> None:
    """Reporting "unavailable" alone would understate the pool's real hygiene."""
    body = client.get("/api/hygiene/status").json()
    states = [p["state"] for p in body["protections"]]
    assert "active" in states
    blob = " ".join(p["detail"] for p in body["protections"])
    # Save-time similar-memory detection, and the deterministic chat id.
    assert "0.90" in blob
    assert "chat:<source>:<sessionId>" in blob


def test_hygiene_tells_the_operator_how_to_run_a_real_pass(client: TestClient) -> None:
    body = client.get("/api/hygiene/status").json()
    commands = [o.get("command") for o in body["howToRun"]["options"]]
    assert "npx gemdex serve" in commands
    # And is clear that a local run covers a *different* pool than this one.
    assert "not the pool at" in body["howToRun"]["caveat"]


def test_hygiene_does_not_leak_the_byoi_token(client: TestClient) -> None:
    """The caveat names the backend URL, so it is worth pinning that it stops there."""
    assert BYOI_TOKEN not in client.get("/api/hygiene/status").text
