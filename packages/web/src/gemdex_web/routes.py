"""The BFF's JSON API, under `/api`.

Every route here depends on `require_identity`, so an unauthenticated request
gets a 401 before any BYOI call happens. The shapes are deliberately *not* a
transparent proxy of `/v1`: this layer decides what the browser is allowed to
know, which is what makes it a BFF rather than a CORS hole.

Two rules worth keeping in mind when adding routes:

1. **Never put the BYOI token, or any raw BYOI error body, in a response.**
   `_byoi_http_error` maps upstream failures to a sanitized message.
2. **Search and pagination are server-side.** See `list_memories`.
"""

from __future__ import annotations

import re
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, File, HTTPException, Query, Request, Response, UploadFile

from .auth import Identity, require_identity
from .byoi import ByoiClient, ByoiError
from .config import Config
from .uploads import RejectedUpload, UploadError, collect_uploads

router = APIRouter(prefix="/api", dependencies=[Depends(require_identity)])

#: Page size cap. The BYOI has no pagination — `GET /v1/memories` returns every
#: summary — so this bounds what we forward to the browser, not what we fetch.
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200

#: `/v1/recall` enforces 1..50 itself; mirror it so a bad value is a clean 422
#: from us rather than a 400 relayed from upstream.
RECALL_MAX_LIMIT = 50
RECALL_DEFAULT_LIMIT = 10

MAX_QUERY_CHARS = 500

#: Mirrors the BYOI's own inline-vs-download rule. Anything outside this set is
#: served as an attachment download with `nosniff`, so a stored `text/html`
#: attachment cannot execute as script in this app's origin.
SAFE_INLINE_MIME_TYPES = frozenset(
    {
        "text/plain",
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "application/pdf",
    }
)


def _client(request: Request) -> ByoiClient:
    return request.app.state.byoi


def _config(request: Request) -> Config:
    return request.app.state.config


def _byoi_http_error(error: ByoiError) -> HTTPException:
    """Translate a BYOI failure into a client-facing HTTPException.

    Upstream 4xx messages are forwarded (they are validation feedback the user
    needs, e.g. "'content' or at least one attachment is required"), but
    5xx/transport failures are collapsed into a generic message: their text can
    name internal hosts, ports, or the storage backend, and the browser is
    untrusted.
    """
    status = error.status
    # 401/403 from the BYOI mean *our* bearer is wrong — a server
    # misconfiguration, not a failure of the user's session. Passing them
    # through would make the SPA treat it as "your login expired" and bounce the
    # user into a login loop that cannot possibly fix it.
    if status in (401, 403):
        return HTTPException(
            status_code=502,
            detail="This server was rejected by the Gemdex server. Check GEMDEX_SERVER_TOKEN.",
        )
    if status is not None and 400 <= status < 500:
        return HTTPException(status_code=status, detail=str(error))
    return HTTPException(status_code=502, detail="The Gemdex server is unreachable or failed.")


def _matches(memory: dict[str, Any], needle: str) -> bool:
    """Case-insensitive substring match over title and preview.

    Same fields and same semantics as the `list_memories` MCP tool's `filter`
    argument, so the two surfaces agree on what "search" means literally.
    """
    return needle in (memory.get("title") or "").lower() or needle in (memory.get("preview") or "").lower()


@router.get("/memories")
async def list_memories(
    request: Request,
    q: Annotated[str | None, Query(max_length=MAX_QUERY_CHARS)] = None,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = DEFAULT_PAGE_SIZE,
) -> dict[str, Any]:
    """Newest-first memory summaries, substring-filtered and paginated.

    **Why the filtering is here and not in the browser or the BYOI:** the BYOI
    has no substring-search route at all (`GET /v1/memories` lists everything,
    `POST /v1/recall` is semantic/embedding-based — a different feature, exposed
    separately below). So a literal search has to happen in one of the two
    shells. Measured against the real pool, the full list is ~1300 records and
    ~540 KB, which the BFF fetches over loopback in tens of milliseconds but
    which would be absurd to re-download into the browser on every keystroke.
    Filtering here keeps the wire payload proportional to what is displayed.

    The summaries are already sorted `updatedAt` desc by the BYOI, so no re-sort.
    """
    try:
        memories = await _client(request).list()
    except ByoiError as error:
        raise _byoi_http_error(error) from error

    needle = (q or "").strip().lower()
    matched = [m for m in memories if _matches(m, needle)] if needle else memories
    page = matched[offset : offset + limit]

    return {
        "memories": [_summary(m) for m in page],
        # `total` is the match count, not the pool size, so the UI can say
        # "12 of 340 match" without a second request.
        "total": len(matched),
        "poolTotal": len(memories),
        "offset": offset,
        "limit": limit,
    }


@router.get("/memories/{memory_id}")
async def get_memory(request: Request, memory_id: str) -> dict[str, Any]:
    try:
        memory = await _client(request).get(memory_id)
    except ByoiError as error:
        raise _byoi_http_error(error) from error
    if memory is None:
        raise HTTPException(status_code=404, detail="Memory not found.")
    return {"memory": _detail(memory)}


@router.post("/memories", status_code=201)
async def create_memory(
    request: Request,
    payload: Annotated[dict[str, Any], Body()],
) -> dict[str, Any]:
    """Create a text memory.

    Text only: this accepts `content` and `title`. Files arrive through
    `POST /sessions/upload` instead, where a transcript becomes its own digested
    memory rather than an attachment on one the user is typing.

    The BYOI enforces the "content or at least one attachment" rule, so an empty
    body surfaces as its 400 rather than a rule duplicated here.
    """
    body: dict[str, Any] = {"content": _optional_str(payload, "content") or ""}
    title = _optional_str(payload, "title")
    if title:
        body["title"] = title

    try:
        memory = await _client(request).create(body)
    except ByoiError as error:
        raise _byoi_http_error(error) from error
    return {"memory": _detail(memory)}


@router.patch("/memories/{memory_id}")
async def update_memory(
    request: Request,
    memory_id: str,
    payload: Annotated[dict[str, Any], Body()],
) -> dict[str, Any]:
    """Edit a memory's content and/or title.

    Only the fields present in the request are forwarded, so a title-only edit
    does not resend (and re-embed) unchanged content.
    """
    body: dict[str, Any] = {}
    for field in ("content", "title"):
        if field in payload:
            value = _optional_str(payload, field)
            if value is None:
                raise HTTPException(status_code=422, detail=f"'{field}' must be a string.")
            body[field] = value
    if not body:
        raise HTTPException(status_code=422, detail="Provide at least one of 'content' or 'title'.")

    try:
        memory = await _client(request).update(memory_id, body)
    except ByoiError as error:
        raise _byoi_http_error(error) from error
    if memory is None:
        raise HTTPException(status_code=404, detail="Memory not found.")
    return {"memory": _detail(memory)}


@router.delete("/memories/{memory_id}")
async def delete_memory(request: Request, memory_id: str) -> dict[str, Any]:
    """Delete a memory. **The only delete surface in Gemdex's HTTP stack.**

    The MCP transports deliberately expose no delete tool (root `AGENTS.md`,
    "Six tools, no delete") because deletion is irreversible and should be a
    deliberate human act. That intent survives only as long as this route stays
    behind `require_identity` and the confirm step in the UI — do not add a
    delete tool to `packages/mcp-http` to "make the surfaces consistent".
    """
    try:
        deleted = await _client(request).delete(memory_id)
    except ByoiError as error:
        raise _byoi_http_error(error) from error
    if not deleted:
        raise HTTPException(status_code=404, detail="Memory not found.")
    return {"ok": True}


@router.post("/recall")
async def recall(
    request: Request,
    payload: Annotated[dict[str, Any], Body()],
) -> dict[str, Any]:
    """Semantic recall — the relevance-ranked path, distinct from `?q=` substring search.

    Both are exposed because they answer different questions: `?q=` finds a
    remembered phrase, recall finds conceptually related memories.
    """
    query = (_optional_str(payload, "query") or "").strip()
    if not query:
        raise HTTPException(status_code=422, detail="'query' is required.")

    limit = payload.get("limit", RECALL_DEFAULT_LIMIT)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= RECALL_MAX_LIMIT:
        raise HTTPException(
            status_code=422, detail=f"'limit' must be an integer between 1 and {RECALL_MAX_LIMIT}."
        )

    try:
        results = await _client(request).recall({"query": query, "limit": limit})
    except ByoiError as error:
        raise _byoi_http_error(error) from error
    return {"results": [_recall_result(r) for r in results]}


@router.get("/memories/{memory_id}/attachments/{attachment_id}")
async def read_attachment(
    request: Request,
    memory_id: str,
    attachment_id: str,
    download: Annotated[bool, Query()] = False,
) -> Response:
    """Stream attachment bytes — the `read_attachment` equivalent for humans.

    Content-type handling mirrors the BYOI's: known-safe types are served
    inline so transcripts and images render in the browser, everything else
    becomes an `application/octet-stream` download. `X-Content-Type-Options:
    nosniff` is unconditional, so the browser cannot re-interpret a
    `text/plain` transcript as HTML and run script in this app's origin — which
    matters more here than on the BYOI, because this origin holds the session
    cookie.
    """
    try:
        blob = await _client(request).read_attachment(memory_id, attachment_id)
    except ByoiError as error:
        raise _byoi_http_error(error) from error
    if blob is None:
        raise HTTPException(status_code=404, detail="Attachment not found.")

    data, mime_type = blob
    normalized = (mime_type or "").lower()
    inline = not download and normalized in SAFE_INLINE_MIME_TYPES
    disposition = "inline" if inline else "attachment"
    filename = _attachment_filename(memory_id, attachment_id, normalized)

    return Response(
        content=data,
        media_type=normalized if inline else "application/octet-stream",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": f'{disposition}; filename="{filename}"',
            # Attachment bytes are private to an authenticated user; keep them
            # out of shared caches.
            "Cache-Control": "private, no-store",
        },
    )


@router.post("/sessions/upload")
async def upload_sessions(
    request: Request,
    files: Annotated[list[UploadFile], File()],
) -> dict[str, Any]:
    """Upload coding-agent session transcripts; the **host** cleans and digests them.

    This is "path B" of chat-history ingestion. Path A is `gemdex sync-history`,
    where a laptop digests its own sessions with its own Gemini key and pushes
    the finished records. Here the human hands over raw transcripts and the
    deployment does the work — so a machine that never ran the CLI, or someone
    else's exported session, can still land in the pool.

    Both paths converge on the same memory: same cleaning, same digest prompt,
    and above all the same deterministic `chat:<source>:<sessionId>` id. That id
    is why re-uploading a session **upserts** instead of duplicating, and why a
    session that was already synced from a laptop is updated rather than
    doubled.

    **The digesting happens on `gemdex-server`, not here** — see `uploads.py` for
    why. This route decodes the form (expanding zips) and forwards; it holds no
    Gemini key and contains no ingest logic.

    The response is always a per-file list. A corrupt transcript in a batch of
    ten is that file's `failed`/`skipped` status next to nine successes, never a
    500 that discards the whole upload — the user needs to know *which* file to
    look at, and the successful digests are already paid for.
    """
    entries: list[tuple[str, bytes]] = [(file.filename or "unnamed", await file.read()) for file in files]

    try:
        uploads, rejected = collect_uploads(entries)
    except UploadError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    try:
        summary = await _client(request).ingest_sessions(
            [{"filename": upload.filename, "content": upload.content} for upload in uploads]
        )
    except ByoiError as error:
        # The BYOI answers 503 to this route for exactly one reason: it has no
        # GEMINI_API_KEY, so it cannot digest. That is a fixable deployment
        # setting, and the generic "unreachable or failed" 502 would send the
        # operator looking at the network instead. The message is written here,
        # not relayed, so nothing upstream can put text on the page.
        if error.status == 503:
            raise HTTPException(
                status_code=503,
                detail=(
                    "The Gemdex server cannot digest sessions: it has no GEMINI_API_KEY. "
                    "Set it in the server's environment and restart it."
                ),
            ) from error
        raise _byoi_http_error(error) from error

    results = [_ingest_result(result) for result in (summary.get("results") or [])]
    # Locally rejected entries join the upstream results so the UI renders one
    # list: from the user's side, "the zip member I gave you" and "the file the
    # digester choked on" are the same kind of outcome.
    results.extend(_rejected_result(entry) for entry in rejected)

    return {
        "results": results,
        "ingested": sum(1 for result in results if result["status"] == "ingested"),
        "skipped": sum(1 for result in results if result["status"] == "skipped"),
        "failed": sum(1 for result in results if result["status"] == "failed"),
    }


@router.get("/status")
async def status(request: Request) -> dict[str, Any]:
    """Connection/status page data: BYOI reachability, versions, and how this app is configured.

    Reports its own auth posture too, so an operator can confirm from the
    running app — not from a config file they hope matches — that `dev` mode
    isn't live in a deployment that should be gated.
    """
    config = _config(request)
    client = _client(request)

    byoi: dict[str, Any] = {"url": config.byoi_url, "reachable": False}
    try:
        health = await client.health()
        version = await client.version()
        byoi.update(
            {
                "reachable": bool(health.get("ok", True)),
                "name": version.get("name"),
                "serverVersion": version.get("serverVersion"),
                "apiVersion": version.get("apiVersion"),
                "minClientVersion": version.get("minClientVersion"),
                "protocolVersion": version.get("protocolVersion"),
                "capabilities": version.get("capabilities"),
            }
        )
    except ByoiError as error:
        # A status page that 502s when the thing it reports on is down is
        # useless — the outage is the information. So this is a 200 whose body
        # says unreachable.
        byoi["error"] = "Unreachable or failing. Check that gemdex-server is running."
        byoi["detail"] = str(error) if error.status is not None else None

    return {
        "byoi": byoi,
        "web": {
            "authMode": config.auth_mode,
            "allowedEmail": config.allowed_email,
            "sessionTtlSeconds": config.session_ttl_seconds,
        },
    }


# --- response shaping -----------------------------------------------------
#
# The BFF returns explicit projections rather than forwarding BYOI objects
# verbatim. Two reasons: a new upstream field cannot silently start reaching the
# browser, and the frontend's types stay a contract with *this* service.


def _summary(memory: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": memory.get("id"),
        "title": memory.get("title"),
        "preview": memory.get("preview"),
        "createdAt": memory.get("createdAt"),
        "updatedAt": memory.get("updatedAt"),
        "attachmentCount": len(memory.get("attachments") or []),
    }


def _detail(memory: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": memory.get("id"),
        "title": memory.get("title"),
        "content": memory.get("content"),
        "preview": memory.get("preview"),
        "createdAt": memory.get("createdAt"),
        "updatedAt": memory.get("updatedAt"),
        "attachments": [_attachment(a) for a in (memory.get("attachments") or [])],
    }


def _attachment(attachment: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": attachment.get("id"),
        "kind": attachment.get("kind"),
        "mimeType": attachment.get("mimeType"),
        "byteSize": attachment.get("byteSize"),
        "caption": attachment.get("caption"),
    }


def _recall_result(result: dict[str, Any]) -> dict[str, Any]:
    """Normalize a `/v1/recall` hit into `{memory, score}`.

    The BYOI returns recall hits **flat** — the memory's own fields with a
    numeric `score` alongside them — not nested under a `memory` key the way
    `/v1/memories/:id` responses are. Nesting here keeps the browser's two list
    shapes identical, so the list view renders filter results and recall results
    with one code path.
    """
    score = result.get("score")
    return {
        "memory": _summary(result),
        # Normalized to an object so a future multi-signal score (the TS
        # surfaces render `fused=… dense=… bm25=…`) is an added key rather than
        # a breaking type change in the SPA.
        "score": {"fused": score} if isinstance(score, (int, float)) else None,
    }


#: Skip reasons the BYOI reports, rendered for a human. The upstream words are
#: internal to core's parser; these are what the person who uploaded the file
#: needs to hear.
_SKIP_EXPLANATIONS = {
    "unparseable": "not a recognizable agent session transcript (no JSON records found).",
    "trivial": "too short to be worth a digest (almost no conversation in it).",
}


def _ingest_result(result: dict[str, Any]) -> dict[str, Any]:
    """Project one BYOI per-file ingest result for the browser.

    An explicit projection like every other response here, and for one extra
    reason: an upstream `error` string is written by the digester and can name
    the model, the store, or an internal host, so it is replaced with a fixed
    message rather than forwarded. The *filename* is what the user acts on.
    """
    status = result.get("status")
    if status not in ("ingested", "skipped", "failed"):
        status = "failed"
    projected: dict[str, Any] = {"filename": result.get("filename"), "status": status}
    if status == "ingested":
        projected["memoryId"] = result.get("memoryId")
        projected["title"] = result.get("title")
        projected["source"] = result.get("source")
    elif status == "skipped":
        reason = result.get("reason")
        projected["detail"] = _SKIP_EXPLANATIONS.get(
            reason if isinstance(reason, str) else "", "skipped by the ingester."
        )
    else:
        projected["detail"] = "the deployment could not digest this session. Check the gemdex-server logs."
    return projected


def _rejected_result(entry: RejectedUpload) -> dict[str, Any]:
    """A file this service refused before any BYOI call.

    Reported as `skipped` rather than `failed` because nothing went wrong in the
    deployment — the input was not a session transcript, or was too large. The
    reason is ours, so unlike an upstream error it is safe to show verbatim.
    """
    return {"filename": entry.filename, "status": "skipped", "detail": entry.error}


def _optional_str(payload: dict[str, Any], field: str) -> str | None:
    value = payload.get(field)
    return value if isinstance(value, str) else None


_UNSAFE_FILENAME = re.compile(r"[^A-Za-z0-9._-]")
_MIME_EXTENSIONS = {
    "text/plain": "txt",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "application/pdf": "pdf",
}


def _attachment_filename(memory_id: str, attachment_id: str, mime_type: str) -> str:
    """A filesystem- and header-safe download name.

    Sanitized rather than interpolated: ids reach us from the URL path, and an
    unescaped quote or newline in a `Content-Disposition` value is a header
    injection.
    """
    stem = _UNSAFE_FILENAME.sub("-", f"gemdex-{memory_id[:12]}-{attachment_id}")
    extension = _MIME_EXTENSIONS.get(mime_type)
    return f"{stem}.{extension}" if extension else stem
