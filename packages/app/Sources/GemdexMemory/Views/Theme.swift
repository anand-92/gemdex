import SwiftUI
import AppKit

/// User-selectable app appearance. `oledPureBlack` is a true-black (`#000000`)
/// dark theme tuned for OLED panels: the window backdrop and sidebar render as
/// solid black (no vibrancy material, no drifting brand blobs) so unlit pixels
/// stay fully off, while glass surfaces keep a faint lift via hairline strokes.
/// Persisted in `UserDefaults` under `gemdex.appearance`.
enum Appearance: String, CaseIterable, Identifiable {
    case system
    case light
    case dark
    case oledPureBlack

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        case .oledPureBlack: return "OLED Pure Black"
        }
    }

    /// The color scheme SwiftUI should render under this appearance. OLED is a
    /// dark theme, so it maps to `.dark`; the black-specific styling keys off
    /// `isOLED` instead of a new scheme.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark, .oledPureBlack: return .dark
        }
    }

    var isOLED: Bool { self == .oledPureBlack }

    /// Reads the persisted selection without a SwiftUI environment (used by the
    /// AppDelegate when configuring window chrome).
    static var persisted: Appearance {
        Appearance(rawValue: UserDefaults.standard.string(forKey: storageKey) ?? "") ?? .system
    }

    static let storageKey = "gemdex.appearance"
}

/// Environment flag so any view can branch on OLED being active (backdrop,
/// glass surfaces, sidebar background).
private struct GemdexOLEDKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var gemdexIsOLED: Bool {
        get { self[GemdexOLEDKey.self] }
        set { self[GemdexOLEDKey.self] = newValue }
    }
}

/// Gemdex brand palette + the shared Liquid Glass design system. Colors are
/// warm paper/terracotta to match the hand-drawn brand art; surfaces lean on
/// macOS 26 Liquid Glass (`.glassEffect`) where available and degrade to
/// vibrancy materials on macOS 13–15 so the app stays beautiful everywhere.
enum Brand {
    static let gold = Color(red: 0.83, green: 0.60, blue: 0.24)
    static let goldBright = Color(red: 0.94, green: 0.72, blue: 0.33)
    static let terracotta = Color(red: 0.82, green: 0.43, blue: 0.31)
    static let sage = Color(red: 0.46, green: 0.57, blue: 0.46)
    static let ink = Color(red: 0.18, green: 0.15, blue: 0.12)

    /// Warm accent gradient used on prominent controls and highlights.
    static let warmGradient = LinearGradient(
        colors: [goldBright, gold, terracotta],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    /// Load a bundled brand image (PNG) from Resources/brand by name.
    static func image(_ name: String) -> Image? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "png", subdirectory: "brand")
            ?? Bundle.main.url(forResource: name, withExtension: "png"),
              let nsImage = NSImage(contentsOf: url) else {
            return nil
        }
        return Image(nsImage: nsImage)
    }
}

/// Design tokens — an 8pt-grid spacing scale and the macOS corner-radius ladder.
enum Metric {
    static let radiusWindow: CGFloat = 16
    static let radiusPanel: CGFloat = 18
    static let radiusCard: CGFloat = 13
    static let radiusControl: CGFloat = 10
    static let radiusChip: CGFloat = 8
}

// MARK: - Liquid Glass helpers

extension View {
    /// A floating glass surface (cards, panels). Uses real Liquid Glass on
    /// macOS 26+, and a tasteful vibrancy + hairline fallback below that.
    ///
    /// The Liquid Glass APIs only exist in the macOS 26 SDK (Swift 6.2+
    /// toolchain), so the `#if compiler(>=6.2)` guard keeps older SDKs (e.g.
    /// CI's Swift 5.10 / macOS 14) compiling the fallback — `#available` alone
    /// is a runtime gate and can't hide a symbol that's missing at compile time.
    @ViewBuilder
    func glassSurface(cornerRadius: CGFloat = Metric.radiusCard, tint: Color? = nil) -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            if let tint {
                glassEffect(.regular.tint(tint.opacity(0.18)), in: .rect(cornerRadius: cornerRadius))
            } else {
                glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
            }
        } else {
            glassFallback(cornerRadius: cornerRadius, tint: tint)
        }
        #else
        glassFallback(cornerRadius: cornerRadius, tint: tint)
        #endif
    }

    /// Vibrancy + hairline-stroke fallback used on pre-macOS-26 SDKs/runtimes.
    /// The tint fill lives *inside* the background so it sits behind content
    /// (keeping text/icon contrast); only the hairline stroke overlays on top.
    /// On OLED the material is replaced with a near-black fill so cards sit on
    /// pure black without the grey cast vibrancy adds.
    func glassFallback(cornerRadius: CGFloat, tint: Color?) -> some View {
        modifier(GlassFallbackModifier(cornerRadius: cornerRadius, tint: tint))
    }

    /// An interactive glass surface that reacts to hover/press on macOS 26+.
    @ViewBuilder
    func glassSurfaceInteractive(cornerRadius: CGFloat = Metric.radiusCard, tint: Color? = nil) -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            if let tint {
                glassEffect(.regular.tint(tint.opacity(0.20)).interactive(), in: .rect(cornerRadius: cornerRadius))
            } else {
                glassEffect(.regular.interactive(), in: .rect(cornerRadius: cornerRadius))
            }
        } else {
            glassFallback(cornerRadius: cornerRadius, tint: tint)
        }
        #else
        glassFallback(cornerRadius: cornerRadius, tint: tint)
        #endif
    }

    /// macOS 26 progressive blur at scroll edges; no-op below.
    @ViewBuilder
    func softScrollEdges() -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            scrollEdgeEffectStyle(.soft, for: .all)
        } else {
            self
        }
        #else
        self
        #endif
    }
}

/// Implements `glassFallback` as a modifier so it can read `@Environment`
/// (View extension methods can't). OLED swaps the vibrancy material for a
/// near-black fill, keeping the same hairline stroke and tint overlay.
private struct GlassFallbackModifier: ViewModifier {
    @Environment(\.gemdexIsOLED) private var isOLED
    let cornerRadius: CGFloat
    let tint: Color?

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(isOLED ? AnyShapeStyle(Color.white.opacity(0.06)) : AnyShapeStyle(.ultraThinMaterial))
                    .overlay(
                        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                            .fill(tint?.opacity(0.10) ?? .clear)
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: [Color.white.opacity(isOLED ? 0.16 : 0.35), Color.white.opacity(0.05)],
                            startPoint: .top, endPoint: .bottom
                        ),
                        lineWidth: 0.75
                    )
            )
    }
}

/// A prominent, warm-gradient primary button with a Liquid Glass sheen.
struct BrandButtonStyle: ButtonStyle {
    var prominent = true

    func makeBody(configuration: Configuration) -> some View {
        let label = configuration.label
            .font(.body.weight(.semibold))
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .contentShape(RoundedRectangle(cornerRadius: Metric.radiusControl, style: .continuous))

        Group {
            if prominent {
                label
                    .foregroundStyle(.white)
                    .background(
                        RoundedRectangle(cornerRadius: Metric.radiusControl, style: .continuous)
                            .fill(Brand.warmGradient)
                            .overlay(
                                RoundedRectangle(cornerRadius: Metric.radiusControl, style: .continuous)
                                    .strokeBorder(Color.white.opacity(0.25), lineWidth: 0.75)
                            )
                            .shadow(color: Brand.gold.opacity(configuration.isPressed ? 0.10 : 0.30),
                                    radius: configuration.isPressed ? 3 : 9, y: configuration.isPressed ? 1 : 4)
                    )
            } else {
                label
                    .foregroundStyle(.primary)
                    .glassSurfaceInteractive(cornerRadius: Metric.radiusControl)
            }
        }
        .scaleEffect(configuration.isPressed ? 0.97 : 1)
        .opacity(configuration.isPressed ? 0.92 : 1)
        .animation(.spring(response: 0.28, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

extension View {
    func brandPrimary() -> some View { buttonStyle(BrandButtonStyle(prominent: true)) }
    func brandSecondary() -> some View { buttonStyle(BrandButtonStyle(prominent: false)) }
}

/// An ambient, slowly-drifting brand-tinted backdrop that sits behind the
/// window's vibrancy. Gives the Liquid Glass surfaces something warm and alive
/// to refract. Respects Reduce Motion (drift disabled) and stays subtle so
/// content keeps its contrast.
///
/// In OLED Pure Black mode the whole thing collapses to a flat `Color.black`:
/// no window material, no drifting blobs. Unlit pixels stay fully off, which
/// is the entire point of the mode.
struct BrandBackdrop: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.gemdexIsOLED) private var isOLED
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drift = false

    var body: some View {
        if isOLED {
            Color.black.ignoresSafeArea()
        } else {
            ambientBackdrop
        }
    }

    private var ambientBackdrop: some View {
        ZStack {
            VisualEffectBackground(material: .underWindowBackground).ignoresSafeArea()

            GeometryReader { geo in
                let w = geo.size.width
                let h = geo.size.height
                // Each blob is blurred + rasterized once (`blobLayer`), and the
                // drifting `.offset` is applied OUTSIDE the rasterized layer —
                // so the 18s drift animates as a cheap layer transform instead
                // of re-blurring a window-sized layer every frame.
                ZStack {
                    blobLayer(Brand.gold, opacity: scheme == .dark ? 0.30 : 0.22, diameter: w * 0.9)
                        .offset(x: drift ? -w * 0.22 : -w * 0.30,
                                y: drift ? -h * 0.28 : -h * 0.20)
                    blobLayer(Brand.terracotta, opacity: scheme == .dark ? 0.26 : 0.18, diameter: w * 0.8)
                        .offset(x: drift ? w * 0.32 : w * 0.24,
                                y: drift ? h * 0.10 : h * 0.22)
                    blobLayer(Brand.sage, opacity: scheme == .dark ? 0.22 : 0.14, diameter: w * 0.7)
                        .offset(x: drift ? w * 0.05 : -w * 0.02,
                                y: drift ? h * 0.40 : h * 0.34)
                }
                // A ZStack sizes to its largest child, so without this it
                // collapses to a top-leading square. Fill the reader so the
                // blobs stay centered and the backdrop covers the window.
                .frame(width: w, height: h)
            }
            .ignoresSafeArea()
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 18).repeatForever(autoreverses: true)) {
                drift = true
            }
        }
    }

    /// One blurred blob, rasterized into its own (padded) layer. Padding gives
    /// the 80pt blur room to feather out instead of clipping at a hard edge.
    private func blobLayer(_ color: Color, opacity: Double, diameter: CGFloat) -> some View {
        Circle()
            .fill(
                RadialGradient(
                    colors: [color.opacity(opacity), color.opacity(0)],
                    center: .center, startRadius: 0, endRadius: max(diameter / 2, 1)
                )
            )
            .frame(width: diameter, height: diameter)
            .padding(160)
            .blur(radius: 80)
            .drawingGroup()
    }
}

/// AppKit visual-effect material, respecting Reduce Transparency.
struct VisualEffectBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .sidebar
    var blending: NSVisualEffectView.BlendingMode = .behindWindow

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = blending
        view.state = .followsWindowActiveState
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
        nsView.material = material
        nsView.blendingMode = blending
    }
}
