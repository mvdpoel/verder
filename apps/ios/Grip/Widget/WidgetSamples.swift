#if DEBUG
import Foundation

/// The widget on the SYNTHETIC case only (docs/superpowers/specs/
/// 2026-11-01-iphone-synthetic-data.md), with the drawn strings of the Figma
/// "widgets · final" frames: these are compared against Figma, an outside
/// service, so no real name, organisation or title may appear here. Shared by
/// the Xcode previews (widget target) and the DEBUG widget host the captures
/// draw (`WidgetHostView`, app target).
enum WidgetSamples {
    /// The frames' "now": Mon 2 nov 2026, 09:41 Amsterdam.
    static let today = Date(timeIntervalSince1970: 1_793_608_860)

    static func at(day: Int, month: Int, hour: Int = 9, minute: Int = 0) -> Date {
        DutchDate.calendar.date(from: DateComponents(year: 2026, month: month, day: day, hour: hour, minute: minute))
            ?? today
    }

    static func item(_ kind: String, _ n: Int, _ title: String, at: Date, dueAt: String? = nil) -> WidgetSnapshot.Item {
        WidgetSnapshot.Item(kind: kind, id: String(format: "00000000-f1c5-4000-8000-%012d", n), title: title,
                            at: at, dueAt: dueAt)
    }

    static let items: [WidgetSnapshot.Item] = [
        item("proposal", 1, "Loonstrook oktober naar Noordkust", at: at(day: 2, month: 11, hour: 8, minute: 30)),
        item("question", 2, "Brief bij vordering Kade & Partners?", at: at(day: 1, month: 11)),
        item("suggestion", 3, "Gesprek Lindehof over betalingsregeling", at: at(day: 31, month: 10)),
        item("task", 4, "Formulier bijzondere bijstand tekenen", at: at(day: 31, month: 10), dueAt: "2026-11-03"),
        item("suggestion", 5, "Brief Westerlaan over huurtoeslag", at: at(day: 30, month: 10)),
    ]

    static let headline = "Stukken naar Team Startdossier"
    static let updated = at(day: 2, month: 11, hour: 8, minute: 12)

    static let few = WidgetSnapshot(
        count: 4, topTitle: nil, topKind: nil, headline: headline, updatedAt: updated,
        items: Array(items.prefix(4)), oldestAt: at(day: 31, month: 10),
        headlineTrack: "Opstart bewind", headlineAt: at(day: 28, month: 10))

    static let many = WidgetSnapshot(
        count: 498, topTitle: nil, topKind: nil, headline: headline, updatedAt: updated,
        items: items, oldestAt: at(day: 20, month: 9),
        headlineTrack: few.headlineTrack, headlineAt: few.headlineAt)

    static let one = WidgetSnapshot(
        count: 1, topTitle: nil, topKind: nil, headline: headline, updatedAt: updated,
        items: [items[0]], oldestAt: at(day: 31, month: 10),
        headlineTrack: few.headlineTrack, headlineAt: few.headlineAt)

    static let empty = WidgetSnapshot(count: 0, topTitle: nil, topKind: nil, headline: nil, updatedAt: updated)

    /// Last written Sat 31 okt 14:02: more than a day before `today`.
    static let stale = WidgetSnapshot(
        count: 4, topTitle: nil, topKind: nil, headline: headline,
        updatedAt: at(day: 31, month: 10, hour: 14, minute: 2), items: few.items, oldestAt: few.oldestAt)

    static func entry(_ snapshot: WidgetSnapshot?, signedOut: Bool = false) -> GripEntry {
        GripEntry(date: today, snapshot: snapshot, signedOut: signedOut)
    }
}
#endif
