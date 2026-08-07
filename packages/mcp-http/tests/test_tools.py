"""Tool-wrapper behavior with the BYOI mocked.

These assert the two things the wrapper layer owns: the exact `/v1` payload sent
for a given set of tool args, and the rendered text handed back to the agent.
"""

from __future__ import annotations

import base64

import pytest
from fastmcp.exceptions import ToolError

from gemdex_mcp_http.formatting import DEFAULT_READ_ATTACHMENT_MAX_CHARS
from gemdex_mcp_http.stats import MemoryStatsStore
from gemdex_mcp_http.tools import GemdexTools

from .conftest import FakeByoi, make_memory


def hit(**overrides: object) -> dict:
    result = make_memory()
    result.update({"score": 0.5, "subScores": {"denseRank": 1, "denseDistance": 0.12, "ftsRank": 2, "ftsScore": 3.5}})
    result.update(overrides)
    return result


# --- save_memory ---------------------------------------------------------


async def test_save_sends_content_and_renders_confirmation(tools: GemdexTools, byoi: FakeByoi) -> None:
    out = await tools.save_memory(content="Deploy with scripts/deploy.sh", title="Deploy")
    assert byoi.payload_for("save") == {"content": "Deploy with scripts/deploy.sh", "title": "Deploy"}
    assert out == "Saved memory.\nid: mem-1\ntitle: Deploy steps"


async def test_save_omits_title_when_absent(tools: GemdexTools, byoi: FakeByoi) -> None:
    await tools.save_memory(content="x")
    assert byoi.payload_for("save") == {"content": "x"}


async def test_save_requires_content_or_attachment(tools: GemdexTools, byoi: FakeByoi) -> None:
    with pytest.raises(ToolError, match="provide 'content' or at least one attachment"):
        await tools.save_memory(content="   ")
    assert byoi.calls == []


async def test_save_renders_attachment_count(tools: GemdexTools, byoi: FakeByoi) -> None:
    byoi.save_result = make_memory(attachments=[{"id": "0", "kind": "image"}])
    out = await tools.save_memory(
        content="screenshot", attachments=[{"data": "Zm9v", "mimeType": "image/png"}]
    )
    assert byoi.payload_for("save")["attachments"] == [{"mimeType": "image/png", "data": "Zm9v"}]
    assert out.endswith("attachments: 1")


async def test_save_renders_similar_advisory(tools: GemdexTools, byoi: FakeByoi) -> None:
    byoi.save_result = make_memory(
        similar=[{"id": "old-1", "title": "Old deploy", "similarity": 0.93, "updatedAt": 0}]
    )
    out = await tools.save_memory(content="new deploy notes")
    assert "⚠ similar existing memories already stored:" in out
    assert '1. "Old deploy" (id old-1, updated' in out
    assert "0.93 similar)" in out


async def test_save_surfaces_byoi_failure(tools: GemdexTools, byoi: FakeByoi) -> None:
    byoi.raise_on = "save"
    with pytest.raises(ToolError, match="Failed to save memory: boom in save"):
        await tools.save_memory(content="x")


# --- attachment path rejection (the host-local invariant) -----------------


@pytest.mark.parametrize("tool_name", ["save_memory", "update_memory"])
async def test_local_path_attachment_rejected(tools: GemdexTools, byoi: FakeByoi, tool_name: str) -> None:
    kwargs: dict = {"attachments": [{"path": "/Users/someone/pic.png"}]}
    if tool_name == "update_memory":
        kwargs["id"] = "mem-1"
    else:
        kwargs["content"] = "x"
    with pytest.raises(ToolError, match="not supported over the HTTP transport"):
        await getattr(tools, tool_name)(**kwargs)
    assert byoi.calls == []


async def test_attachment_without_data_rejected(tools: GemdexTools) -> None:
    with pytest.raises(ToolError, match="requires inline base64 'data' and a 'mimeType'"):
        await tools.save_memory(content="x", attachments=[{"mimeType": "image/png"}])


# --- recall (title index) -------------------------------------------------


async def test_recall_requires_query(tools: GemdexTools, byoi: FakeByoi) -> None:
    with pytest.raises(ToolError, match="'query' is required"):
        await tools.recall(query="  ")
    assert byoi.calls == []


async def test_recall_no_results_message(tools: GemdexTools) -> None:
    out = await tools.recall(query="anything")
    assert out == 'No memories matched "anything". Nothing stored yet, or no relevant match.'


async def test_recall_renders_title_index_only(tools: GemdexTools, byoi: FakeByoi) -> None:
    body = "Run scripts/deploy.sh then verify /health."
    byoi.recall_results = [hit(content=body)]
    out = await tools.recall(query="deploy")
    assert 'Recalled 1 memory for "deploy"' in out
    assert "titles only" in out
    assert "1. Deploy steps" in out
    assert "id: mem-1" in out
    assert body not in out
    assert "Scores:" not in out
    assert "updated:" not in out
    assert "attachments:" not in out
    assert byoi.payload_for("recall") == {"query": "deploy", "limit": 10}


async def test_recall_does_not_bump_stats(tools: GemdexTools, byoi: FakeByoi, stats: MemoryStatsStore) -> None:
    byoi.recall_results = [hit()]
    await tools.recall(query="q")
    await tools.recall(query="q")
    assert stats.get("mem-1") is None


async def test_recall_track_record_when_stats_already_exist(
    tools: GemdexTools, byoi: FakeByoi, stats: MemoryStatsStore
) -> None:
    byoi.recall_results = [hit()]
    stats.record_outcome("mem-1", "failed")
    out = await tools.recall(query="q")
    assert "⚠ track record: recalled 0×, failed 1× (last: failed" in out or "⚠ track record:" in out
    assert "failed 1×" in out
    # Still no bump from title-index recall.
    assert stats.get("mem-1")["recallCount"] == 0


async def test_recall_trust_ranking_overfetches_and_reorders(
    trust_tools: GemdexTools, byoi: FakeByoi, stats: MemoryStatsStore
) -> None:
    byoi.recall_results = [
        hit(id="loser", title="Loser", score=0.50),
        hit(id="winner", title="Winner", score=0.48),
    ]
    # Give "winner" a strong track record and "loser" a bad one so the
    # multiplier flips their raw-relevance order.
    for _ in range(5):
        stats.record_outcome("winner", "worked")
    for _ in range(3):
        stats.record_outcome("loser", "failed")

    out = await trust_tools.recall(query="q")
    # Fixed N=10 → over-fetch min(max(20, 15), 100) = 20
    assert byoi.payload_for("recall")["limit"] == 20
    assert "1. Winner" in out
    winner_pos = out.index("id: winner")
    loser_pos = out.index("id: loser")
    assert winner_pos < loser_pos
    assert "trust=×" not in out  # title index does not render the factor


# --- get_memory -----------------------------------------------------------


async def test_get_memory_requires_id(tools: GemdexTools, byoi: FakeByoi) -> None:
    with pytest.raises(ToolError, match="'id' is required"):
        await tools.get_memory(id="  ")
    assert byoi.calls == []


async def test_get_memory_not_found(tools: GemdexTools, byoi: FakeByoi) -> None:
    byoi.get_result = None
    with pytest.raises(ToolError, match="Memory not found: missing"):
        await tools.get_memory(id="missing")


async def test_get_memory_returns_full_body_and_bumps_stats(
    tools: GemdexTools, byoi: FakeByoi, stats: MemoryStatsStore
) -> None:
    byoi.get_result = make_memory(
        content="Run scripts/deploy.sh then verify /health.",
        attachments=[{"id": "transcript", "kind": "file", "caption": "Full transcript (source file)"}],
        updatedAt=0,
    )
    out = await tools.get_memory(id="mem-1")
    assert "Deploy steps" in out
    assert "id: mem-1" in out
    assert "updated:" in out
    assert 'attachments: file (id transcript: "Full transcript (source file)")' in out
    assert "Run scripts/deploy.sh then verify /health." in out
    assert stats.get("mem-1")["recallCount"] == 1


# --- update_memory -------------------------------------------------------


async def test_update_requires_id(tools: GemdexTools) -> None:
    with pytest.raises(ToolError, match="'id' is required"):
        await tools.update_memory(id="  ", content="x")


async def test_update_requires_a_field(tools: GemdexTools, byoi: FakeByoi) -> None:
    with pytest.raises(ToolError, match="at least one of 'content', 'edits', 'title', or 'attachments'"):
        await tools.update_memory(id="mem-1")
    assert byoi.calls == []


async def test_update_rejects_content_and_edits_together(tools: GemdexTools) -> None:
    with pytest.raises(ToolError, match="either 'content' or 'edits', not both"):
        await tools.update_memory(id="mem-1", content="x", edits=[{"oldText": "a", "newText": "b"}])


async def test_update_sends_only_provided_fields(tools: GemdexTools, byoi: FakeByoi) -> None:
    await tools.update_memory(id="mem-1", title="New title")
    assert byoi.payload_for("update") == ("mem-1", {"title": "New title"})


async def test_update_empty_attachments_clears(tools: GemdexTools, byoi: FakeByoi) -> None:
    await tools.update_memory(id="mem-1", attachments=[])
    assert byoi.payload_for("update") == ("mem-1", {"attachments": []})


async def test_update_edits_read_modify_write(tools: GemdexTools, byoi: FakeByoi) -> None:
    byoi.get_result = make_memory(content="alpha beta gamma")
    await tools.update_memory(id="mem-1", edits=[{"oldText": "beta", "newText": "BETA"}])
    assert byoi.payload_for("get") == "mem-1"
    assert byoi.payload_for("update") == ("mem-1", {"content": "alpha BETA gamma"})


async def test_update_edits_missing_memory(tools: GemdexTools, byoi: FakeByoi) -> None:
    byoi.get_result = None
    with pytest.raises(ToolError, match="Memory not found: mem-1"):
        await tools.update_memory(id="mem-1", edits=[{"oldText": "a", "newText": "b"}])


async def test_update_edits_non_unique_old_text(tools: GemdexTools, byoi: FakeByoi) -> None:
    byoi.get_result = make_memory(content="dup dup")
    with pytest.raises(ToolError, match="oldText is not unique"):
        await tools.update_memory(id="mem-1", edits=[{"oldText": "dup", "newText": "x"}])


async def test_update_edits_replace_all(tools: GemdexTools, byoi: FakeByoi) -> None:
    byoi.get_result = make_memory(content="dup dup")
    await tools.update_memory(id="mem-1", edits=[{"oldText": "dup", "newText": "x", "replaceAll": True}])
    assert byoi.payload_for("update") == ("mem-1", {"content": "x x"})


async def test_update_edits_rejects_bad_shape(tools: GemdexTools) -> None:
    with pytest.raises(ToolError, match="string 'oldText' and 'newText'"):
        await tools.update_memory(id="mem-1", edits=[{"oldText": 1, "newText": "b"}])


# --- report_outcome ------------------------------------------------------


async def test_report_outcome_validates_id_against_backend(
    tools: GemdexTools, byoi: FakeByoi, stats: MemoryStatsStore
) -> None:
    byoi.get_result = None
    with pytest.raises(ToolError, match="Memory not found: junk"):
        await tools.report_outcome(id="junk", outcome="worked")
    # Nothing recorded for a junk id.
    assert stats.get("junk") is None


async def test_report_outcome_records_and_renders(tools: GemdexTools, stats: MemoryStatsStore) -> None:
    out = await tools.report_outcome(id="mem-1", outcome="worked", note="  followed it  ")
    assert 'Recorded outcome for "Deploy steps".' in out
    assert "track record: recalled 0×, worked 1×, failed 0×, stale 0×" in out
    assert stats.get("mem-1")["lastOutcome"]["note"] == "followed it"


async def test_report_outcome_note_capped(tools: GemdexTools, stats: MemoryStatsStore) -> None:
    await tools.report_outcome(id="mem-1", outcome="stale", note="x" * 600)
    assert len(stats.get("mem-1")["lastOutcome"]["note"]) == 500


# --- read_attachment -----------------------------------------------------


async def test_read_attachment_requires_memory_id(tools: GemdexTools) -> None:
    with pytest.raises(ToolError, match="'memory_id' is required"):
        await tools.read_attachment(memory_id=" ")


async def test_read_attachment_memory_not_found(tools: GemdexTools, byoi: FakeByoi) -> None:
    byoi.get_result = None
    with pytest.raises(ToolError, match="Memory not found: mem-1"):
        await tools.read_attachment(memory_id="mem-1")


async def test_read_attachment_no_attachments(tools: GemdexTools) -> None:
    with pytest.raises(ToolError, match="has no attachments"):
        await tools.read_attachment(memory_id="mem-1")


async def test_read_attachment_hints_at_transcript_footer(tools: GemdexTools, byoi: FakeByoi) -> None:
    byoi.get_result = make_memory(content="notes\nFull transcript: /tmp/x.jsonl")
    with pytest.raises(ToolError, match="Digest still has a local path footer"):
        await tools.read_attachment(memory_id="mem-1")


async def test_read_attachment_defaults_to_sole_attachment(tools: GemdexTools, byoi: FakeByoi) -> None:
    byoi.get_result = make_memory(attachments=[{"id": "0", "kind": "file", "caption": "Full transcript"}])
    byoi.attachment = (b"line one\nline two", "text/plain")
    out = await tools.read_attachment(memory_id="mem-1")
    assert byoi.payload_for("read_attachment") == ("mem-1", "0")
    assert "kind: file" in out
    assert "mimeType: text/plain" in out
    assert "byteLength: 17" in out
    assert "caption: Full transcript" in out
    assert out.endswith("encoding: utf-8\n\nline one\nline two")


async def test_read_attachment_prefers_sole_file_kind(tools: GemdexTools, byoi: FakeByoi) -> None:
    byoi.get_result = make_memory(
        attachments=[
            {"id": "img", "kind": "image"},
            {"id": "transcript", "kind": "file"},
        ]
    )
    byoi.attachment = (b"transcript body", "text/plain")
    await tools.read_attachment(memory_id="mem-1")
    assert byoi.payload_for("read_attachment") == ("mem-1", "transcript")


async def test_read_attachment_ambiguous_asks_for_id(tools: GemdexTools, byoi: FakeByoi) -> None:
    byoi.get_result = make_memory(
        attachments=[{"id": "a", "kind": "image"}, {"id": "b", "kind": "image"}]
    )
    with pytest.raises(ToolError, match="multiple attachments; pass 'attachment_id'"):
        await tools.read_attachment(memory_id="mem-1")


async def test_read_attachment_unknown_id(tools: GemdexTools, byoi: FakeByoi) -> None:
    byoi.get_result = make_memory(attachments=[{"id": "a", "kind": "image"}])
    with pytest.raises(ToolError, match="Attachment zz not found on mem-1. Available: a"):
        await tools.read_attachment(memory_id="mem-1", attachment_id="zz")


async def test_read_attachment_missing_blob(tools: GemdexTools, byoi: FakeByoi) -> None:
    byoi.get_result = make_memory(attachments=[{"id": "a", "kind": "file"}])
    byoi.attachment = None
    with pytest.raises(ToolError, match="Blob missing for mem-1/a"):
        await tools.read_attachment(memory_id="mem-1")


async def test_read_attachment_binary_returns_base64(tools: GemdexTools, byoi: FakeByoi) -> None:
    byoi.get_result = make_memory(attachments=[{"id": "a", "kind": "image"}])
    byoi.attachment = (b"\x89PNG\r\n", "image/png")
    out = await tools.read_attachment(memory_id="mem-1")
    assert "encoding: base64" in out
    assert out.endswith(base64.b64encode(b"\x89PNG\r\n").decode())


async def test_read_attachment_truncates_text(tools: GemdexTools, byoi: FakeByoi) -> None:
    byoi.get_result = make_memory(attachments=[{"id": "a", "kind": "file"}])
    byoi.attachment = (b"y" * 100, "text/plain")
    out = await tools.read_attachment(memory_id="mem-1", max_chars=10)
    assert "truncated: true" in out
    assert "showingChars: 10 of 100" in out
    assert f"default is {DEFAULT_READ_ATTACHMENT_MAX_CHARS}" in out
    assert out.endswith("y" * 10)
