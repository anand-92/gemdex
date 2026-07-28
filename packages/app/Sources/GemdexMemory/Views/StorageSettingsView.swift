import SwiftUI

/// Storage settings: switch between the embedded local store and a named BYOI
/// Gemdex Server, add/update/remove remotes, test connectivity, and import
/// local memories to the active remote. Mirrors the web app's settings modal.
struct StorageSettingsView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    var isEmbedded: Bool = false

    @State private var selectedRemote: String = ""
    @State private var status: String = ""
    @State private var statusIsError = false
    @State private var error: String?

    // Add/update remote form.
    @State private var formName = ""
    @State private var formURL = ""
    @State private var formToken = ""
    @State private var saving = false

    private var settings: SettingsSummary? { model.settings }
    private var remotes: [RemoteSummary] { settings?.remotes ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    appearanceSection
                    geminiSection
                    modeChooser
                    remoteChooser
                    addRemoteForm
                    if let error {
                        Text(error).font(.callout).foregroundStyle(Brand.terracotta)
                    }
                }
                .padding(20)
            }
        }
        .frame(width: isEmbedded ? nil : 620)
        .frame(minHeight: isEmbedded ? 0 : 560)
        .frame(maxWidth: isEmbedded ? 640 : .infinity, maxHeight: isEmbedded ? .infinity : nil)
        .background(isEmbedded ? nil : BrandBackdrop())
        .task { await refresh() }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Label("Storage & Gemini", systemImage: "externaldrive.connected.to.line.below")
                    .font(.title3.bold())
                    .labelStyle(.titleAndIcon)
                Text("Choose where memories live and verify the Gemini key used for local embeddings and chat-history ingestion.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                if isEmbedded {
                    model.showSettings = false
                } else {
                    dismiss()
                }
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

    private var geminiSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Gemini API readiness").font(.headline)
            if let readiness = model.geminiReadiness, readiness.isReady {
                HStack(spacing: 10) {
                    Image(systemName: "checkmark.seal.fill")
                        .foregroundStyle(Brand.sage)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Gemini key verified").font(.callout.bold())
                        Text("Local embeddings and new-session ingestion are unlocked for this launch.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassSurface(cornerRadius: Metric.radiusCard, tint: Brand.sage)
            } else {
                GeminiReadinessAlert(readiness: model.geminiReadiness, compact: true)
                GeminiKeySetupPanel(primaryButtonTitle: "Validate Gemini key")
            }
        }
    }

    private var modeChooser: some View {
        HStack(spacing: 12) {
            ModeCard(title: "Local", subtitle: "Gemini + LanceDB on this machine",
                     active: settings?.mode == "local") {
                Task { await apply(mode: "local") }
            }
            ModeCard(title: "Remote", subtitle: "Connect through your BYOI Gemdex Server",
                     active: settings?.mode == "remote",
                     disabled: !canUseSelectedRemote) {
                Task { await apply(mode: "remote", name: selectedRemote) }
            }
        }
    }

    @ViewBuilder
    private var remoteChooser: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Configured remote").font(.headline)
            HStack {
                Picker("", selection: $selectedRemote) {
                    ForEach(remotes) { remote in
                        Text(remote.hasToken ? remote.name : "\(remote.name) (no token)").tag(remote.name)
                    }
                }
                .labelsHidden()
                .disabled(remotes.isEmpty)
                .onChange(of: selectedRemote) { _ in populateForm() }
            }

            HStack(spacing: 8) {
                Button("Use remote") { Task { await apply(mode: "remote", name: selectedRemote) } }
                    .disabled(!canUseSelectedRemote)
                Button("Test") { Task { await testRemote() } }
                    .disabled(!canUseSelectedRemote)
                Button("Import local") { Task { await importLocal() } }
                    .disabled(!canUseSelectedRemote || !(settings?.localConfigured ?? false))
                Button("Remove", role: .destructive) { Task { await removeRemote() } }
                    .disabled(remotes.isEmpty)
            }
            .controlSize(.small)

            if !status.isEmpty {
                Text(status)
                    .font(.callout)
                    .foregroundStyle(statusIsError ? Brand.terracotta : Brand.sage)
            }
        }
    }

    private var addRemoteForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Add or update a remote").font(.headline)
            TextField("Name (e.g. production)", text: $formName)
                .textFieldStyle(.roundedBorder)
            TextField("Server URL (https://memory.example.com)", text: $formURL)
                .textFieldStyle(.roundedBorder)
            SecureField("Bearer token (required for new remotes)", text: $formToken)
                .textFieldStyle(.roundedBorder)
            Button {
                Task { await saveRemote() }
            } label: {
                HStack { if saving { ProgressView().controlSize(.small) }; Text("Save remote") }
            }
            .brandPrimary()
            .disabled(saving || trimmedFormName.isEmpty || trimmedFormURL.isEmpty)
            Text("The token is sent once to the localhost sidecar and stored in ~/.gemdex/.env. It is never returned to this app.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var appearanceSection: some View {
        @AppStorage(Appearance.storageKey) var appearanceRaw = Appearance.system.rawValue
        return VStack(alignment: .leading, spacing: 10) {
            Text("Appearance").font(.headline)
            Picker("", selection: $appearanceRaw) {
                ForEach(Appearance.allCases) { option in
                    Text(option.label).tag(option.rawValue)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            Text("OLED Pure Black renders the window and sidebar as true black so unlit pixels stay fully off.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var canUseSelectedRemote: Bool {
        remotes.first { $0.name == selectedRemote }?.hasToken ?? false
    }

    private var trimmedFormName: String { formName.trimmingCharacters(in: .whitespaces) }
    private var trimmedFormURL: String { formURL.trimmingCharacters(in: .whitespaces) }

    // MARK: - Actions

    private func refresh() async {
        await model.refreshSettings()
        await model.refreshConfig()
        if selectedRemote.isEmpty {
            selectedRemote = model.config?.activeRemote?.name ?? remotes.first?.name ?? ""
        }
        populateForm()
        if settings?.mode == "remote" {
            let label = selectedRemote.isEmpty ? "remote storage" : selectedRemote
            status = "Using \(label)."
        } else {
            status = "Using the embedded local store."
        }
        statusIsError = false
    }

    private func populateForm() {
        guard let remote = remotes.first(where: { $0.name == selectedRemote }) else { return }
        formName = remote.name
        formURL = remote.url
        formToken = ""
    }

    private func apply(mode: String, name: String? = nil) async {
        error = nil
        do {
            try await model.applyMode(mode, name: name)
            await refresh()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func saveRemote() async {
        error = nil
        saving = true
        defer { saving = false }
        do {
            try await model.saveRemote(name: trimmedFormName,
                                       url: trimmedFormURL,
                                       token: formToken.isEmpty ? nil : formToken)
            formToken = ""
            await model.refreshSettings()
            selectedRemote = trimmedFormName
            status = "Saved \(selectedRemote)."
            statusIsError = false
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func testRemote() async {
        status = "Testing \(selectedRemote)…"
        statusIsError = false
        do {
            let result = try await model.testRemote(selectedRemote)
            if result.authenticated {
                status = "\(selectedRemote) is reachable and authenticated."
                statusIsError = false
            } else if result.reachable {
                status = "\(selectedRemote) is reachable but authentication failed. \(result.detail ?? "")"
                statusIsError = true
            } else {
                status = "\(selectedRemote) is unreachable. \(result.detail ?? "")"
                statusIsError = true
            }
        } catch {
            status = error.localizedDescription
            statusIsError = true
        }
    }

    private func importLocal() async {
        status = "Importing local memories to \(selectedRemote)…"
        statusIsError = false
        do {
            let result = try await model.importLocalToRemote(selectedRemote)
            status = "Imported \(result.created) new, updated \(result.updated), skipped \(result.skipped)."
            statusIsError = false
        } catch {
            status = error.localizedDescription
            statusIsError = true
        }
    }

    private func removeRemote() async {
        error = nil
        do {
            try await model.removeRemote(selectedRemote)
            await model.refreshSettings()
            selectedRemote = remotes.first?.name ?? ""
            populateForm()
            status = "Removed remote."
            statusIsError = false
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// A selectable backend-mode card.
struct ModeCard: View {
    let title: String
    let subtitle: String
    let active: Bool
    var disabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(title).font(.headline)
                    Spacer()
                    if active { Image(systemName: "checkmark.circle.fill").foregroundStyle(Brand.sage) }
                }
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(16)
            .frame(maxWidth: .infinity)
            .glassSurfaceInteractive(cornerRadius: Metric.radiusCard, tint: active ? Brand.gold : nil)
            .overlay(
                RoundedRectangle(cornerRadius: Metric.radiusCard, style: .continuous)
                    .strokeBorder(active ? Brand.gold : Color.clear, lineWidth: active ? 1.5 : 0)
            )
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.55 : 1)
    }
}
