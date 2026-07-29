"""Shared fixtures. The BYOI is always faked — no test touches the network."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from gemdex_web.byoi import ByoiError
from gemdex_web.config import Config, load_config

#: A path that cannot exist, so `EnvSource` never picks up the developer's real
#: `~/.gemdex/.env` and a test's outcome doesn't depend on the host.
NO_DOTENV = Path("/nonexistent/.env")

#: The BYOI bearer used throughout. Distinctive on purpose: the leak tests grep
#: whole response bodies for this exact string.
BYOI_TOKEN = "byoi-secret-token-do-not-leak"

ALLOWED_EMAIL = "nik.anand.1998@gmail.com"
OTHER_EMAIL = "someone.else@gmail.com"
CLIENT_ID = "test-client-id.apps.googleusercontent.com"
SESSION_SECRET = "s" * 48


def make_dev_config(**overrides: str) -> Config:
    env = {"GEMDEX_SERVER_TOKEN": BYOI_TOKEN, **overrides}
    return load_config(env=env, dotenv_path=NO_DOTENV)


def make_google_config(**overrides: str) -> Config:
    env = {
        "GEMDEX_SERVER_TOKEN": BYOI_TOKEN,
        "GEMDEX_WEB_AUTH": "google",
        "GOOGLE_OAUTH_CLIENT_ID": CLIENT_ID,
        "GOOGLE_OAUTH_CLIENT_SECRET": "GOCSPX-test-secret",
        "GEMDEX_WEB_BASE_URL": "https://gemdex.example",
        "GEMDEX_ALLOWED_EMAIL": ALLOWED_EMAIL,
        "GEMDEX_WEB_SESSION_SECRET": SESSION_SECRET,
        **overrides,
    }
    return load_config(env=env, dotenv_path=NO_DOTENV)


def memory(
    memory_id: str = "mem-1",
    title: str = "A memory",
    content: str = "The body of the memory.",
    attachments: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """A BYOI memory record, shaped like the real `/v1` responses."""
    return {
        "id": memory_id,
        "title": title,
        "content": content,
        "preview": content[:100],
        "createdAt": 1_700_000_000_000,
        "updatedAt": 1_700_000_001_000,
        "attachments": attachments if attachments is not None else [],
    }


class FakeByoi:
    """Records calls and returns canned data. Mirrors `ByoiClient`'s interface.

    Deliberately hand-written rather than `unittest.mock`: the point of these
    tests is that the BFF calls the *right* upstream method with the *right*
    arguments, and an autospec mock would happily accept a typo'd attribute.
    """

    def __init__(self) -> None:
        self.memories: list[dict[str, Any]] = []
        self.calls: list[tuple[str, tuple[Any, ...]]] = []
        self.attachment: tuple[bytes, str] | None = None
        #: Set to raise from the next call, to test error mapping.
        self.error: ByoiError | None = None
        self.health_payload: dict[str, Any] = {"ok": True}
        self.version_payload: dict[str, Any] = {
            "name": "gemdex-server",
            "apiVersion": "v1",
            "serverVersion": "1.0.37",
            "minClientVersion": "0.3.0",
            "protocolVersion": 1,
            "capabilities": {"attachments": True, "auth": ["bearer"]},
        }

    def _record(self, name: str, *args: Any) -> None:
        self.calls.append((name, args))
        if self.error is not None:
            error, self.error = self.error, None
            raise error

    async def list(self) -> list[dict[str, Any]]:
        self._record("list")
        return list(self.memories)

    async def get(self, memory_id: str) -> dict[str, Any] | None:
        self._record("get", memory_id)
        return next((m for m in self.memories if m["id"] == memory_id), None)

    async def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._record("create", payload)
        record = memory(
            memory_id=f"mem-{len(self.memories) + 1}",
            title=payload.get("title") or "Untitled",
            content=payload.get("content") or "",
        )
        self.memories.append(record)
        return record

    async def update(self, memory_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        self._record("update", memory_id, payload)
        for record in self.memories:
            if record["id"] == memory_id:
                record.update(payload)
                return record
        return None

    async def delete(self, memory_id: str) -> bool:
        self._record("delete", memory_id)
        before = len(self.memories)
        self.memories = [m for m in self.memories if m["id"] != memory_id]
        return len(self.memories) < before

    async def recall(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        """Recall hits are **flat**: memory fields plus a numeric `score`.

        Verified against the live BYOI — an earlier version of this fake nested
        the memory under a `memory` key, which let a real bug pass the suite
        (the BFF projected `result["memory"]` and produced `null` for every hit
        in production). The fake's shape is part of the contract under test.
        """
        self._record("recall", payload)
        return [{**m, "score": 0.42} for m in self.memories]

    async def read_attachment(self, memory_id: str, attachment_id: str) -> tuple[bytes, str] | None:
        self._record("read_attachment", memory_id, attachment_id)
        return self.attachment

    async def health(self) -> dict[str, Any]:
        self._record("health")
        return self.health_payload

    async def version(self) -> dict[str, Any]:
        self._record("version")
        return self.version_payload

    async def aclose(self) -> None:
        pass

    def method_names(self) -> list[str]:
        return [name for name, _ in self.calls]


@pytest.fixture
def fake_byoi() -> FakeByoi:
    return FakeByoi()
