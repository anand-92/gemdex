"""Outcome-feedback ledger backing `report_outcome` and `recall`'s track record.

Same file, same format, same semantics as `gemdex-core`'s `MemoryStatsStore`
(`~/.gemdex/stats.json`, `GEMDEX_STATS_PATH` override) so this service and the
TS stdio server share one ledger when they run on the same host.

Telemetry, never source of truth: a missing or corrupt file starts fresh rather
than throwing. Writes are atomic (temp file + rename).
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Literal

from .formatting import now_ms

MemoryOutcome = Literal["worked", "failed", "stale"]

MAX_NOTE_LENGTH = 500


def _empty_stats() -> dict[str, Any]:
    return {"recallCount": 0, "workedCount": 0, "failedCount": 0, "staleCount": 0}


class MemoryStatsStore:
    def __init__(self, file_path: Path | None = None) -> None:
        if file_path is not None:
            self.file_path = file_path
        else:
            override = os.environ.get("GEMDEX_STATS_PATH")
            self.file_path = Path(override) if override else Path.home() / ".gemdex" / "stats.json"

    def get(self, memory_id: str) -> dict[str, Any] | None:
        return self._load()["memories"].get(memory_id)

    def record_recall(self, ids: list[str], now: int | None = None) -> None:
        """Bump `recallCount` + `lastRecalledAt` for every surfaced id."""
        if not ids:
            return
        timestamp = now_ms() if now is None else now
        file = self._load()
        for memory_id in ids:
            stats = file["memories"].get(memory_id) or _empty_stats()
            stats["recallCount"] += 1
            stats["lastRecalledAt"] = timestamp
            file["memories"][memory_id] = stats
        self._write(file)

    def record_outcome(
        self,
        memory_id: str,
        outcome: MemoryOutcome,
        note: str | None = None,
        now: int | None = None,
    ) -> dict[str, Any]:
        """Record how acting on a recalled memory went; returns the updated stats."""
        timestamp = now_ms() if now is None else now
        file = self._load()
        stats = file["memories"].get(memory_id) or _empty_stats()
        if outcome == "worked":
            stats["workedCount"] += 1
        elif outcome == "failed":
            stats["failedCount"] += 1
        else:
            stats["staleCount"] += 1
        last_outcome: dict[str, Any] = {"outcome": outcome, "at": timestamp}
        trimmed = note.strip()[:MAX_NOTE_LENGTH] if note else None
        if trimmed:
            last_outcome["note"] = trimmed
        stats["lastOutcome"] = last_outcome
        file["memories"][memory_id] = stats
        self._write(file)
        return stats

    def _load(self) -> dict[str, Any]:
        if not self.file_path.exists():
            return {"version": 1, "memories": {}}
        # Read and parse are deliberately separate: a system read error (EACCES,
        # EMFILE) must propagate rather than be mistaken for a corrupt file —
        # swallowing it would let a later write() overwrite a healthy ledger.
        content = self.file_path.read_text(encoding="utf-8")
        try:
            parsed = json.loads(content)
            if not isinstance(parsed, dict) or parsed.get("version") != 1 or not isinstance(
                parsed.get("memories"), dict
            ):
                raise ValueError("unsupported format")
            return parsed
        except ValueError:
            return {"version": 1, "memories": {}}

    def _write(self, file: dict[str, Any]) -> None:
        self.file_path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=self.file_path.parent, delete=False, suffix=".tmp"
        )
        try:
            with handle:
                handle.write(json.dumps(file, indent=2) + "\n")
            os.chmod(handle.name, 0o600)
            os.replace(handle.name, self.file_path)
        except BaseException:
            Path(handle.name).unlink(missing_ok=True)
            raise
