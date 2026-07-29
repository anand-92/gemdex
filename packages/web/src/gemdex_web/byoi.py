"""Async HTTP client for the BYOI `/v1` memory API.

The same shape as `gemdex_mcp_http.byoi` — and, like it, the **only** module in
this package that touches the network. It differs in two ways that follow from
this being the *human* surface rather than the agent one:

- it has `delete()`, which the MCP client deliberately does not (deletion is a
  human action; see the root `AGENTS.md` "Six tools, no delete");
- it exposes `health()`/`version()`, which are unauthenticated on the BYOI and
  power the status page.
"""

from __future__ import annotations

from typing import Any

import httpx2


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

    def __init__(self, url: str, token: str, timeout_ms: int = 30_000, ingest_timeout_ms: int = 600_000) -> None:
        self._url = url.rstrip("/")
        #: Session ingest is one Gemini digest call per uploaded file, so it can
        #: run for minutes where a normal /v1 call is milliseconds. Sharing the
        #: default timeout would abort a legitimate multi-file upload, so a much
        #: larger budget is applied per-request instead of raising the default
        #: for everything.
        self._ingest_timeout_ms = ingest_timeout_ms
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

    async def list(self) -> list[dict[str, Any]]:
        body = await self._request("GET", "/v1/memories")
        return self._require_field(body, "memories", "/v1/memories")

    async def get(self, memory_id: str) -> dict[str, Any] | None:
        """`None` when the memory does not exist (HTTP 404), not an error."""
        path = f"/v1/memories/{_quote(memory_id)}"
        body = await self._request("GET", path, allow_not_found=True)
        if body is None:
            return None
        return self._require_field(body, "memory", path)

    async def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        body = await self._request("POST", "/v1/memories", json=payload)
        return self._require_field(body, "memory", "/v1/memories")

    async def update(self, memory_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        """`None` when the memory does not exist."""
        path = f"/v1/memories/{_quote(memory_id)}"
        body = await self._request("PATCH", path, json=payload, allow_not_found=True)
        if body is None:
            return None
        return self._require_field(body, "memory", path)

    async def delete(self, memory_id: str) -> bool:
        """`True` when deleted, `False` when it did not exist.

        Has no counterpart in the MCP surface on purpose: deleting a memory is a
        deliberate human action, so it lives only behind this authenticated UI.
        """
        path = f"/v1/memories/{_quote(memory_id)}"
        body = await self._request("DELETE", path, allow_not_found=True)
        return body is not None

    async def recall(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        body = await self._request("POST", "/v1/recall", json=payload)
        return self._require_field(body, "results", "/v1/recall")

    async def ingest_sessions(self, files: list[dict[str, str]]) -> dict[str, Any]:
        """Hand uploaded transcripts to the BYOI to clean, digest, and upsert.

        The BYOI is where this work happens because it is the only process that
        has all three prerequisites at once: `gemdex-core`'s TypeScript ingest
        pipeline, a `GEMINI_API_KEY`, and the memory store. This service is
        Python and holds no Gemini key, so it forwards rather than reimplements —
        the same "own no memory logic" rule as every other route here.

        Digestion is one Gemini call per file, so this can take much longer than
        a normal `/v1` call; the caller passes its own timeout.
        """
        body = await self._request(
            "POST", "/v1/sessions/ingest", json={"files": files}, timeout_ms=self._ingest_timeout_ms
        )
        return body or {}

    async def read_attachment(self, memory_id: str, attachment_id: str) -> tuple[bytes, str] | None:
        """Raw attachment bytes plus their mime type, or `None` when absent."""
        path = f"/v1/memories/{_quote(memory_id)}/attachments/{_quote(attachment_id)}"
        response = await self._send("GET", path, accept="*/*")
        if response.status_code == 404:
            return None
        if not response.is_success:
            raise ByoiError(
                _error_message(_maybe_json(response), response.status_code, response.reason_phrase),
                response.status_code,
            )
        mime_type = (response.headers.get("content-type") or "application/octet-stream").split(";")[0].strip()
        return response.content, mime_type or "application/octet-stream"

    # --- unauthenticated status routes ------------------------------------

    async def health(self) -> dict[str, Any]:
        body = await self._request("GET", "/v1/health")
        return body or {}

    async def version(self) -> dict[str, Any]:
        body = await self._request("GET", "/v1/version")
        return body or {}

    # --- plumbing ---------------------------------------------------------

    async def _request(
        self,
        method: str,
        path: str,
        json: dict[str, Any] | None = None,
        allow_not_found: bool = False,
        timeout_ms: int | None = None,
    ) -> dict[str, Any] | None:
        response = await self._send(method, path, json=json, timeout_ms=timeout_ms)
        if allow_not_found and response.status_code == 404:
            return None
        body = _maybe_json(response)
        if not response.is_success:
            raise ByoiError(
                _error_message(body, response.status_code, response.reason_phrase), response.status_code
            )
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
        timeout_ms: int | None = None,
    ) -> httpx2.Response:
        try:
            return await self._client.request(
                method,
                path,
                json=json,
                headers={"Accept": accept},
                **({"timeout": timeout_ms / 1000} if timeout_ms is not None else {}),
            )
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
