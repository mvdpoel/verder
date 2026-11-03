import SwiftUI

/// The pieces every Meer screen is drawn from (Figma "meer · final", shared
/// system): the column, the group label, the card, the row, the badge, the
/// button, the footnote and the offline strip. The words come from
/// `MoreMenu`, `AccountCopy`, `NotificationsCopy`, `WidgetGuide`,
/// `AboutInfo` and `DeveloperCopy`; nothing here decides what is said.
enum MoreType {
    static let title = Font.display(28, relativeTo: .title, weight: .regular)
    static let rowTitle = Font.display(17, relativeTo: .body, weight: .medium)
    static let body = Font.display(15, relativeTo: .subheadline, weight: .regular)
    static let button = Font.display(17, relativeTo: .body, weight: .medium)
    static let navTitle = Font.display(17, relativeTo: .headline, weight: .medium)
    static let label = Font.mono(13, relativeTo: .caption, weight: .regular)
    static let value = Font.mono(15, relativeTo: .subheadline)
    static let meta = Font.mono(13, relativeTo: .footnote)
    static let badge = Font.mono(12, relativeTo: .caption, weight: .medium)
    /// 20 / 15 and 24 / 17: the ramp's line heights as a multiple of the size.
    static let lineFactor: CGFloat = 20.0 / 15.0
    static let titleLineFactor: CGFloat = 24.0 / 17.0
}

enum MoreText {
    static func title(_ text: String) -> some View {
        Text(text)
            .font(MoreType.title)
            .foregroundStyle(Color.inkBright)
            .accessibilityAddTraits(.isHeader)
    }

    static func label(_ text: String) -> some View {
        Text(text.uppercased())
            .font(MoreType.label)
            .tracking(1)
            .foregroundStyle(Color.inkLabel)
            .padding(.leading, 16)
            // A group label is a signpost, not reading matter: at AX5 it
            // stays at the frames' 18 pt and leaves the line to the rows.
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            .accessibilityAddTraits(.isHeader)
    }

    static func body(_ text: String, color: Color = .inkMute) -> some View {
        Text(text)
            .font(MoreType.body)
            .foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// A footnote under a card: 16 in from the column, ink-mute.
    static func footnote(_ text: String) -> some View {
        body(text)
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Soft hyphens for the accessibility sizes. Copy that already carries
    /// its own ("Toegangs\u{00AD}sleutel") keeps exactly those: the
    /// dictionary would break a compound where Dutch readers would not.
    static func hyphenate(_ text: String) -> String {
        text.contains("\u{00AD}") ? text : HomeSummary.hyphenated(text)
    }

    /// "jij@thuis." / "example": an address may break after a dot or the @
    /// at AX5, never inside a word.
    static func breakableAddress(_ email: String) -> String {
        email.replacingOccurrences(of: ".", with: ".\u{200B}").replacingOccurrences(of: "@", with: "@\u{200B}")
    }

    static func readout(_ text: String) -> some View {
        Text(text)
            .font(MoreType.meta)
            .foregroundStyle(Color.inkMute)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Saira with its numbers in Plex Mono ("versie 1.0 · build 31",
    /// "leefgeld ··3210"): a figure reads as measured, the words around it
    /// as prose.
    static func mixed(_ text: String, color: Color = .inkMute) -> AttributedString {
        var out = AttributedString()
        var run = ""
        var runIsFigure = false
        let chars = Array(text)
        func isFigure(_ i: Int) -> Bool {
            let c = chars[i]
            if c.isNumber || c == "·" && i + 1 < chars.count && (chars[i + 1].isNumber || chars[i + 1] == "·") {
                return true
            }
            // "1.0", "37,60", "08:00": a separator BETWEEN two digits.
            if [".", ",", ":"].contains(c), i > 0, i + 1 < chars.count, chars[i - 1].isNumber, chars[i + 1].isNumber {
                return true
            }
            return false
        }
        func flush() {
            guard !run.isEmpty else { return }
            var piece = AttributedString(run)
            piece.font = runIsFigure ? Font.mono(13, relativeTo: .subheadline) : MoreType.body
            piece.foregroundColor = color
            out += piece
            run = ""
        }
        for i in chars.indices {
            let figure = isFigure(i)
            if figure != runIsFigure { flush(); runIsFigure = figure }
            run.append(chars[i])
        }
        flush()
        return out
    }
}

/// The Meer column: 16 gutters, 16 between cards, 24 under the last.
struct MoreColumn<Content: View>: View {
    var top: CGFloat = 8
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 16) { content }
            .padding(.horizontal, 16)
            .padding(.top, top)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
            .lineHeight(.multiple(factor: MoreType.lineFactor))
    }
}

/// A pushed Meer screen: the system bar with its back button, the title in
/// Saira, the column below.
struct MorePage<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollViewReader { proxy in
                ScrollView {
                    MoreColumn(top: 0) {
                        content
                        Color.clear.frame(height: 1).id(MorePageAnchor.end)
                    }
                }
                #if DEBUG
                .task { await MorePageAnchor.applyFixtureScroll(proxy) }
                #endif
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(title)
                    .font(MoreType.navTitle)
                    .foregroundStyle(Color.inkBright)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .accessibilityAddTraits(.isHeader)
            }
        }
        .preferredColorScheme(.dark)
    }
}

/// A group: its label 8 above its card.
struct MoreGroup<Content: View>: View {
    let label: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let label { MoreText.label(label) }
            content
        }
    }
}

/// The glass card rows sit in, with a hairline between rows (`MoreDivider`).
struct MoreCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassPanel()
    }
}

/// The hairline between two rows, from the text's edge to the card's.
struct MoreDivider: View {
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Rectangle().fill(Color.hairline).frame(height: 1)
            .padding(.leading, typeSize.isAccessibilitySize ? 16 : 48)
            .padding(.trailing, 16)
    }
}

/// What sits at a row's trailing edge after the value or accessory.
enum MoreChevron { case none, push, external }

/// One row: glyph · title over its lines · value or accessory · chevron.
/// At the accessibility sizes the glyph goes (it would take a third of the
/// line), the value moves under the title and the accessory under the lines.
struct MoreRowView<Value: View, Accessory: View>: View {
    var symbol: String?
    /// Nil: not known yet, a bar in its place.
    var title: String?
    var titleColor: Color = .inkBright
    var lines: [MoreMenu.Line] = []
    var chevron: MoreChevron = .none
    var dimmed = false
    @ViewBuilder var value: Value
    @ViewBuilder var accessory: Accessory

    @Environment(\.dynamicTypeSize) private var typeSize
    private var ax: Bool { typeSize.isAccessibilitySize }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            if let symbol, !ax {
                Image(systemName: symbol)
                    .font(.system(size: 18, weight: .regular))
                    .foregroundStyle(Color.inkMute)
                    .frame(width: 20)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: ax ? 4 : 2) {
                titleView
                if ax { value }
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in MoreLineView(line: line) }
                if ax { accessory }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !ax {
                value
                accessory
            }
            chevronView
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
        .opacity(dimmed ? 0.75 : 1)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var titleView: some View {
        if let title {
            Text(ax ? (title.contains("@") ? MoreText.breakableAddress(title) : MoreText.hyphenate(title)) : title)
                .font(MoreType.rowTitle)
                .foregroundStyle(titleColor)
                .lineHeight(.multiple(factor: MoreType.titleLineFactor))
                .fixedSize(horizontal: false, vertical: true)
        } else {
            MoreSkeleton(fraction: 0.7).padding(.vertical, 6)
        }
    }

    @ViewBuilder private var chevronView: some View {
        switch chevron {
        case .none: EmptyView()
        case .push:
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.inkMute)
                .accessibilityHidden(true)
        case .external:
            Image(systemName: "arrow.up.right")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(dimmed ? Color.inkMute : Color.signal)
                .accessibilityHidden(true)
        }
    }
}

extension MoreRowView where Value == EmptyView, Accessory == EmptyView {
    init(symbol: String?, title: String?, titleColor: Color = .inkBright, lines: [MoreMenu.Line] = [],
         chevron: MoreChevron = .none, dimmed: Bool = false) {
        self.init(symbol: symbol, title: title, titleColor: titleColor, lines: lines, chevron: chevron,
                  dimmed: dimmed, value: { EmptyView() }, accessory: { EmptyView() })
    }
}

extension MoreRowView where Value == EmptyView {
    init(symbol: String?, title: String?, titleColor: Color = .inkBright, lines: [MoreMenu.Line] = [],
         chevron: MoreChevron = .none, dimmed: Bool = false, @ViewBuilder accessory: () -> Accessory) {
        self.init(symbol: symbol, title: title, titleColor: titleColor, lines: lines, chevron: chevron,
                  dimmed: dimmed, value: { EmptyView() }, accessory: accessory)
    }
}

/// One line under a row's title.
struct MoreLineView: View {
    let line: MoreMenu.Line
    var color: Color = .inkMute

    @Environment(\.dynamicTypeSize) private var typeSize
    private var ax: Bool { typeSize.isAccessibilitySize }

    var body: some View {
        switch line {
        case .phrases(let phrases):
            PhraseLine(phrases: phrases, lead: nil, color: color, ax: ax)
        case .kind(let level, let phrases):
            // One running text, so the explanation continues on the level's
            // own line ("gewoon · een schuldeiser of" / "deurwaarder stuurde
            // je iets"); the dot is bound to the word before it, so a line
            // never starts with one.
            let rest = phrases.map { ax ? MoreText.hyphenate($0) : $0 }
            Text(MoreText.mixed(level, color: .inkSoft) + MoreText.mixed("\u{00A0}· " + rest.joined(separator: "\u{00A0}· "), color: color))
                .fixedSize(horizontal: false, vertical: true)
        case .mono(let text):
            Text(text)
                .font(MoreType.meta)
                .foregroundStyle(Color.inkMute)
                .fixedSize(horizontal: false, vertical: true)
        case .offline(let text):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "wifi.slash")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.inkMute)
                    .accessibilityHidden(true)
                Text(text)
                    .font(MoreType.meta)
                    .foregroundStyle(Color.inkMute)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .skeleton(let fraction):
            MoreSkeleton(fraction: fraction).padding(.vertical, 5)
        }
    }
}

/// Phrases joined by " · ", packed greedily: a phrase moves to the next
/// line WHOLE and the dot before it goes (Figma "Geld-rij varianten SE":
/// "leefgeld ··3210" / "deze week"); only a phrase wider than the line
/// wraps inside itself. `lead` colours the first phrase (a push's level).
private struct PhraseLine: View {
    let phrases: [String]
    let lead: Color?
    let color: Color
    let ax: Bool

    var body: some View {
        PhraseFlow {
            ForEach(Array(phrases.enumerated()), id: \.offset) { i, phrase in
                if i > 0 { Text(MoreText.mixed(" · ", color: color)).accessibilityHidden(true) }
                Text(MoreText.mixed(ax ? MoreText.hyphenate(phrase) : phrase,
                                    color: i == 0 ? (lead ?? color) : color))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The layout behind `PhraseLine`: subviews alternate phrase, separator,
/// phrase…; a separator that would end a line is placed out of sight.
struct PhraseFlow: Layout {
    private struct Placement {
        var origin: CGPoint
        var proposal: ProposedViewSize
        var hidden: Bool
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> (CGSize, [Placement]) {
        var out = [Placement](repeating: Placement(origin: .zero, proposal: .zero, hidden: true), count: subviews.count)
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, widest: CGFloat = 0
        var i = 0
        while i < subviews.count {
            let phrase = subviews[i]
            let ideal = phrase.sizeThatFits(.unspecified)
            let sep = i > 0 ? subviews[i - 1].sizeThatFits(.unspecified) : .zero
            if i > 0 && x + sep.width + ideal.width <= width + 0.5 {
                out[i - 1] = Placement(origin: CGPoint(x: x, y: y), proposal: .unspecified, hidden: false)
                x += sep.width
                out[i] = Placement(origin: CGPoint(x: x, y: y), proposal: .unspecified, hidden: false)
                x += ideal.width
                lineHeight = max(lineHeight, ideal.height, sep.height)
            } else {
                if i > 0 { y += lineHeight; x = 0; lineHeight = 0 }
                if ideal.width <= width + 0.5 {
                    out[i] = Placement(origin: CGPoint(x: 0, y: y), proposal: .unspecified, hidden: false)
                    x = ideal.width
                    lineHeight = ideal.height
                } else {
                    let p = ProposedViewSize(width: width, height: nil)
                    let wrapped = phrase.sizeThatFits(p)
                    out[i] = Placement(origin: CGPoint(x: 0, y: y), proposal: p, hidden: false)
                    // What follows starts on a line of its own.
                    x = width + 1
                    lineHeight = wrapped.height
                }
            }
            widest = max(widest, min(x, width))
            i += 2
        }
        return (CGSize(width: widest, height: y + lineHeight), out)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(proposal.width ?? .infinity, subviews).0
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let (_, placements) = arrange(bounds.width, subviews)
        for (view, p) in zip(subviews, placements) {
            if p.hidden {
                view.place(at: CGPoint(x: bounds.minX - 10_000, y: bounds.minY), proposal: .unspecified)
            } else {
                view.place(at: CGPoint(x: bounds.minX + p.origin.x, y: bounds.minY + p.origin.y), proposal: p.proposal)
            }
        }
    }
}

/// A line not known yet. Static (no shimmer) under Reduce Motion.
struct MoreSkeleton: View {
    let fraction: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        GeometryReader { geo in
            Capsule()
                .fill(Color.steelDim.opacity(dim ? 0.18 : 0.3))
                .frame(width: geo.size.width * fraction, height: 10)
        }
        .frame(height: 10)
        .accessibilityHidden(true)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { dim = true }
        }
    }
}

/// "● AAN", "● ALTIJD", "● BEREIKBAAR": a state, outlined; okay-green when
/// healthy, ink-mute otherwise. Never amber: nothing here waits on Martin.
struct MoreBadge: View {
    enum Tone { case okay, mute }
    let text: String
    var tone: Tone = .mute

    @Environment(\.dynamicTypeSize) private var typeSize

    private var color: Color { tone == .okay ? .okay : .inkMute }

    var body: some View {
        HStack(spacing: 6) {
            if !typeSize.isAccessibilitySize {
                Circle().fill(color).frame(width: 5, height: 5).accessibilityHidden(true)
            }
            Text(text.uppercased())
                .font(MoreType.badge)
                .tracking(1)
                .foregroundStyle(color)
                .lineLimit(1)
                .fixedSize()
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(color.opacity(0.8), lineWidth: 1))
    }
}

/// The Meer buttons (Figma Button 2:51): Saira 17, 48 tall, no glow.
struct MoreButton: View {
    enum Weight { case primary, secondary, plain }

    let title: String
    var weight: Weight = .secondary
    /// The label's colour on a secondary button: signal for an action that
    /// goes somewhere, ink-bright for one that ends something (Uitloggen).
    var tint: Color = .signal
    var enabled = true
    var busy = false
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy {
                    if reduceMotion {
                        Image(systemName: "arrow.up.circle").accessibilityHidden(true)
                    } else {
                        ProgressView().tint(foreground)
                    }
                }
                Text(title)
                    .font(MoreType.button)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(foreground)
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(background)
            .overlay {
                if weight == .secondary {
                    RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled || busy)
        .opacity(enabled ? 1 : 0.5)
    }

    private var foreground: Color {
        switch weight {
        case .primary: .onSignal
        case .secondary: tint
        case .plain: .inkBright
        }
    }

    @ViewBuilder private var background: some View {
        switch weight {
        case .primary:
            RoundedRectangle(cornerRadius: Radius.chip)
                .fill(LinearGradient(colors: [.signalLit, .signal], startPoint: .top, endPoint: .bottom))
        case .secondary:
            RoundedRectangle(cornerRadius: Radius.chip).fill(Color.field)
        case .plain:
            Color.clear
        }
    }
}

/// "offline · bijgewerkt 14:02", over the kept stand.
struct MoreOfflineStrip: View {
    let stamp: String
    var hint: String?

    var body: some View {
        MoreCard {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Image(systemName: "wifi.slash")
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(Color.inkMute)
                    .frame(width: 20)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(stamp)
                        .font(MoreType.meta)
                        .foregroundStyle(Color.inkMute)
                        .fixedSize(horizontal: false, vertical: true)
                    if let hint { MoreText.body(hint) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The trailing value of a row: "€ 37,60" over "over", or "aan".
struct MoreValue: View {
    let value: String?
    var caption: String?

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if let value {
            VStack(alignment: typeSize.isAccessibilitySize ? .leading : .trailing, spacing: 0) {
                Text(value)
                    .font(MoreType.value)
                    .foregroundStyle(Color.inkBright)
                    .fixedSize()
                if let caption {
                    Text(caption)
                        .font(MoreType.body)
                        .foregroundStyle(Color.inkMute)
                        .fixedSize()
                }
            }
        }
    }
}
