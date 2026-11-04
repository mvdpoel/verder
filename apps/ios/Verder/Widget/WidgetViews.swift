import SwiftUI
import WidgetKit

/// The widget's faces, one per family (Figma "widgets · final", 347:16197).
/// THIN BY DESIGN: every decision — what shows, what is sensitive, when it is
/// amber, where a tap goes — is `WidgetContent`'s; these only paint it with the
/// Holodek tokens.
///
/// Compiled into the app as well as the widget, so the unit tests can render
/// the faces (and the DEBUG widget host can draw them for the captures).
struct WidgetFamilyView: View {
    let content: WidgetContent
    let family: WidgetFamily
    /// StandBy draws the small widget with no container background, scaled up
    /// (`showsWidgetContainerBackground == false`): its own composition.
    var standBy = false

    var body: some View {
        face.multilineTextAlignment(family == .accessoryCircular ? .center : .leading)
    }

    @ViewBuilder private var face: some View {
        switch family {
        case .accessoryCircular: WidgetCircular(content: content)
        case .accessoryRectangular: WidgetRectangular(content: content)
        case .accessoryInline: WidgetInline(content: content)
        case .systemMedium: WidgetMedium(content: content)
        case .systemLarge, .systemExtraLarge: WidgetLarge(content: content)
        default:
            if standBy { WidgetStandBy(content: content) } else { WidgetSmall(content: content) }
        }
    }
}

/// The widget's background: the plate with its one hairline, which WidgetKit
/// clips to the widget's own corner (`ContainerRelativeShape`).
struct WidgetPlate: View {
    var body: some View {
        Color.plate.overlay(ContainerRelativeShape().strokeBorder(Color.edge, lineWidth: 1))
    }
}

// MARK: - Type

/// The ramp from the frames. At the accessibility sizes the faces switch to
/// their own AX composition and FIXED sizes (64 / 22 / 17), because the
/// relative sizes would otherwise scale a second time on top of it.
private struct Ramp {
    let ax: Bool

    func display(_ size: CGFloat, _ weight: Font.Weight = .regular, _ style: Font.TextStyle = .body) -> Font {
        ax ? .custom(FontFamily.display, fixedSize: size).weight(weight) : .display(size, relativeTo: style, weight: weight)
    }

    func mono(_ size: CGFloat, _ style: Font.TextStyle = .caption) -> Font {
        ax ? .custom(FontFamily.mono, fixedSize: size) : .mono(size, relativeTo: style)
    }
}

/// The frames' Saira line heights (15/20, 17/22, 22/28, 48/52, 64/72):
/// Saira's own leading is far looser, and the large face's five rows only fit
/// at the drawn ones.
extension View {
    func sairaLine(_ size: CGFloat) -> some View {
        let height: CGFloat = switch size {
        case ...12: size + 4
        case ...17: size + 5
        case ...24: size + 6
        case ...40: size + 4
        case ...48: size + 4
        default: size + 6
        }
        return lineHeight(.multiple(factor: height / size))
    }
}

// MARK: - Pieces

/// The hero count: Saira Regular, amber only in full colour while something
/// waits; in tinted, clear and lock-screen rendering it joins the accent group.
private struct CountText: View {
    let content: WidgetContent
    let size: CGFloat
    var ax = false
    @Environment(\.widgetRenderingMode) private var mode

    var body: some View {
        if let count = content.countText {
            Text(count)
                .font(Ramp(ax: ax).display(size, .regular, .largeTitle))
                .sairaLine(size)
                .foregroundStyle(content.countIsAmber(in: mode) ? Color.attn : Color.inkBright)
                .contentTransition(.numericText())
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .widgetAccentable()
        }
    }
}

/// "• wachten op jou": the dot is amber with the count and never alone — the
/// words beside it say who it waits on.
private struct WaitLine: View {
    let content: WidgetContent
    var size: CGFloat = 15
    var ax = false
    @Environment(\.widgetRenderingMode) private var mode

    var body: some View {
        HStack(spacing: 4) {
            if content.showsDot {
                Circle()
                    .fill(content.countIsAmber(in: mode) ? Color.attn : Color.inkBright)
                    .frame(width: 8, height: 8)
                    .widgetAccentable()
                    .accessibilityHidden(true)
            }
            Text(content.words)
                .font(Ramp(ax: ax).display(size, .semibold, .subheadline))
                .sairaLine(size)
                .foregroundStyle(Color.inkBright)
                .lineLimit(1)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The mono line: ages, "en nog N", "bijgewerkt 08:12".
private struct Readout: View {
    let text: String
    var size: CGFloat = 12
    var ax = false
    var lines = 2
    var color = Color.inkLabel

    var body: some View {
        Text(text)
            .font(Ramp(ax: ax).mono(size))
            .foregroundStyle(color)
            .lineLimit(lines)
            // A one-line readout may tighten a little before it would wrap
            // (the SE's "bijgewerkt 31 okt" in 116 pt); it is never cut.
            .minimumScaleFactor(lines == 1 ? 0.8 : 1)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// The tray (or person) and "VOOR JOU"; on a locked phone (the Today View,
/// StandBy) a lock joins it, so the bars below read as hidden, not missing.
private struct Eyebrow: View {
    let content: WidgetContent
    var showsWord = true
    var size: CGFloat = 12
    var ax = false
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        let ax = ax || content.layout == .accessibility
        HStack(spacing: 6) {
            Image(systemName: content.glyph == .person ? "person" : "tray")
                .font(.system(size: size))
            if redaction.contains(.privacy) {
                Image(systemName: "lock").font(.system(size: size - 1))
            }
            if showsWord {
                Text(content.eyebrow)
                    .font(Ramp(ax: ax).mono(size))
                    .textCase(.uppercase)
                    .tracking(1)
                    .lineLimit(1)
            }
        }
        .foregroundStyle(Color.inkLabel)
        .accessibilityHidden(true)
    }
}

/// The check, the refresh arrow or the person, in place of a count.
private struct StateGlyph: View {
    let glyph: WidgetContent.Glyph
    var size: CGFloat = 20

    var body: some View {
        Image(systemName: glyph.rawValue)
            .font(.system(size: size, weight: .light))
            .foregroundStyle(glyph == .check ? Color.okay : Color.inkLabel)
            .widgetAccentable()
            .accessibilityHidden(true)
    }
}

/// A title in Saira SemiBold, wrapping to two lines at most — the brief's one
/// allowed truncation, and only for prose.
private struct RowTitle: View {
    let text: String
    var size: CGFloat = 15
    var ax = false

    var body: some View {
        Text(text)
            .font(Ramp(ax: ax).display(size, .semibold, .subheadline))
            .sairaLine(size)
            .foregroundStyle(Color.inkBright)
            .lineLimit(2)
            .truncationMode(.tail)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// One item: its title and its meta, both case content (the date says what
/// arrived when), redacted together on a locked phone; links to that item.
private struct ItemRow: View {
    let line: WidgetContent.Line
    var titleSize: CGFloat = 15
    var ax = false
    var showsMeta = true

    var body: some View {
        Link(destination: line.url) {
            VStack(alignment: .leading, spacing: 2) {
                RowTitle(text: line.text, size: titleSize, ax: ax)
                if showsMeta, let meta = line.meta {
                    Text(meta)
                        .font(.mono(12, relativeTo: .caption))
                        .foregroundStyle(Color.inkLabel)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .privacySensitive(line.sensitive)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(line.spoken)
        .accessibilityAddTraits(.isLink)
    }
}

private struct WidgetRule: View {
    var body: some View {
        Rectangle().fill(Color.edge).frame(height: 1).accessibilityHidden(true)
    }
}

/// The statement block of every face with nothing to count: the glyph, "Niets
/// wacht op je" / "Open verder om bij te werken" / "Log in bij verder", the
/// explanation and the mono line.
private struct StatementBlock: View {
    let content: WidgetContent
    var glyphSize: CGFloat = 20
    var size: CGFloat = 17
    var lines = 3
    /// Small and medium leave the person out when signed out: the eyebrow
    /// already carries it. The SE's small leaves every glyph out: its 116 pt
    /// box needs the room for a three-line statement.
    var showsGlyph = true

    var body: some View {
        // Fixed sizes at AX: these states have no AX composition of their own,
        // and the box does not grow.
        let ramp = Ramp(ax: content.layout == .accessibility)
        VStack(alignment: .leading, spacing: 0) {
            if showsGlyph {
                StateGlyph(glyph: content.glyph, size: glyphSize)
                    .padding(.bottom, glyphSize < 16 ? 4 : 8)
            }
            Text(content.words)
                .font(ramp.display(size, .semibold, .headline))
                .sairaLine(size)
                .foregroundStyle(Color.inkBright)
                .lineLimit(lines)
                .fixedSize(horizontal: false, vertical: true)
            if let body = content.body {
                Text(body)
                    .font(ramp.display(15, .regular, .subheadline))
                    .sairaLine(15)
                    .foregroundStyle(Color.inkSoft)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 4)
            }
            if let readout = content.readout {
                Readout(text: readout, ax: content.layout == .accessibility, lines: 1).padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Home screen

/// Small: "VOOR JOU", the count, "• wachten op jou" and the age, the block at
/// the bottom. The SE (compact) takes a 40 pt count and no dot; AX takes the
/// tray alone, a 64 pt count and "• voor jou".
private struct WidgetSmall: View {
    let content: WidgetContent

    var body: some View {
        let ax = content.layout == .accessibility
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow(content: content, showsWord: !(ax && content.state == .waiting))
            Spacer(minLength: 8)
            if content.state == .waiting {
                VStack(alignment: .leading, spacing: 4) {
                    CountText(content: content, size: ax ? 64 : content.layout == .compact ? 40 : 48, ax: ax)
                    WaitLine(content: content, size: ax ? 22 : 15, ax: ax)
                    if let readout = content.readout { Readout(text: readout, ax: ax, lines: 1) }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(content.spokenSummary(showing: 0))
            } else {
                StatementBlock(content: content,
                               showsGlyph: content.state != .signedOut && content.layout != .compact)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

/// Medium: the 124 pt count column and the top two items (the SE and AX: one).
/// With nothing to count, the statement takes the whole width.
private struct WidgetMedium: View {
    let content: WidgetContent
    static let countColumn: CGFloat = 124

    var body: some View {
        if content.state != .waiting {
            VStack(alignment: .leading, spacing: 0) {
                Eyebrow(content: content)
                Spacer(minLength: 4)
                StatementBlock(content: content, glyphSize: 13, lines: 2,
                               showsGlyph: content.state != .signedOut && content.layout == .standard)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        } else if content.layout == .accessibility {
            accessibilityFace
        } else {
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    if content.layout == .standard { Eyebrow(content: content, showsWord: false) }
                    Spacer(minLength: 0)
                    CountText(content: content, size: 48)
                    WaitLine(content: content)
                    if let readout = content.readout { Readout(text: readout, lines: 1) }
                }
                .frame(width: Self.countColumn, alignment: .leading)
                .frame(maxHeight: .infinity, alignment: .bottom)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(content.spokenSummary(showing: content.rows.count))
                VStack(spacing: 0) {
                    ForEach(Array(content.rows.enumerated()), id: \.offset) { i, line in
                        if i > 0 { WidgetRule() }
                        ItemRow(line: line)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: content.rows.count < 2 ? 68 : .infinity, alignment: .leading)
                .frame(maxHeight: .infinity, alignment: .bottom)
            }
        }
    }

    /// AX5: the count and "• voor jou" / "en nog 3" on top, one title in two
    /// 22 pt lines across the full width below.
    private var accessibilityFace: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 8) {
                CountText(content: content, size: 64, ax: true)
                VStack(alignment: .leading, spacing: 2) {
                    WaitLine(content: content, size: 22, ax: true)
                    if let readout = content.readout { Readout(text: readout, size: 17, ax: true, lines: 1) }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(content.spokenSummary(showing: content.rows.count))
            Spacer(minLength: 4)
            ForEach(Array(content.rows.enumerated()), id: \.offset) { _, line in
                ItemRow(line: line, titleSize: 22, ax: true, showsMeta: false)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// Large: the count with "• wachten op jou" and "en nog 493 · oudste 6 wk",
/// up to five rows, and "waar het nu op wacht" as a FIXED footer. The rows
/// are a `ViewThatFits` over 5 → 1, so a title that needs its second line
/// (a larger Dynamic Type size) costs a row — never the footer — and "en nog"
/// counts exactly what is hidden.
private struct WidgetLarge: View {
    let content: WidgetContent

    var body: some View {
        if content.state != .waiting {
            calmFace
        } else if content.layout == .accessibility {
            LargeFace(content: content, shown: min(content.rows.count, 2), ax: true)
        } else {
            ViewThatFits(in: .vertical) {
                ForEach((1...max(content.rows.count, 1)).reversed(), id: \.self) { n in
                    LargeFace(content: content, shown: min(n, content.rows.count), ax: false)
                }
            }
        }
    }

    /// Leeg, verouderd, afgemeld: the header, the statement centred in the
    /// body, and the footer still answering.
    private var calmFace: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Eyebrow(content: content)
                Spacer(minLength: 8)
                if let updated = content.updatedText { Readout(text: updated, lines: 1) }
            }
            Spacer(minLength: 8)
            StatementBlock(content: content, glyphSize: 30, size: 22)
            Spacer(minLength: 8)
            if let footer = content.footer { LargeFooter(footer: footer) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// One candidate of the large face, showing `shown` rows.
struct LargeFace: View {
    let content: WidgetContent
    let shown: Int
    let ax: Bool
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 12) {
                CountText(content: content, size: ax ? 64 : 48, ax: ax)
                VStack(alignment: .leading, spacing: 4) {
                    if redaction.contains(.privacy) {
                        // Locked: the eyebrow names the widget; the readout,
                        // which counts the hidden rows, stays away.
                        Eyebrow(content: content)
                        WaitLine(content: content, size: ax ? 22 : 15, ax: ax)
                    } else {
                        WaitLine(content: content, size: ax ? 22 : 15, ax: ax)
                        if let readout = content.largeReadout(showing: shown) {
                            Readout(text: readout, size: ax ? 17 : 12, ax: ax, lines: 1)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(content.spokenSummary(showing: shown))
            VStack(spacing: 0) {
                ForEach(Array(content.rows.prefix(shown).enumerated()), id: \.offset) { i, line in
                    if i > 0 { WidgetRule() }
                    ItemRow(line: line, titleSize: ax ? 22 : 15, ax: ax, showsMeta: !ax)
                        .frame(minHeight: ax ? 0 : 44)
                }
            }
            .frame(maxHeight: .infinity, alignment: .top)
            if let footer = content.footer { LargeFooter(footer: footer, ax: ax) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// "WAAR HET NU OP WACHT" and the stop — a link to the map at that stop.
private struct LargeFooter: View {
    let footer: WidgetContent.Footer
    var ax = false

    var body: some View {
        Link(destination: footer.url) {
            VStack(alignment: .leading, spacing: 4) {
                WidgetRule()
                Text(footer.label)
                    .font(Ramp(ax: ax).mono(ax ? 17 : 12))
                    .textCase(.uppercase)
                    .tracking(1)
                    .foregroundStyle(Color.inkLabel)
                    .lineLimit(1)
                    .padding(.top, 4)
                Text(footer.text)
                    .font(Ramp(ax: ax).display(ax ? 22 : 17, .semibold, .headline))
                    .sairaLine(ax ? 22 : 17)
                    .foregroundStyle(Color.inkBright)
                    .lineLimit(2)
                    // A Link centres wrapped text; the footer reads left-aligned.
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    // AX: the 22 pt stop is capped at 314 of 330 pt, so it
                    // wraps with air rather than running edge to edge.
                    .padding(.trailing, ax ? 16 : 0)
                    .privacySensitive(footer.sensitive)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .fixedSize(horizontal: false, vertical: true)
        .layoutPriority(1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(footer.spoken)
        .accessibilityAddTraits(.isLink)
    }
}

// MARK: - StandBy

/// StandBy's left stack: the small widget with no background, scaled up by
/// the system. "VOOR JOU", the hero count, "• wachten op jou", the age — or
/// the statement and when it was last known.
private struct WidgetStandBy: View {
    let content: WidgetContent

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 0)
            if content.state == .waiting {
                Text(content.eyebrow)
                    .font(.mono(10, relativeTo: .caption))
                    .textCase(.uppercase)
                    .tracking(1)
                    .foregroundStyle(Color.inkLabel)
                CountText(content: content, size: 66)
                    .padding(.bottom, 4)
                WaitLine(content: content, size: 12)
                if let readout = content.readout { Readout(text: readout, size: 10, color: .inkSoft).padding(.top, 2) }
            } else {
                StateGlyph(glyph: content.glyph, size: 17).padding(.bottom, 6)
                Text(content.words)
                    .font(.display(17, relativeTo: .headline, weight: .semibold))
                    .sairaLine(17)
                    .foregroundStyle(Color.inkBright)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                if let readout = content.readout {
                    Readout(text: readout, size: 10, lines: 3, color: .inkSoft).padding(.top, 2)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Voor jou, " + content.spokenSummary(showing: 0))
    }
}

/// The "Waar het nu op wacht" widget: StandBy's right stack (and a small box
/// on the home screen). The stop and its spoor are case content; on a locked
/// phone they turn to bars and "ontgrendel om te zien" takes the spoor's place.
struct HeadlineFace: View {
    let content: HeadlineContent
    var standBy = false
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        let scale: CGFloat = standBy ? 0.5 : 1
        VStack(alignment: .leading, spacing: 4 * scale) {
            if !standBy {
                HStack(spacing: 6) {
                    Image(systemName: "map")
                    Text("verder").textCase(.uppercase).tracking(1)
                }
                .font(.mono(12, relativeTo: .caption))
                .foregroundStyle(Color.inkLabel)
                .accessibilityHidden(true)
            }
            Spacer(minLength: 0)
            Text(content.label)
                .font(.mono(standBy ? 10 : 12, relativeTo: .caption))
                .textCase(.uppercase)
                .tracking(1)
                .foregroundStyle(Color.inkLabel)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Text(content.text)
                .font(.display(content.quiet ? (standBy ? 12 : 15) : 17, relativeTo: .headline,
                               weight: content.quiet ? .regular : .semibold))
                .sairaLine(content.quiet ? (standBy ? 12 : 15) : 17)
                .foregroundStyle(content.quiet ? Color.inkSoft : Color.inkBright)
                .lineLimit(standBy ? 2 : 4)
                .fixedSize(horizontal: false, vertical: true)
                .privacySensitive(content.sensitive)
            if content.sensitive && redaction.contains(.privacy) {
                Readout(text: HeadlineContent.lockedText, size: standBy ? 10 : 12, lines: 1, color: .inkSoft)
            } else if let sub = content.sub {
                Text(sub)
                    .font(.mono(standBy ? 10 : 12, relativeTo: .caption))
                    .foregroundStyle(content.quiet ? Color.inkLabel : Color.inkSoft)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .privacySensitive(content.sensitive)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(redaction.contains(.privacy) && content.sensitive
                            ? "Waar het nu op wacht: \(HeadlineContent.lockedText)" : content.spoken)
    }
}

// MARK: - Lock screen (counts only)

/// The tray and the count; with nothing to count, its glyph and one word.
private struct WidgetCircular: View {
    let content: WidgetContent

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 1) {
                Image(systemName: content.glyph.rawValue)
                    .font(.system(size: content.countText == nil ? 15 : 12, weight: .semibold))
                    .widgetAccentable()
                if let count = content.countText {
                    Text(count)
                        .font(.display(22, relativeTo: .title2, weight: .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                        .widgetAccentable()
                } else {
                    Text(content.words)
                        .font(.mono(11, relativeTo: .caption2))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
            }
            .padding(4)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(content.countText == nil ? content.caption : content.words)
    }
}

private struct WidgetRectangular: View {
    let content: WidgetContent

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if content.state == .signedOut {
                Text(content.eyebrow)
                    .font(.mono(11, relativeTo: .caption2))
                    .textCase(.uppercase)
                    .tracking(1)
                    .opacity(0.75)
            }
            if let count = content.countText {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(count)
                        .font(.display(22, relativeTo: .title2, weight: .semibold))
                        .lineLimit(1)
                        .widgetAccentable()
                    Text(content.words)
                        .font(.display(15, relativeTo: .subheadline, weight: .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            } else {
                Text(content.words)
                    .font(.display(15, relativeTo: .subheadline, weight: .semibold))
                    .lineLimit(2)
                    .widgetAccentable()
            }
            if let readout = content.readout {
                HStack(spacing: 4) {
                    if content.state == .waiting || content.state == .empty {
                        Image(systemName: content.glyph.rawValue).font(.system(size: 10, weight: .semibold))
                    }
                    Text(readout).font(.mono(12, relativeTo: .caption)).lineLimit(1).minimumScaleFactor(0.8)
                }
                .opacity(0.8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// The whole of the inline line: its glyph and "verder · 4 voor jou". iOS
/// sets the font; only the text and one image survive.
private struct WidgetInline: View {
    let content: WidgetContent

    var body: some View {
        Label {
            Text(content.words)
        } icon: {
            Image(systemName: content.glyph.rawValue)
        }
    }
}
