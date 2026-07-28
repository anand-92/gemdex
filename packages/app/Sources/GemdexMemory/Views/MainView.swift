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
                // Unified Activity Center — ingest, hygiene, import, migration.
                // Survives panel navigation so progress/cancel never vanish.
                ActivityRail()
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

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        backendBadgeItem
        ToolbarItem {
            Spacer()
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Button { model.showSettings = true; model.showIngest = false; model.showHygiene = false } label: {
                Label("Storage", systemImage: model.activities[.migration]?.isActive == true
                      ? "externaldrive.badge.timemachine"
                      : "externaldrive")
            }
            .help(model.activities[.migration]?.isActive == true
                  ? "Local → remote import in progress"
                  : "Storage & Gemini settings")
            Button {
                model.showIngest = true
                model.showSettings = false
                model.showHygiene = false
            } label: {
                Label(
                    model.ingestIsActive || model.pendingIngestBatch != nil
                        ? "Ingest (active)"
                        : "Ingest Chat History",
                    systemImage: ingestToolbarIcon
                )
            }
            .help(ingestToolbarHelp)
            Button {
                model.showHygiene = true
                model.showSettings = false
                model.showIngest = false
            } label: {
                Label(
                    model.hygieneIsActive ? "Hygiene (active)" : "Memory Hygiene",
                    systemImage: hygieneToolbarIcon
                )
            }
            .help(hygieneToolbarHelp)
            Button(action: exportMemories) {
                Label("Export", systemImage: "square.and.arrow.up")
            }
            Button(action: importMemories) {
                Label("Import", systemImage: model.importIsActive
                      ? "square.and.arrow.down.badge.clock"
                      : "square.and.arrow.down")
            }
            .disabled(model.importIsActive)
            .help(model.importIsActive
                  ? "Import in progress — cancel from the activity bar"
                  : "Import memories from a JSON/JSONL file")
            Button { model.openNew() } label: {
                Label("New Memory", systemImage: "plus")
            }
            .keyboardShortcut("n", modifiers: .command)
        }
    }

    private var ingestToolbarIcon: String {
        if model.ingestIsActive { return "tray.and.arrow.down.fill" }
        if model.pendingIngestBatch != nil { return "clock.arrow.circlepath" }
        return model.ingestionIsReady ? "tray.and.arrow.down" : "exclamationmark.triangle.fill"
    }

    private var ingestToolbarHelp: String {
        if model.ingestIsActive {
            return "Ingestion running — open for details, or cancel from the activity bar"
        }
        if model.pendingIngestBatch != nil {
            return "A batch ingestion job is waiting to be collected"
        }
        return model.ingestionIsReady
            ? "Ingest new coding-agent sessions as memories"
            : "Gemini key validation required before ingestion"
    }

    private var hygieneToolbarIcon: String {
        if model.hygieneIsActive { return "sparkles" }
        return model.hygieneIsReady ? "sparkles" : "exclamationmark.triangle.fill"
    }

    private var hygieneToolbarHelp: String {
        if model.hygieneIsActive {
            return "Hygiene analysis running — open for details, or cancel from the activity bar"
        }
        return model.hygieneIsReady
            ? "Find stale, duplicate, or contradicted memories"
            : "Gemini key validation required before hygiene analysis"
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
