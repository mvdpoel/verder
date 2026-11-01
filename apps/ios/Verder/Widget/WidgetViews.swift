import SwiftUI
import WidgetKit

/// The widget's faces, one per family. THIN BY DESIGN: every decision —
/// what shows, what is sensitive, when it is amber, where a tap goes — is
/// `WidgetContent`'s; these only paint it with the Holodek tokens.
///
/// Compiled into the app as well as the widget, so the unit tests can render
/// the medium face under the privacy redaction.
struct WidgetFamilyView: View {
    let content: WidgetContent
    let family: WidgetFamily

    var body: some View {
        switch family {
        case .accessoryCircular: WidgetCircular(content: content)
        case .accessoryRectangular: WidgetRectangular(content: content)
        case .accessoryInline: Text(content.inlineText)
        case .systemMedium: WidgetMedium(content: content)
        case .systemLarge, .systemExtraLarge: WidgetLarge(content: content)
        default: WidgetSmall(content: content)
        }
    }
}

// MARK: - Pieces

/// The hero count and its words. In full colour the count is amber while
/// something waits; in tinted, clear and lock-screen rendering it joins the
/// accent group and the words keep the meaning.
private struct CountBlock: View {
    let content: WidgetContent
    var size: CGFloat = 48
    @Environment(\.widgetRenderingMode) private var mode

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let count = content.countText {
                Text(count)
                    .font(.display(size, relativeTo: .largeTitle, weight: .light))
                    .foregroundStyle(content.countIsAmber(in: mode) ? Color.attn : Color.inkBright)
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                    .widgetAccentable()
            } else {
                Image(systemName: "arrow.clockwise")
                    .font(.display(28, relativeTo: .title))
                    .foregroundStyle(Color.ink)
                    .widgetAccentable()
                    .accessibilityHidden(true)
            }
            Text(content.caption)
                .font(.display(15, relativeTo: .subheadline))
                .foregroundStyle(content.state == .stale ? Color.ink : Color.inkSoft)
                .lineLimit(2)
        }
        .accessibilityElement(children: .combine)
    }
}

/// "verder", and the amber dot while something waits — the dot never stands
/// alone: the caption under it says "wacht op jou".
private struct Masthead: View {
    let content: WidgetContent
    @Environment(\.widgetRenderingMode) private var mode

    var body: some View {
        HStack(spacing: 8) {
            if content.state == .waiting {
                Circle()
                    .fill(content.countIsAmber(in: mode) ? Color.attn : Color.inkBright)
                    .frame(width: 8, height: 8)
                    .widgetAccentable()
                    .accessibilityHidden(true)
            }
            Text("verder")
                .font(.mono(12, relativeTo: .caption))
                .foregroundStyle(Color.inkLabel)
        }
    }
}

/// One item: its kind (not sensitive) over its title (sensitive, redacted on a
/// locked phone), linking to that exact item.
private struct ItemRow: View {
    let line: WidgetContent.Line

    var body: some View {
        Link(destination: line.url) {
            VStack(alignment: .leading, spacing: 4) {
                if let label = line.label {
                    Text(label)
                        .font(.mono(12, relativeTo: .caption))
                        .foregroundStyle(Color.inkLabel)
                }
                Text(line.text)
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.ink)
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .privacySensitive(line.sensitive)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - Home screen

private struct WidgetSmall: View {
    let content: WidgetContent

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Masthead(content: content)
            Spacer(minLength: 8)
            CountBlock(content: content)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private struct WidgetMedium: View {
    let content: WidgetContent

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            WidgetSmall(content: content)
                .frame(maxWidth: 112)
            if !content.rows.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(content.rows.enumerated()), id: \.offset) { _, line in
                        ItemRow(line: line)
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

private struct WidgetLarge: View {
    let content: WidgetContent

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Masthead(content: content)
                Spacer()
                if let oldest = content.oldestText {
                    Text(oldest)
                        .font(.mono(12, relativeTo: .caption))
                        .foregroundStyle(Color.inkLabel)
                }
            }
            CountBlock(content: content, size: 40)
            if !content.rows.isEmpty {
                Rectangle().fill(Color.hairline).frame(height: 1).accessibilityHidden(true)
                ForEach(Array(content.rows.enumerated()), id: \.offset) { _, line in
                    ItemRow(line: line)
                }
            }
            Spacer(minLength: 0)
            if let headline = content.headline {
                VStack(alignment: .leading, spacing: 4) {
                    Text(WidgetContent.headlineLabel)
                        .font(.mono(12, relativeTo: .caption))
                        .foregroundStyle(Color.inkLabel)
                    Text(headline.text)
                        .font(.display(15, relativeTo: .subheadline))
                        .foregroundStyle(Color.steel)
                        .lineLimit(1)
                        .privacySensitive(headline.sensitive)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Lock screen (counts only)

private struct WidgetCircular: View {
    let content: WidgetContent

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                if let count = content.countText {
                    Text(count)
                        .font(.display(22, relativeTo: .title2, weight: .medium))
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                        .widgetAccentable()
                    Text("voor jou")
                        .font(.mono(11, relativeTo: .caption2))
                } else {
                    Image(systemName: "arrow.clockwise")
                        .font(.display(17, relativeTo: .body))
                        .widgetAccentable()
                    Text("open")
                        .font(.mono(11, relativeTo: .caption2))
                }
            }
            .padding(4)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(content.countText.map { "\($0) \(content.caption)" } ?? WidgetContent.staleText)
    }
}

private struct WidgetRectangular: View {
    let content: WidgetContent

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let count = content.countText {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(count)
                        .font(.display(22, relativeTo: .title2, weight: .medium))
                        .lineLimit(1)
                        .widgetAccentable()
                    Text(content.caption)
                        .font(.display(15, relativeTo: .subheadline))
                        .lineLimit(1)
                }
                if let oldest = content.oldestText {
                    Text(oldest).font(.mono(12, relativeTo: .caption))
                }
            } else {
                Text("verder")
                    .font(.display(15, relativeTo: .headline, weight: .medium))
                    .widgetAccentable()
                Text(content.caption)
                    .font(.display(15, relativeTo: .subheadline))
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
