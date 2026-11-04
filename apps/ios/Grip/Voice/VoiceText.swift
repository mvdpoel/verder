import Foundation

/// The voice note's words that are pure functions of data: what the
/// transcript names (party, channel), the summary the server will write, the
/// picker's sections and the screen's small formatted lines. No view, no
/// state — `VoiceTextTests` pins each.
enum VoiceText {
    // MARK: - Reading the transcript

    /// What the transcript itself says about the call.
    struct Reading: Equatable {
        var partyId: String?
        var partyRange: Range<String.Index>?
        var channel: VoiceChannel?
        var channelRange: Range<String.Index>?
    }

    /// Words that name how the conversation went. Whole words only, case
    /// and accents folded; the first one in the text wins.
    static let channelWords: [(VoiceChannel, [String])] = [
        (.call, ["gebeld", "opgebeld", "teruggebeld", "belde", "telefonisch", "telefoongesprek"]),
        (.meeting, ["langs geweest", "langsgeweest", "op bezoek", "bezoek", "op kantoor", "afspraak gehad"]),
        (.voicemail, ["voicemail", "ingesproken"]),
        (.whatsapp, ["whatsapp", "geappt", "appje"]),
    ]

    /// A party is recognised ONLY by its full name (or its organisation),
    /// as a whole phrase: "Lindehof" alone never picks "Woonstichting
    /// Lindehof", so a near-equal name can never win over "laatst
    /// gesproken". The longest name found wins, then the earliest.
    static func read(_ transcript: String, parties: [PartyDTO]) -> Reading {
        var reading = Reading()
        var best: (id: String, range: Range<String.Index>)?
        for party in parties {
            for name in [party.name, party.organization].compactMap({ $0 }) where name.count >= 3 {
                guard let range = phrase(name, in: transcript) else { continue }
                if let b = best {
                    let longer = transcript[range].count > transcript[b.range].count
                    let sameLengthEarlier = transcript[range].count == transcript[b.range].count
                        && range.lowerBound < b.range.lowerBound
                    if !(longer || sameLengthEarlier) { continue }
                }
                best = (party.id, range)
            }
        }
        reading.partyId = best?.id
        reading.partyRange = best?.range
        var first: (VoiceChannel, Range<String.Index>)?
        for (channel, words) in channelWords {
            for word in words {
                guard let range = phrase(word, in: transcript) else { continue }
                if first == nil || range.lowerBound < first!.1.lowerBound { first = (channel, range) }
            }
        }
        reading.channel = first?.0
        reading.channelRange = first?.1
        return reading
    }

    /// `needle` as a whole phrase in `text`: case- and accent-insensitive,
    /// never inside a longer word.
    static func phrase(_ needle: String, in text: String) -> Range<String.Index>? {
        var from = text.startIndex
        while let r = text.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive], range: from..<text.endIndex) {
            let before = r.lowerBound == text.startIndex ? nil : text[text.index(before: r.lowerBound)]
            let after = r.upperBound == text.endIndex ? nil : text[r.upperBound]
            let edge: (Character?) -> Bool = { c in c.map { !($0.isLetter || $0.isNumber) } ?? true }
            if edge(before) && edge(after) { return r }
            from = r.upperBound
        }
        return nil
    }

    // MARK: - The summary (packages/api/src/voice-summary.ts)

    static let summaryMax = 120
    static let emptySummary = "Gesprek (spraaknotitie)"

    /// The server's `voiceSummary`, so the sent card shows the title Voor
    /// jou will: the first sentence, cut at 120 on a word boundary.
    static func summary(_ transcript: String) -> String {
        let text = transcript.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !text.isEmpty else { return emptySummary }
        var sentence = text
        var i = text.startIndex
        while i < text.endIndex {
            let c = text[i]
            let next = text.index(after: i)
            if ".!?".contains(c), next == text.endIndex || text[next].isWhitespace {
                sentence = String(text[...i])
                break
            }
            i = next
        }
        // A title, not a sentence: its closing full stop goes (frame "staat
        // in Voor jou"). "?" and "!" stay, they carry meaning.
        if sentence.count > 1, sentence.hasSuffix("."), !sentence.hasSuffix("..") { sentence.removeLast() }
        guard sentence.count > summaryMax else { return sentence }
        let room = String(sentence.prefix(summaryMax - 1))
        var kept = room
        if let space = room.lastIndex(of: " "), space > room.startIndex { kept = String(room[..<space]) }
        while let last = kept.last, last.isWhitespace || ",;:".contains(last) { kept.removeLast() }
        return kept + "…"
    }

    // MARK: - The picker

    struct Sections: Equatable {
        var recent: [PartyDTO]
        var all: [PartyDTO]
    }

    /// "RECENT": up to three parties Martin was last in contact with (the
    /// route's order); "ALLE PARTIJEN · A–Z": the rest, by name. A search
    /// filters both on name or organisation.
    static func sections(_ parties: [PartyDTO], query: String, recentCount: Int = 3) -> Sections {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let shown = q.isEmpty ? parties : parties.filter { p in
            [p.name, p.organization].compactMap { $0 }
                .contains { $0.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
        }
        let recent = Array(shown.filter { $0.lastContactAt != nil }.prefix(recentCount))
        let ids = Set(recent.map(\.id))
        let rest = shown.filter { !ids.contains($0.id) }
            .sorted { $0.name.compare($1.name, options: [.caseInsensitive, .diacriticInsensitive], locale: dutch) == .orderedAscending }
        return Sections(recent: recent, all: rest)
    }

    // MARK: - Formatting

    static let dutch = Locale(identifier: "nl_NL")

    static var calendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = ProposalFormat.amsterdam
        cal.locale = dutch
        return cal
    }

    /// "0:14", "12:03", "1:02:09".
    static func elapsed(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        if s >= 3600 { return String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60) }
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    /// "14:20", Amsterdam's clock.
    static func time(_ date: Date) -> String {
        let c = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    /// "VANDAAG", "GISTEREN" or "ZA 31 OKT", on Amsterdam's calendar.
    static func day(_ date: Date, now: Date) -> String {
        let cal = calendar
        if cal.isDate(date, inSameDayAs: now) { return "VANDAAG" }
        if let y = cal.date(byAdding: .day, value: -1, to: now), cal.isDate(date, inSameDayAs: y) { return "GISTEREN" }
        return shortDay(date, weekday: true).uppercased()
    }

    /// "31 okt", or "za 31 okt" with the weekday.
    static func shortDay(_ date: Date, weekday: Bool = false) -> String {
        let cal = calendar
        let c = cal.dateComponents([.day, .month, .weekday], from: date)
        let months = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"]
        let days = ["zo", "ma", "di", "wo", "do", "vr", "za"]
        let d = "\(c.day ?? 1) \(months[((c.month ?? 1) - 1) % 12])"
        return weekday ? "\(days[((c.weekday ?? 1) - 1) % 7]) \(d)" : d
    }

    // MARK: - The time wheel ("tijd wijzigen")

    /// One day on the time wheel: its start on Amsterdam's calendar and its
    /// label — "Vandaag" for today, "za 31 okt" for every earlier day.
    struct WheelDay: Hashable, Sendable {
        let start: Date
        let label: String
    }

    /// The days the wheel offers, oldest first and TODAY LAST: a call is
    /// never in the future, so no later day is listed (frame "tijd
    /// wijzigen": "za 31 okt", "Vandaag", nothing below it).
    static func wheelDays(now: Date, back: Int = 30) -> [WheelDay] {
        let cal = calendar
        let today = cal.startOfDay(for: now)
        return (0...max(0, back)).reversed().compactMap { offset in
            guard let day = cal.date(byAdding: .day, value: -offset, to: today) else { return nil }
            return WheelDay(start: day, label: offset == 0 ? "Vandaag" : shortDay(day, weekday: true))
        }
    }

    /// The day (its start), hour and minute of `date` on Amsterdam's clock.
    static func wheelParts(_ date: Date) -> (day: Date, hour: Int, minute: Int) {
        let cal = calendar
        let c = cal.dateComponents([.hour, .minute], from: date)
        return (cal.startOfDay(for: date), c.hour ?? 0, c.minute ?? 0)
    }

    /// The moment a wheel position names, on Amsterdam's clock.
    static func wheelDate(day: Date, hour: Int, minute: Int) -> Date {
        let cal = calendar
        return cal.date(bySettingHour: min(max(hour, 0), 23), minute: min(max(minute, 0), 59), second: 0, of: day) ?? day
    }

    /// "LAATST 31 OKT".
    static func lastContact(_ date: Date) -> String { "laatst \(shortDay(date))".uppercased() }

    /// "38 VAN 61 MB" (whole megabytes, as the frame).
    static func megabytes(done: Int64, total: Int64) -> String {
        let mb: (Int64) -> Int64 = { ($0 + 500_000) / 1_000_000 }
        return "\(mb(done)) VAN \(mb(total)) MB"
    }
}
