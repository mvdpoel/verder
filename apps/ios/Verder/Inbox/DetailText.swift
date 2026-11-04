import Foundation

/// The words the three detail screens one level under Voor jou share (Figma
/// "detail · final": Vraag, Suggestie, Taak), as pure functions on the
/// Amsterdam calendar. No SwiftUI here, so every date and phrase the screens
/// show is unit-tested (`DetailTextTests`).
///
/// Dates are glued with NO-BREAK spaces ("zo 1 nov"): a line may break
/// beside a date, never inside it (the final frames' U+00A0).
enum DetailText {
    static let nbsp = ProposalText.nbsp
    static let amsterdam = ProposalFormat.amsterdam

    static let weekdays = ["zo", "ma", "di", "wo", "do", "vr", "za"]

    private static var calendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = amsterdam
        return cal
    }

    /// "zo 1 nov".
    static func dayName(_ date: Date) -> String {
        let c = calendar.dateComponents([.weekday], from: date)
        let wd = weekdays[max(0, min(6, (c.weekday ?? 1) - 1))]
        return "\(wd) \(ProposalText.dayMonthName(date))".replacingOccurrences(of: " ", with: nbsp)
    }

    /// "zo 1 nov · 14:02": when something was decided.
    static func stamp(_ date: Date) -> String {
        "\(dayName(date)) · \(ProposalText.clock(date))"
    }

    /// "di 3 nov 2026 · 17:00": a deadline with its time, as the cards set it.
    static func longDateTime(_ date: Date) -> String {
        let year = calendar.component(.year, from: date)
        return "\(dayName(date))\(nbsp)\(year) · \(ProposalText.clock(date))"
    }

    /// Whole Amsterdam calendar days from `from` to `to` (negative when `to`
    /// is earlier).
    static func days(from: Date, to: Date) -> Int {
        let cal = calendar
        return cal.dateComponents([.day], from: cal.startOfDay(for: from), to: cal.startOfDay(for: to)).day ?? 0
    }

    /// "sinds vandaag", "sinds 1 dag", "sinds 3 dagen": how long it has waited,
    /// counted in calendar days.
    static func age(since date: Date, now: Date) -> String {
        let d = max(0, days(from: date, to: now))
        switch d {
        case 0: return "sinds vandaag"
        case 1: return "sinds\(nbsp)1\(nbsp)dag"
        default: return "sinds\(nbsp)\(d)\(nbsp)dagen"
        }
    }

    /// The line under a deadline: "vandaag", "morgen", "over 2 dagen",
    /// "gisteren", "3 dagen te laat".
    static func relativeDue(_ due: Date, now: Date) -> String {
        let d = days(from: now, to: due)
        switch d {
        case 0: return "vandaag"
        case 1: return "morgen"
        case -1: return "gisteren"
        case let n where n > 1: return "over \(n) dagen"
        default: return "\(-d) dagen te laat"
        }
    }

    /// "OFFLINE · BIJGEWERKT 14:02": the copy on screen and when it was loaded.
    static func offlineStamp(loadedAt: Date, now: Date) -> String {
        let at = ProposalText.stamp(loadedAt, now: now).replacingOccurrences(of: " ", with: nbsp)
        return "Offline · bijgewerkt\(nbsp)\(at)"
    }

    /// "Volgende in Voor jou · 3".
    static func nextLabel(remaining: Int) -> String { "Volgende in Voor jou ·\(nbsp)\(remaining)" }

    /// The first word in capitals: "gedaan" → "Gedaan".
    static func capitalised(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }
}

/// What "Volgende in Voor jou" opens: the first waiting item in the SERVER's
/// order that is not the one just decided, and how many are left besides it.
/// A deliberate tap, never an automatic step (plan 3: no auto-advance).
enum VoorJouNextPick {
    static func pick(items: [WaitingItem], excluding id: String) -> (route: InboxRoute, remaining: Int)? {
        let others = items.filter { $0.id.lowercased() != id.lowercased() }
        let routable = others.compactMap { InboxRoute($0) }
        guard let first = routable.first else { return nil }
        return (first, routable.count)
    }
}
