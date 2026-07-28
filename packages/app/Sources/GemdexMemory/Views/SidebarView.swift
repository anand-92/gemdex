import SwiftUI

/// Source-list of memories with a search box. Typing filters loaded titles
/// client-side; pressing Return runs semantic free-text recall (`POST /recall`)
/// and lists the parent-document hybrid ranking. Selecting a row opens it in
/// the detail editor.
struct SidebarView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.gemdexIsOLED) private var isOLED

    var body: some View {
        VStack(spacing: 0) {
            filterField
                .padding(.horizontal, 10)
                .padding(.top, 8)
                .padding(.bottom, 6)
            listContent
        }
        // OLED: solid black instead of the sidebar vibrancy material, so the
        // source list blends into the pure-black window.
        .background((isOLED ? AnyView(Color.black) : AnyView(VisualEffectBackground(material: .sidebar))).ignoresSafeArea())
    }

    private var filterField: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            TextField("Search memories…", text: $model.filterText)
                .textFieldStyle(.plain)
                .font(.callout)
                .onSubmit { Task { await model.runSearch() } }
                .onChange(of: model.filterText) { _ in
                    // Editing the query returns to the live local-title filter
                    // until the next Return-triggered semantic search.
                    if case .idle = model.searchState {} else { model.searchState = .idle }
                }
            if !model.filterText.isEmpty {
                Button { model.clearSearch() } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .transition(.scale.combined(with: .opacity))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .glassSurface(cornerRadius: Metric.radiusControl)
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: model.filterText.isEmpty)
    }

    @ViewBuilder
    private var listContent: some View {
        switch model.searchState {
        case .searching:
            statusState(systemImage: nil, title: "Searching memories…", detail: nil, showSpinner: true)
        case let .failed(message):
            statusState(systemImage: "exclamationmark.triangle", title: "Search could not complete.", detail: message, showSpinner: false)
        case let .results(results):
            let hits = model.resultSummaries(results)
            if hits.isEmpty {
                statusState(systemImage: "magnifyingglass", title: "No matching memories.", detail: nil, showSpinner: false)
            } else {
                memoryList(hits)
            }
        case .idle:
            if model.memories.isEmpty {
                emptyState
            } else {
                memoryList(model.visibleMemories)
            }
        }
    }

    private func memoryList(_ items: [MemorySummary]) -> some View {
        List(selection: Binding(
            get: { model.selectedID },
            set: { newID in if let newID { Task { await model.openMemory(newID) } } }
        )) {
            ForEach(items) { memory in
                MemoryRow(memory: memory, isSelected: memory.id == model.selectedID)
                    .equatable()
                    .tag(memory.id)
                    .frame(height: 74)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 3, leading: 8, bottom: 3, trailing: 8))
                    .contextMenu {
                        Button("Open") { Task { await model.openMemory(memory.id) } }
                        Button("Delete", role: .destructive) {
                            Task {
                                await model.openMemory(memory.id)
                                await model.deleteSelected()
                            }
                        }
                    }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
    }

    private func statusState(systemImage: String?, title: String, detail: String?, showSpinner: Bool) -> some View {
        VStack(spacing: 14) {
            if showSpinner {
                ProgressView().controlSize(.large)
            } else if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 30, weight: .light))
                    .foregroundStyle(Brand.gold.gradient)
            }
            Text(title)
                .font(.callout.weight(.semibold))
                .multilineTextAlignment(.center)
            if let detail {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "tray")
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(Brand.gold.gradient)
            Text("No memories yet.")
                .font(.callout.weight(.semibold))
            Text("Create one, or save from your agent.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

/// One row in the sidebar: optional image thumbnail, title, preview, date, and
/// an attachment-count chip.
struct MemoryRow: View, Equatable {
    let memory: MemorySummary
    var isSelected: Bool = false

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            thumbnail
            VStack(alignment: .leading, spacing: 3) {
                Text(memory.displayTitle)
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                if !memory.preview.isEmpty {
                    Text(memory.preview)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                HStack(spacing: 7) {
                    Text(memory.updatedLabel)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    if !memory.attachments.isEmpty {
                        Label("\(memory.attachments.count)", systemImage: "paperclip")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(Brand.gold)
                            .labelStyle(.titleAndIcon)
                    }
                }
                .padding(.top, 1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 9)
        .background(selectionBackground)
        .contentShape(RoundedRectangle(cornerRadius: Metric.radiusControl, style: .continuous))
    }

    @ViewBuilder
    private var thumbnail: some View {
        if let image = memory.firstImage {
            ThumbnailView(memoryID: memory.id, attachmentID: image.id)
                .frame(width: 46, height: 46)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .strokeBorder(Color.primary.opacity(0.08))
                )
        } else {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Brand.warmGradient.opacity(0.16))
                .frame(width: 46, height: 46)
                .overlay(
                    Image(systemName: "doc.text")
                        .font(.system(size: 16, weight: .light))
                        .foregroundStyle(Brand.gold)
                )
        }
    }

    @ViewBuilder
    private var selectionBackground: some View {
        if isSelected {
            RoundedRectangle(cornerRadius: Metric.radiusControl, style: .continuous)
                .fill(Brand.gold.opacity(0.16))
        }
    }
}

/// Lazily fetches a small image attachment for a sidebar thumbnail. Renders
/// synchronously from the shared `ThumbnailLoader` cache when possible, so
/// recycled rows don't flash a placeholder or re-fetch on scroll-back.
struct ThumbnailView: View {
    @EnvironmentObject var model: AppModel
    let memoryID: String
    let attachmentID: String
    @State private var loaded: NSImage?

    private var image: NSImage? {
        loaded ?? model.thumbnails.cached(memoryID: memoryID, attachmentID: attachmentID)
    }

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFill()
            } else {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(Color(nsColor: .controlColor))
                    .overlay(Image(systemName: "photo").foregroundStyle(.secondary).font(.caption))
            }
        }
        .task(id: attachmentID) {
            guard image == nil else { return }
            loaded = await model.thumbnails.thumbnail(memoryID: memoryID, attachmentID: attachmentID)
        }
    }
}
