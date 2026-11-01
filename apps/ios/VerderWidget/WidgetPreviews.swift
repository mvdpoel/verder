#if DEBUG
import SwiftUI
import WidgetKit

/// Previews on the SYNTHETIC case only (docs/superpowers/specs/
/// 2026-11-01-iphone-synthetic-data.md, Voor jou `voorjou-few` and
/// `voorjou-many`): these frames are compared against Figma, an outside
/// service, so no real name, organisation or title may appear here.
enum WidgetSamples {
    /// The case's "today": Sun 1 nov 2026, 12:00 Amsterdam.
    static let today = Date(timeIntervalSince1970: 1_793_530_800)

    static func item(_ kind: String, _ n: Int, _ title: String) -> WidgetSnapshot.Item {
        WidgetSnapshot.Item(kind: kind, id: String(format: "00000000-f1c5-4000-8000-%012d", n), title: title)
    }

    static let few = WidgetSnapshot(
        count: 4, topTitle: nil, topKind: nil,
        headline: "Stukken aanleveren bij Team Startdossier",
        updatedAt: today.addingTimeInterval(-600),
        items: [
            item("proposal", 1, "Antwoord aan Bewindkantoor Noordkust: loonstrook oktober"),
            item("question", 2, "Hoort deze brief bij de vordering van Kade & Partners?"),
            item("suggestion", 3, "Telefoongesprek met Woonstichting Lindehof over de betalingsregeling"),
            item("task", 4, "Formulier bijzondere bijstand ondertekenen"),
        ],
        oldestAt: today.addingTimeInterval(-2 * 86_400))

    static let many = WidgetSnapshot(
        count: 498, topTitle: nil, topKind: nil, headline: few.headline, updatedAt: few.updatedAt,
        items: few.items + [item("suggestion", 5, "Brief van Gemeente Westerlaan over de huurtoeslag 5")],
        oldestAt: today.addingTimeInterval(-40 * 86_400))

    static let one = WidgetSnapshot(
        count: 1, topTitle: nil, topKind: nil, headline: few.headline, updatedAt: few.updatedAt,
        items: [few.items[3]], oldestAt: today.addingTimeInterval(-3600))

    static let empty = WidgetSnapshot(count: 0, topTitle: nil, topKind: nil, headline: nil,
                                      updatedAt: few.updatedAt)

    static let stale = WidgetSnapshot(
        count: 4, topTitle: nil, topKind: nil, headline: few.headline,
        updatedAt: today.addingTimeInterval(-2 * 86_400), items: few.items, oldestAt: few.oldestAt)

    static func at(_ snapshot: WidgetSnapshot?) -> VerderEntry {
        VerderEntry(date: today, snapshot: snapshot)
    }
}

#Preview("Klein", as: .systemSmall) { VerderWidget() } timeline: {
    WidgetSamples.at(WidgetSamples.few)
    WidgetSamples.at(WidgetSamples.many)
    WidgetSamples.at(WidgetSamples.one)
    WidgetSamples.at(WidgetSamples.empty)
    WidgetSamples.at(WidgetSamples.stale)
    WidgetSamples.at(nil)
}
#Preview("Middel", as: .systemMedium) { VerderWidget() } timeline: {
    WidgetSamples.at(WidgetSamples.few)
    WidgetSamples.at(WidgetSamples.many)
    WidgetSamples.at(WidgetSamples.one)
    WidgetSamples.at(WidgetSamples.empty)
    WidgetSamples.at(WidgetSamples.stale)
    WidgetSamples.at(nil)
}
#Preview("Groot", as: .systemLarge) { VerderWidget() } timeline: {
    WidgetSamples.at(WidgetSamples.few)
    WidgetSamples.at(WidgetSamples.many)
    WidgetSamples.at(WidgetSamples.one)
    WidgetSamples.at(WidgetSamples.empty)
    WidgetSamples.at(WidgetSamples.stale)
    WidgetSamples.at(nil)
}
#Preview("Rond", as: .accessoryCircular) { VerderWidget() } timeline: {
    WidgetSamples.at(WidgetSamples.few)
    WidgetSamples.at(WidgetSamples.many)
    WidgetSamples.at(WidgetSamples.one)
    WidgetSamples.at(WidgetSamples.empty)
    WidgetSamples.at(WidgetSamples.stale)
    WidgetSamples.at(nil)
}
#Preview("Rechthoek", as: .accessoryRectangular) { VerderWidget() } timeline: {
    WidgetSamples.at(WidgetSamples.few)
    WidgetSamples.at(WidgetSamples.many)
    WidgetSamples.at(WidgetSamples.one)
    WidgetSamples.at(WidgetSamples.empty)
    WidgetSamples.at(WidgetSamples.stale)
    WidgetSamples.at(nil)
}
#Preview("Regel", as: .accessoryInline) { VerderWidget() } timeline: {
    WidgetSamples.at(WidgetSamples.few)
    WidgetSamples.at(WidgetSamples.many)
    WidgetSamples.at(WidgetSamples.one)
    WidgetSamples.at(WidgetSamples.empty)
    WidgetSamples.at(WidgetSamples.stale)
    WidgetSamples.at(nil)
}
#endif
