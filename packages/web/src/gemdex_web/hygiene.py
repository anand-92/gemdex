"""Memory-hygiene status for the web manager.

**This module deliberately does not run hygiene. It explains where hygiene can
run.** That is the whole point of the ticket's "says so honestly instead of
pretending to run it" requirement, so the reasoning is written down here rather
than being re-derived by whoever next wonders why there is no button.

Hygiene is a two-phase feature in `gemdex-core` (`hygiene/HygieneManager`):

1. **Cluster** near-duplicate memories. Free, no API calls — but it reads every
   parent's row vectors via `MemoryStore.listParentsWithVectors()`.
2. **Judge** each cluster with a Gemini LLM, then a human applies deletions.

Phase 1 is the blocker for a host-side run, and it is a real one, not a missing
wire-up:

- `listParentsWithVectors()` is a method on `MemoryStore` — the **local LanceDB**
  store. It is not on the `MemoryBackend` interface, so it is not something a
  remote backend can be asked for, and `PostgresMemoryBackend` (what this
  deployment actually runs) has no equivalent. There is no `/v1` route for it.
- The one process that *does* expose hygiene over HTTP is the `gemdex serve`
  sidecar, and it gates every hygiene route on local mode explicitly:
  "Memory hygiene requires local storage mode (remote hygiene is not supported
  yet)."
- Phase 2 needs a Gemini key on the machine doing the judging. The sidecar is
  explicit that this is client-side even when the backend is remote.

So "host-side hygiene" would mean adding a vector-listing route to `/v1` plus a
pgvector clustering implementation — new infrastructure, well outside a 3-point
ticket, and a change to the BYOI's surface area that deserves its own decision.

What this deployment *does* have, and what an operator should know:

- **Save-time similar-memory detection is already running.** Every save embeds,
  then checks the pool for an existing memory above `GEMDEX_SIMILAR_THRESHOLD`
  (default `0.90` — the same cosine scale hygiene clusters on) and advises the
  caller. That is duplicate *prevention*, and it is automatic.
- **Ingested chat sessions cannot duplicate at all.** They are keyed by the
  deterministic `chat:<source>:<sessionId>` id, so re-syncing or re-uploading
  the same session upserts it. Since chat digests dominate a real pool (1278 of
  1289 memories in the pool this was developed against), the large majority of
  the pool is structurally duplicate-free.
- **A real hygiene pass is available on a machine with a local pool**, via the
  desktop app or the sidecar. The command is reported so nobody has to go
  looking for it.
"""

from __future__ import annotations

from typing import Any

#: Save-time detection's default similarity bar (`GEMDEX_SIMILAR_THRESHOLD` in
#: core). Same cosine scale hygiene clustering uses, which is why quoting it
#: here is meaningful rather than trivia.
DEFAULT_SIMILAR_THRESHOLD = 0.90


def hygiene_status_payload(byoi_url: str) -> dict[str, Any]:
    """Describe hygiene availability for this deployment.

    Shaped as `{available, reason, checks[], howToRun{}}` so the SPA renders a
    card per fact without embedding any of this prose itself — the explanation
    lives with the reasoning, not in a component.
    """
    return {
        # No host-side run today. Stated as a field rather than implied by an
        # empty response so the UI cannot accidentally render an enabled state.
        "available": False,
        "reason": (
            "Hygiene clustering reads per-memory vectors directly from a local LanceDB store. "
            "This deployment stores memories in Postgres/pgvector, which has no equivalent "
            "read, and the /v1 API exposes no vector-listing route — so a hygiene pass cannot "
            "run on the server as it stands."
        ),
        "protections": [
            {
                "title": "Duplicate prevention is already active",
                "detail": (
                    f"Every save embeds the new memory and checks the pool for anything above "
                    f"{DEFAULT_SIMILAR_THRESHOLD:.2f} cosine similarity — the same scale hygiene "
                    "clusters on — and tells the caller what it found. Duplicates are flagged as "
                    "they arrive rather than swept up later."
                ),
                "state": "active",
            },
            {
                "title": "Ingested chat sessions cannot duplicate",
                "detail": (
                    "Sessions are stored under a deterministic chat:<source>:<sessionId> id, so "
                    "re-syncing from another machine or re-uploading the same transcript updates "
                    "the existing memory instead of adding a second one. On a typical pool this "
                    "covers the large majority of memories."
                ),
                "state": "active",
            },
            {
                "title": "Deletion stays a human action",
                "detail": (
                    "Hygiene only ever proposes; a person applies. That is the same reason no "
                    "agent-facing tool can delete — and it is why an automatic server-side sweep "
                    "would be the wrong default even once clustering is possible here."
                ),
                "state": "by-design",
            },
        ],
        "howToRun": {
            "summary": (
                "Run a hygiene pass from a machine that keeps a local pool. It needs that "
                "machine's own GEMINI_API_KEY, because cluster judging is a client-side "
                "model call."
            ),
            "options": [
                {
                    "label": "Desktop app (recommended)",
                    "detail": (
                        "Gemdex Memory for macOS has a hygiene panel: scan, judge, then review "
                        "and apply deletions one by one."
                    ),
                },
                {
                    "label": "Sidecar HTTP",
                    "detail": (
                        "Start the local sidecar and drive its hygiene routes "
                        "(POST /hygiene/scan, POST /hygiene/start, GET /hygiene/report)."
                    ),
                    "command": "npx gemdex serve",
                },
            ],
            # Named so the operator understands the scope of what a local run
            # would cover: it is a *different* pool, not this one.
            "caveat": (
                f"A local run inspects that machine's own ~/.gemdex pool, not the pool at "
                f"{byoi_url}. Hygiene for a self-hosted pool needs pgvector clustering on the "
                "server, which does not exist yet."
            ),
        },
    }
