"""Async HTTP client for the colocated BYOI `/v1` memory API.

The Python analogue of `gemdex-core`'s `RemoteMemoryBackend`: it owns **no**
memory logic, only the wire calls. Every tool wrapper in `tools.py` goes through
this class, and this is the only module in the package that touches the network.
"""

from __future__ import annotations

from typing import Any

import httpx2

# Mirrors RemoteMemoryBackend's client-side caps.
BODY_LIMIT_BYTES = 100 * 1024 * 1024


class ByoiError(Exception):
    """A BYOI request failed. `status` is set for HTTP error responses."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def _error_message(body: Any, status: int, reason: str) -> str:
    if isinstance(body, dict) and isinstance(body.get("error"), str):
        return body["error"]
    suffix = f" {reason}" if reason else ""
    return f"Gemdex Server returned HTTP {status}{suffix}."


class ByoiClient:
    """Thin `/v1` client. Construct once per process; `aclose()` on shutdown."""

    def __init__(self, url: str, token: str, timeout_ms: int = 30_000) -> None:
        self._url = url.rstrip("/")
        self._client = httpx2.AsyncClient(
            base_url=self._url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=timeout_ms / 1000,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> ByoiClient:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    # --- memory routes ----------------------------------------------------

    async def save(self, payload: dict[str, Any]) -> dict[str, Any]:
        body = await self._request("POST", "/v1/memories", json=payload)
        return self._require_field(body, "memory", "/v1/memories")

    async def recall(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        body = await self._request("POST", "/v1/recall", json=payload)
        return self._require_field(body, "results", "/v1/recall")

    async def update(self, memory_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        path = f"/v1/memories/{_quote(memory_id)}"
        body = await self._request("PUT", path, json=payload)
        return self._require_field(body, "memory", path)

    async def get(self, memory_id: str) -> dict[str, Any] | None:
        """`None` when the memory does not exist (HTTP 404), not an error."""
        path = f"/v1/memories/{_quote(memory_id)}"
        body = await self._request("GET", path, allow_not_found=True)
        if body is None:
            return None
        return self._require_field(body, "memory", path)

    async def list(self) -> list[dict[str, Any]]:
        body = await self._request("GET", "/v1/memories")
        return self._require_field(body, "memories", "/v1/memories")

    async def import_records(self, records: list[dict[str, Any]]) -> dict[str, Any]:
        """Upsert portable records by id — the only write that preserves an id.

        `save` mints a fresh server-side UUID, which would duplicate a chat
        session on every sync run; `/v1/import` upserts on the deterministic
        `chat:<source>:<sessionId>` id instead. This backs the sync-history
        route and has no tool wrapper: it is not part of the six-tool surface.
        """
        body = await self._request("POST", "/v1/import", json={"records": records})
        assert body is not None  # _request only returns None for allowed 404s
        imported = body.get("imported")
        if not isinstance(imported, int):
            raise ByoiError("Invalid response from Gemdex Server for /v1/import: missing 'imported' field.")
        return {
            "imported": imported,
            # Servers pre-dating per-record import errors return only { imported }.
            "failed": body["failed"] if isinstance(body.get("failed"), int) else 0,
            "errors": body["errors"] if isinstance(body.get("errors"), list) else [],
        }

    async def read_attachment(self, memory_id: str, attachment_id: str) -> tuple[bytes, str] | None:
        """Raw attachment bytes plus their mime type, or `None` when absent."""
        path = f"/v1/memories/{_quote(memory_id)}/attachments/{_quote(attachment_id)}"
        response = await self._send("GET", path, accept="*/*")
        if response.status_code == 404:
            return None
        if not response.is_success:
            raise ByoiError(_error_message(_maybe_json(response), response.status_code, response.reason_phrase),
                            response.status_code)
        mime_type = (response.headers.get("content-type") or "application/octet-stream").split(";")[0].strip()
        return response.content, mime_type or "application/octet-stream"

    # --- plumbing ---------------------------------------------------------

    async def _request(
        self,
        method: str,
        path: str,
        json: dict[str, Any] | None = None,
        allow_not_found: bool = False,
    ) -> dict[str, Any] | None:
        response = await self._send(method, path, json=json)
        if allow_not_found and response.status_code == 404:
            return None
        body = _maybe_json(response)
        if not response.is_success:
            raise ByoiError(_error_message(body, response.status_code, response.reason_phrase),
                            response.status_code)
        if body is None:
            raise ByoiError(f"Gemdex Server returned an empty body for {path}.")
        if not isinstance(body, dict):
            raise ByoiError(f"Invalid response from Gemdex Server for {path}: expected a JSON object.")
        return body

    async def _send(
        self,
        method: str,
        path: str,
        json: dict[str, Any] | None = None,
        accept: str = "application/json",
    ) -> httpx2.Response:
        try:
            return await self._client.request(method, path, json=json, headers={"Accept": accept})
        except httpx2.TimeoutException as error:
            raise ByoiError(f"Gemdex Server request to {path} timed out.") from error
        except httpx2.HTTPError as error:
            raise ByoiError(f"Unable to reach Gemdex Server at {self._url}: {error}") from error

    @staticmethod
    def _require_field(body: dict[str, Any] | None, field: str, path: str) -> Any:
        if body is None or field not in body:
            raise ByoiError(f"Invalid response from Gemdex Server for {path}: missing '{field}' field.")
        return body[field]


def _maybe_json(response: httpx2.Response) -> Any:
    if not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        return None


def _quote(value: str) -> str:
    from urllib.parse import quote

    return quote(value, safe="")
