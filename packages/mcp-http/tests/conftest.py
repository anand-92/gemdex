"""Shared fixtures: a fake BYOI client and a server wired to it.

Nothing here touches the network or the real `~/.gemdex` store. `FakeByoi`
records the exact payloads the tool wrappers send, which is what most of these
tests assert on — the wrappers' whole job is translating tool args into `/v1`
calls and rendering the response.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastmcp import Client

from gemdex_mcp_http.byoi import ByoiError
from gemdex_mcp_http.config import Config
from gemdex_mcp_http.server import build_server
from gemdex_mcp_http.stats import MemoryStatsStore
from gemdex_mcp_http.tools import GemdexTools


#: The single account google mode admits in tests. Mirrors the real deployment's
#: GEMDEX_ALLOWED_EMAIL so the allowlist tests read like production.
ALLOWED_EMAIL = "nik.anand.1998@gmail.com"


def make_memory(**overrides: Any) -> dict[str, Any]:
    memory = {
        "id": "mem-1",
        "title": "Deploy steps",
        "content": "Run scripts/deploy.sh then verify /health.",
        "attachments": [],
        "createdAt": 1_700_000_000_000,
        "updatedAt": 1_700_000_000_000,
    }
    memory.update(overrides)
    return memory


class FakeByoi:
    """Stand-in for `ByoiClient`. Same method surface, no network."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.save_result: dict[str, Any] = make_memory()
        self.recall_results: list[dict[str, Any]] = []
        self.update_result: dict[str, Any] = make_memory()
        self.get_result: dict[str, Any] | None = make_memory()
        self.list_result: list[dict[str, Any]] = []
        self.attachment: tuple[bytes, str] | None = None
        self.raise_on: str | None = None

    def _record(self, name: str, payload: Any) -> None:
        self.calls.append((name, payload))
        if self.raise_on == name:
            raise ByoiError(f"boom in {name}", 500)

    async def save(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._record("save", payload)
        return self.save_result

    async def recall(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        self._record("recall", payload)
        return self.recall_results

    async def update(self, memory_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        self._record("update", (memory_id, payload))
        return self.update_result

    async def get(self, memory_id: str) -> dict[str, Any] | None:
        self._record("get", memory_id)
        return self.get_result

    async def list(self) -> list[dict[str, Any]]:
        self._record("list", None)
        return self.list_result

    async def read_attachment(self, memory_id: str, attachment_id: str) -> tuple[bytes, str] | None:
        self._record("read_attachment", (memory_id, attachment_id))
        return self.attachment

    async def aclose(self) -> None:
        self.calls.append(("aclose", None))

    def payload_for(self, name: str) -> Any:
        return next(payload for called, payload in self.calls if called == name)


def make_config(**overrides: Any) -> Config:
    defaults: dict[str, Any] = {
        "byoi_url": "http://127.0.0.1:8765",
        "byoi_token": "byoi-token",
        "host": "127.0.0.1",
        "port": 8766,
        "timeout_ms": 30_000,
        "client_token": "client-token",
        "unsafe_no_auth": False,
        "trust_ranking": False,
        "auth_mode": "static",
        "google_client_id": None,
        "google_client_secret": None,
        "public_base_url": None,
        "allowed_email": None,
    }
    defaults.update(overrides)
    return Config(**defaults)


def make_google_config(**overrides: Any) -> Config:
    """A config in google mode, with plausible-shaped Google credentials."""
    defaults: dict[str, Any] = {
        "auth_mode": "google",
        "client_token": None,
        "google_client_id": "123456.apps.googleusercontent.com",
        "google_client_secret": "GOCSPX-test-secret",
        "public_base_url": "https://mcp.example.com",
        "allowed_email": ALLOWED_EMAIL,
    }
    defaults.update(overrides)
    return make_config(**defaults)


@pytest.fixture
def byoi() -> FakeByoi:
    return FakeByoi()


@pytest.fixture
def stats(tmp_path: Path) -> MemoryStatsStore:
    return MemoryStatsStore(tmp_path / "stats.json")


@pytest.fixture
def tools(byoi: FakeByoi, stats: MemoryStatsStore) -> GemdexTools:
    return GemdexTools(byoi, stats)


@pytest.fixture
def trust_tools(byoi: FakeByoi, stats: MemoryStatsStore) -> GemdexTools:
    return GemdexTools(byoi, stats, trust_ranking=True)


@pytest.fixture
def client(byoi: FakeByoi) -> Client:
    """An in-memory MCP client against the real server, with the BYOI faked."""
    return Client(build_server(make_config(unsafe_no_auth=True, client_token=None), client=byoi))
