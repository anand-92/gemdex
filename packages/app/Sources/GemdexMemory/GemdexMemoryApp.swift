import SwiftUI
import AppKit

@main
struct GemdexMemoryApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()
    @StateObject private var updater = UpdaterController()
    @AppStorage(Appearance.storageKey) private var appearanceRaw = Appearance.system.rawValue

    private var appearance: Appearance {
        Appearance(rawValue: appearanceRaw) ?? .system
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environment(\.gemdexIsOLED, appearance.isOLED)
                .preferredColorSchemeIfAvailable(appearance.colorScheme)
                .frame(minWidth: 820, minHeight: 560)
                .onAppear { model.start() }
        }
        .defaultSize(width: 1080, height: 720)
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unified(showsTitle: false))
        .commands {
            CommandGroup(after: .newItem) {
                Button("New Memory") { model.openNew() }
                    .keyboardShortcut("n", modifiers: .command)
                    .disabled(model.screen != .ready)
            }
            CommandGroup(replacing: .appInfo) {
                Button("About Gemdex Memory") {
                    NSApp.orderFrontStandardAboutPanel(options: [
                        .applicationName: "Gemdex Memory",
                        .init(rawValue: "Copyright"): "A global, persistent memory layer for AI coding agents.",
                    ])
                }
            }
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") { updater.checkForUpdates() }
                    .disabled(!updater.canCheckForUpdates)
            }
            // Insert into the system View menu rather than adding a second
            // top-level "View" (a CommandMenu("View") collides and renders
            // two View menus).
            CommandGroup(after: .sidebar) {
                Menu("Appearance") {
                    Picker("Appearance", selection: $appearanceRaw) {
                        ForEach(Appearance.allCases) { option in
                            Text(option.label).tag(option.rawValue)
                        }
                    }
                    .pickerStyle(.inline)
                }
            }
            CommandGroup(after: .toolbar) {
                Button("Refresh") {
                    Task { await model.refreshList() }
                }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(model.screen != .ready)
                Button("Ingest Chat History…") { model.showIngest = true }
                    .keyboardShortcut("i", modifiers: [.command, .option])
                    .disabled(model.screen != .ready)
            }
        }

        Settings {
            StorageSettingsView()
                .environmentObject(model)
                .environment(\.gemdexIsOLED, appearance.isOLED)
                .preferredColorSchemeIfAvailable(appearance.colorScheme)
                .frame(width: 540, height: 560)
        }
    }
}

extension View {
    /// `.preferredColorScheme` takes a non-optional scheme, so `.system` can't
    /// be expressed directly. This helper leaves the view untouched when the
    /// appearance is `.system` (nil scheme), letting macOS drive.
    @ViewBuilder
    func preferredColorSchemeIfAvailable(_ scheme: ColorScheme?) -> some View {
        if let scheme {
            self.preferredColorScheme(scheme)
        } else {
            self
        }
    }
}

/// App-level AppKit hooks. The sidecar tears itself down on
/// `NSApplication.willTerminate` (see `SidecarManager`), so quitting the last
/// window quits the app and stops the child process.
final class AppDelegate: NSObject, NSApplicationDelegate {
    override init() {
        super.init()
        
        let center = NotificationCenter.default
        center.addObserver(
            forName: NSWindow.didBecomeKeyNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            if let window = notification.object as? NSWindow {
                self?.configureWindow(window)
            }
        }

        center.addObserver(
            forName: NSWindow.didUpdateNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            if let window = notification.object as? NSWindow {
                self?.configureWindow(window)
            }
        }

        center.addObserver(
            forName: UserDefaults.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.reconfigureAllWindows()
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        for window in NSApp.windows {
            configureWindow(window)
        }
    }

    private func configureWindow(_ window: NSWindow) {
        let windowClassName = String(describing: type(of: window))
        if windowClassName.hasPrefix("SU") || windowClassName.hasPrefix("SPU") || windowClassName.contains("Sparkle") {
            return
        }
        if let controller = window.windowController {
            let controllerClassName = String(describing: type(of: controller))
            if controllerClassName.hasPrefix("SU") || controllerClassName.hasPrefix("SPU") || controllerClassName.contains("Sparkle") {
                return
            }
        }

        guard window.styleMask.contains(.titled) else { return }
        guard !(window is NSPanel) else { return }

        if !window.styleMask.contains(.fullSizeContentView) || !window.titlebarAppearsTransparent || window.titlebarSeparatorStyle != .none {
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.styleMask.insert(.fullSizeContentView)
            window.titlebarSeparatorStyle = .none
            window.isMovableByWindowBackground = true
            window.hasShadow = true
        }
        applyWindowBackground(window)
    }

    /// OLED Pure Black needs a genuinely black, opaque window backing; the
    /// default vibrancy path uses a transparent window so the system material
    /// can show through. This is re-applied on launch and whenever the
    /// appearance defaults change (the menu flips `gemdex.appearance`).
    private func applyWindowBackground(_ window: NSWindow) {
        if Appearance.persisted.isOLED {
            window.backgroundColor = .black
            window.isOpaque = true
        } else {
            window.backgroundColor = .clear
            window.isOpaque = false
        }
    }

    func applicationDidChangeScreenParameters(_ notification: Notification) {
        reconfigureAllWindows()
    }

    private func reconfigureAllWindows() {
        for window in NSApp.windows {
            configureWindow(window)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}
