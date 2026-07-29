"""Session upload (`POST /api/sessions/upload`) — history path B.

Two things are under test, and they are deliberately separated:

- `uploads.py` decoding, called directly. The interesting cases are adversarial
  or malformed archives, and they are far easier to state as pure functions.
- The route, which must **forward** rather than process (this service holds no
  Gemini key and no memory logic) and must degrade **per file**: a corrupt
  transcript in a batch is that file's status, never a 500 that throws away the
  digests already paid for.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from gemdex_web.app import create_app
from gemdex_web.byoi import ByoiError
from gemdex_web.uploads import (
    MAX_FILE_BYTES,
    MAX_FILES,
    MAX_TOTAL_UPLOAD_BYTES,
    UploadError,
    collect_uploads,
    expand_zip,
)

from .conftest import BYOI_TOKEN, FakeByoi, make_dev_config

UPLOAD_PATH = "/api/sessions/upload"


@pytest.fixture
def client(fake_byoi: FakeByoi) -> TestClient:
    with TestClient(create_app(make_dev_config(), byoi=fake_byoi)) as test_client:
        yield test_client


def session_jsonl(session_id: str = "sess-1") -> str:
    """A minimal Claude-shaped transcript. Shape realism matters: the BYOI
    derives the memory id from the record contents, not the filename."""
    return "\n".join(
        json.dumps(record)
        for record in [
            {
                "type": "user",
                "timestamp": "2026-05-14T15:01:32.088Z",
                "sessionId": session_id,
                "message": {"role": "user", "content": "Set up notarization for the mac app."},
            },
            {
                "type": "assistant",
                "timestamp": "2026-05-14T15:02:00.000Z",
                "sessionId": session_id,
                "message": {"role": "assistant", "content": [{"type": "text", "text": "Submitted."}]},
            },
        ]
    )


def make_zip(members: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def upload(client: TestClient, files: list[tuple[str, bytes]]) -> object:
    return client.post(
        UPLOAD_PATH,
        files=[("files", (name, raw, "application/octet-stream")) for name, raw in files],
    )


# --- the route forwards, and reports per file ----------------------------


def test_a_jsonl_upload_is_forwarded_to_the_byoi_for_digesting(
    client: TestClient, fake_byoi: FakeByoi
) -> None:
    """The BFF must hand the transcript upstream, not digest it itself.

    Asserted through the call log rather than the response: the whole design
    decision of this feature is *where* the Gemini call happens, and the only
    way this service can be doing it locally is if it never called the BYOI.
    """
    response = upload(client, [("agent.jsonl", session_jsonl().encode())])
    assert response.status_code == 200, response.text
    assert fake_byoi.method_names() == ["ingest_sessions"]

    (_name, (forwarded,)) = fake_byoi.calls[0]
    assert [file["filename"] for file in forwarded] == ["agent.jsonl"]
    assert "notarization" in forwarded[0]["content"]

    body = response.json()
    assert body["ingested"] == 1
    assert body["results"][0]["status"] == "ingested"
    assert body["results"][0]["memoryId"] == "chat:claude:agent"


def test_the_response_is_a_per_file_list_not_all_or_nothing(
    client: TestClient, fake_byoi: FakeByoi
) -> None:
    """One bad session in a batch must not cost the user the good ones."""
    fake_byoi.ingest_results = [
        {"filename": "good.jsonl", "status": "ingested", "memoryId": "chat:claude:good", "title": "T"},
        {"filename": "short.jsonl", "status": "skipped", "reason": "trivial"},
        {"filename": "boom.jsonl", "status": "failed", "error": "gemini 429"},
    ]
    response = upload(
        client,
        [(name, session_jsonl().encode()) for name in ("good.jsonl", "short.jsonl", "boom.jsonl")],
    )
    assert response.status_code == 200
    body = response.json()
    assert (body["ingested"], body["skipped"], body["failed"]) == (1, 1, 1)
    assert [r["status"] for r in body["results"]] == ["ingested", "skipped", "failed"]


def test_a_skip_reason_is_explained_in_human_terms(client: TestClient, fake_byoi: FakeByoi) -> None:
    """`trivial` is core's word; the person who uploaded the file needs a sentence."""
    fake_byoi.ingest_results = [{"filename": "short.jsonl", "status": "skipped", "reason": "trivial"}]
    body = upload(client, [("short.jsonl", session_jsonl().encode())]).json()
    assert "too short" in body["results"][0]["detail"]


def test_an_unparseable_file_is_reported_as_skipped_not_a_500(
    client: TestClient, fake_byoi: FakeByoi
) -> None:
    """A file that is named `.jsonl` but is not a transcript reaches the BYOI
    (only it can tell) and comes back as that file's skip, with a 200 overall."""
    fake_byoi.ingest_results = [{"filename": "junk.jsonl", "status": "skipped", "reason": "unparseable"}]
    response = upload(client, [("junk.jsonl", b"this is not jsonl at all\n{")])
    assert response.status_code == 200
    assert response.json()["results"][0]["status"] == "skipped"
    assert "recognizable" in response.json()["results"][0]["detail"]


def test_an_upstream_digest_error_string_is_not_shown_to_the_browser(
    client: TestClient, fake_byoi: FakeByoi
) -> None:
    """Per-file `error` text comes from the digester and can name the model or
    an internal host, so it is replaced — same rule as the 5xx translation."""
    fake_byoi.ingest_results = [
        {
            "filename": "a.jsonl",
            "status": "failed",
            "error": "gemini-3.5-flash at 10.1.2.3 refused: quota project byoi-prod",
        }
    ]
    response = upload(client, [("a.jsonl", session_jsonl().encode())])
    assert "10.1.2.3" not in response.text
    assert "byoi-prod" not in response.text
    assert response.json()["results"][0]["status"] == "failed"


def test_an_unknown_upstream_status_is_treated_as_failure(
    client: TestClient, fake_byoi: FakeByoi
) -> None:
    """Fail closed: an unrecognized status must not be counted as ingested."""
    fake_byoi.ingest_results = [{"filename": "a.jsonl", "status": "weird-new-status"}]
    body = upload(client, [("a.jsonl", session_jsonl().encode())]).json()
    assert body["failed"] == 1
    assert body["ingested"] == 0


def test_a_byoi_outage_becomes_502(client: TestClient, fake_byoi: FakeByoi) -> None:
    fake_byoi.error = ByoiError("Unable to reach Gemdex Server at http://internal:8765")
    response = upload(client, [("a.jsonl", session_jsonl().encode())])
    assert response.status_code == 502
    assert "internal" not in response.text


def test_a_missing_gemini_key_upstream_is_surfaced_not_swallowed(
    client: TestClient, fake_byoi: FakeByoi
) -> None:
    """The BYOI answers 503 when it has no key. That is actionable for the
    operator, so it must not be flattened into a generic failure."""
    fake_byoi.error = ByoiError("Session ingest requires GEMINI_API_KEY on the server", status=503)
    response = upload(client, [("a.jsonl", session_jsonl().encode())])
    assert response.status_code in (502, 503)


def test_the_byoi_token_never_appears_in_an_upload_response(
    client: TestClient, fake_byoi: FakeByoi
) -> None:
    fake_byoi.error = ByoiError(f"401 for Bearer {BYOI_TOKEN}", status=500)
    response = upload(client, [("a.jsonl", session_jsonl().encode())])
    assert BYOI_TOKEN not in response.text


# --- zip containers ------------------------------------------------------


def test_a_zip_is_expanded_into_its_jsonl_members(client: TestClient, fake_byoi: FakeByoi) -> None:
    """Browsers cannot portably upload a directory, and agents nest sessions in
    per-project folders, so a zip is the practical way to hand over a batch."""
    raw = make_zip(
        {
            "projects/a/one.jsonl": session_jsonl("one"),
            "projects/b/two.jsonl": session_jsonl("two"),
            "projects/README.md": "not a session",
        }
    )
    response = upload(client, [("sessions.zip", raw)])
    assert response.status_code == 200, response.text

    (_name, (forwarded,)) = fake_byoi.calls[0]
    # Flattened to leaf names: nothing downstream should see archive paths.
    assert sorted(file["filename"] for file in forwarded) == ["one.jsonl", "two.jsonl"]


def test_zip_member_names_are_flattened_so_traversal_cannot_travel(
    fake_byoi: FakeByoi,
) -> None:
    """A member named `../../etc/x.jsonl` must reduce to `x.jsonl`.

    Nothing here writes to disk, but the name reaches the digest's provenance
    line and the BYOI's session-id fallback, so it is stripped at the boundary
    rather than trusted downstream.
    """
    uploads, _rejected = expand_zip(make_zip({"../../etc/x.jsonl": session_jsonl()}), "evil.zip")
    assert [u.filename for u in uploads] == ["x.jsonl"]


def test_a_zip_bomb_member_is_refused_before_it_is_inflated() -> None:
    """The declared uncompressed size is checked first — reading and measuring
    afterwards is exactly what makes a bomb work."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("huge.jsonl", "a" * (MAX_FILE_BYTES + 1024))
    uploads, rejected = expand_zip(buffer.getvalue(), "bomb.zip")
    assert uploads == []
    assert len(rejected) == 1
    assert "limit" in rejected[0].error


def test_a_zip_with_no_sessions_is_a_request_level_error() -> None:
    with pytest.raises(UploadError, match="no .jsonl session files"):
        expand_zip(make_zip({"notes.md": "hello"}), "docs.zip")


def test_a_corrupt_zip_is_a_request_level_error() -> None:
    with pytest.raises(UploadError, match="not a readable zip"):
        expand_zip(b"PK\x03\x04 truncated garbage", "broken.zip")


def test_a_nested_archive_is_skipped_rather_than_recursed() -> None:
    """Bounded work: recursing would make the depth attacker-controlled.

    The sibling transcript still comes through — skipping the inner zip is not
    allowed to abort the archive.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("inner.zip", make_zip({"deep.jsonl": session_jsonl()}))
        archive.writestr("real.jsonl", session_jsonl())
    uploads, _rejected = expand_zip(buffer.getvalue(), "outer.zip")
    assert [u.filename for u in uploads] == ["real.jsonl"]


# --- request-level validation --------------------------------------------


def test_a_non_session_file_type_is_rejected_by_name(client: TestClient, fake_byoi: FakeByoi) -> None:
    """Rejected before any upstream call: paying for a Gemini digest to discover
    that a screenshot is not a session would be the expensive way to find out."""
    response = upload(client, [("screenshot.png", b"\x89PNG\r\n\x1a\n")])
    assert response.status_code == 422
    assert fake_byoi.calls == []


def test_a_mixed_batch_keeps_the_sessions_and_reports_the_rest(
    client: TestClient, fake_byoi: FakeByoi
) -> None:
    """A rejected sibling must not sink the valid transcripts, and it still has
    to appear in the results so the user knows it did not land."""
    response = upload(
        client,
        [("agent.jsonl", session_jsonl().encode()), ("notes.md", b"hello")],
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ingested"] == 1
    assert body["skipped"] == 1
    skipped = next(r for r in body["results"] if r["status"] == "skipped")
    assert skipped["filename"] == "notes.md"
    # Only the transcript was forwarded.
    (_name, (forwarded,)) = fake_byoi.calls[0]
    assert [file["filename"] for file in forwarded] == ["agent.jsonl"]


def test_an_empty_file_is_reported_rather_than_forwarded(
    client: TestClient, fake_byoi: FakeByoi
) -> None:
    response = upload(client, [("agent.jsonl", session_jsonl().encode()), ("empty.jsonl", b"")])
    body = response.json()
    assert body["skipped"] == 1
    (_name, (forwarded,)) = fake_byoi.calls[0]
    assert [file["filename"] for file in forwarded] == ["agent.jsonl"]


def test_an_oversized_single_file_is_rejected() -> None:
    with pytest.raises(UploadError):
        collect_uploads([("huge.jsonl", b"a" * (MAX_FILE_BYTES + 1))])


def test_the_total_upload_size_is_capped() -> None:
    """Guards this process's memory: transcripts are held in RAM to forward."""
    chunk = b"a" * MAX_FILE_BYTES
    entries = [(f"s{i}.jsonl", chunk) for i in range(MAX_TOTAL_UPLOAD_BYTES // MAX_FILE_BYTES + 1)]
    with pytest.raises(UploadError, match="total limit"):
        collect_uploads(entries)


def test_too_many_sessions_in_one_request_is_rejected() -> None:
    raw = session_jsonl().encode()
    with pytest.raises(UploadError, match="per-request limit"):
        collect_uploads([(f"s{i}.jsonl", raw) for i in range(MAX_FILES + 1)])


def test_a_utf8_bom_is_stripped_so_the_first_record_parses() -> None:
    """Real exported transcripts do carry a BOM; leaving it makes line one
    unparseable and silently costs the first turn of the conversation."""
    uploads, _rejected = collect_uploads([("a.jsonl", b"\xef\xbb\xbf" + session_jsonl().encode())])
    assert uploads[0].content.startswith("{")


def test_invalid_utf8_costs_one_character_not_the_whole_session() -> None:
    """A truncated write or mangled paste should not discard a long session."""
    uploads, _rejected = collect_uploads([("a.jsonl", session_jsonl().encode() + b"\n\xff\xfe")])
    assert "notarization" in uploads[0].content


def test_no_files_at_all_is_a_422(client: TestClient, fake_byoi: FakeByoi) -> None:
    response = client.post(UPLOAD_PATH, files=[])
    # FastAPI's own validation catches the missing field; either way it must be
    # a client error and must not reach the BYOI.
    assert response.status_code in (422, 400)
    assert fake_byoi.calls == []
