import Foundation

/// Media modalities `gemini-embedding-2` accepts. Mirrors `AttachmentKind` in
/// gemdex-core. The sidecar always sends one of these in `kind`, but we infer
/// from `mimeType` defensively when older payloads omit it.
enum AttachmentKind: String, Codable, Sendable {
    case image
    case audio
    case video
    case pdf

    static func from(mimeType: String) -> AttachmentKind? {
        let m = mimeType.lowercased()
        if m.hasPrefix("image/") { return .image }
        if m.hasPrefix("audio/") { return .audio }
        if m.hasPrefix("video/") { return .video }
        if m == "application/pdf" || m.hasSuffix("/pdf") { return .pdf }
        return nil
    }
}

/// Stored-attachment metadata as seen by the manager UI. Raw bytes are fetched
/// on demand from `GET /memories/:id/attachments/:attachmentId`.
struct Attachment: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let kind: AttachmentKind
    let mimeType: String
    let byteLength: Int
    var caption: String?

    private enum CodingKeys: String, CodingKey {
        case id, kind, mimeType, byteLength, caption
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        mimeType = (try? c.decode(String.self, forKey: .mimeType)) ?? "application/octet-stream"
        byteLength = (try? c.decode(Int.self, forKey: .byteLength)) ?? 0
        caption = try? c.decode(String.self, forKey: .caption)
        if let raw = try? c.decode(String.self, forKey: .kind), let k = AttachmentKind(rawValue: raw) {
            kind = k
        } else {
            kind = AttachmentKind.from(mimeType: mimeType) ?? .image
        }
    }
}

/// Lightweight memory shape for the sidebar list (`GET /memories`).
struct MemorySummary: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let preview: String
    let attachments: [Attachment]
    let createdAt: Double
    let updatedAt: Double
    let displayTitle: String
    let searchTitle: String
    let updatedLabel: String

    private enum CodingKeys: String, CodingKey {
        case id, title, preview, attachments, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        preview = (try? c.decode(String.self, forKey: .preview)) ?? ""
        attachments = (try? c.decode([Attachment].self, forKey: .attachments)) ?? []
        createdAt = (try? c.decode(Double.self, forKey: .createdAt)) ?? 0
        updatedAt = (try? c.decode(Double.self, forKey: .updatedAt)) ?? 0
        displayTitle = title.isEmpty ? "Untitled memory" : title
        searchTitle = displayTitle.lowercased()
        updatedLabel = Self.formatDate(updatedAt)
    }

    var firstImage: Attachment? { attachments.first { $0.kind == .image } }

    /// Precomputed once during JSON decoding. Sidebar rows reuse this while
    /// scrolling instead of formatting dates during every body recomputation.
    nonisolated private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    nonisolated private static func formatDate(_ ms: Double) -> String {
        guard ms > 0 else { return "" }
        return dateFormatter.string(from: Date(timeIntervalSince1970: ms / 1000))
    }
}

/// A full memory (`GET /memories/:id`).
struct Memory: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let content: String
    let attachments: [Attachment]
    let createdAt: Double
    let updatedAt: Double

    private enum CodingKeys: String, CodingKey {
        case id, title, content, attachments, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        content = (try? c.decode(String.self, forKey: .content)) ?? ""
        attachments = (try? c.decode([Attachment].self, forKey: .attachments)) ?? []
        createdAt = (try? c.decode(Double.self, forKey: .createdAt)) ?? 0
        updatedAt = (try? c.decode(Double.self, forKey: .updatedAt)) ?? 0
    }
}

/// A recall hit: full parent memory plus fused relevance score (`POST /recall`).
struct RecallResult: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let score: Double?

    private enum CodingKeys: String, CodingKey { case id, title, score }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        score = try? c.decode(Double.self, forKey: .score)
    }

    var displayTitle: String { title.isEmpty ? "Untitled memory" : title }
}

/// Per-launch proof that the configured Gemini key can perform embedding work.
struct GeminiReadiness: Codable, Sendable {
    let status: String
    let message: String?
    let validatedAt: Double?

    var isReady: Bool { status == "valid" }
    var needsAttention: Bool { !isReady && status != "checking" }
}

/// Active backend summary (`GET /config`).
struct ConfigSummary: Codable, Sendable {
    struct ActiveRemote: Codable, Sendable {
        let name: String
        let url: String?
        let hasToken: Bool?
    }
    let configured: Bool
    let mode: String
    let needsKey: Bool
    let gemini: GeminiReadiness
    let activeRemote: ActiveRemote?
}

/// One configured remote (`GET /settings`).
struct RemoteSummary: Codable, Identifiable, Hashable, Sendable {
    var id: String { name }
    let name: String
    let url: String
    let hasToken: Bool
}

/// Storage settings summary (`GET /settings`).
struct SettingsSummary: Codable, Sendable {
    let mode: String
    let activeRemote: String?
    let configured: Bool
    let localConfigured: Bool
    let gemini: GeminiReadiness
    let remotes: [RemoteSummary]
}

/// Remote connection test result (`POST /settings/test`).
struct RemoteTestResult: Codable, Sendable {
    let reachable: Bool
    let authenticated: Bool
    let detail: String?
}

/// Local→remote import result (`POST /settings/import-local`).
struct MigrationResult: Codable, Sendable {
    let created: Int
    let updated: Int
    let skipped: Int
}

/// One record that failed to import (`POST /import`).
struct ImportFailure: Codable, Sendable {
    let index: Int
    let id: String?
    let error: String
}

/// Import result (`POST /import`). `failed`/`errors` are optional so older
/// sidecars that return only `imported` still decode.
struct ImportResult: Codable, Sendable {
    let imported: Int
    let failed: Int?
    let errors: [ImportFailure]?
}

/// A portable export/import record (`GET /export`, `POST /import`). Attachments
/// are carried inline as base64 so a dump round-trips without the blob dir.
struct ExportRecord: Codable, Sendable {
    let id: String
    let title: String
    let content: String
    let createdAt: Double
    let updatedAt: Double
    let attachments: [ExportAttachment]?
}

struct ExportAttachment: Codable, Sendable {
    let id: String?
    let mimeType: String
    let data: String
    let caption: String?
}

// MARK: - Chat-history ingestion (`/ingest/*`)

/// One scannable session folder (`GET /ingest/sources` presets/customFolders).
struct IngestFolderSummary: Codable, Identifiable, Hashable, Sendable {
    var id: String { path }
    let source: String
    let path: String
    let exists: Bool
    let sessionCount: Int
}

/// A selectable digest model with its standard-tier pricing.
struct IngestModelInfo: Codable, Identifiable, Hashable, Sendable {
    var id: String { model }
    let model: String
    let description: String
    let inputUsdPerMTok: Double
    let outputUsdPerMTok: Double
    let isDefault: Bool
}

/// `GET /ingest/sources` response.
struct IngestSources: Codable, Sendable {
    let presets: [IngestFolderSummary]
    let customFolders: [IngestFolderSummary]
    let models: [IngestModelInfo]
    let pricingAsOf: String
    let ingestReady: Bool
    let gemini: GeminiReadiness
}

/// Per-model cost estimate (standard vs. Batch API pricing).
struct IngestCostEstimate: Codable, Identifiable, Hashable, Sendable {
    var id: String { model }
    let model: String
    let standardUsd: Double
    let batchUsd: Double
}

/// Pending count and cost estimates for one ingestion scope.
struct IngestScanTotals: Codable, Sendable {
    let pendingCount: Int
    let estimatedInputTokens: Int
    let estimatedOutputTokens: Int
    let estimates: [IngestCostEstimate]
}

/// `POST /ingest/scan` response.
struct IngestScanSummary: Codable, Sendable {
    struct Buckets: Codable, Sendable {
        let newFiles: [IngestSessionFile]
        let changedFiles: [IngestSessionFile]
        let upToDate: [IngestSessionFile]
        let skippedActive: [IngestSessionFile]
    }
    let buckets: Buckets
    let pendingCount: Int
    let estimatedInputTokens: Int
    let estimatedOutputTokens: Int
    let estimates: [IngestCostEstimate]
}

struct IngestSessionFile: Codable, Hashable, Sendable {
    let source: String
    let filePath: String
}

/// `GET /ingest/status` response.
struct IngestStatus: Codable, Sendable {
    struct PendingBatch: Codable, Sendable {
        let jobName: String
        let model: String
        let submittedAt: Double
        let requestCount: Int
    }
    let state: String
    let processed: Int
    let failed: Int
    let skipped: Int
    let total: Int
    let currentFile: String?
    let error: String?
    let pendingBatch: PendingBatch?
}

/// `POST /ingest/collect` response.
struct IngestCollectResult: Codable, Sendable {
    let state: String
    let jobState: String?
    let ingested: Int?
    let failed: Int?
    let error: String?
}

// MARK: - Memory hygiene (`/hygiene/*`)

/// One memory inside a hygiene candidate cluster.
struct HygieneClusterMember: Codable, Identifiable, Hashable, Sendable {
    var id: String { memoryId }
    let memoryId: String
    let title: String
    let createdAt: Double
    let updatedAt: Double
    let contentLength: Int

    var displayTitle: String { title.isEmpty ? "Untitled memory" : title }
}

/// The LLM judge's per-memory verdict within a cluster.
struct HygieneFinding: Codable, Hashable, Sendable {
    let memoryId: String
    let verdict: String
    let supersededBy: String?
    let evidence: String?
    let confidence: String?

    var isKeep: Bool { verdict == "keep" }
    var isHighConfidence: Bool { confidence == "high" }
    /// Only high-confidence duplicate/superseded memories are ever pre-checked
    /// for deletion; contradicted and low/medium confidence stay unchecked.
    var isSafePreselect: Bool { isHighConfidence && (verdict == "duplicate" || verdict == "superseded") }
}

/// A cluster of similar memories. `findings`/`error` appear only after an
/// analysis run has judged the cluster.
struct HygieneCluster: Codable, Identifiable, Hashable, Sendable {
    var id: String { clusterId }
    let clusterId: String
    let similarity: Double
    let members: [HygieneClusterMember]
    let findings: [HygieneFinding]?
    let error: String?

    func finding(for memoryId: String) -> HygieneFinding? {
        findings?.first { $0.memoryId == memoryId }
    }

    var newestMember: HygieneClusterMember? {
        members.max { $0.updatedAt < $1.updatedAt }
    }
}

/// `POST /hygiene/scan` response: candidate clusters + LLM cost estimates.
struct HygieneScanSummary: Codable, Sendable {
    let scannedAt: Double
    let threshold: Double
    let memoryCount: Int
    let clusters: [HygieneCluster]
    let dismissedCount: Int
    let estimatedInputTokens: Int
    let estimatedOutputTokens: Int
    let estimates: [IngestCostEstimate]
}

/// Persisted hygiene report (`GET /hygiene/report`).
struct HygieneReport: Codable, Sendable {
    let version: Int
    let scannedAt: Double
    let judgedAt: Double?
    let model: String?
    let threshold: Double
    let memoryCount: Int
    let clusters: [HygieneCluster]
    let deletedIds: [String]
}

/// `GET /hygiene/status` response.
struct HygieneStatus: Codable, Sendable {
    let state: String
    let judged: Int
    let failed: Int
    let total: Int
    let error: String?
}

/// `GET /hygiene/report` envelope: last report (if any) plus judge models.
struct HygieneReportEnvelope: Codable, Sendable {
    let report: HygieneReport?
    let models: [IngestModelInfo]
    let pricingAsOf: String
    let hygieneReady: Bool
}

/// Inline attachment payload for create/update (base64 `data`).
struct AttachmentInput: Codable, Sendable {
    let mimeType: String
    let data: String
    let caption: String?
}

/// Raw attachment bytes plus content type, for native rendering.
struct AttachmentBytes: Sendable {
    let data: Data
    let mimeType: String
}
