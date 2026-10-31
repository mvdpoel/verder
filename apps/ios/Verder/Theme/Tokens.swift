import SwiftUI

/// The Holodek palette, ported one-to-one from `apps/web/src/app/globals.css`
/// (`@theme`, every `--color-*` token). This file is the ONLY place in the app a
/// colour, radius or glow is defined: screens pick from it and invent nothing.
///
/// `TokensMatchWebTests` reads globals.css off disk and fails the moment the two
/// disagree, so a change on the web must land here in the same commit.
///
/// AMBER (`attn`) IS FOR WHAT IS WAITING ON MARTIN, AND NOTHING ELSE. Not
/// "important", not "error", not an accent.
enum Tokens {
    /// The raw values exactly as globals.css spells them (6- or 8-digit lower-case
    /// hex, `#RRGGBB` or `#RRGGBBAA`), keyed by the CSS name without `--color-`.
    static let hex: [String: String] = [
        // ── ground
        "void": "#04070d",          // the page itself
        "rail": "#060b1499",        // the rail, 60% over the field
        "glass-a": "#78b4e613",     // panel gradient, top (7.5%)
        "glass-b": "#78b4e605",     // panel gradient, bottom (1.8%)
        "edge": "#8cc3f01a",        // panel border (10%)
        "edge-lit": "#a0d7fa3d",    // a panel's top border (24%)
        "edge-strong": "#8cc3f033", // ghost button, input border (20%)
        "hairline": "#8cc3f012",    // separator between rows (7%)
        "hairline-lit": "#8cc3f017",// the grid behind a tile row (9%)
        "field": "#060b1480",       // input control
        "scrim": "#020408b8",       // scrim under a dialog
        "plate": "#0a0f18",         // the panel's gradient, flattened opaque
        // ── text
        "ink-bright": "#f0f7fc",    // headings
        "ink": "#dbe6f2",           // ordinary text
        "ink-soft": "#cfe0ee",      // rows, second plane
        "ink-mute": "#93a8bd",      // paragraphs, explanation
        "ink-label": "#6d8298",     // the small caps labels
        "ink-dim": "#63788e",       // mono micro, dates
        "ink-faint": "#4f6478",     // axis names, specifications
        // ── signal
        "signal": "#63d3ea",        // the system: links, action, index
        "signal-lit": "#7fdcf0",    // light end of the button gradient
        "signal-link": "#a9e9f6",   // hover / pressed
        "attn": "#e8a557",          // WAITING ON YOU — and nothing else
        "okay": "#7fd8c0",          // system healthy
        "steel": "#b6cfe4",         // it happened
        "steel-dim": "#8fb3cc",     // it happened, second plane
        "on-signal": "#041016",     // text ON a cyan field
    ]

    static let colors: [String: Color] = hex.mapValues { value in
        guard let c = rgba(value) else { preconditionFailure("bad token hex \(value)") }
        return Color(.sRGB, red: c.red, green: c.green, blue: c.blue, opacity: c.opacity)
    }

    /// `#RRGGBB` or `#RRGGBBAA` → sRGB components in 0…1. Anything else is nil.
    static func rgba(_ hex: String) -> (red: Double, green: Double, blue: Double, opacity: Double)? {
        guard hex.first == "#" else { return nil }
        let digits = hex.dropFirst()
        guard digits.count == 6 || digits.count == 8,
              digits.allSatisfy(\.isHexDigit),
              let value = UInt32(digits, radix: 16) else { return nil }
        let full = digits.count == 6 ? (value << 8) | 0xff : value
        func byte(_ shift: UInt32) -> Double { Double((full >> shift) & 0xff) / 255 }
        return (byte(24), byte(16), byte(8), byte(0))
    }

    static func color(_ name: String) -> Color {
        guard let c = colors[name] else { preconditionFailure("unknown token \(name)") }
        return c
    }
}

extension Color {
    // ground
    static let void = Tokens.color("void")
    static let rail = Tokens.color("rail")
    static let glassA = Tokens.color("glass-a")
    static let glassB = Tokens.color("glass-b")
    static let edge = Tokens.color("edge")
    static let edgeLit = Tokens.color("edge-lit")
    static let edgeStrong = Tokens.color("edge-strong")
    static let hairline = Tokens.color("hairline")
    static let hairlineLit = Tokens.color("hairline-lit")
    static let field = Tokens.color("field")
    static let scrim = Tokens.color("scrim")
    static let plate = Tokens.color("plate")
    // text
    static let inkBright = Tokens.color("ink-bright")
    static let ink = Tokens.color("ink")
    static let inkSoft = Tokens.color("ink-soft")
    static let inkMute = Tokens.color("ink-mute")
    static let inkLabel = Tokens.color("ink-label")
    static let inkDim = Tokens.color("ink-dim")
    static let inkFaint = Tokens.color("ink-faint")
    // signal
    static let signal = Tokens.color("signal")
    static let signalLit = Tokens.color("signal-lit")
    static let signalLink = Tokens.color("signal-link")
    /// WAITING ON MARTIN — and nothing else.
    static let attn = Tokens.color("attn")
    static let okay = Tokens.color("okay")
    static let steel = Tokens.color("steel")
    static let steelDim = Tokens.color("steel-dim")
    static let onSignal = Tokens.color("on-signal")
}

/// `--radius-chip` / `--radius-panel`, in points.
enum Radius {
    /// Button, chip, input.
    static let chip: CGFloat = 2
    /// Panel, card, dialog.
    static let panel: CGFloat = 3
}

/// The `--shadow-*` glows. GLOW IS A SIGNAL, NOT DECORATION — only on something
/// you can press or something asking for attention.
///
/// Colours are one-to-one (guarded by `glowColorsMatchWeb`). Geometry is an
/// approximation and cannot be otherwise: SwiftUI's `shadow` has no spread, and
/// its `radius` is roughly half a CSS blur radius. `action` (CSS blur 26px,
/// spread -4px) therefore uses a slightly smaller radius than half the blur to
/// stand in for the negative spread; `attn` (12px, +2px) a slightly larger one.
enum Glow {
    static let hex: [String: String] = [
        "action": "#63d3ea99",      // 0 0 26px -4px
        "attn": "#e8a55799",        // 0 0 12px 2px
        "okay": "#7fd8c0b3",        // 0 0 8px 1px
        "signal-dot": "#63d3eab3",  // 0 0 12px 2px
        "lift": "#000000e6",        // 0 30px 70px -30px
    ]

    struct Shadow: Sendable {
        let color: Color
        let radius: CGFloat
        let y: CGFloat
    }

    private static func shadow(_ name: String, radius: CGFloat, y: CGFloat = 0) -> Shadow {
        guard let c = hex[name].flatMap(Tokens.rgba) else { preconditionFailure("unknown glow \(name)") }
        return Shadow(color: Color(.sRGB, red: c.red, green: c.green, blue: c.blue, opacity: c.opacity),
                      radius: radius, y: y)
    }

    static let action = shadow("action", radius: 11)
    static let attn = shadow("attn", radius: 7)
    static let okay = shadow("okay", radius: 4.5)
    static let signalDot = shadow("signal-dot", radius: 7)
    static let lift = shadow("lift", radius: 20, y: 30)
}

extension View {
    func glow(_ s: Glow.Shadow) -> some View {
        shadow(color: s.color, radius: s.radius, x: 0, y: s.y)
    }
}

/// The web's `.panel`: a glass gradient at 168° (light from the upper left), a
/// 1px `edge` border whose TOP edge is lighter (`edge-lit`), radius `panel`.
/// That lighter top edge is what makes it read as glass instead of a box.
struct GlassPanel: ViewModifier {
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
        content
            .background(
                // CSS 168deg points down and slightly right; with y downwards its
                // unit vector is (sin 168°, -cos 168°) ≈ (0.208, 0.978).
                LinearGradient(
                    stops: [.init(color: .glassA, location: 0), .init(color: .glassB, location: 0.62)],
                    startPoint: UnitPoint(x: 0.396, y: 0.011),
                    endPoint: UnitPoint(x: 0.604, y: 0.989)
                ),
                in: shape
            )
            .overlay(shape.strokeBorder(Color.edge, lineWidth: 1))
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(Color.edgeLit)
                    .frame(height: 1)
                    .padding(.horizontal, Radius.panel)
            }
    }
}

extension View {
    func glassPanel() -> some View { modifier(GlassPanel()) }
}
