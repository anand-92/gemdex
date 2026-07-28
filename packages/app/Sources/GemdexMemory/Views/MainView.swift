import SwiftUI
import AppKit
import UniformTypeIdentifiers

/// The main manager UI: a source-list sidebar of memories plus a detail pane
/// that hosts the editor (or a placeholder). Toolbar carries New / Export /
/// Import / Storage and the backend badge.
struct MainView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 420)
        } detail: {
            DetailPane()
        }
        .navigationTitle("Gemdex Memory")
        .navigationSubtitle(model.statusText)
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                if model.backendIsRemote && (model.ingestionNeedsAttention || model.ingestionIsChecking) {
                    ingestionReadinessBanner
                }
                if let progress = model.importProgress {
                    importProgressBanner(progress)
                }
            }
        }
        .toolbar { toolbarContent }
        .alert(item: $model.importAlert) { alert in
            Alert(title: Text(alert.title), message: Text(alert.message), dismissButton: .default(Text("OK")))
        }
    }

    private var ingestionReadinessBanner: some View {
        let checking = model.ingestionIsChecking
        return HStack(alignment: .center, spacing: 12) {
            GeminiReadinessAlert(readiness: model.geminiReadiness, compact: true)
            if !checking {
                Button("Fix Gemini key") {
                    model.showSettings = true
                    model.showIngest = false
                    model.showHygiene = false
                }
                .brandPrimary()
                .fixedSize()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background((checking ? Brand.gold : Color.red).opacity(0.08))
        .overlay(alignment: .bottom) { Divider() }
    }

    /// Live determinate progress while a file imports — re-embedding makes
    /// large files take minutes, and silence reads as "nothing happened".
    private func importProgressBanner(_ progress: ImportProgress) -> some View {
        VStack(spacing: 6) {
            HStack {
                Text("Importing memories…")
                    .font(.caption.weight(.semibold))
                Spacer()
                Text("\(progress.completed) / \(progress.total)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            ProgressView(value: Double(progress.completed), total: Double(max(progress.total, 1)))
                .tint(Brand.gold)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Brand.gold.opacity(0.08))
        .overlay(alignment: .bottom) { Divider() }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        backendBadgeItem
        ToolbarItem {
            Spacer()
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Button { model.showSettings = true; model.showIngest = false; model.showHygiene = false } label: {
                Label("Storage", systemImage: "externaldrive")
            }
            Button { model.showIngest = true; model.showSettings = false; model.showHygiene = false } label: {
                Label("Ingest Chat History", systemImage: model.ingestionIsReady ? "tray.and.arrow.down" : "exclamationmark.triangle.fill")
            }
            .help(model.ingestionIsReady
                  ? "Ingest new coding-agent sessions as memories"
                  : "Gemini key validation required before ingestion")
            Button { model.showHygiene = true; model.showSettings = false; model.showIngest = false } label: {
                Label("Memory Hygiene", systemImage: model.hygieneIsReady ? "sparkles" : "exclamationmark.triangle.fill")
            }
            .help(model.hygieneIsReady
                  ? "Find stale, duplicate, or contradicted memories"
                  : "Gemini key validation required before hygiene analysis")
            Button(action: exportMemories) {
                Label("Export", systemImage: "square.and.arrow.up")
            }
            Button(action: importMemories) {
                Label("Import", systemImage: "square.and.arrow.down")
            }
            .disabled(model.importProgress != nil)
            Button { model.openNew() } label: {
                Label("New Memory", systemImage: "plus")
            }
            .keyboardShortcut("n", modifiers: .command)
        }
    }

    /// The backend badge carries its own glass pill, so opt it out of the
    /// system's automatic toolbar-item glass container on macOS 26 to avoid a
    /// doubled pill. No-op on earlier SDKs/runtimes.
    @ToolbarContentBuilder
    private var backendBadgeItem: some ToolbarContent {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            ToolbarItem(placement: .navigation) {
                BackendBadge()
            }
            .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .navigation) {
                BackendBadge()
            }
        }
        #else
        ToolbarItem(placement: .navigation) {
            BackendBadge()
        }
        #endif
    }

    private func exportMemories() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "jsonl") ?? .json]
        panel.nameFieldStringValue = "gemdex-memories-\(Self.today).jsonl"
        panel.canCreateDirectories = true
        if panel.runModal() == .OK, let url = panel.url {
            Task { await model.exportAll(to: url) }
        }
    }

    private func importMemories() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.json, UTType(filenameExtension: "jsonl") ?? .json, .plainText]
        if panel.runModal() == .OK, let url = panel.url {
            Task { await model.importFile(url) }
        }
    }

    private static let todayFormatter: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static var today: String {
        todayFormatter.string(from: Date())
    }
}

/// A compact glass pill showing the active backend (local / remote / needs key)
/// with a live status dot.
struct BackendBadge: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
                .shadow(color: color.opacity(0.7), radius: 3)
            Text(model.backendLabel)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 5)
        .glassSurface(cornerRadius: 999, tint: color)
        .help(model.backendLabel)
    }

    private var color: Color {
        if model.backendNeedsAttention { return Brand.terracotta }
        return model.backendIsRemote ? Brand.sage : Brand.gold
    }
}
