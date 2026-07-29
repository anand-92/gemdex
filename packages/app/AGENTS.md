# AGENTS.md — `packages/app` (Gemdex Memory, macOS)

> **Status: maintenance-only.** This app is not the primary manage surface any
> more — `packages/web` is, for self-hosted deployments. Keep this code working
> and fix bugs here, but land new manage features in `packages/web` unless the
> request is specifically about the macOS app. **Do not delete this package.**

Architecture quick-reference for the **native SwiftUI manage-only macOS app**.
It is a **thin HTTP client over a Node sidecar** and holds **no memory logic of
its own** — all retrieval/embedding/storage lives in the sidecar (`gemdex serve`
from `gemdex-mcp`, wrapping `gemdex-core` + LanceDB over the shared `~/.gemdex`
store). The app spawns that sidecar, reads a localhost handshake, and drives a
browse/create/edit/delete UI (inline image/audio/video/PDF attachments,
semantic free-text search, JSONL export/import). Behavior changes belong
in `core`/`mcp`/`server`, not here. This is Swift/SwiftUI — the repo-wide TS
lint rules (`??` over `||`, no `eslint-disable`) do **not** apply.

## File map — `Sources/GemdexMemory/`

- `GemdexMemoryApp.swift` — `@main` `App`; `WindowGroup` + `Settings` scenes,
  menu commands (New Memory ⌘N, Refresh ⌘R, Check for Updates…), `AppDelegate`
  (quit-on-last-window-closed). `model.start()` fires `.onAppear`.
- `AppModel.swift` — `@MainActor ObservableObject`, the central state hub. Owns
  `SidecarManager` + `APIClient`, subscribes to `sidecar.$phase`, maps it to an
  `AppScreen`, and exposes all memory/config/settings async actions.
- `EditorModel.swift` — editor state (content/title/attachments/captions).
- `Models/Models.swift` — `Codable` DTOs for the sidecar API (`Memory`,
  `MemorySummary`, `ConfigSummary`, `SettingsSummary`, `RecallResult`, …).
- `Services/SidecarManager.swift` — Node child-process lifecycle, launch-mode
  state machine, handshake parsing (the most complex file — see below).
- `Services/APIClient.swift` — `actor`; async localhost HTTP/JSON client.
- `Services/UpdaterController.swift` — Sparkle wrapper; real updater only under
  `#if SPARKLE_ENABLED`, otherwise a no-op that disables the menu item.
- `Views/*` — per-screen SwiftUI: `RootView` (screen switch), `MainView`,
  `SidebarView`, `DetailPane`, `EditorView`, `AttachmentsSection`, `SetupView`,
  `RecoveryView`, `LaunchOverlay`, `StorageSettingsView`, `IngestView`,
  `HygieneView` (memory-hygiene panel: scan → judge → review/delete/dismiss),
  `ActivityRail` (global progress/cancel/open strip for long jobs),
  `Theme.swift` (brand).
- `Models/JobActivity.swift` — Activity Center DTOs (`JobKind` / `JobPhase` /
  `JobActivity`). Long-running work is owned by `AppModel.activities`, not
  panel-local `@State`, so navigating away never loses progress.
- `macos/` — `build-app.sh` (assemble `.app`), `stage-sidecar.sh` (bundle
  Node+sidecar into Resources), `embed-sparkle.sh`, `sign-app.sh`,
  `package-dmg.sh`, `entitlements.plist`.
- `Package.swift` — SwiftPM, single executable target `GemdexMemory`, macOS 13;
  defines `SPARKLE_ENABLED` + links `Sparkle.framework` only when
  `GEMDEX_SPARKLE=1`. `VERSION` — bundle version string (`0.4.0`).

## Sidecar launch state machine (`SidecarManager`)

`@MainActor`; publishes `@Published phase: SidecarPhase`
(`.starting` / `.ready(base,token)` / `.needsNode` /
`.needsBootstrap(previouslyInstalled,detail)` / `.installing` / `.failed`).
All probing/spawning runs in `Task.detached`; results are published back via
`MainActor.run`. `start()` first kills any prior child, then picks a mode in
strict precedence:

1. **dev** — `GEMDEX_SERVE_CMD` non-empty → login shell runs
   `exec node "$GEMDEX_SERVE_CMD" serve --port 0`.
2. **bundled** — release `.app` ships `Contents/Resources/node/bin/node` +
   `Contents/Resources/sidecar/dist/index.js`; launched directly as
   `node sidecar/dist/index.js serve --port 0` (bundled node's dir prepended to
   PATH). No user Node needed.
3. **offline** — else if `node` **and** `npx` resolve on the **login-shell**
   PATH (`zsh -lc`, so Homebrew/nvm are visible — a Finder-launched `.app`
   otherwise gets a minimal PATH) → `exec npx --offline gemdex-mcp serve --port 0`
   (cache-only, **zero network**).
4. **needsNode** — nothing available → recovery UI.

Network install is **never** done implicitly. Only a user-approved
`bootstrap(install: true)` runs the one permitted network install,
`exec npx -y gemdex-mcp serve --port 0`, and on success writes the non-secret
marker `~/.gemdex/desktop.json` (`previouslyInstalled` reads it to tailor the
recovery copy). `bootstrap(install: false)` is a cache-only retry; if a bundled
sidecar exists it always wins over both.

## Handshake + localhost contract

The spawned sidecar prints one line `PORT=<n> TOKEN=<hex>` to stdout (token
optional for old builds). `readHandshake` reads stdout on a background queue
until the first newline (20s timeout / 4KB cap so a hung child can't wedge
launch), parses it, and flips to `.ready(base: http://127.0.0.1:<port>, token)`.
`APIClient` then sends every request with header `X-Gemdex-Token: <token>`; the
sidecar binds `127.0.0.1` only and rejects untokened requests. No `Origin`
header is set — the serve layer treats absent-Origin as a same-process caller.
The child `Process` is held in a thread-safe `ProcessHolder` and terminated
**synchronously** on `NSApplication.willTerminateNotification`, so the sidecar
never outlives the app.

Routes used by `APIClient`: `GET /health`, `GET|POST /config`, `POST /config/validate`,
`GET|POST /memories`, `GET|PUT|DELETE /memories/:id`,
`PATCH /memories/:id/attachments` (caption-only),
`GET /memories/:id/attachments/:attachmentId` (stream bytes),
`POST /recall` (semantic free-text search), `GET /export`, `POST /import`,
`GET /settings`, `POST /settings/mode`, `POST|DELETE /settings/remotes[/:name]`,
`POST /settings/test`, `POST /settings/import-local`, and the memory-hygiene
set: `GET /hygiene/report`, `POST /hygiene/scan`, `POST /hygiene/start`,
`GET /hygiene/status`, `POST /hygiene/cancel`, `POST /hygiene/apply`,
`POST /hygiene/dismiss`.

## Validated key gate (`SetupView`)

`GET /config` carries an explicit Gemini readiness state (`missing`, `checking`,
`valid`, `invalid`, or `unavailable`). In local mode,
`AppModel.syncConfigGate()` keeps the manager unmounted until readiness is
`valid`; missing/rejected/unverifiable keys route to `SetupView` with a prominent
red blocking alert. `POST /config` validates a candidate with a real embedding
request **before** persistence, and `POST /config/validate` retries a saved key.

`SetupView` offers two cards: **Use this Mac** validates and persists
`GEMINI_API_KEY` to `~/.gemdex/.env`; **Use a Gemdex Server** opens
`StorageSettingsView`. Remote mode can mount the manager without a local key,
but `MainView` keeps a red ingestion warning visible and `IngestView` disables
scan/start until the local Gemini readiness state is `valid`.

## Remote / BYOI mode (`StorageSettingsView`)

The app **always talks only to the localhost sidecar**, never directly to a
remote. Settings switch the sidecar's backend (`POST /settings/mode`
local|remote), and add/test/remove named remotes. A remote bearer token is sent
to the sidecar **once** via `POST /settings/remotes`, persisted under
`~/.gemdex/.env`, and **never returned** to the app (`hasToken` is the only
signal exposed); the sidecar owns all outbound remote traffic. If a remote
backend is unreachable, `loadMemories` surfaces `.remoteUnavailable`.

## Concurrency model

`SidecarManager` and `AppModel` are `@MainActor`; `phase` flows
`@Published → Combine sink → AppModel.handle(phase:)`. `APIClient` is an `actor`
(serializes baseURL/token mutation + requests). Slow/blocking work (probing,
spawning, export/import file IO) runs in `Task.detached`; UI state is always
mutated back on the main actor.

## Activity Center (long-running jobs)

Ingest, hygiene, JSON import, and local→remote migration are tracked on
`AppModel` (`activities`, `ingestStatus`, `hygieneStatus`) and rendered by
`ActivityRail` at the top of `MainView`. Closing a panel never cancels the job
or hides progress. The rail exposes **Cancel** (cooperative: sidecar
`/ingest/cancel` + `/hygiene/cancel`, import batch boundary) and **Show/Review**
to reopen the panel. There is no pause primitive — cancel keeps already-saved
work (ingest ledger / partial hygiene report / imported batches); re-run or
collect continues from remaining work. Terminal chips auto-dismiss after ~12s.

## Build note

Swift 5.9+ toolchain (Xcode **or** CommandLineTools — no full Xcode needed),
Apple Silicon/arm64, macOS 13 minimum. From `packages/app`:
`bash macos/build-app.sh` → `build/Gemdex Memory.app`
(binary at `Contents/MacOS/GemdexMemory`). `--with-sidecar` bundles Node + the
sidecar; `GEMDEX_SPARKLE=1` links Sparkle (needs `third_party/sparkle`);
`--out <dir>` / `APP_VERSION` override output dir / version. Dev trick: run the
binary directly (not `open`) against a local sidecar build with
`GEMDEX_SERVE_CMD=/abs/path/to/packages/mcp/dist/index.js`.

## Gotchas / invariants

- Apple-Silicon (arm64) only; deployment target macOS 13.
- All app↔sidecar traffic is localhost-only **and** tokened (`X-Gemdex-Token`).
- Sidebar search is two-tier — `visibleMemories` filters loaded titles while
  typing; pressing Return runs semantic free-text recall via `POST /recall`
  (`AppModel.runSearch` → `searchState`), listing the parent-document hybrid
  ranking. Editing or clearing the query returns to the local title filter.
- The sidecar child is killed on app quit and must never outlive the app.
- A network install happens **only** through the explicit
  `bootstrap(install: true)` path; every other mode is offline/probe-only.
- Sparkle/updater code is gated behind `#if SPARKLE_ENABLED`; dev/CI builds need
  no Sparkle framework.
- Release DMGs bundle their own Node runtime + sidecar under
  `Contents/Resources/{node,sidecar}`.
