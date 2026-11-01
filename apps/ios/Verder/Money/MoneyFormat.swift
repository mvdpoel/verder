import Foundation

/// How money and the case's calendar read on the phone. Pure and locale-free:
/// the strings are spelled here rather than asked of a formatter, so a
/// simulator set to English renders exactly what Martin's phone does.
///
/// MONEY IS INTEGER CENTS. `euro` splits with integer division and never goes
/// near `Double` — the same discipline as `money.ts` on the server.
enum MoneyFormat {
    /// "€ 1.234,56"; a negative reads "−€ 62,40" (a real minus sign).
    static func euro(cents: Int) -> String {
        let magnitude = cents.magnitude // UInt: Int.min has no Int magnitude
        let whole = magnitude / 100, fraction = magnitude % 100
        let digits = String(whole)
        var grouped = ""
        for (i, ch) in digits.enumerated() {
            if i > 0 && (digits.count - i) % 3 == 0 { grouped.append(".") }
            grouped.append(ch)
        }
        let amount = "€ \(grouped),\(fraction < 10 ? "0" : "")\(fraction)"
        return cents < 0 ? "−\(amount)" : amount
    }

    static let weekdays = ["zo", "ma", "di", "wo", "do", "vr", "za"]
    static let months = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"]

    /// A civil day "YYYY-MM-DD" (the server's Amsterdam day key) → "29 okt".
    static func day(_ key: String) -> String? {
        guard let c = civil(key) else { return nil }
        return "\(c.day) \(months[c.month - 1])"
    }

    /// "do 29 okt". The weekday is computed from the date on a fixed UTC
    /// Gregorian calendar — a day key is a civil day, so no zone applies.
    static func dayWithWeekday(_ key: String) -> String? {
        guard let c = civil(key), let d = day(key) else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        guard let date = cal.date(from: DateComponents(year: c.year, month: c.month, day: c.day, hour: 12))
        else { return nil }
        return "\(weekdays[cal.component(.weekday, from: date) - 1]) \(d)"
    }

    /// "2026-10" → "okt '26", as /money's columns read.
    static func month(_ key: String) -> String? {
        let parts = key.split(separator: "-")
        guard parts.count == 2, parts[0].count == 4, parts[1].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), (1...12).contains(month) else { return nil }
        return "\(months[month - 1]) '\(String(format: "%02d", year % 100))"
    }

    /// A booking instant on Amsterdam's calendar → "19 aug".
    static func day(_ date: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
        let c = cal.dateComponents([.day, .month], from: date)
        return "\(c.day ?? 0) \(months[(c.month ?? 1) - 1])"
    }

    /// "NL00 TEST 0123 4567 89".
    static func iban(_ iban: String) -> String {
        var out = ""
        for (i, ch) in iban.enumerated() {
            if i > 0 && i % 4 == 0 { out.append(" ") }
            out.append(ch)
        }
        return out
    }

    /// "…6789": enough to tell two accounts apart at a glance.
    static func ibanTail(_ iban: String) -> String { "…\(iban.suffix(4))" }

    private static func civil(_ key: String) -> (year: Int, month: Int, day: Int)? {
        let parts = key.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
              (1...12).contains(m), (1...31).contains(d) else { return nil }
        return (y, m, d)
    }
}
