import Foundation
import WidgetKit

/// One moment of the widget's timeline: the App Group snapshot as it was read.
/// Nil when nothing was ever written (or the file does not decode).
struct VerderEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

/// The provider's whole decision, pure so it is tested without WidgetKit
/// running. THE WIDGET NEVER CALLS THE NETWORK: the app's refresh (foreground,
/// or the silent `badge.sync` push) writes the snapshot and reloads timelines;
/// this only re-reads the file every 30 minutes.
enum VerderTimeline {
    static let reloadAfter: TimeInterval = 30 * 60

    /// The entry for `now` and when WidgetKit should ask again.
    static func entry(now: Date, snapshot: WidgetSnapshot?) -> (VerderEntry, Date) {
        (VerderEntry(date: now, snapshot: snapshot), now.addingTimeInterval(reloadAfter))
    }

    /// The timeline: `now`, plus — when the snapshot turns stale before the
    /// next reload — an entry at that very moment, so a day-old count is never
    /// shown for up to half an hour past its 24 h.
    static func entries(now: Date, snapshot: WidgetSnapshot?) -> [VerderEntry] {
        let (first, reload) = entry(now: now, snapshot: snapshot)
        guard let snapshot else { return [first] }
        let staleAt = snapshot.updatedAt.addingTimeInterval(WidgetContent.staleAfter)
        guard staleAt > now, staleAt < reload else { return [first] }
        return [first, VerderEntry(date: staleAt, snapshot: snapshot)]
    }
}

/// What a widget family shows, decided here so the views only paint.
///
/// THE LOCK SCREEN SHOWS COUNTS ONLY: it is visible to anyone holding the
/// phone, and the app lock does not reach widgets, so the accessory families
/// get no rows and no headline BY CONSTRUCTION. Home-screen widgets also render
/// while the phone is locked (StandBy, always-on), so every title there is
/// `sensitive` and the view marks it `.privacySensitive()`.
///
/// AMBER IS FOR WHAT WAITS ON MARTIN, and it is never the only carrier: the
/// words "wacht op jou" go with every count, because the tinted and clear home
/// screens (`.accented`) and the lock screen (`.vibrant`) drop the colour.
struct WidgetContent: Equatable {
    enum State: Equatable {
        /// Something waits on Martin, on a fresh snapshot.
        case waiting
        /// Nothing waits.
        case empty
        /// No snapshot, or one older than `staleAfter`: no count at all.
        case stale
    }

    /// One line of case content: a title, or the map headline.
    struct Line: Equatable {
        let text: String
        /// The kind in Dutch ("voorstel"), not sensitive; nil for the headline.
        let label: String?
        let sensitive: Bool
        let url: URL
    }

    static let staleAfter: TimeInterval = 24 * 3600
    // A literal that parses: force-unwrapping it can never fail at runtime.
    static let inboxURL = URL(string: "verder://inbox")!

    static let staleText = "Open verder om bij te werken"
    static let emptyText = "Niets wacht op je."
    static let headlineLabel = "waar het nu op wacht"

    let state: State
    /// The family this content was made for: `drawnText` answers for it alone.
    let family: WidgetFamily
    /// Nil when stale: a day-old count is a guess, and the widget does not guess.
    let countText: String?
    /// "wacht op jou" / "wachten op jou", "Niets wacht op je." or the stale text.
    let caption: String
    /// The words THIS family paints beside its count, and the only carrier of
    /// the meaning once tinted, clear or lock-screen rendering drops amber:
    /// the caption on the home screen and the rectangle, "voor jou" / "open"
    /// in the circle, the whole line inline. The views read this and nothing
    /// else for their words (`WidgetEntryTests.everyFamilyPaintsItsWords`).
    let words: String
    /// The count and its words are the glance, never redacted.
    let countSensitive = false
    let rows: [Line]
    let headline: Line?
    /// "oudste 3 dagen" (rectangular and large only).
    let oldestText: String?
    /// The whole of `accessoryInline`: "verder · 3 voor jou".
    let inlineText: String
    /// The widget's own tap (`widgetURL`); rows carry their own.
    let url: URL

    /// Every string THIS family draws — never another family's — for the
    /// "never a title on the lock screen" and "never colour alone" checks.
    var drawnText: [String] {
        if family == .accessoryInline { return [words] }
        return [countText, words, oldestText].compactMap { $0 }
            + rows.flatMap { [$0.label, $0.text].compactMap { $0 } }
            + [headline.map { _ in Self.headlineLabel }, headline?.text].compactMap { $0 }
    }

    /// The same content with other words: the test's lever for proving that a
    /// face paints `words` rather than a string of its own.
    func withWords(_ words: String) -> WidgetContent {
        WidgetContent(state: state, family: family, countText: countText, caption: caption, words: words,
                      rows: rows, headline: headline, oldestText: oldestText, inlineText: inlineText, url: url)
    }

    /// The words a family paints with its count, per state.
    static func words(state: State, caption: String, inline: String, family: WidgetFamily) -> String {
        switch family {
        case .accessoryInline: inline
        case .accessoryCircular: state == .stale ? "open" : "voor jou"
        default: caption
        }
    }

    /// Amber only in full colour, and only while something waits on a fresh
    /// snapshot. Elsewhere the count is `.widgetAccentable()` and the words
    /// carry the meaning.
    func countIsAmber(in mode: WidgetRenderingMode) -> Bool {
        state == .waiting && mode == .fullColor
    }

    static func rowLimit(_ family: WidgetFamily) -> Int {
        switch family {
        case .systemMedium: 2
        case .systemLarge, .systemExtraLarge: WidgetSnapshot.maxItems
        default: 0
        }
    }

    static func showsHeadline(_ family: WidgetFamily) -> Bool {
        family == .systemLarge || family == .systemExtraLarge
    }

    static func showsOldest(_ family: WidgetFamily) -> Bool {
        family == .accessoryRectangular || showsHeadline(family)
    }

    static func make(snapshot: WidgetSnapshot?, family: WidgetFamily, now: Date) -> WidgetContent {
        func content(_ state: State, count: String?, caption: String, rows: [Line] = [], headline: Line? = nil,
                     oldest: String? = nil, inline: String) -> WidgetContent {
            WidgetContent(state: state, family: family, countText: count, caption: caption,
                          words: words(state: state, caption: caption, inline: inline, family: family),
                          rows: rows, headline: headline, oldestText: oldest, inlineText: inline, url: inboxURL)
        }
        guard let snapshot, now.timeIntervalSince(snapshot.updatedAt) < staleAfter else {
            return content(.stale, count: nil, caption: staleText, inline: "verder · open om bij te werken")
        }
        let count = max(snapshot.count, 0)
        guard count > 0 else {
            return content(.empty, count: "0", caption: emptyText, inline: "verder · niets voor jou")
        }
        let rows = snapshot.items.prefix(rowLimit(family)).map {
            Line(text: $0.title, label: KindLabel.dutch($0.kind), sensitive: true, url: url(for: $0))
        }
        let headline = showsHeadline(family) ? snapshot.headline.map {
            Line(text: $0, label: nil, sensitive: true, url: inboxURL)
        } : nil
        return content(.waiting, count: String(count),
                       caption: count == 1 ? "wacht op jou" : "wachten op jou",
                       rows: Array(rows), headline: headline,
                       oldest: showsOldest(family) ? snapshot.oldestAt.map { oldest(since: $0, now: now) } : nil,
                       inline: "verder · \(count) voor jou")
    }

    /// The exact item. `DeepLink.parse` accepts only a UUID, so anything else
    /// (the map's stop, an unknown kind, a malformed id) opens Voor jou rather
    /// than becoming a tap that does nothing.
    static func url(for item: WidgetSnapshot.Item) -> URL {
        guard let id = UUID(uuidString: item.id) else { return inboxURL }
        let host: String
        switch item.kind {
        case "proposal", "question": host = "proposal"
        case "suggestion": host = "suggestion"
        case "task": host = "task"
        default: return inboxURL
        }
        return URL(string: "verder://\(host)/\(id.uuidString.lowercased())") ?? inboxURL
    }

    /// Whole calendar days in Amsterdam, the case's clock.
    static func oldest(since: Date, now: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Amsterdam") ?? .current
        let days = max(cal.dateComponents([.day], from: cal.startOfDay(for: since),
                                          to: cal.startOfDay(for: now)).day ?? 0, 0)
        switch days {
        case 0: return "oudste van vandaag"
        case 1: return "oudste 1 dag"
        default: return "oudste \(days) dagen"
        }
    }
}
