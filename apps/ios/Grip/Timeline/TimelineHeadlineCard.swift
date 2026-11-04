import SwiftUI

/// "Waar het nu op wacht" as a card that opens the Tijdlijn — on Dossier and on
/// Overzicht (Figma "Dossier / ingang naar de tijdlijn", "Overzicht / naar de
/// tijdlijn"). Amber eyebrow: the current stop is what waits on Martin.
///
/// Locked, Overzicht shows the card WITHOUT the stop: that something waits is
/// a count, what it is is case content (`locked`).
struct TimelineHeadlineCard: View {
    static let opens = "opent tijdlijn"
    static let lockedTitle = "Je volgende stap staat op je tijdlijn"
    static let lockedBody = "Tik en ontgrendel met Face ID om te zien wat het is."

    let title: String
    let note: String?
    /// "Opstart en stukken", "opent tijdlijn" — one per line.
    let meta: [String]

    @Environment(\.dynamicTypeSize) private var typeSize
    private var ax: Bool { typeSize.isAccessibilitySize }

    static func locked() -> TimelineHeadlineCard {
        TimelineHeadlineCard(title: lockedTitle, note: lockedBody, meta: [opens])
    }

    var body: some View {
        HStack(alignment: ax ? .top : .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: ax ? 24 : 13, weight: .medium))
                        .foregroundStyle(Color.attn)
                        .accessibilityHidden(true)
                    Text(ax ? TimelineCopy.headlineLabel : TimelineCopy.headlineLabel.uppercased())
                        .font(.mono(12, relativeTo: .caption, weight: .medium)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
                        .tracking(ax ? 0 : 1.9)
                        .foregroundStyle(Color.attn)
                        .fixedSize(horizontal: false, vertical: true)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.display(17, relativeTo: .headline, weight: .medium))
                        .foregroundStyle(Color.inkBright)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if let note, !note.isEmpty {
                        Text(note)
                            .font(.display(15, relativeTo: .subheadline))
                            .foregroundStyle(Color.inkSoft)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(meta.enumerated()), id: \.offset) { _, line in
                        Text(ax ? HomeSummary.sentence(line) : line.uppercased())
                    }
                }
                .font(.mono(12, relativeTo: .caption)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
                .tracking(ax ? 0 : 1)
                .foregroundStyle(Color.inkLabel)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.system(size: ax ? 20 : 13, weight: .medium))
                .foregroundStyle(Color.inkLabel)
                .accessibilityHidden(true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .lineHeight(.multiple(factor: ax ? TimelineType.axLineFactor : TimelineType.lineFactor))
        .glassPanel()
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
