import SwiftUI

/// The first visual check (spec §8): every token on one screen, to be laid
/// beside the web's `/dashboard` at the same zoom. Token values only — nothing
/// on this screen defines a colour, size or glow of its own beyond layout.
///
/// Reach it from Xcode's canvas (`#Preview` below) or, in a DEBUG build, by
/// launching the app with the argument `-tokenPreview`
/// (`xcrun simctl launch booted pro.vanderpoel.verder -tokenPreview`).
struct TokenPreview: View {
    /// The order globals.css declares them in.
    static let order = [
        "void", "rail", "glass-a", "glass-b", "edge", "edge-lit", "edge-strong",
        "hairline", "hairline-lit", "field", "scrim", "plate",
        "ink-bright", "ink", "ink-soft", "ink-mute", "ink-label", "ink-dim", "ink-faint",
        "signal", "signal-lit", "signal-link", "attn", "okay", "steel", "steel-dim", "on-signal",
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Text("verder")
                    .font(.display(34, relativeTo: .largeTitle, weight: .ultraLight))
                    .foregroundStyle(Color.inkBright)

                hero
                swatches
                typeScale
                buttons
            }
            .padding(16)
        }
        .background(Color.void.ignoresSafeArea())
    }

    /// The dashboard's hero, in miniature: the one lit panel, an amber label for
    /// the one thing that waits on Martin, the one primary button.
    private var hero: some View {
        VStack(alignment: .leading, spacing: 0) {
            label("wacht op jou", color: .attn)
            Text("Opstart en stukken")
                .font(.display(19, relativeTo: .title3, weight: .light))
                .foregroundStyle(Color.signal)
                .padding(.top, 14)
            Text("Stukken aanleveren")
                .font(.display(34, relativeTo: .largeTitle, weight: .ultraLight))
                .foregroundStyle(Color.inkBright)
                .padding(.top, 5)
            Text("Team Opstart wacht op je loonstroken en polissen.")
                .font(.display(14.5, relativeTo: .body, weight: .light))
                .foregroundStyle(Color.inkMute)
                .padding(.top, 14)
            HStack(spacing: 10) {
                Circle().fill(Color.attn).frame(width: 9, height: 9).glow(Glow.attn)
                chip("wacht op jou", color: .attn)
            }
            .padding(.top, 18)
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
    }

    private var swatches: some View {
        VStack(alignment: .leading, spacing: 10) {
            label("kleuren · \(Self.order.count)")
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 10)], spacing: 10) {
                ForEach(Self.order, id: \.self) { name in
                    VStack(alignment: .leading, spacing: 4) {
                        RoundedRectangle(cornerRadius: Radius.chip)
                            .fill(Tokens.color(name))
                            .frame(height: 34)
                            .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edge))
                        Text(name).font(.mono(10)).foregroundStyle(Color.inkSoft)
                        Text(Tokens.hex[name] ?? "").font(.mono(9)).foregroundStyle(Color.inkDim)
                    }
                }
            }
        }
        .padding(16)
        .glassPanel()
    }

    private var typeScale: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("display · Saira")
            Text("Stukken aanleveren").font(.display(34, relativeTo: .largeTitle, weight: .ultraLight))
            Text("Opstart en stukken").font(.display(19, relativeTo: .title3, weight: .light))
            Text("Ordinary text, 400").font(.display(15, relativeTo: .body))
            Text("Medium, 500").font(.display(15, relativeTo: .body, weight: .medium))
            label("mono · IBM Plex Mono").padding(.top, 10)
            Text("28-08-2026 · MAIL").font(.mono(10)).tracking(1.4).foregroundStyle(Color.inkDim)
            Text("Regular 400 · 0123456789").font(.mono(13))
            Text("Medium 500 · € 3.556,42").font(.mono(13, weight: .medium))
            Text("SemiBold 600 · NLTZ2612548IVB").font(.mono(13, weight: .semibold))
        }
        .foregroundStyle(Color.ink)
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
    }

    private var buttons: some View {
        VStack(alignment: .leading, spacing: 14) {
            label("knoppen")
            Text("Bekijk de kaart".uppercased())
                .font(.mono(11))
                .tracking(1.76)
                .foregroundStyle(Color.onSignal)
                .padding(.horizontal, 22).padding(.vertical, 13)
                .background(
                    LinearGradient(colors: [.signalLit, .signal], startPoint: .leading, endPoint: .trailing),
                    in: RoundedRectangle(cornerRadius: Radius.chip)
                )
                .glow(Glow.action)
            HStack(spacing: 10) {
                chip("signal", color: .signal)
                chip("okay", color: .okay)
                Circle().fill(Color.okay).frame(width: 9, height: 9).glow(Glow.okay)
                Circle().fill(Color.steel).frame(width: 9, height: 9)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
    }

    /// The web's `.lbl`. Tone is a parameter because an inner foregroundStyle
    /// wins over an outer one: `label(...).foregroundStyle(.attn)` stays grey.
    private func label(_ text: String, color: Color = .inkLabel) -> some View {
        Text(text.uppercased())
            .font(.display(9.5, relativeTo: .caption2))
            .tracking(2.09)
            .foregroundStyle(color)
    }

    /// The web's `Chip`: outline at ~40% of its tone, mono 9.5, tracked caps.
    private func chip(_ text: String, color: Color) -> some View {
        Text(text.uppercased())
            .font(.mono(9.5))
            .tracking(1.33)
            .foregroundStyle(color)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(color.opacity(0.4)))
    }
}

#Preview {
    TokenPreview()
        .preferredColorScheme(.dark)
}
