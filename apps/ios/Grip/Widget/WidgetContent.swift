import Foundation
import SwiftUI
import WidgetKit

/// One moment of the widget's timeline: the App Group snapshot as it was read.
/// Nil when nothing was ever written (or the file does not decode).
struct GripEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
    /// The App Group's empty "signed out" marker (`WidgetSnapshot.isSignedOut`):
    /// with no snapshot, the widget says "Log in bij Grip" rather than
    /// "Open Grip om bij te werken".
    var signedOut = false
    /// The widget's box as WidgetKit reported it (`context.displaySize`): the
    /// iPhone SE's 148 pt small and 321 pt medium take the compact faces.
    var displaySize: CGSize? = nil
}

/// The provider's whole decision, pure so it is tested without WidgetKit
/// running. THE WIDGET NEVER CALLS THE NETWORK: the app's refresh (foreground,
/// or the silent `badge.sync` push) writes the snapshot and reloads timelines;
/// this only re-reads the file every 30 minutes.
enum GripTimeline {
    static let reloadAfter: TimeInterval = 30 * 60

    /// The entry for `now` and when WidgetKit should ask again.
    static func entry(now: Date, snapshot: WidgetSnapshot?, signedOut: Bool = false,
                      displaySize: CGSize? = nil) -> (GripEntry, Date) {
        (GripEntry(date: now, snapshot: snapshot, signedOut: signedOut, displaySize: displaySize),
         now.addingTimeInterval(reloadAfter))
    }

    /// The timeline: `now`, plus — when the snapshot turns stale before the
    /// next reload — an entry at that very moment, so a day-old count is never
    /// shown for up to half an hour past its 24 h.
    static func entries(now: Date, snapshot: WidgetSnapshot?, signedOut: Bool = false,
                        displaySize: CGSize? = nil) -> [GripEntry] {
        let (first, reload) = entry(now: now, snapshot: snapshot, signedOut: signedOut, displaySize: displaySize)
        guard let snapshot else { return [first] }
        let staleAt = snapshot.updatedAt.addingTimeInterval(WidgetContent.staleAfter)
        guard staleAt > now, staleAt < reload else { return [first] }
        return [first, GripEntry(date: staleAt, snapshot: snapshot, signedOut: signedOut, displaySize: displaySize)]
    }
}

/// What a widget family shows, decided here so the views only paint (Figma
/// "widgets · final", 347:16197).
///
/// THE LOCK SCREEN SHOWS COUNTS ONLY: it is visible to anyone holding the
/// phone, and the app lock does not reach widgets, so the accessory families
/// get no rows and no headline BY CONSTRUCTION. Home-screen widgets also render
/// while the phone is locked (StandBy, always-on, the Today View), so every
/// row there is `sensitive` and the view marks it `.privacySensitive()`.
///
/// AMBER IS FOR WHAT WAITS ON MARTIN, and it is never the only carrier: the
/// words "wacht op jou" go with every home-screen count, because the tinted and
/// clear home screens (`.accented`) and the lock screen (`.vibrant`) drop the
/// colour.
struct WidgetContent: Equatable {
    enum State: Equatable {
        /// Something waits on Martin, on a fresh snapshot.
        case waiting
        /// Nothing waits.
        case empty
        /// A snapshot older than `staleAfter`, or none that reads: no count at all.
        case stale
        /// Signed out (the App Group's marker, no snapshot): "Log in bij Grip".
        case signedOut
    }

    /// Which composition a face takes. `compact` is the iPhone SE's 148 pt
    /// small and 321 pt medium; `accessibility` is every AX Dynamic Type size.
    enum Layout: Equatable {
        case standard, compact, accessibility

        /// The small box narrower than this, or the medium narrower than
        /// `compactMediumWidth`, is the SE's (148 / 321; every current
        /// iPhone's small is 155 or more, its medium 329 or more).
        static let compactSmallWidth: CGFloat = 152
        static let compactMediumWidth: CGFloat = 326

        static func make(family: WidgetFamily, displaySize: CGSize?, accessibilitySize: Bool) -> Layout {
            if accessibilitySize { return .accessibility }
            guard let width = displaySize?.width else { return .standard }
            switch family {
            case .systemSmall: return width < compactSmallWidth ? .compact : .standard
            case .systemMedium: return width < compactMediumWidth ? .compact : .standard
            default: return .standard
            }
        }
    }

    /// The SF Symbol beside the eyebrow and in place of a count.
    enum Glyph: String, Equatable {
        case tray, check = "checkmark", refresh = "arrow.clockwise", person
    }

    /// One row: a title, its meta ("VOORSTEL · 2 NOV") and the full sentence
    /// VoiceOver reads.
    struct Line: Equatable {
        let text: String
        /// Uppercased kind and date; nil when nothing is known but the title.
        let meta: String?
        let sensitive: Bool
        let url: URL
        let spoken: String
    }

    /// The large face's fixed footer ("waar het nu op wacht" and the stop).
    struct Footer: Equatable {
        /// Lower case; the view sets it in capitals.
        let label: String
        let text: String
        /// Only the map's own stop is case content; "Nergens op." is not.
        let sensitive: Bool
        let url: URL
        let spoken: String
    }

    static let staleAfter: TimeInterval = 24 * 3600
    // Literals that parse: force-unwrapping them can never fail at runtime.
    static let inboxURL = URL(string: "grip://inbox")!
    /// The footer's tap: the Tijdlijn on Dossier, at the open stop.
    static let mapURL = URL(string: "grip://timeline")!

    static let staleText = "Open Grip om bij te werken"
    static let emptyText = "Niets wacht op je"
    static let signedOutText = "Log in bij Grip"
    static let headlineLabel = "waar het nu op wacht"
    static let emptyFooter = "Nergens op. Je bent helemaal bij."

    let state: State
    /// The family this content was made for: `drawnText` answers for it alone.
    let family: WidgetFamily
    let layout: Layout
    let glyph: Glyph
    /// "voor jou", or "Grip" when signed out (the view sets it in capitals).
    let eyebrow: String
    /// Nil unless something waits: a stale count is a guess, and "0" is
    /// replaced by the check and "Niets wacht op je".
    let countText: String?
    /// "wacht op jou" / "wachten op jou" / "voor jou" (AX) while waiting; the
    /// statement otherwise.
    let caption: String
    /// The words THIS family paints as its meaning, and the only carrier of it
    /// once tinted, clear or lock-screen rendering drops amber: the caption
    /// while waiting, the statement ("Niets wacht op je") otherwise, "niets" /
    /// "oud" / "log in" in the circle, the whole line inline. The views read
    /// this and nothing else for their words (`everyFamilyPaintsItsWords`).
    /// The circle draws a glyph and the count while waiting, and its words
    /// only as its VoiceOver label — the rectangle beside it says them.
    let words: String
    /// Medium and large only, when nothing can be counted: "Goed bezig. …".
    let body: String?
    /// The mono line under the words: "oudste 2 dagen", "en nog 2",
    /// "bijgewerkt 08:12", "tik en log in". The large face builds its own
    /// (`largeReadout(showing:)`), because how many rows fit decides it.
    let readout: String?
    /// The count and its words are the glance, never redacted.
    let countSensitive = false
    let rows: [Line]
    /// How many wait beyond the rows a face can show: `count - shown`.
    let count: Int
    /// "oudste 2 dagen", "oudste 6 wk", "sinds 2 dagen" (one item).
    let oldestText: String?
    let oldestSpoken: String?
    /// The large face's footer.
    let footer: Footer?
    /// The large empty face's header readout: "bijgewerkt 08:12".
    let updatedText: String?
    /// The whole of `accessoryInline`: "Grip · 3 voor jou".
    let inlineText: String
    /// The widget's own tap (`widgetURL`); rows and the footer carry their own.
    let url: URL

    /// "en nog 493" for a face showing `shown` rows, nil when nothing is hidden.
    func more(showing shown: Int) -> String? {
        let rest = count - shown
        return rest > 0 ? "en nog \(rest)" : nil
    }

    /// The large header's mono line: "en nog 493 · oudste 6 wk". At AX sizes
    /// the age is left out (`oldestText` is nil there).
    func largeReadout(showing shown: Int) -> String? {
        let parts = [more(showing: shown), oldestText].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// What VoiceOver reads for the count block: "498 wachten op jou, en nog
    /// 493, oudste 6 weken".
    func spokenSummary(showing shown: Int) -> String {
        guard let countText else { return [words, readout].compactMap { $0 }.joined(separator: ", ") }
        return ["\(countText) \(count == 1 ? "wacht op jou" : "wachten op jou")",
                more(showing: shown), oldestSpoken].compactMap { $0 }.joined(separator: ", ")
    }

    /// Every string THIS family draws — never another family's — for the
    /// "never a title on the lock screen" and "never colour alone" checks.
    var drawnText: [String] {
        switch family {
        case .accessoryInline: return [words]
        case .accessoryCircular: return [countText ?? words]
        default: break
        }
        let largeReadout = Self.showsHeadline(family) ? largeReadout(showing: rows.count) : nil
        return [countText, words, body, readout, largeReadout, updatedText].compactMap { $0 }
            + rows.flatMap { [$0.meta, $0.text].compactMap { $0 } }
            + [footer?.label, footer?.text].compactMap { $0 }
    }

    /// The same content with other words: the test's lever for proving that a
    /// face paints `words` rather than a string of its own.
    func withWords(_ words: String) -> WidgetContent {
        WidgetContent(state: state, family: family, layout: layout, glyph: glyph, eyebrow: eyebrow,
                      countText: countText, caption: caption, words: words, body: body, readout: readout,
                      rows: rows, count: count, oldestText: oldestText, oldestSpoken: oldestSpoken,
                      footer: footer, updatedText: updatedText, inlineText: inlineText, url: url)
    }

    /// Amber only in full colour, and only while something waits on a fresh
    /// snapshot. Elsewhere the count is `.widgetAccentable()` and the words
    /// carry the meaning.
    func countIsAmber(in mode: WidgetRenderingMode) -> Bool {
        state == .waiting && mode == .fullColor
    }

    /// The SE's small face drops the wait dot: 8 + 4 + 107 pt cannot fit its
    /// 116 pt column, and the amber numeral and the words carry it there.
    var showsDot: Bool { !(family == .systemSmall && layout == .compact) }

    /// Every family the widget offers (`GripWidget.supportedFamilies`), in
    /// the order the in-app guide lists them.
    static let families: [WidgetFamily] = [.systemSmall, .systemMedium, .systemLarge,
                                           .accessoryCircular, .accessoryRectangular, .accessoryInline]

    static func rowLimit(_ family: WidgetFamily, layout: Layout = .standard) -> Int {
        switch family {
        case .systemMedium: layout == .standard ? 2 : 1
        case .systemLarge, .systemExtraLarge: layout == .accessibility ? 2 : WidgetSnapshot.maxItems
        default: 0
        }
    }

    static func showsHeadline(_ family: WidgetFamily) -> Bool {
        family == .systemLarge || family == .systemExtraLarge
    }

    /// The small face carries the age under its words ("oudste 2 dagen"),
    /// and so do the rectangle and the large header; the medium face spends
    /// that line on "en nog N" instead. (At the AX sizes the small and the
    /// large leave it out: `make` decides per layout.)
    static func showsOldest(_ family: WidgetFamily) -> Bool {
        family == .systemSmall || family == .accessoryRectangular || showsHeadline(family)
    }

    static func make(snapshot: WidgetSnapshot?, family: WidgetFamily, now: Date, signedOut: Bool = false,
                     layout: Layout = .standard, standBy: Bool = false) -> WidgetContent {
        func content(_ state: State, glyph: Glyph, count: Int = 0, countText: String? = nil, caption: String,
                     words: String, body: String? = nil, readout: String? = nil, rows: [Line] = [],
                     oldest: (String, String)? = nil, footer: Footer? = nil, updated: String? = nil,
                     inline: String) -> WidgetContent {
            WidgetContent(state: state, family: family, layout: layout, glyph: glyph,
                          eyebrow: state == .signedOut ? "Grip" : "voor jou",
                          countText: countText, caption: caption, words: words, body: body, readout: readout,
                          rows: rows, count: count, oldestText: oldest?.0, oldestSpoken: oldest?.1,
                          footer: footer, updatedText: updated, inlineText: inline, url: inboxURL)
        }
        let large = showsHeadline(family)

        if snapshot == nil, signedOut {
            let words: String = switch family {
            case .accessoryCircular: "log in"
            case .accessoryInline: "Grip · log in"
            default: standBy ? "Log in\nbij Grip" : signedOutText
            }
            let readout: String? = switch family {
            case .systemSmall: standBy ? "afgemeld\nniets bewaard op dit toestel" : "tik en log in"
            case .systemMedium: "afgemeld · niets bewaard op dit toestel"
            case .accessoryRectangular: "om je lijst te zien"
            default: nil
            }
            let body: String? = switch family {
            case .systemMedium: "Open Grip om je lijst te zien."
            case .systemLarge, .systemExtraLarge:
                "Open Grip om je lijst te zien. Na het inloggen staat hier wat er op je wacht."
            default: nil
            }
            return content(.signedOut, glyph: .person, caption: signedOutText, words: words, body: body,
                           readout: readout,
                           footer: large ? Footer(label: "afgemeld", text: "Niets bewaard op dit toestel",
                                                  sensitive: false, url: inboxURL,
                                                  spoken: "Afgemeld. Niets bewaard op dit toestel.") : nil,
                           inline: "Grip · log in")
        }

        guard let snapshot, now.timeIntervalSince(snapshot.updatedAt) < staleAfter else {
            let at = snapshot?.updatedAt
            let words: String = switch family {
            case .accessoryCircular: "oud"
            case .accessoryInline: "Grip · open de app"
            default: standBy ? "Open Grip\nom bij te werken" : staleText
            }
            // Without a snapshot there is no time to give: the line stays away.
            let readout: String? = at.flatMap { at in
                switch family {
                case .systemSmall: standBy ? "laatst bijgewerkt\n\(DutchDate.full(at))" : "bijgewerkt \(DutchDate.dayMonth(at))"
                case .accessoryRectangular: "bijgewerkt \(DutchDate.dayMonth(at))"
                case .systemMedium: "laatst bijgewerkt \(DutchDate.full(at))"
                default: nil
                }
            }
            let body: String? = switch family {
            case .systemMedium: "Grip toont bewust geen oud aantal."
            case .systemLarge, .systemExtraLarge:
                "Grip toont bewust geen oud aantal en geen oude titels. Wat er nu wacht, zie je zodra Grip weer bij is."
            default: nil
            }
            let footer = large ? at.map {
                Footer(label: "laatst bijgewerkt", text: DutchDate.full($0), sensitive: false, url: inboxURL,
                       spoken: "Laatst bijgewerkt \(DutchDate.spoken($0))")
            } : nil
            return content(.stale, glyph: .refresh, caption: staleText, words: words, body: body,
                           readout: readout, footer: footer, inline: "Grip · open de app")
        }

        let count = max(snapshot.count, 0)
        guard count > 0 else {
            let updated = DutchDate.updated(snapshot.updatedAt, now: now)
            let words: String = switch family {
            case .accessoryCircular: "niets"
            case .accessoryInline: "Grip · niets voor jou"
            default: emptyText
            }
            let readout: String? = switch family {
            case .systemSmall, .systemMedium, .accessoryRectangular: updated
            default: nil
            }
            let body: String? = (family == .systemMedium || large)
                ? "Goed bezig. Grip laat het weten zodra er iets binnenkomt." : nil
            // Nothing waits, so the map has no open stop either (the open stop
            // is one of the waiting items); the footer still answers.
            let footer = large ? Footer(label: headlineLabel, text: snapshot.headline ?? emptyFooter,
                                        sensitive: snapshot.headline != nil,
                                        url: snapshot.headline == nil ? inboxURL : mapURL,
                                        spoken: "Waar het nu op wacht: \(snapshot.headline ?? emptyFooter)") : nil
            return content(.empty, glyph: .check, caption: emptyText, words: words, body: body, readout: readout,
                           footer: footer, updated: large ? updated : nil, inline: "Grip · niets voor jou")
        }

        let rows = snapshot.items.prefix(rowLimit(family, layout: layout)).map(line(for:))
        let footer = large ? snapshot.headline.map {
            Footer(label: headlineLabel, text: $0, sensitive: true, url: mapURL, spoken: "Waar het nu op wacht: \($0)")
        } : nil
        let caption = layout == .accessibility && !large ? "voor jou"
            : count == 1 ? "wacht op jou" : "wachten op jou"
        let oldest = snapshot.oldestAt.map { oldest(since: $0, now: now, single: count == 1) }
        let showsOldest = showsOldest(family) && (layout != .accessibility || standBy)
        let shownOldest = showsOldest ? oldest : nil
        let readout: String? = switch family {
        case .systemSmall, .accessoryRectangular: shownOldest?.0
        case .systemMedium: rows.count < count ? "en nog \(count - rows.count)" : nil
        default: nil
        }
        let words = family == .accessoryInline ? "Grip · \(count) voor jou"
            : family == .accessoryCircular ? "\(count) \(caption)" : caption
        return content(.waiting, glyph: .tray, count: count, countText: String(count), caption: caption,
                       words: words, readout: readout, rows: Array(rows), oldest: shownOldest, footer: footer,
                       inline: "Grip · \(count) voor jou")
    }

    /// A row: the title, "VOORSTEL · 2 NOV" (a task with a deadline: "TAAK ·
    /// VÓÓR 3 NOV"), and the sentence VoiceOver reads.
    static func line(for item: WidgetSnapshot.Item) -> Line {
        let kind = KindLabel.dutch(item.kind)
        var meta = kind.uppercased()
        var spoken = "\(kind), \(item.title)"
        if item.kind == "task", let due = item.dueAt.flatMap(DutchDate.day(from:)) {
            meta += " · VÓÓR \(DutchDate.dayMonth(due).uppercased())"
            spoken += ", vóór \(DutchDate.spokenDay(due))"
        } else if let at = item.at {
            meta += " · \(DutchDate.dayMonth(at).uppercased())"
            spoken += ", \(DutchDate.spokenDay(at))"
        }
        return Line(text: item.title, meta: meta, sensitive: true, url: url(for: item), spoken: spoken)
    }

    /// The exact item. `DeepLink.parse` accepts only a UUID, so anything else
    /// (the map's stop, an unknown kind, a malformed id) opens Voor jou rather
    /// than becoming a tap that does nothing.
    static func url(for item: WidgetSnapshot.Item) -> URL {
        guard let id = UUID(uuidString: item.id) else { return inboxURL }
        let host: String
        switch item.kind {
        case "proposal", "question": host = "proposal"
        case "request": host = "request"
        case "suggestion": host = "suggestion"
        case "task": host = "task"
        default: return inboxURL
        }
        return URL(string: "grip://\(host)/\(id.uuidString.lowercased())") ?? inboxURL
    }

    /// From two weeks on the age reads in whole weeks ("oudste 6 wk"): a
    /// three-digit day count is noise beside a three-digit item count.
    static let weeksFrom = 14

    /// Whole calendar days in Amsterdam, the case's clock. One item reads
    /// "sinds", more read "oudste". Returns the drawn and the spoken form.
    static func oldest(since: Date, now: Date, single: Bool = false) -> (String, String) {
        let days = DutchDate.daysBetween(since, now)
        let word = single ? "sinds" : "oudste"
        switch days {
        case 0: return single ? ("sinds vandaag", "sinds vandaag") : ("oudste van vandaag", "oudste van vandaag")
        case 1: return ("\(word) 1 dag", "\(word) 1 dag")
        case ..<weeksFrom: return ("\(word) \(days) dagen", "\(word) \(days) dagen")
        default:
            let weeks = days / 7
            return ("\(word) \(weeks) wk", "\(word) \(weeks) weken")
        }
    }

    /// The old spelling, kept for callers that want the drawn form only.
    static func oldest(since: Date, now: Date) -> String { oldest(since: since, now: now, single: false).0 }
}

/// The widget's second face, for StandBy's right-hand stack (and the home
/// screen's small box): "waar het nu op wacht" — the map's open stop, its
/// spoor and its date. The stop is case content and `sensitive`; under the
/// privacy redaction the view says "ontgrendel om te zien" in its place.
struct HeadlineContent: Equatable {
    let label: String
    let text: String
    /// "Opstart bewind · 28 okt", "geen open stap", "bijgewerkt 31 okt".
    let sub: String?
    let sensitive: Bool
    /// The quiet empty statement ("Nergens op. …") draws Regular in ink-soft,
    /// never as a second hero beside "Niets wacht op je".
    let quiet: Bool
    let url: URL
    let spoken: String

    static let lockedText = "ontgrendel om te zien"

    static func make(snapshot: WidgetSnapshot?, now: Date, signedOut: Bool = false) -> HeadlineContent {
        let label = WidgetContent.headlineLabel
        if snapshot == nil, signedOut {
            return HeadlineContent(label: "Grip", text: WidgetContent.signedOutText, sub: "om je lijst te zien",
                                   sensitive: false, quiet: false, url: WidgetContent.inboxURL,
                                   spoken: WidgetContent.signedOutText)
        }
        guard let snapshot, now.timeIntervalSince(snapshot.updatedAt) < WidgetContent.staleAfter else {
            return HeadlineContent(label: label, text: WidgetContent.staleText,
                                   sub: snapshot.map { "bijgewerkt \(DutchDate.dayMonth($0.updatedAt))" },
                                   sensitive: false, quiet: false, url: WidgetContent.inboxURL,
                                   spoken: WidgetContent.staleText)
        }
        guard let headline = snapshot.headline else {
            return HeadlineContent(label: label, text: WidgetContent.emptyFooter, sub: "geen open stap",
                                   sensitive: false, quiet: true, url: WidgetContent.mapURL,
                                   spoken: "Waar het nu op wacht: nergens op. Je bent helemaal bij.")
        }
        let sub = [snapshot.headlineTrack, snapshot.headlineAt.map(DutchDate.dayMonth)].compactMap { $0 }
        let spokenSub = [snapshot.headlineTrack, snapshot.headlineAt.map(DutchDate.spokenDay)].compactMap { $0 }
        return HeadlineContent(label: label, text: headline, sub: sub.isEmpty ? nil : sub.joined(separator: " · "),
                               sensitive: true, quiet: false, url: WidgetContent.mapURL,
                               spoken: (["Waar het nu op wacht: \(headline)"] + spokenSub).joined(separator: ", "))
    }
}

/// Dates on the case's clock (Amsterdam), in Dutch, with no locale data the
/// widget extension might lack: "2 nov", "za 31 okt 14:02", "08:12".
enum DutchDate {
    static let months = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"]
    static let monthsLong = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus",
                             "september", "oktober", "november", "december"]
    static let weekdays = ["zo", "ma", "di", "wo", "do", "vr", "za"]

    static var calendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Amsterdam") ?? .current
        return cal
    }

    static func daysBetween(_ from: Date, _ to: Date) -> Int {
        let cal = calendar
        return max(cal.dateComponents([.day], from: cal.startOfDay(for: from), to: cal.startOfDay(for: to)).day ?? 0, 0)
    }

    static func dayMonth(_ date: Date) -> String {
        let c = calendar.dateComponents([.day, .month], from: date)
        return "\(c.day ?? 0) \(months[((c.month ?? 1) - 1) % 12])"
    }

    static func spokenDay(_ date: Date) -> String {
        let c = calendar.dateComponents([.day, .month], from: date)
        return "\(c.day ?? 0) \(monthsLong[((c.month ?? 1) - 1) % 12])"
    }

    static func time(_ date: Date) -> String {
        let c = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    /// "za 31 okt 14:02".
    static func full(_ date: Date) -> String {
        let weekday = calendar.component(.weekday, from: date)
        return "\(weekdays[(weekday - 1) % 7]) \(dayMonth(date)) \(time(date))"
    }

    static func spoken(_ date: Date) -> String { "\(spokenDay(date)) om \(time(date))" }

    /// "bijgewerkt 08:12" today, "bijgewerkt 31 okt" on an earlier day.
    static func updated(_ date: Date, now: Date) -> String {
        calendar.isDate(date, inSameDayAs: now) ? "bijgewerkt \(time(date))" : "bijgewerkt \(dayMonth(date))"
    }

    /// A deadline as the server spells it: a plain day ("2026-11-03") is that
    /// day in Amsterdam; an ISO instant is the Amsterdam day it falls on.
    static func day(from raw: String) -> Date? {
        if raw.count == 10 {
            let parts = raw.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3 else { return nil }
            return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
        }
        let plain = ISO8601DateFormatter()
        if let d = plain.date(from: raw) { return d }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: raw)
    }
}
