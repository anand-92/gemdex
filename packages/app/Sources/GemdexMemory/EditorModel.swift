import Foundation
import SwiftUI
import UniformTypeIdentifiers

/// One attachment in the open editor. Either an `existing` attachment owned by
/// the loaded memory (bytes fetched lazily for preview / re-embed) or a `new`
/// file the user just added (bytes already in hand).
struct EditorAttachment: Identifiable {
    enum Source: Equatable {
        case existing(attachmentId: String)
        case new
    }

    let id = UUID()
    var source: Source
    var kind: AttachmentKind
    var mimeType: String
    var byteLength: Int
    var caption: String
    /// Bytes for rendering / re-embed. Loaded eagerly for `new`; lazily for
    /// `existing` (filled in by `loadPreviewData`).
    var data: Data?
}

/// Attachment limits, matching the web app / gemdex-core validator.
enum AttachmentLimits {
    static let maxBytesPerAttachment = 20 * 1024 * 1024
    static let caps: [AttachmentKind: Int] = [.image: 6, .audio: 1, .video: 1, .pdf: 1, .file: 1]
    static let allowedMimeTypes: Set<String> = [
        "image/png", "image/jpeg",
        "audio/mpeg", "audio/mp3", "audio/wav",
        "video/mp4", "video/quicktime",
        "application/pdf",
    ]
}

private enum AttachmentChange { case none, captionOnly, structural }

/// Editor state for one memory (new or existing). Owns the working attachment
/// set and the save logic (create / structural update / caption-only fast path).
@MainActor
final class EditorModel: ObservableObject {
    @Published var title: String = ""
    @Published var content: String = ""
    @Published var attachments: [EditorAttachment] = []
    @Published var attachError: String?
    @Published var attachProgress: String?
    @Published var isSaving = false

    /// nil while composing a brand-new memory.
    private(set) var memoryID: String?
    private(set) var createdAt: Double = 0
    private(set) var updatedAt: Double = 0

    /// Snapshot of the loaded attachment set (id → caption) to classify edits.
    private var originalExisting: [String: String] = [:]

    weak var appModel: AppModel?

    var isEditingExisting: Bool { memoryID != nil }

    var metaText: String {
        guard isEditingExisting else { return "New memory" }
        return "Created \(Self.fmt(createdAt)) · Updated \(Self.fmt(updatedAt))"
    }

    // MARK: - Loading

    func startNew() {
        memoryID = nil
        title = ""
        content = ""
        attachments = []
        originalExisting = [:]
        createdAt = 0
        updatedAt = 0
        attachError = nil
        attachProgress = nil
    }

    func load(_ memory: Memory) {
        memoryID = memory.id
        title = memory.title
        content = memory.content
        createdAt = memory.createdAt
        updatedAt = memory.updatedAt
        attachError = nil
        attachProgress = nil
        originalExisting = [:]
        attachments = memory.attachments.map { a in
            originalExisting[a.id] = a.caption ?? ""
            return EditorAttachment(
                source: .existing(attachmentId: a.id),
                kind: a.kind,
                mimeType: a.mimeType,
                byteLength: a.byteLength,
                caption: a.caption ?? "",
                data: nil
            )
        }
    }

    // MARK: - Adding / removing files

    func addFiles(_ urls: [URL]) async {
        attachError = nil
        var counts: [AttachmentKind: Int] = [:]
        for a in attachments { counts[a.kind, default: 0] += 1 }

        for url in urls {
            let mime = Self.mimeType(for: url)
            guard let kind = AttachmentKind.from(mimeType: mime), AttachmentLimits.allowedMimeTypes.contains(mime) else {
                attachError = "Unsupported file type: \(url.lastPathComponent)."
                continue
            }
            // Read off the main thread so large files don't stutter the UI.
            guard let data = try? await Task.detached(priority: .userInitiated, operation: {
                try Data(contentsOf: url)
            }).value else {
                attachError = "Could not read \(url.lastPathComponent)."
                continue
            }
            if data.count > AttachmentLimits.maxBytesPerAttachment {
                attachError = "\(url.lastPathComponent) is \(Self.humanSize(data.count)); the limit is \(Self.humanSize(AttachmentLimits.maxBytesPerAttachment))."
                continue
            }
            let cap = AttachmentLimits.caps[kind] ?? 1
            if (counts[kind] ?? 0) + 1 > cap {
                attachError = "Too many \(kind.rawValue) attachments (max \(cap))."
                continue
            }
            counts[kind, default: 0] += 1
            attachments.append(EditorAttachment(
                source: .new, kind: kind, mimeType: mime, byteLength: data.count, caption: "", data: data
            ))
        }
    }

    func remove(_ attachment: EditorAttachment) {
        attachments.removeAll { $0.id == attachment.id }
        attachError = nil
    }

    /// Fetch + cache bytes for an existing attachment so it can be previewed.
    func loadPreviewData(for attachment: EditorAttachment) async {
        guard attachment.data == nil,
              case let .existing(attachmentId) = attachment.source,
              let memoryID, let api = appModel?.api else { return }
        if let bytes = try? await api.attachmentBytes(memoryId: memoryID, attachmentId: attachmentId) {
            if let idx = attachments.firstIndex(where: { $0.id == attachment.id }) {
                attachments[idx].data = bytes.data
            }
        }
    }

    // MARK: - Save

    func save() async {
        guard let appModel, let api = appModel.api else { return }
        let trimmedContent = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedContent.isEmpty && attachments.isEmpty {
            appModel.setStatus("Add content or at least one attachment.", isError: true)
            return
        }
        isSaving = true
        defer { isSaving = false; attachProgress = nil }

        let titleArg = title.trimmingCharacters(in: .whitespaces)
        do {
            if let memoryID {
                switch classifyChange() {
                case .captionOnly:
                    try await api.updateContentOnly(memoryID, content: content, title: titleArg)
                    let caps = attachments.compactMap { a -> (id: String, caption: String?)? in
                        guard case let .existing(attachmentId) = a.source else { return nil }
                        return (id: attachmentId, caption: a.caption.isEmpty ? nil : a.caption)
                    }
                    try await api.updateCaptions(memoryID, captions: caps)
                case .none:
                    try await api.updateMemory(memoryID, content: content, title: titleArg, attachments: nil)
                case .structural:
                    let payload = try await buildPayload(memoryID: memoryID)
                    try await api.updateMemory(memoryID, content: content, title: titleArg, attachments: payload)
                }
                await appModel.refreshList()
                await appModel.openMemory(memoryID)
            } else {
                let payload = attachments.isEmpty ? nil : try await buildPayload(memoryID: nil)
                let created = try await api.createMemory(content: content, title: titleArg, attachments: payload)
                await appModel.refreshList()
                await appModel.openMemory(created.id)
            }
            appModel.setStatus("Saved.")
        } catch {
            let message = (error as? APIError)?.message ?? error.localizedDescription
            if appModel.handlePossibleInvalidKey(message) { return }
            appModel.setStatus("Error: \(message)", isError: true)
        }
    }

    /// Build the full inline attachment set as base64 (re-fetching kept bytes,
    /// since PUT replaces all media).
    private func buildPayload(memoryID: String?) async throws -> [AttachmentInput] {
        guard let api = appModel?.api else { return [] }
        var out: [AttachmentInput] = []
        let total = attachments.count
        var done = 0
        attachProgress = "Preparing \(total) \(total == 1 ? "attachment" : "attachments")…"
        for a in attachments {
            let caption = a.caption.trimmingCharacters(in: .whitespaces)
            let bytes: Data
            if let data = a.data {
                bytes = data
            } else if case let .existing(attachmentId) = a.source, let memoryID {
                bytes = try await api.attachmentBytes(memoryId: memoryID, attachmentId: attachmentId).data
            } else {
                continue
            }
            out.append(AttachmentInput(mimeType: a.mimeType, data: bytes.base64EncodedString(), caption: caption.isEmpty ? nil : caption))
            done += 1
            attachProgress = "Prepared \(done) of \(total) \(total == 1 ? "attachment" : "attachments")…"
        }
        return out
    }

    private func classifyChange() -> AttachmentChange {
        let currentExisting = attachments.compactMap { a -> String? in
            if case let .existing(id) = a.source { return id }
            return nil
        }
        let hasNew = attachments.contains { $0.source == .new }
        if hasNew { return .structural }
        if Set(currentExisting) != Set(originalExisting.keys) { return .structural }
        // Same existing set, no new files — check captions.
        for a in attachments {
            if case let .existing(id) = a.source {
                if (originalExisting[id] ?? "") != a.caption { return .captionOnly }
            }
        }
        return .none
    }

    // MARK: - Formatting helpers

    /// Cached: sidebar rows call this on every render, and constructing a
    /// DateFormatter per call is expensive enough to stutter scrolling.
    /// Main-actor only, so the non-thread-safe formatter is fine.
    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    static func fmt(_ ms: Double) -> String {
        guard ms > 0 else { return "" }
        return dateFormatter.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    static func humanSize(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    static func mimeType(for url: URL) -> String {
        guard let type = UTType(filenameExtension: url.pathExtension),
              let mime = type.preferredMIMEType else {
            return "application/octet-stream"
        }
        return mime
    }
}
