import SwiftUI

/// Memory hygiene: find stale, duplicate, or contradicted memories. Four-step
/// flow: intro (last report summary) → scan (local vector clustering + cost
/// estimate + judge-model choice) → run LLM analysis with live progress →
/// review clusters and delete human-approved memories. All clustering and
/// judging happens in the sidecar behind `/hygiene/*`; this view is a thin
/// polling client and only owns checkbox selection state.
@MainActor
struct HygieneView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    var isEmbedded: Bool = false

    private enum Step {
        case intro
        case scanned
        case running
        case review
        case deleted
    }

    /// Deletions are applied in small sequential batches so a big approval
    /// (hundreds of ids) shows live progress instead of one long frozen POST.
    private static let applyBatchSize = 10

    @State private var step: Step = .intro
    @State private var envelope: HygieneReportEnvelope?
    @State private var scan: HygieneScanSummary?
    @State private var reviewClusters: [HygieneCluster] = []
    @State private var selectedModel = ""
    @State private var status: HygieneStatus?
    @State private var selectedIds: Set<String> = []
    @State private var deletedCount: Int?
    @State private var applyProgress: (done: Int, total: Int)?
    @State private var showDeleteConfirm = false
    @State private var busy = false
    @State private var error: String?

    /// Prefer the Activity Center's live poll so leaving the panel never freezes progress.
    private var liveStatus: HygieneStatus? { model.hygieneStatus ?? status }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    content
                    if let error {
                        Text(error).font(.callout).foregroundStyle(Brand.terracotta)
                            .textSelection(.enabled)
                    }
                }
                .padding(20)
            }
            Divider()
            footer
        }
        .frame(width: isEmbedded ? nil : 620, height: isEmbedded ? nil : 600)
        .frame(maxWidth: isEmbedded ? 640 : .infinity)
        .background(isEmbedded ? nil : BrandBackdrop())
        .task { await loadReport() }
        .onChange(of: model.hygieneStatus?.state) { _ in
            syncStepWithActivity()
        }
        .onChange(of: model.activities[.hygiene]?.phase) { _ in
            syncStepWithActivity()
        }
    }

    // MARK: - Header / footer

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Label("Memory hygiene", systemImage: "sparkles")
                    .font(.title3.bold())
                Text("Find stale, duplicate, or contradicted memories. Nothing is ever deleted without your explicit approval.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                close()
            } label: {
                Image(systemName: "xmark")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 26, height: 26)
                    .glassSurfaceInteractive(cornerRadius: 999)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
            .accessibilityLabel("Close")
        }
        .padding(20)
    }

    @ViewBuilder
    private var footer: some View {
        HStack {
            switch step {
            case .intro:
                Spacer()
                if hasJudgedReport {
                    Button("Review Last Results") { openLastReport() }
                        .disabled(busy)
                }
                Button("New Scan") { Task { await runScan() } }
                    .buttonStyle(BrandButtonStyle())
                    .disabled(busy || !hygieneReady)
            case .scanned:
                Button("Back") { step = .intro; scan = nil; error = nil }
                Spacer()
                Button("Run Analysis") { Task { await start() } }
                    .buttonStyle(BrandButtonStyle())
                    .disabled(busy || (scan?.clusters.isEmpty ?? true) || !hygieneReady)
            case .running:
                Spacer()
                Text(model.activities[.hygiene]?.phase == .cancelling
                     ? "Cancelling… partial findings are kept"
                     : "Runs in the background — safe to leave this panel")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Cancel") { model.cancelActivity(.hygiene) }
                    .disabled(busy || model.activities[.hygiene]?.phase == .cancelling)
            case .review:
                if let progress = applyProgress {
                    // Replace the footer controls with determinate progress
                    // while the batched deletion runs.
                    VStack(alignment: .leading, spacing: 6) {
                        ProgressView(value: Double(progress.done), total: Double(max(progress.total, 1)))
                        Text("Deleting \(progress.done) of \(progress.total)…")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                } else {
                    Text(selectedIds.isEmpty
                         ? "No memories selected"
                         : "\(selectedIds.count) selected")
                        .font(.callout)
                        .foregroundStyle(selectedIds.isEmpty ? Color.secondary : Brand.terracotta)
                    Spacer()
                    Button("Done") { close() }
                    Button("Delete Selected", role: .destructive) { showDeleteConfirm = true }
                        .disabled(busy || selectedIds.isEmpty)
                        .confirmationDialog(
                            "Delete \(selectedIds.count) \(selectedIds.count == 1 ? "memory" : "memories")? This cannot be undone.",
                            isPresented: $showDeleteConfirm,
                            titleVisibility: .visible
                        ) {
                            Button("Delete \(selectedIds.count) \(selectedIds.count == 1 ? "Memory" : "Memories")", role: .destructive) {
                                Task { await applyDeletion() }
                            }
                            Button("Cancel", role: .cancel) {}
                        }
                }
            case .deleted:
                Spacer()
                if !reviewClusters.isEmpty {
                    Button("Back to Review") { step = .review }
                }
                Button("Close") { close() }
                    .buttonStyle(BrandButtonStyle())
            }
        }
        .padding(16)
    }

    // MARK: - Step content

    @ViewBuilder
    private var content: some View {
        switch step {
        case .intro: introStep
        case .scanned: scannedStep
        case .running: runningStep
        case .review: reviewStep
        case .deleted: deletedStep
        }
    }

    @ViewBuilder
    private var introStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !hygieneReady {
                VStack(alignment: .leading, spacing: 10) {
                    GeminiReadinessAlert(readiness: model.geminiReadiness, compact: true)
                    Text("Hygiene analysis is disabled. Judging always runs locally with your Gemini key, even when memories are stored on a remote Gemdex Server.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Open Storage & Gemini settings") {
                        model.showHygiene = false
                        model.showIngest = false
                        model.showSettings = true
                    }
                    .brandPrimary()
                }
            }
            Text("How it works").font(.headline)
            Text("A fast local scan clusters similar memories by embedding similarity — no LLM calls, no cost. You then pick a judge model and run an analysis that reads each cluster and marks every memory as keep, duplicate, superseded, or contradicted, with evidence. Finally you review the findings and choose exactly what to delete.")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let report = envelope?.report {
                lastReportCard(report)
            } else if envelope != nil {
                Text("No previous hygiene report on this machine.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                ProgressView("Loading…")
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 20)
            }
        }
    }

    private func lastReportCard(_ report: HygieneReport) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Last report").font(.callout.bold())
            Text("\(report.clusters.count) clusters across \(report.memoryCount) memories · threshold \(formatSimilarity(report.threshold))")
                .font(.caption).foregroundStyle(.secondary)
            if let judgedAt = report.judgedAt {
                Text("Judged \(formatDate(judgedAt))" + (report.model.map { " · \($0)" } ?? ""))
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Scanned \(formatDate(report.scannedAt)) · not yet analyzed")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !report.deletedIds.isEmpty {
                Text("\(report.deletedIds.count) memories already deleted from this report")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .glassSurface(cornerRadius: Metric.radiusCard, tint: Brand.gold)
    }

    @ViewBuilder
    private var scannedStep: some View {
        if let scan {
            VStack(alignment: .leading, spacing: 16) {
                Text("Scan results").font(.headline)
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                    GridRow {
                        Text("Candidate clusters"); Text("\(scan.clusters.count)").bold()
                    }
                    GridRow {
                        Text("Memories scanned"); Text("\(scan.memoryCount)").foregroundStyle(.secondary)
                    }
                    GridRow {
                        Text("Previously dismissed clusters"); Text("\(scan.dismissedCount)").foregroundStyle(.secondary)
                    }
                    GridRow {
                        Text("Similarity threshold"); Text(formatSimilarity(scan.threshold)).foregroundStyle(.secondary)
                    }
                }
                .font(.callout)

                if scan.clusters.isEmpty {
                    Label("No similar-memory clusters found. Your memories look tidy.",
                          systemImage: "checkmark.circle")
                        .foregroundStyle(Brand.sage)
                } else {
                    Text("Clusters found").font(.headline)
                    ForEach(scan.clusters) { cluster in
                        HStack(spacing: 10) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(cluster.newestMember?.displayTitle ?? "Untitled memory")
                                    .font(.body.weight(.medium))
                                    .lineLimit(1).truncationMode(.tail)
                                Text("\(cluster.members.count) memories")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(formatSimilarity(cluster.similarity))
                                .font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                        .padding(10)
                        .glassSurface(cornerRadius: Metric.radiusCard)
                    }
                    Divider()
                    Text("Judge model & cost").font(.headline)
                    Text("≈ \(formatTokens(scan.estimatedInputTokens)) input / \(formatTokens(scan.estimatedOutputTokens)) output tokens across \(scan.clusters.count) clusters. Pricing as of \(envelope?.pricingAsOf ?? "—").")
                        .font(.caption).foregroundStyle(.secondary)
                    Picker("Model", selection: $selectedModel) {
                        ForEach(envelope?.models ?? []) { info in
                            Text("\(info.model) — \(info.description)").tag(info.model)
                        }
                    }
                    costTable(scan.estimates)
                }
            }
        }
    }

    private func costTable(_ estimates: [IngestCostEstimate]) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 4) {
            GridRow {
                Text("Model").font(.caption.bold())
                Text("Standard").font(.caption.bold())
                Text("Batch").font(.caption.bold())
            }
            ForEach(estimates) { estimate in
                GridRow {
                    Text(estimate.model)
                        .font(.caption.monospaced())
                        .fontWeight(estimate.model == selectedModel ? .bold : .regular)
                    Text(formatUsd(estimate.standardUsd)).font(.caption.monospaced())
                    Text(formatUsd(estimate.batchUsd)).font(.caption.monospaced())
                }
            }
        }
        .padding(10)
        .glassSurface(cornerRadius: Metric.radiusCard)
    }

    private var runningStep: some View {
        let s = liveStatus
        return VStack(alignment: .leading, spacing: 14) {
            Text(model.activities[.hygiene]?.phase == .cancelling
                 ? "Cancelling…"
                 : "Analyzing clusters…")
                .font(.headline)
            let done = (s?.judged ?? 0) + (s?.failed ?? 0)
            ProgressView(value: Double(done), total: Double(max(s?.total ?? 1, 1)))
                .tint(Brand.sage)
            HStack {
                Text("\(s?.judged ?? 0) judged · \(s?.failed ?? 0) failed · \(s?.total ?? 0) total")
                    .font(.callout).foregroundStyle(.secondary)
                Spacer()
            }
            Text("The judge model reads each cluster's memories and marks every one as keep, duplicate, superseded, or contradicted — with evidence.")
                .font(.caption).foregroundStyle(.secondary)
            Label("Progress stays visible in the activity bar if you leave this panel. Cancel keeps partial findings so you can review what finished.",
                  systemImage: "info.circle")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var reviewStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            if reviewClusters.isEmpty {
                Label("Nothing left to review. Your memories look tidy.",
                      systemImage: "checkmark.circle")
                    .foregroundStyle(Brand.sage)
            } else {
                Text("Check the memories you want to delete. Only high-confidence duplicates are pre-checked — everything else is your call.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(reviewClusters) { cluster in
                        clusterCard(cluster)
                    }
                }
            }
        }
    }

    private var deletedStep: some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 52))
                .foregroundStyle(Brand.sage)
            let count = deletedCount ?? 0
            Text("Deleted \(count) \(count == 1 ? "memory" : "memories")")
                .font(.title3.bold())
            Text(reviewClusters.isEmpty
                 ? "Nothing left to review. Your memories look tidy."
                 : "Some clusters still have findings you can review.")
                .font(.callout).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }

    private func clusterCard(_ cluster: HygieneCluster) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("\(cluster.members.count) similar memories")
                    .font(.callout.bold())
                Text(formatSimilarity(cluster.similarity))
                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                Spacer()
                Button("Keep All") { Task { await dismissCluster(cluster) } }
                    .disabled(busy)
                    .help("Keep every memory in this cluster and never flag it again")
            }
            if let clusterError = cluster.error {
                Text(clusterError).font(.caption).foregroundStyle(Brand.terracotta)
                    .textSelection(.enabled)
            }
            Divider()
            ForEach(cluster.members) { member in
                memberRow(member, in: cluster)
            }
        }
        .padding(12)
        .glassSurface(cornerRadius: Metric.radiusCard)
    }

    @ViewBuilder
    private func memberRow(_ member: HygieneClusterMember, in cluster: HygieneCluster) -> some View {
        let finding = cluster.finding(for: member.memoryId)
        let isNewest = cluster.newestMember?.memoryId == member.memoryId
        HStack(alignment: .top, spacing: 10) {
            // Keep-verdict memories can never be checked for deletion; the
            // server's "keep" is the anchor the rest of the cluster hangs on.
            if let finding, !finding.isKeep {
                Toggle(isOn: selectionBinding(member.memoryId)) { EmptyView() }
                    .toggleStyle(.checkbox)
                    .labelsHidden()
                    .disabled(busy)
                    .accessibilityLabel("Delete \(member.displayTitle)")
            } else {
                // Reserve the checkbox column so rows line up.
                Spacer().frame(width: 16)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if let finding {
                        verdictBadge(finding.verdict)
                    }
                    Text(member.displayTitle)
                        .font(.body.weight(.medium))
                        .lineLimit(1).truncationMode(.tail)
                    if isNewest {
                        Text("newest")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Brand.gold.opacity(0.18), in: Capsule())
                    }
                }
                HStack(spacing: 8) {
                    Text(relativeDate(member.updatedAt))
                        .font(.caption).foregroundStyle(.secondary)
                    if let confidence = finding?.confidence {
                        Text("confidence: \(confidence)")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let evidence = finding?.evidence, !evidence.isEmpty {
                    Text(evidence)
                        .font(.caption.italic())
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                if let supersededBy = finding?.supersededBy,
                   let covering = cluster.members.first(where: { $0.memoryId == supersededBy }) {
                    Label("superseded by → \(covering.displayTitle)", systemImage: "arrow.turn.down.right")
                        .font(.caption)
                        .foregroundStyle(Brand.gold)
                        .lineLimit(1).truncationMode(.tail)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private func verdictBadge(_ verdict: String) -> some View {
        Text(verdict)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .foregroundStyle(verdictColor(verdict))
            .background(verdictColor(verdict).opacity(0.16), in: Capsule())
    }

    private func verdictColor(_ verdict: String) -> Color {
        switch verdict {
        case "keep": return Brand.sage
        case "superseded": return Brand.gold
        case "contradicted": return Brand.terracotta
        default: return .secondary // duplicate
        }
    }

    private func selectionBinding(_ memoryId: String) -> Binding<Bool> {
        Binding(
            get: { selectedIds.contains(memoryId) },
            set: { checked in
                if checked { selectedIds.insert(memoryId) } else { selectedIds.remove(memoryId) }
            }
        )
    }

    // MARK: - State helpers

    private var hygieneReady: Bool { model.hygieneIsReady }

    private var hasJudgedReport: Bool {
        guard let report = envelope?.report else { return false }
        return report.judgedAt != nil
    }

    // MARK: - Actions

    private func close() {
        if isEmbedded {
            model.showHygiene = false
        } else {
            dismiss()
        }
    }

    private func loadReport() async {
        guard let api = model.api else { return }
        do {
            let loaded = try await api.hygieneReport()
            apply(envelope: loaded)
            await model.refreshActivityStatus()
            // Resume mid-flight analysis, or jump to review if a fresh report
            // just finished while the panel was closed.
            if !resumeFromActivity() {
                if let latest = model.hygieneStatus, latest.state == "running" {
                    status = latest
                    step = .running
                }
            }
        } catch {
            let message = (error as? APIError)?.message ?? error.localizedDescription
            if model.handlePossibleInvalidIngestionKey(message) { return }
            self.error = message
        }
    }

    @discardableResult
    private func resumeFromActivity() -> Bool {
        if let latest = model.hygieneStatus {
            status = latest
        }
        return syncStepWithActivity()
    }

    @discardableResult
    private func syncStepWithActivity() -> Bool {
        let state = model.hygieneStatus?.state
            ?? model.activities[.hygiene].map { activityState($0.phase) }
        switch state {
        case "running":
            if step != .running { step = .running }
            status = model.hygieneStatus ?? status
            return true
        case "done", "cancelled", "failed":
            // Only auto-advance while we were showing the progress screen —
            // the Activity Center owns terminal chips after that.
            guard step == .running else { return false }
            let latest = model.hygieneStatus ?? status ?? HygieneStatus(
                state: state ?? "done",
                judged: 0,
                failed: 0,
                total: 0,
                error: model.activities[.hygiene]?.error
            )
            Task { await finishRun(latest) }
            return true
        default:
            return false
        }
    }

    private func activityState(_ phase: JobPhase) -> String {
        switch phase {
        case .running, .cancelling: return "running"
        case .batchPending: return "running"
        case .completed: return "done"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
        }
    }

    private func apply(envelope loaded: HygieneReportEnvelope) {
        envelope = loaded
        if selectedModel.isEmpty {
            selectedModel = loaded.models.first(where: { $0.isDefault })?.model
                ?? loaded.models.first?.model ?? ""
        }
    }

    private func openLastReport() {
        guard let report = envelope?.report else { return }
        enterReview(with: report)
    }

    private func runScan() async {
        await withBusy {
            guard let api = model.api else { return }
            scan = try await api.hygieneScan()
            deletedCount = nil
            step = .scanned
        }
    }

    private func start() async {
        await withBusy {
            guard let api = model.api else { return }
            try await api.hygieneStart(model: selectedModel)
            status = nil
            // Hand ownership to the Activity Center so leaving the panel is safe.
            model.noteHygieneStarted(total: scan?.clusters.count ?? 0)
            step = .running
        }
    }

    private func finishRun(_ latest: HygieneStatus) async {
        // Avoid re-entering review repeatedly while the Activity Center holds
        // a terminal chip (onChange would fire again).
        guard step == .running else { return }
        status = latest
        if latest.state == "failed", let message = latest.error {
            error = message
        }
        guard let api = model.api else { return }
        if let loaded = try? await api.hygieneReport() {
            apply(envelope: loaded)
        }
        if let report = envelope?.report {
            enterReview(with: report)
        } else {
            step = .intro
        }
    }

    private func enterReview(with report: HygieneReport) {
        let deleted = Set(report.deletedIds)
        reviewClusters = report.clusters.compactMap { cluster -> HygieneCluster? in
            let members = cluster.members.filter { !deleted.contains($0.memoryId) }
            guard members.count >= 2 else { return nil }
            return HygieneCluster(
                clusterId: cluster.clusterId,
                similarity: cluster.similarity,
                members: members,
                findings: cluster.findings,
                error: cluster.error
            )
        }
        // Pre-check ONLY high-confidence duplicate/superseded verdicts —
        // contradicted and low/medium confidence always start unchecked.
        selectedIds = Set(reviewClusters.flatMap { cluster in
            cluster.members.compactMap { member -> String? in
                guard let finding = cluster.finding(for: member.memoryId),
                      finding.isSafePreselect else { return nil }
                return member.memoryId
            }
        })
        deletedCount = nil
        step = .review
    }

    /// Delete the approved ids in small sequential batches so the UI shows
    /// determinate progress and no single request can run long enough to hit
    /// the URLSession timeout. A mid-run failure keeps the already-deleted
    /// batches pruned from local state and leaves the rest selected.
    private func applyDeletion() async {
        guard let api = model.api else { return }
        busy = true
        error = nil
        let ids = selectedIds.sorted()
        applyProgress = (done: 0, total: ids.count)
        var totalDeleted = 0
        var failure: String?
        for batchStart in stride(from: 0, to: ids.count, by: Self.applyBatchSize) {
            let batch = Array(ids[batchStart..<min(batchStart + Self.applyBatchSize, ids.count)])
            do {
                totalDeleted += try await api.hygieneApply(ids: batch)
            } catch {
                let message = (error as? APIError)?.message ?? error.localizedDescription
                failure = message
                break
            }
            removeFromReview(Set(batch))
            applyProgress = (done: batchStart + batch.count, total: ids.count)
        }
        applyProgress = nil
        busy = false
        if totalDeleted > 0 {
            await model.refreshList()
        }
        if let failure {
            if model.handlePossibleInvalidIngestionKey(failure) { return }
            error = failure
            return
        }
        deletedCount = totalDeleted
        step = .deleted
    }

    /// Prune deleted members from local review state; unselect them and drop
    /// clusters that no longer have at least two remaining members.
    private func removeFromReview(_ removed: Set<String>) {
        selectedIds.subtract(removed)
        reviewClusters = reviewClusters.compactMap { cluster -> HygieneCluster? in
            let members = cluster.members.filter { !removed.contains($0.memoryId) }
            guard members.count >= 2 else { return nil }
            return HygieneCluster(
                clusterId: cluster.clusterId,
                similarity: cluster.similarity,
                members: members,
                findings: cluster.findings,
                error: cluster.error
            )
        }
    }

    private func dismissCluster(_ cluster: HygieneCluster) async {
        await withBusy {
            guard let api = model.api else { return }
            try await api.hygieneDismiss(clusterIds: [cluster.clusterId])
            reviewClusters.removeAll { $0.clusterId == cluster.clusterId }
            for member in cluster.members {
                selectedIds.remove(member.memoryId)
            }
        }
    }

    private func withBusy(_ work: () async throws -> Void) async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await work()
        } catch {
            let message = (error as? APIError)?.message ?? error.localizedDescription
            if model.handlePossibleInvalidIngestionKey(message) { return }
            self.error = message
        }
    }

    // MARK: - Formatting

    private func formatSimilarity(_ value: Double) -> String {
        String(format: "%.0f%%", value * 100)
    }

    private func formatTokens(_ tokens: Int) -> String {
        if tokens >= 1_000_000 { return String(format: "%.1fM", Double(tokens) / 1_000_000) }
        if tokens >= 1_000 { return String(format: "%.0fk", Double(tokens) / 1_000) }
        return "\(tokens)"
    }

    private func formatUsd(_ value: Double) -> String {
        value < 0.01 && value > 0 ? "<$0.01" : String(format: "$%.2f", value)
    }

    private func formatDate(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .shortened)
    }

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    private func relativeDate(_ ms: Double) -> String {
        guard ms > 0 else { return "" }
        return Self.relativeFormatter.localizedString(
            for: Date(timeIntervalSince1970: ms / 1000), relativeTo: Date()
        )
    }
}
