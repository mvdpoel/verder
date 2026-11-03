import SwiftUI

/// The three button weights of the sign-in, lock and pre-prompt screens
/// (Figma "auth · final", Button 2:51): `primary` is the one thing to do
/// (Saira Medium 17 on the signal gradient, with the action glow — glow only
/// on what is pressable), `secondary` the outlined alternative beside it
/// ("Bekijk alleen het overzicht"), `ghost` a link in signal ("Inloggen met
/// wachtwoord", "Sla over"). Never amber: nothing here is waiting on Martin in
/// the dossier. Labels wrap rather than clip at the accessibility sizes.
struct AuthButton: View {
    enum Weight { case primary, secondary, ghost }

    let title: String
    var weight: Weight = .primary
    var enabled = true
    /// Underway ("Wacht op Face ID…"): drawn at full strength, not pressable.
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(AuthType.button)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(foreground)
                .padding(.horizontal, weight == .ghost ? 0 : 12)
                .padding(.vertical, weight == .ghost ? 8 : 10)
                .frame(maxWidth: .infinity, minHeight: weight == .ghost ? 44 : 48)
                .background(background)
                .overlay {
                    if weight == .secondary {
                        RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .allowsHitTesting(!busy)
        // A disabled primary keeps a legible label on a muted plate (frame
        // "Te veel pogingen"); the others fade as a whole.
        .opacity(enabled || weight == .primary ? 1 : 0.5)
        .accessibilityAddTraits(busy ? .updatesFrequently : [])
    }

    private var foreground: Color {
        switch weight {
        case .primary: .onSignal
        case .secondary: .inkBright
        case .ghost: .signalLink
        }
    }

    @ViewBuilder private var background: some View {
        switch weight {
        case .primary:
            RoundedRectangle(cornerRadius: Radius.chip)
                .fill(LinearGradient(colors: [.signalLit, .signal], startPoint: .top, endPoint: .bottom))
                .opacity(enabled ? 1 : 0.42)
        case .secondary:
            RoundedRectangle(cornerRadius: Radius.chip).fill(Color.field)
        case .ghost:
            Color.clear
        }
    }
}

/// The type ramp of these screens (spec "Tokens and sizes").
enum AuthType {
    /// The frames set Saira on ~1.33 of its size (20 on 15); Saira's own
    /// metrics run ~1.57.
    static let lineFactor: CGFloat = 1.33
    /// display/title, Saira 28.
    static let title = Font.display(28, relativeTo: .title)
    /// display/headline, Saira Medium 17 (buttons, notice titles).
    static let button = Font.display(17, relativeTo: .body, weight: .medium)
    static let headline = Font.display(17, relativeTo: .headline, weight: .medium)
    /// display/callout 15: bodies, cause lines, captions and footers.
    static let callout = Font.display(15, relativeTo: .callout)
    /// mono/label 12, uppercase.
    static let label = Font.mono(12, relativeTo: .caption)
    static let labelTracking: CGFloat = 1.2
}

/// A screen or sheet title: Saira 28, SemiBold at the accessibility sizes
/// (spec: "AX5 58 SemiBold"), where a light face loses its strokes.
struct AuthTitle: View {
    let text: String
    @Environment(\.dynamicTypeSize) private var typeSize

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.display(28, relativeTo: .title, weight: typeSize.isAccessibilitySize ? .semibold : .regular))
            .foregroundStyle(Color.inkBright)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }
}

extension View {
    /// The largest text these screens set. Martin's rule is that no word breaks
    /// in the middle, and at AX4/AX5 "toegangssleutel", "vergrendelscherm" and
    /// "bewindvoerder" are each wider than the line, so SwiftUI would split
    /// them; AX3 is the largest size at which every word of these screens
    /// fits whole (the final frames shrank the same strings to fit).
    func authTypeCap() -> some View { dynamicTypeSize(...DynamicTypeSize.accessibility3) }
}

/// The "VERDER" word above a screen title.
struct AuthEyebrow: View {
    var text = "VERDER"
    var body: some View {
        Text(text)
            .font(.display(12, relativeTo: .caption, weight: .medium))
            .tracking(1.8)
            .foregroundStyle(Color.inkSoft)
            .accessibilityHidden(true)
    }
}

/// The verder mark (the rail's): a ring, its axis and the curve.
struct VerderGlyph: View {
    var lineWidth: CGFloat = 1.6

    var body: some View {
        Canvas { ctx, size in
            let s = size.width / 26
            func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * s, y: y * s) }
            ctx.stroke(Path(ellipseIn: CGRect(x: 1 * s, y: 1 * s, width: 24 * s, height: 24 * s)),
                       with: .color(.signal), lineWidth: lineWidth)
            var axis = Path(); axis.move(to: p(13, 2)); axis.addLine(to: p(13, 24))
            ctx.stroke(axis, with: .color(.signal.opacity(0.5)), lineWidth: lineWidth * 0.7)
            var curve = Path(); curve.move(to: p(4.6, 8.6))
            curve.addCurve(to: p(21.4, 8.6), control1: p(9.5, 14), control2: p(16.5, 14))
            ctx.stroke(curve, with: .color(.signal), lineWidth: lineWidth)
        }
        .accessibilityHidden(true)
    }
}

/// The mark in its two rings, the centre of the sign-in screens and of the
/// app-switcher cover. `confirmed` adds the okay check of "Je toegangssleutel
/// werkt al" (a fact, so okay-green, never amber).
struct VerderRings: View {
    var size: CGFloat = 128
    var confirmed = false

    var body: some View {
        ZStack {
            Circle().strokeBorder(Color.edge, lineWidth: 1)
            Circle()
                .strokeBorder(confirmed ? Color.okay.opacity(0.45) : Color.signal.opacity(0.45), lineWidth: 1)
                .padding(size * 0.11)
            Circle()
                .fill(RadialGradient(colors: [Color.signal.opacity(0.16), .clear], center: .center,
                                     startRadius: 0, endRadius: size * 0.3))
                .padding(size * 0.2)
            VerderGlyph(lineWidth: 1.8)
                .frame(width: size * 0.36, height: size * 0.36)
                .glow(Glow.signalDot)
        }
        .frame(width: size, height: size)
        .overlay(alignment: .bottomTrailing) {
            if confirmed {
                Image(systemName: "checkmark")
                    .font(.system(size: size * 0.11, weight: .bold))
                    .foregroundStyle(Color.void)
                    .frame(width: size * 0.25, height: size * 0.25)
                    .background(Circle().fill(Color.okay))
                    .offset(x: -size * 0.03, y: -size * 0.06)
            }
        }
        .accessibilityHidden(true)
    }
}

/// The Face ID tile the sign-in screen shows while it waits on the sheet
/// ("Sign-in / Toegangssleutel bezig").
struct FaceIDTile: View {
    var size: CGFloat = 156

    var body: some View {
        Image(systemName: "faceid")
            .font(.system(size: size * 0.36, weight: .ultraLight))
            .foregroundStyle(Color.inkBright)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: size * 0.2, style: .continuous).fill(Color.plate))
            .accessibilityHidden(true)
    }
}

/// One notice at the top of a sign-in screen: the kind and time, the cause in
/// one line, what to do next (FEATURES 3.10). VoiceOver reads it as one
/// element, in that order.
struct AuthNoticeCard: View {
    let label: String
    let title: String
    let text: String
    var detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(AuthType.label)
                .tracking(AuthType.labelTracking)
                .foregroundStyle(Color.inkLabel)
                .padding(.bottom, 8)
            Text(title)
                .font(AuthType.headline)
                .foregroundStyle(Color.inkBright)
            Text(text)
                .font(AuthType.callout)
                .foregroundStyle(Color.inkSoft)
            if let detail {
                Text(detail)
                    .font(.mono(11, relativeTo: .caption2))
                    .foregroundStyle(Color.inkMute)
                    .padding(.top, 4)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .glassPanel()
        .accessibilityElement(children: .combine)
    }
}

/// A caption under a button (ink-mute callout, centred).
struct AuthCaption: View {
    let text: String
    var emphasised = false

    init(_ text: String, emphasised: Bool = false) {
        self.text = text
        self.emphasised = emphasised
    }

    var body: some View {
        Text(text)
            .font(AuthType.callout)
            .foregroundStyle(emphasised ? Color.ink : Color.inkMute)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity)
    }
}
