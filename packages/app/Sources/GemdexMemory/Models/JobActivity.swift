import Foundation

/// Kind of long-running background work the Activity Center tracks.
enum JobKind: String, Equatable, CaseIterable, Sendable {
    case ingest
    case hygiene
    case importFile
    case migration

    var systemImage: String {
        switch self {
        case .ingest: return "tray.and.arrow.down"
        case .hygiene: return "sparkles"
        case .importFile: return "square.and.arrow.down"
        case .migration: return "arrow.triangle.2.circlepath"
        }
    }

    var shortTitle: String {
        switch self {
        case .ingest: return "Ingestion"
        case .hygiene: return "Hygiene"
        case .importFile: return "Import"
        case .migration: return "Local → remote"
        }
    }
}

/// Lifecycle phase for a background job. `batchPending` is ingest-only
/// (Gemini Batch API job waiting for collection). Terminal phases
/// (`completed` / `failed` / `cancelled`) stay visible briefly so the user
/// can see what finished while they were elsewhere.
enum JobPhase: String, Equatable, Sendable {
    case running
    case batchPending
    case cancelling
    case completed
    case failed
    case cancelled

    var isActive: Bool {
        switch self {
        case .running, .batchPending, .cancelling: return true
        case .completed, .failed, .cancelled: return false
        }
    }

    var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled: return true
        case .running, .batchPending, .cancelling: return false
        }
    }
}

/// One row in the Activity Center. Owned by `AppModel` so progress survives
/// panel navigation; views never own the only copy of a long job.
struct JobActivity: Identifiable, Equatable, Sendable {
    var id: String { kind.rawValue }
    var kind: JobKind
    var phase: JobPhase
    /// Primary line, e.g. "Ingesting chat history".
    var title: String
    /// Secondary line, e.g. "42 ingested · 1 failed · 120 total".
    var detail: String?
    var completed: Int
    var total: Int
    /// `nil` means indeterminate (spinner only).
    var fraction: Double?
    var canCancel: Bool
    /// Whether the Activity rail can jump into the job's full panel.
    var canOpen: Bool
    var error: String?
    /// Wall-clock for auto-dismiss of terminal chips.
    var updatedAt: Date = Date()

    var isActive: Bool { phase.isActive }
    var isTerminal: Bool { phase.isTerminal }

    var progressLabel: String {
        if total > 0 {
            return "\(min(completed, total)) / \(total)"
        }
        return ""
    }

    /// Build a determinate progress snapshot for a running count-based job.
    static func running(
        kind: JobKind,
        title: String,
        completed: Int,
        total: Int,
        detail: String? = nil,
        canCancel: Bool = true,
        canOpen: Bool = true
    ) -> JobActivity {
        let fraction: Double? = total > 0 ? Double(min(completed, total)) / Double(total) : nil
        return JobActivity(
            kind: kind,
            phase: .running,
            title: title,
            detail: detail,
            completed: completed,
            total: total,
            fraction: fraction,
            canCancel: canCancel,
            canOpen: canOpen
        )
    }

    static func indeterminate(
        kind: JobKind,
        title: String,
        detail: String? = nil,
        phase: JobPhase = .running,
        canCancel: Bool = false,
        canOpen: Bool = true
    ) -> JobActivity {
        JobActivity(
            kind: kind,
            phase: phase,
            title: title,
            detail: detail,
            completed: 0,
            total: 0,
            fraction: nil,
            canCancel: canCancel,
            canOpen: canOpen
        )
    }
}
