import Foundation
import Combine
import SwiftUI

/// Top-level screen the window should show, derived from the sidecar phase and
/// the active backend config. Mirrors the web app's gate/recovery states.
enum AppScreen: Equatable {
    case launching
    case setup                         // sidecar ready, no API key configured
    case ready                         // memories loaded
    case needsNode
    case needsBootstrap(previouslyInstalled: Bool, detail: String)
    case installing(detail: String)
    case sidecarFailed(detail: String)
    case remoteUnavailable(detail: String)
}

/// Sidebar search state. `.idle` shows the local title filter / full list;
/// `.results` holds the relevance-ranked recall hits from `POST /recall`.
enum SearchState: Equatable {
    case idle
    case searching
    case results([RecallResult])
    case failed(String)
}

/// Live import progress for the banner shown while a file imports; nil when
/// no import is running.
struct ImportProgress: Equatable {
    var completed: Int
    var total: Int
}

/// End-of-import alert payload (success / partial / failure).
struct ImportAlert: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let message: String
}

/// Central observable app state. Owns the sidecar lifecycle, the API client,
/// and all loaded memory/config/settings state. Views read from here and call
/// its async methods; it never reaches around the sidecar for store access.
@MainActor
final class AppModel: ObservableObject {
    @Published var screen: AppScreen = .launching
    @Published var statusText: String = "Starting…"
    @Published var statusIsError: Bool = false

    @Published var memories: [MemorySummary] = []
    @Published var filterText: String = ""
    @Published var selectedID: String?

    @Published var config: ConfigSummary?
    @Published var settings: SettingsSummary?

    /// Shown on the setup screen when we send the user back to re-enter a key
    /// (e.g. the configured Gemini key was rejected by Google at embed time).
    @Published var setupNotice: String?

    @Published var isEditorOpen = false
    @Published var showSettings = false
    @Published var showIngest = false
    @Published var showHygiene = false
    /// Set when a Gemini Batch ingestion job is awaiting collection, so the
    /// UI can re-surface a "Collect" affordance across launches.
    @Published var pendingIngestBatch: IngestStatus.PendingBatch?

    /// Semantic free-text search state (`.idle` = local title filter).
    @Published var searchState: SearchState = .idle

    /// Non-nil while an import is running (drives the progress banner and
    /// disables the Import button); the alert fires once when it finishes.
    @Published var importProgress: ImportProgress?
    @Published var importAlert: ImportAlert?

    let editor = EditorModel()
    let sidecar = SidecarManager()
    let thumbnails = ThumbnailLoader()
    private(set) var api: APIClient?
    private var cancellables = Set<AnyCancellable>()

    var visibleMemories: [MemorySummary] {
        let query = filterText.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return memories }
        // Match displayTitle so empty-title memories ("Untitled memory") filter
        // consistently with how they render.
        return memories.filter { $0.searchTitle.contains(query) }
    }

    /// Recall hits joined back to loaded summaries, preserving recall order so
    /// the sidebar can render ranked results with the normal `MemoryRow`.
    func resultSummaries(_ results: [RecallResult]) -> [MemorySummary] {
        let byID = Dictionary(memories.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return results.compactMap { byID[$0.id] }
    }

    init() {
        editor.appModel = self
        thumbnails.appModel = self
        sidecar.$phase
            .receive(on: RunLoop.main)
            .sink { [weak self] phase in
                self?.handle(phase: phase)
            }
            .store(in: &cancellables)
    }

    func start() {
        sidecar.start()
    }

    func stop() {
        sidecar.stop()
    }

    // MARK: - Phase handling

    private func handle(phase: SidecarPhase) {
        switch phase {
        case .starting:
            screen = .launching
            statusText = "Waiting for memory store…"
            statusIsError = false
        case let .ready(base, token):
            if let api {
                Task { await api.update(baseURL: base, token: token) }
            } else {
                api = APIClient(baseURL: base, token: token)
            }
            Task { await syncConfigGate() }
        case .needsNode:
            screen = .needsNode
            statusText = "Node.js is required"
            statusIsError = true
        case let .needsBootstrap(installed, detail):
            screen = .needsBootstrap(previouslyInstalled: installed, detail: detail)
            statusText = "Setup required"
            statusIsError = true
        case let .installing(detail):
            screen = .installing(detail: detail)
            statusText = "Setting up…"
            statusIsError = false
        case let .failed(detail):
            screen = .sidecarFailed(detail: detail)
            statusText = "Setup failed"
            statusIsError = true
        }
    }

    /// Reconcile UI with the sidecar's config. Local mode is a hard gate: the
    /// manager UI is never mounted until a real Gemini embedding request proves
    /// that the configured key works during this sidecar launch.
    @discardableResult
    func syncConfigGate() async -> Bool {
        guard let api else { return false }
        do {
            var cfg = try await api.config()
            self.config = cfg

            if cfg.mode == "local" && cfg.gemini.status == "checking" {
                screen = .launching
                statusText = "Validating Gemini API key…"
                statusIsError = false
                cfg = await pollGeminiReadiness(from: cfg, api: api)
            }

            if cfg.mode == "local" && !cfg.gemini.isReady {
                setupNotice = cfg.gemini.message
                screen = .setup
                statusText = readinessTitle(cfg.gemini)
                statusIsError = true
                return false
            }

            if cfg.configured {
                await loadMemories()
                if cfg.mode == "remote" && cfg.gemini.status == "checking" {
                    Task { await refreshGeminiReadinessUntilSettled() }
                }
                return true
            }
            screen = .setup
            statusText = readinessTitle(cfg.gemini)
            statusIsError = true
            return false
        } catch {
            setStatus("Error: \(error.localizedDescription)", isError: true)
            return false
        }
    }

    /// Poll GET /config while readiness is `checking` (≈15s max at 250ms).
    private func pollGeminiReadiness(from initial: ConfigSummary, api: APIClient) async -> ConfigSummary {
        var cfg = initial
        for _ in 0..<60 {
            guard cfg.gemini.status == "checking" else { break }
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard let latest = try? await api.config() else { continue }
            cfg = latest
            self.config = latest
        }
        return cfg
    }

    private func refreshGeminiReadinessUntilSettled() async {
        guard let api, let cfg = config else { return }
        _ = await pollGeminiReadiness(from: cfg, api: api)
    }

    private func readinessTitle(_ readiness: GeminiReadiness) -> String {
        switch readiness.status {
        case "invalid": return "Gemini API key rejected"
        case "unavailable": return "Gemini validation unavailable"
        case "checking": return "Validating Gemini API key…"
        default: return "Gemini API key required"
        }
    }

    func loadMemories() async {
        guard let api else { return }
        do {
            let list = try await api.listMemories()
            self.memories = list
            screen = .ready
            setStatus(Self.countLabel(list.count))
            await refreshPendingIngestBatch()
        } catch let err as APIError {
            if config?.mode == "remote" {
                screen = .remoteUnavailable(detail: err.message)
                setStatus("Remote unavailable: \(err.message)", isError: true)
            } else {
                setStatus("Error: \(err.message)", isError: true)
            }
        } catch {
            setStatus("Error: \(error.localizedDescription)", isError: true)
        }
    }

    func refreshList() async {
        guard let api else { return }
        if let list = try? await api.listMemories() {
            self.memories = list
            setStatus(Self.countLabel(list.count))
        }
    }

    // MARK: - Memory actions

    func openNew() {
        selectedID = nil
        editor.startNew()
        showSettings = false
        showIngest = false
        showHygiene = false
        isEditorOpen = true
    }

    func openMemory(_ id: String) async {
        guard let api else { return }
        do {
            let memory = try await api.getMemory(id)
            selectedID = memory.id
            editor.load(memory)
            showSettings = false
            showIngest = false
            showHygiene = false
            isEditorOpen = true
        } catch {
            setStatus("Error: \(error.localizedDescription)", isError: true)
        }
    }

    func deleteSelected() async {
        guard let api, let id = selectedID else { return }
        do {
            try await api.deleteMemory(id)
            selectedID = nil
            isEditorOpen = false
            await refreshList()
            setStatus("Deleted.")
        } catch {
            setStatus("Error: \(error.localizedDescription)", isError: true)
        }
    }

    // MARK: - Search

    /// Run semantic free-text recall for the current `filterText`. An empty
    /// query resets to the local-filter idle state; otherwise the sidecar
    /// embeds the query and returns the parent-document hybrid ranking.
    func runSearch() async {
        guard let api else { return }
        let query = filterText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            searchState = .idle
            return
        }
        searchState = .searching
        do {
            let results = try await api.recallByText(query: query)
            // Drop stale results if the user edited the query while loading.
            guard filterText.trimmingCharacters(in: .whitespacesAndNewlines) == query else { return }
            searchState = .results(results)
        } catch let err as APIError {
            if handlePossibleInvalidKey(err.message) {
                searchState = .idle
                return
            }
            searchState = .failed(err.message)
            setStatus("Search failed: \(err.message)", isError: true)
        } catch {
            searchState = .failed(error.localizedDescription)
            setStatus("Search failed: \(error.localizedDescription)", isError: true)
        }
    }

    func clearSearch() {
        filterText = ""
        searchState = .idle
    }

    // MARK: - Export / import

    func exportAll(to url: URL) async {
        guard let api else { return }
        do {
            let records = try await api.exportAll()
            // Encode + write off the main thread so a large export can't stutter.
            try await Task.detached(priority: .userInitiated) {
                let encoder = JSONEncoder()
                let lines = try records.map { String(data: try encoder.encode($0), encoding: .utf8) ?? "" }
                let data = Data(lines.joined(separator: "\n").utf8)
                try data.write(to: url, options: .atomic)
            }.value
            setStatus("Exported \(records.count) memories.")
        } catch {
            setStatus("Error: \(error.localizedDescription)", isError: true)
        }
    }

    func importFile(_ url: URL) async {
        guard let api else {
            importAlert = ImportAlert(
                title: "Import unavailable",
                message: "The memory store isn't ready yet. Try again in a moment.",
            )
            return
        }
        let batches: [[Any]]
        do {
            // Read + parse + batch off the main thread; the network import runs here.
            batches = try await Task.detached(priority: .userInitiated) {
                let text = try String(contentsOf: url, encoding: .utf8)
                return try Self.batchImportRecords(Self.parseImport(text))
            }.value
        } catch {
            importAlert = ImportAlert(title: "Import failed", message: error.localizedDescription)
            setStatus("Import failed: \(error.localizedDescription)", isError: true)
            return
        }
        let total = batches.reduce(0) { $0 + $1.count }
        guard total > 0 else {
            importAlert = ImportAlert(
                title: "Nothing to import",
                message: "The selected file doesn't contain any memory records.",
            )
            return
        }

        // Import in batches so a large file shows real progress and one bad
        // batch can't sink the whole import. The server is additionally
        // per-record fault-tolerant within each batch.
        importProgress = ImportProgress(completed: 0, total: total)
        defer { importProgress = nil }
        var imported = 0
        var failedCount = 0
        var failureDetails: [String] = []
        var processed = 0
        for batch in batches {
            do {
                let payload = try JSONSerialization.data(withJSONObject: ["records": batch])
                let result = try await api.importRecords(payload)
                imported += result.imported
                failedCount += result.failed ?? 0
                failureDetails.append(contentsOf: (result.errors ?? []).map(\.error))
            } catch {
                failedCount += batch.count
                failureDetails.append("\(batch.count) records: \(error.localizedDescription)")
            }
            processed += batch.count
            importProgress = ImportProgress(completed: processed, total: total)
            setStatus("Importing \(processed) of \(total) memories…")
        }

        await refreshList()
        if failedCount == 0 {
            setStatus("Imported \(imported) \(imported == 1 ? "memory" : "memories").")
            importAlert = ImportAlert(
                title: "Import complete",
                message: "Imported \(imported) \(imported == 1 ? "memory" : "memories").",
            )
        } else {
            let sample = failureDetails.prefix(3).joined(separator: "\n")
            setStatus("Imported \(imported) of \(total) memories (\(failedCount) failed)", isError: true)
            importAlert = ImportAlert(
                title: imported > 0 ? "Import partially complete" : "Import failed",
                message: "Imported \(imported) of \(total) memories; \(failedCount) failed.\n\n\(sample)",
            )
        }
    }

    /// Split parsed records into POST-sized batches so a large import reports
    /// real progress and a single failure can't sink the whole file. Batches
    /// cap at a record count or a serialized byte budget, whichever comes
    /// first (kept well under the sidecar's 100 MiB import body limit).
    /// Pure + nonisolated so it can run on a detached background task.
    nonisolated private static func batchImportRecords(_ records: [Any]) throws -> [[Any]] {
        let recordLimit = 25
        let byteLimit = 24 * 1024 * 1024
        var batches: [[Any]] = []
        var current: [Any] = []
        var currentBytes = 0
        for record in records {
            let recordBytes = try JSONSerialization.data(withJSONObject: record).count
            if !current.isEmpty && (current.count >= recordLimit || currentBytes + recordBytes > byteLimit) {
                batches.append(current)
                current = []
                currentBytes = 0
            }
            current.append(record)
            currentBytes += recordBytes
        }
        if !current.isEmpty { batches.append(current) }
        return batches
    }

    /// Accept either a JSON array or JSONL (one record per line). Pure +
    /// nonisolated so it can run on a detached background task.
    nonisolated private static func parseImport(_ text: String) throws -> [Any] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return [] }
        if trimmed.hasPrefix("[") {
            return (try JSONSerialization.jsonObject(with: Data(trimmed.utf8)) as? [Any]) ?? []
        }
        return try trimmed.split(separator: "\n").compactMap { line -> Any? in
            // Trim newlines too so Windows CRLF (\r\n) files don't leave a
            // trailing \r that breaks JSON parsing.
            let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { return nil }
            return try JSONSerialization.jsonObject(with: Data(t.utf8))
        }
    }

    // MARK: - Chat-history ingestion

    /// Check for a previously submitted Batch API job awaiting collection.
    /// Local mode only — ingestion always digests with a local Gemini key, and
    /// the status route reports idle when no key/manager is available.
    func refreshPendingIngestBatch() async {
        guard let api else { return }
        pendingIngestBatch = (try? await api.ingestStatus())?.pendingBatch
    }

    // MARK: - Setup

    func submitApiKey(_ key: String) async throws {
        guard let api else { throw APIError(status: -1, message: "Sidecar not ready", needsKey: false) }
        statusText = "Validating Gemini API key…"
        statusIsError = false
        let cfg = try await api.setApiKey(key)
        guard cfg.gemini.isReady else {
            throw APIError(status: -1, message: cfg.gemini.message ?? "Key was not validated.", needsKey: true)
        }
        config = cfg
        setupNotice = nil
        await syncConfigGate()
        await refreshSettings()
    }

    func retryApiKeyValidation() async throws {
        guard let api else { throw APIError(status: -1, message: "Sidecar not ready", needsKey: false) }
        statusText = "Validating Gemini API key…"
        statusIsError = false
        let cfg: ConfigSummary
        do {
            cfg = try await api.validateConfiguredApiKey()
        } catch {
            await refreshConfig()
            setupNotice = config?.gemini.message ?? error.localizedDescription
            throw error
        }
        config = cfg
        setupNotice = cfg.gemini.message
        guard cfg.gemini.isReady else {
            statusText = readinessTitle(cfg.gemini)
            statusIsError = true
            throw APIError(
                status: -1,
                message: cfg.gemini.message ?? "Gemini API key validation failed.",
                needsKey: true
            )
        }
        await syncConfigGate()
        await refreshSettings()
    }

    /// Detect Gemini's "API key not valid" failure (the key is configured but
    /// rejected by Google at embed time) so callers can route the user back to
    /// key entry instead of surfacing raw Google JSON.
    static func isInvalidKeyError(_ message: String) -> Bool {
        let m = message.lowercased()
        return m.contains("api_key_invalid")
            || m.contains("api key not valid")
            || m.contains("invalid_argument") && m.contains("api key")
    }

    /// If `message` indicates an invalid Gemini key, send the user back to the
    /// setup screen with a clear prompt and return `true`. Local mode only —
    /// remote backends own their own key.
    @discardableResult
    func handlePossibleInvalidKey(_ message: String) -> Bool {
        guard config?.mode != "remote", Self.isInvalidKeyError(message) else { return false }
        markGeminiKeyInvalid()
        showSettings = false
        showIngest = false
        showHygiene = false
        isEditorOpen = false
        screen = .setup
        statusText = "API key required"
        statusIsError = true
        return true
    }

    /// Ingestion always uses the local Gemini key, even with remote storage.
    /// If that key is revoked after startup, close the ingestion flow and route
    /// remote users directly to the repair controls without disabling storage.
    @discardableResult
    func handlePossibleInvalidIngestionKey(_ message: String) -> Bool {
        guard Self.isInvalidKeyError(message) else { return false }
        markGeminiKeyInvalid()
        showIngest = false
        showHygiene = false
        if backendIsRemote {
            showSettings = true
            setStatus("Gemini key rejected; ingestion is blocked.", isError: true)
        } else {
            isEditorOpen = false
            screen = .setup
            statusText = "Gemini API key required"
            statusIsError = true
        }
        return true
    }

    private func markGeminiKeyInvalid() {
        let notice = "Your Gemini API key was rejected. Please enter a valid key."
        setupNotice = notice
        if let config {
            self.config = ConfigSummary(
                configured: config.mode == "remote" ? config.configured : false,
                mode: config.mode,
                needsKey: config.mode == "local",
                gemini: GeminiReadiness(status: "invalid", message: notice, validatedAt: nil),
                activeRemote: config.activeRemote
            )
        }
    }

    // MARK: - Config / settings helpers

    func refreshConfig() async {
        guard let api else { return }
        self.config = try? await api.config()
    }

    func refreshSettings() async {
        guard let api else { return }
        self.settings = try? await api.settings()
    }

    var backendLabel: String {
        guard let config else { return "Backend: loading…" }
        if config.mode == "remote" {
            return "Remote: \(config.activeRemote?.name ?? "remote")"
        }
        switch config.gemini.status {
        case "valid": return "Local: Gemini verified"
        case "checking": return "Local: validating Gemini"
        case "invalid": return "Local: key rejected"
        case "unavailable": return "Local: validation unavailable"
        default: return "Local: API key required"
        }
    }

    var backendIsRemote: Bool { config?.mode == "remote" }
    var backendNeedsAttention: Bool {
        guard let config else { return true }
        return config.mode == "local" && !config.gemini.isReady
    }
    var geminiReadiness: GeminiReadiness? { config?.gemini }
    var ingestionIsReady: Bool { config?.gemini.isReady ?? false }
    /// Hygiene analysis judges with the local Gemini key — same gate as ingestion.
    var hygieneIsReady: Bool { ingestionIsReady }
    /// True when ingestion is blocked for a user-actionable reason (not mid-check).
    var ingestionNeedsAttention: Bool { config?.gemini.needsAttention ?? true }
    var ingestionIsChecking: Bool { config?.gemini.status == "checking" }

    // MARK: - Settings actions

    func applyMode(_ mode: String, name: String? = nil) async throws {
        guard let api else { return }
        self.settings = try await api.setMode(mode, name: name)
        await syncConfigGate()
    }

    func saveRemote(name: String, url: String, token: String?) async throws {
        guard let api else { return }
        self.settings = try await api.saveRemote(name: name, url: url, token: token)
        await refreshConfig()
    }

    func removeRemote(_ name: String) async throws {
        guard let api else { return }
        self.settings = try await api.removeRemote(name)
        await syncConfigGate()
    }

    func testRemote(_ name: String) async throws -> RemoteTestResult {
        guard let api else { throw APIError(status: -1, message: "Sidecar not ready", needsKey: false) }
        return try await api.testRemote(name)
    }

    func importLocalToRemote(_ name: String) async throws -> MigrationResult {
        guard let api else { throw APIError(status: -1, message: "Sidecar not ready", needsKey: false) }
        let result = try await api.importLocalToRemote(name)
        if backendIsRemote, config?.activeRemote?.name == name {
            await loadMemories()
        }
        return result
    }

    func setStatus(_ text: String, isError: Bool = false) {
        statusText = text
        statusIsError = isError
    }

    private static func countLabel(_ count: Int) -> String {
        "\(count) \(count == 1 ? "memory" : "memories")"
    }
}
