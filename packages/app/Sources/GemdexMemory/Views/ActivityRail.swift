import SwiftUI

/// Persistent activity strip for long-running work. Jobs live on `AppModel`, so
/// navigating away from Ingest / Hygiene / Settings never hides progress.
/// Each row shows determinate progress (when known), Cancel, Open, and a brief
/// terminal state after finish so the user always knows what happened.
struct ActivityRail: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        let jobs = model.activityList
        if !jobs.isEmpty {
            VStack(spacing: 0) {
                ForEach(jobs) { job in
                    ActivityRow(job: job)
                    if job.id != jobs.last?.id {
                        Divider().opacity(0.5)
                    }
                }
            }
            .overlay(alignment: .bottom) { Divider() }
        }
    }
}

private struct ActivityRow: View {
    @EnvironmentObject var model: AppModel
    let job: JobActivity

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                statusIcon
                    .frame(width: 16, height: 16)

                VStack(alignment: .leading, spacing: 2) {
                    Text(job.title)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                    if let detail = job.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .textSelection(.enabled)
                    }
                }

                Spacer(minLength: 8)

                if !job.progressLabel.isEmpty, job.isActive {
                    Text(job.progressLabel)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }

                actionButtons
            }

            if job.isActive {
                if let fraction = job.fraction {
                    ProgressView(value: fraction)
                        .tint(accent)
                        .animation(.easeInOut(duration: 0.25), value: fraction)
                } else {
                    ProgressView()
                        .controlSize(.small)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(backgroundTint.opacity(0.10))
        .contentShape(Rectangle())
        .onTapGesture {
            if job.canOpen { model.openActivity(job.kind) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilitySummary)
        .accessibilityAddTraits(job.canOpen ? .isButton : [])
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch job.phase {
        case .running:
            Image(systemName: job.kind.systemImage)
                .foregroundStyle(accent)
        case .batchPending:
            Image(systemName: "clock.arrow.circlepath")
                .foregroundStyle(Brand.gold)
        case .cancelling:
            ProgressView()
                .controlSize(.small)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Brand.sage)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Brand.terracotta)
        case .cancelled:
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var actionButtons: some View {
        HStack(spacing: 6) {
            if job.phase == .batchPending {
                Button("Collect") {
                    model.openActivity(.ingest)
                }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
                .tint(Brand.gold)
            }

            if job.canCancel, job.isActive {
                Button("Cancel") {
                    model.cancelActivity(job.kind)
                }
                .controlSize(.small)
                .help(cancelHelp)
            }

            if job.canOpen, job.isActive || job.phase == .batchPending {
                Button(job.phase == .batchPending ? "Open" : "Show") {
                    model.openActivity(job.kind)
                }
                .controlSize(.small)
            }

            if job.isTerminal {
                if job.canOpen {
                    Button("Review") {
                        model.openActivity(job.kind)
                    }
                    .controlSize(.small)
                }
                Button {
                    model.dismissActivity(job.kind)
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption2.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Dismiss")
                .accessibilityLabel("Dismiss")
            }
        }
    }

    private var accent: Color {
        switch job.kind {
        case .ingest: return Brand.gold
        case .hygiene: return Brand.sage
        case .importFile: return Brand.gold
        case .migration: return Brand.sage
        }
    }

    private var backgroundTint: Color {
        switch job.phase {
        case .failed: return Brand.terracotta
        case .completed: return Brand.sage
        case .cancelled: return Color.secondary
        case .batchPending, .running, .cancelling: return accent
        }
    }

    private var cancelHelp: String {
        switch job.kind {
        case .ingest:
            return "Stop ingestion. Already-saved digests stay in your memory store; re-run later to continue with remaining sessions."
        case .hygiene:
            return "Stop analysis. Partial findings are kept so you can review what finished."
        case .importFile:
            return "Stop after the current batch. Already-imported memories stay."
        case .migration:
            return "This job cannot be cancelled mid-flight."
        }
    }

    private var accessibilitySummary: String {
        var parts = [job.title]
        if let detail = job.detail { parts.append(detail) }
        if !job.progressLabel.isEmpty { parts.append(job.progressLabel) }
        return parts.joined(separator: ", ")
    }
}
