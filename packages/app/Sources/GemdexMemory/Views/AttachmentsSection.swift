import SwiftUI
import AppKit
import AVKit
import PDFKit
import UniformTypeIdentifiers

/// Attachment editor: drag-and-drop / pick files, caption them, preview each
/// (image / audio / video / PDF), and remove. Mirrors the web editor's
/// attachments panel.
struct AttachmentsSection: View {
    @EnvironmentObject var model: AppModel
    @State private var isTargeted = false

    private var editor: EditorModel { model.editor }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Attachments", systemImage: "paperclip")
                    .font(.headline)
                    .labelStyle(.titleAndIcon)
                Spacer()
                Button(action: pickFiles) {
                    Label("Add files", systemImage: "plus")
                        .font(.callout.weight(.medium))
                        .padding(.horizontal, 11)
                        .padding(.vertical, 6)
                        .glassSurfaceInteractive(cornerRadius: Metric.radiusControl)
                }
                .buttonStyle(.plain)
            }

            dropZone

            if let progress = editor.attachProgress {
                Label(progress, systemImage: "arrow.triangle.2.circlepath")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let error = editor.attachError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(Brand.terracotta)
            }
        }
    }

    private var dropZone: some View {
        VStack(spacing: 12) {
            if editor.attachments.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "tray.and.arrow.down.fill")
                        .font(.system(size: 26, weight: .light))
                        .foregroundStyle(isTargeted ? Brand.gold : .secondary)
                        .scaleEffect(isTargeted ? 1.1 : 1)
                    Text("Drag & drop media here, or “Add files”.")
                        .font(.callout.weight(.medium)).foregroundStyle(.secondary)
                    Text("Images (≤6), plus one each of audio / video / PDF. 20 MB per file.")
                        .font(.caption).foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 30)
            } else {
                ForEach(editor.attachments) { attachment in
                    AttachmentCard(attachment: attachment)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity)
        .glassSurface(cornerRadius: Metric.radiusPanel, tint: isTargeted ? Brand.gold : nil)
        .overlay(
            RoundedRectangle(cornerRadius: Metric.radiusPanel, style: .continuous)
                .strokeBorder(isTargeted ? Brand.gold : Color.clear,
                              style: StrokeStyle(lineWidth: isTargeted ? 2 : 0, dash: editor.attachments.isEmpty ? [7] : []))
        )
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: isTargeted)
        .onDrop(of: [.fileURL], isTargeted: $isTargeted) { providers in
            handleDrop(providers)
            return true
        }
    }

    private func pickFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.png, .jpeg, .mpeg4Movie, .quickTimeMovie, .mp3, .wav, .pdf, .audio, .movie, .image]
        if panel.runModal() == .OK {
            let urls = panel.urls
            Task { await editor.addFiles(urls) }
        }
    }

    private func handleDrop(_ providers: [NSItemProvider]) {
        let group = DispatchGroup()
        var urls: [URL] = []
        for provider in providers {
            group.enter()
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                // Completion fires on an internal background queue; serialize
                // the append onto main to avoid a data race on `urls`.
                DispatchQueue.main.async {
                    if let url { urls.append(url) }
                    group.leave()
                }
            }
        }
        group.notify(queue: .main) {
            Task { await editor.addFiles(urls) }
        }
    }
}

/// One attachment card: media preview, name/size, caption field, and actions.
struct AttachmentCard: View {
    @EnvironmentObject var model: AppModel
    let attachment: EditorAttachment

    private var editor: EditorModel { model.editor }

    private var binding: Binding<EditorAttachment>? {
        guard editor.attachments.contains(where: { $0.id == attachment.id }) else { return nil }
        let id = attachment.id
        return Binding(
            get: { editor.attachments.first { $0.id == id } ?? attachment },
            set: { newValue in
                if let idx = editor.attachments.firstIndex(where: { $0.id == id }) {
                    editor.attachments[idx] = newValue
                }
            }
        )
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AttachmentPreview(attachment: attachment)
                .frame(width: 120, height: 90)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

            VStack(alignment: .leading, spacing: 8) {
                Text("\(attachment.kind.rawValue) · \(EditorModel.humanSize(attachment.byteLength))")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if let binding {
                    TextField("Caption (helps recall)", text: binding.caption)
                        .textFieldStyle(.roundedBorder)
                        .controlSize(.small)
                }

                HStack(spacing: 8) {
                    Button {
                        editor.remove(attachment)
                    } label: {
                        Label("Remove", systemImage: "trash")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(Brand.terracotta)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 5)
                            .glassSurfaceInteractive(cornerRadius: Metric.radiusChip)
                    }
                    .buttonStyle(.plain)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .glassSurface(cornerRadius: Metric.radiusCard)
        .task(id: attachment.id) {
            await editor.loadPreviewData(for: attachment)
        }
    }
}

/// Renders an attachment's preview based on its kind. Fetches its own bytes
/// into local `@State` (lazily for existing attachments) so it re-renders once
/// the data lands, independent of the editor model's publishing.
struct AttachmentPreview: View {
    @EnvironmentObject var model: AppModel
    let attachment: EditorAttachment
    @State private var data: Data?
    /// Temp file for AVPlayer (audio/video), written off the main thread.
    @State private var mediaURL: URL?

    var body: some View {
        Group {
            switch attachment.kind {
            case .image:
                if let data, let image = NSImage(data: data) {
                    Image(nsImage: image).resizable().scaledToFill()
                } else { placeholder("photo") }
            case .video:
                if let mediaURL {
                    MediaPlayerView(url: mediaURL)
                } else { placeholder("film") }
            case .audio:
                if let mediaURL {
                    MediaPlayerView(url: mediaURL)
                } else { placeholder("waveform") }
            case .pdf:
                if let data {
                    PDFThumbnail(data: data)
                } else { placeholder("doc.richtext") }
            case .file:
                // Blob-only sources (e.g. full chat transcripts) — no media preview.
                placeholder("doc.text")
            }
        }
        .background(Color(nsColor: .controlColor))
        .task(id: attachment.id) { await loadData() }
    }

    private func loadData() async {
        var bytes = attachment.data
        if bytes == nil {
            guard case let .existing(attachmentId) = attachment.source,
                  let memoryID = model.selectedID, let api = model.api else { return }
            bytes = try? await api.attachmentBytes(memoryId: memoryID, attachmentId: attachmentId).data
        }
        guard let bytes else { return }
        data = bytes
        // AVPlayer needs a file URL; materialize it off the main thread.
        if attachment.kind == .video || attachment.kind == .audio {
            mediaURL = await Self.writeTempFile(bytes, id: attachment.id, mimeType: attachment.mimeType)
        }
    }

    private func placeholder(_ symbol: String) -> some View {
        ZStack {
            Color(nsColor: .controlColor)
            Image(systemName: symbol).font(.title2).foregroundStyle(.secondary)
        }
    }

    private static func writeTempFile(_ data: Data, id: UUID, mimeType: String) async -> URL {
        let ext = UTType(mimeType: mimeType)?.preferredFilenameExtension ?? "bin"
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("gemdex-\(id.uuidString)")
            .appendingPathExtension(ext)
        if !FileManager.default.fileExists(atPath: url.path) {
            try? await Task.detached(priority: .userInitiated) {
                try data.write(to: url)
            }.value
        }
        return url
    }
}

/// AVKit player (AppKit) for audio + video previews, with standard controls.
struct MediaPlayerView: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.controlsStyle = .inline
        view.player = AVPlayer(url: url)
        return view
    }
    func updateNSView(_ nsView: AVPlayerView, context: Context) {
        if nsView.player == nil { nsView.player = AVPlayer(url: url) }
    }
}

/// Inline PDF preview using PDFKit.
struct PDFThumbnail: NSViewRepresentable {
    let data: Data
    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePage
        view.document = PDFDocument(data: data)
        return view
    }
    func updateNSView(_ nsView: PDFView, context: Context) {
        if nsView.document == nil { nsView.document = PDFDocument(data: data) }
    }
}
