"""The sync-history ingest route: `POST /mcp/sync/records`.

Why this exists at all, given "six tools, no delete" and "this package owns no
memory logic": chat-history sync needs to **upsert on a deterministic id**
(`chat:<source>:<sessionId>`), and no MCP tool can do that. `save_memory` mints
a fresh server-side UUID, so a laptop syncing the same session twice would
create two memories; `update_memory` needs the id to already exist. The
capability the sync client needs — upsert-by-id — is `/v1/import`, which is
deliberately absent from the agent tool surface.

So this is a **route, not a tool**: agents never see it (`list_tools` is
unchanged), and it stays a thin pass-through to BYOI `/v1/import`, exactly like
every tool wrapper. The digest text and the cleaned transcript blob are produced
on the *client* (which has the Gemini key and the session files); this endpoint
only forwards the resulting records.

Why it is mounted under `/mcp/…`: the public edge already routes `^/mcp` to this
container (see docs/SELF_HOST_DEPLOY.md). A sibling path such as `/sync` would
silently fall through to the web UI until every deployment's edge config was
updated, which fails *open* into a confusing 404 rather than closed.

Auth: FastMCP exempts custom routes from its auth middleware (that is what makes
`/healthz` work as an unauthenticated healthcheck in google mode). A write route
must therefore enforce auth **itself** — `require_access_token` below runs the
configured provider's own `verify_token`, so the static bearer and the
single-user Google allowlist both apply here with no mode branching, and an
unauthenticated request can never reach the BYOI.
"""

from __future__ import annotations

import json
from typing import Any

from fastmcp.server.auth import AuthProvider
from fastmcp.server.auth.auth import AccessToken
from fastmcp.utilities.logging import get_logger
from starlette.requests import Request
from starlette.responses import JSONResponse

from .byoi import ByoiClient, ByoiError

logger = get_logger(__name__)

#: Path of the sync route. Under `/mcp` so the existing edge rule covers it.
SYNC_RECORDS_PATH = "/mcp/sync/records"

#: Matches core's `ATTACHMENT_BODY_LIMIT` — records carry base64 transcripts.
MAX_BODY_BYTES = 100 * 1024 * 1024

#: Per-request record cap. The client batches; this bounds one request's work.
MAX_RECORDS_PER_REQUEST = 50

#: Only chat-history digests may be written here. This route exists for
#: sync-history and nothing else, so it must not become a general-purpose
#: write-anything-by-id endpoint that bypasses the tool surface.
REQUIRED_ID_PREFIX = "chat:"


class SyncRequestError(Exception):
    """The request body is malformed. `status` is the HTTP status to return."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def _bearer_token(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer":
        return None
    token = value.strip()
    return token or None


async def require_access_token(request: Request, auth: AuthProvider | None) -> AccessToken | None:
    """Verify the request's bearer against the configured provider.

    Returns the verified token, or raises `SyncRequestError(401)`. `auth is
    None` means `GEMDEX_MCP_HTTP_UNSAFE_NO_AUTH=true`, which the config layer
    only permits explicitly for loopback development — the same escape hatch
    `/mcp` itself honors, so this route is neither stricter nor looser.

    Calling the provider's own `verify_token` is what keeps auth in one place:
    in google mode that is `SingleUserGoogleProvider.verify_token`, so the
    email allowlist and the `email_verified` requirement apply here too.
    """
    if auth is None:
        return None
    token = _bearer_token(request)
    if token is None:
        raise SyncRequestError("Authorization: Bearer <token> is required.", 401)
    access_token = await auth.verify_token(token)
    if access_token is None:
        raise SyncRequestError("Invalid or unauthorized token.", 401)
    return access_token


def _validate_attachments(attachments: Any, record_index: int) -> list[dict[str, Any]]:
    if not isinstance(attachments, list):
        raise SyncRequestError(f"record #{record_index + 1}: 'attachments' must be an array.")
    validated: list[dict[str, Any]] = []
    for index, attachment in enumerate(attachments):
        if not isinstance(attachment, dict):
            raise SyncRequestError(
                f"record #{record_index + 1} attachment #{index + 1}: must be an object."
            )
        mime_type = attachment.get("mimeType")
        data = attachment.get("data")
        if not isinstance(mime_type, str) or not mime_type.strip():
            raise SyncRequestError(
                f"record #{record_index + 1} attachment #{index + 1}: 'mimeType' is required."
            )
        if not isinstance(data, str) or not data:
            raise SyncRequestError(
                f"record #{record_index + 1} attachment #{index + 1}: inline base64 'data' is required."
            )
        entry: dict[str, Any] = {"mimeType": mime_type, "data": data}
        for optional in ("id", "caption"):
            value = attachment.get(optional)
            if isinstance(value, str) and value:
                entry[optional] = value
        validated.append(entry)
    return validated


def validate_records(body: Any) -> list[dict[str, Any]]:
    """Validate a `{ records: [...] }` payload into BYOI export records.

    Rejects anything whose id is not `chat:`-prefixed: this route is the
    sync-history path, not a general upsert-by-id back door around the six
    tools. Unknown fields are dropped rather than forwarded, so a client cannot
    smuggle extra keys into the BYOI import payload.
    """
    if not isinstance(body, dict):
        raise SyncRequestError("Request body must be a JSON object with a 'records' array.")
    records = body.get("records")
    if not isinstance(records, list) or not records:
        raise SyncRequestError("'records' must be a non-empty array.")
    if len(records) > MAX_RECORDS_PER_REQUEST:
        raise SyncRequestError(
            f"Too many records: {len(records)} exceeds the {MAX_RECORDS_PER_REQUEST}-record "
            "per-request limit. Send them in smaller batches."
        )

    validated: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise SyncRequestError(f"record #{index + 1}: must be an object.")
        record_id = record.get("id")
        if not isinstance(record_id, str) or not record_id.strip():
            raise SyncRequestError(f"record #{index + 1}: 'id' is required.")
        record_id = record_id.strip()
        if not record_id.startswith(REQUIRED_ID_PREFIX):
            raise SyncRequestError(
                f"record #{index + 1}: id '{record_id}' must start with "
                f"'{REQUIRED_ID_PREFIX}'. This route only accepts chat-history digests."
            )
        content = record.get("content")
        if not isinstance(content, str) or not content.strip():
            raise SyncRequestError(f"record #{index + 1}: 'content' is required.")

        entry: dict[str, Any] = {"id": record_id, "content": content}
        title = record.get("title")
        if isinstance(title, str) and title.strip():
            entry["title"] = title
        for stamp in ("createdAt", "updatedAt"):
            value = record.get(stamp)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                entry[stamp] = int(value)
        if record.get("attachments") is not None:
            entry["attachments"] = _validate_attachments(record["attachments"], index)
        validated.append(entry)
    return validated


async def handle_sync_records(
    request: Request,
    client: ByoiClient,
    auth: AuthProvider | None,
) -> JSONResponse:
    """Authenticate, validate, and forward digest records to BYOI `/v1/import`."""
    try:
        access_token = await require_access_token(request, auth)
    except SyncRequestError as error:
        # 401s carry the discovery hint an MCP OAuth client needs to start a flow.
        return JSONResponse(
            {"error": str(error)},
            status_code=error.status,
            headers={"WWW-Authenticate": 'Bearer realm="gemdex"'},
        )

    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        return JSONResponse(
            {"error": f"Request body exceeds the {MAX_BODY_BYTES}-byte limit."}, status_code=413
        )

    try:
        records = validate_records(json.loads(raw) if raw else None)
    except SyncRequestError as error:
        return JSONResponse({"error": str(error)}, status_code=error.status)
    except ValueError:
        return JSONResponse({"error": "Request body is not valid JSON."}, status_code=400)

    try:
        result = await client.import_records(records)
    except ByoiError as error:
        # 502: the failure is the upstream BYOI's, not the client's request.
        return JSONResponse({"error": f"Failed to sync records: {error}"}, status_code=502)

    logger.info(
        "sync-history: imported %d of %d record(s) for %s",
        result["imported"],
        len(records),
        (access_token.claims or {}).get("email") if access_token else "unauthenticated-dev",
    )
    return JSONResponse(result)
