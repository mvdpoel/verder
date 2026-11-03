import Foundation

/// What the Overzicht tab says, decided outside the view so it is testable.
///
/// EVERY NUMBER HERE IS THE SERVER'S: the waiting count is `loadWaiting`
/// (packages/api/src/waiting.ts) as the inbox route serves it — the same number
/// the badge, the widget and Voor jou show — and the task counts and the map
/// headline are `/dashboard/summary`. The phone adds nothing up itself.
///
/// AMBER ONLY for what waits on Martin: the waiting card when it is non-zero,
/// and overdue tasks ("1 te laat" and its dot); never the money card, never
/// "Door verder gedaan", never the map, never the scan queue.
///
/// THE CASE'S CALENDAR is Amsterdam's, whatever zone the phone is in, and the
/// board stores instants, never formatted strings: every age ("vandaag",
/// "gisteren", "vr 30 okt") is worked out against `now` on display, so a board
/// kept from yesterday reads as yesterday's (Figma it4, F8).
enum HomeSummary {
    static let title = "Overzicht"
    static let waitingLabel = "Wacht op jou"
    static let leefgeldLabel = "Leefgeld"
    static let headlineLabel = "Waar het nu op wacht"
    static let moneyLabel = "Geld"
    static let nothingWaiting = "Niets wacht op je."
    static let calmBody = "Alles wat bij jou lag, is gedaan —\ngoed bezig."
    static let reveal = "Toon details"
    /// NBSP in "Face ID": it never breaks over two lines.
    static let lockedFootnote = "Titels en de kaart verschijnen na Face\u{00A0}ID."
    static let headlineHint = "Opent de tijdlijn"
    static let retry = "Opnieuw proberen"
    /// How long the board waits before it asks the server again — after a
    /// failure, and while it is on screen. The error copy promises it.
    static let pollInterval: TimeInterval = 60
    /// From this many waiting items the card adds a line that says it is fine
    /// not to do them all at once.
    static let manyThreshold = 50

    static let amsterdam = TimeZone(identifier: "Europe/Amsterdam")!
    static var calendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = amsterdam
        return cal
    }

    static let weekdaysLong = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"]

    // MARK: - Words, dates and ages

    /// "zondag 1 nov" — the eyebrow's day.
    static func longDay(_ date: Date) -> String {
        let c = calendar.dateComponents([.weekday, .day, .month], from: date)
        return "\(weekdaysLong[(c.weekday ?? 1) - 1]) \(c.day ?? 0) \(MoneyFormat.months[(c.month ?? 1) - 1])"
    }

    /// "28 okt", in Amsterdam. No year: the board is about now.
    static func day(_ date: Date) -> String { MoneyFormat.day(date) }

    /// "13:58".
    static func clock(_ date: Date) -> String {
        let c = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    /// "vandaag", "gisteren", else "vr 30 okt". A date AFTER today (a clock
    /// that disagrees with the server's) reads as its day, never as "vandaag".
    static func age(_ date: Date, now: Date) -> String {
        let cal = calendar
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: date), to: cal.startOfDay(for: now)).day ?? 0
        switch days {
        case 0: return "vandaag"
        case 1: return "gisteren"
        default:
            let wd = cal.component(.weekday, from: date)
            return "\(MoneyFormat.weekdays[wd - 1]) \(day(date))"
        }
    }

    /// "13:58" today, "gisteren 22:14", else "za 31 okt 22:14".
    static func stamp(_ date: Date, now: Date) -> String {
        let a = age(date, now: now)
        return a == "vandaag" ? clock(date) : "\(a) \(clock(date))"
    }

    /// The first letter upper-cased: the AX layout writes meta in sentence case.
    static func sentence(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }

    /// Segments of a mono meta line, joined so the line can wrap ONLY after
    /// a " ·" — the dot stays at the end of the first line, never leads the
    /// next: the spaces inside a segment and before each dot are NBSP
    /// (Figma final, finding 5).
    static func metaLine(_ parts: [String]) -> String {
        parts.map { $0.replacingOccurrences(of: " ", with: "\u{00A0}") }.joined(separator: "\u{00A0}· ")
    }

    // MARK: - Eyebrow

    struct Eyebrow: Equatable {
        let text: String
        let offline: Bool
        /// What VoiceOver reads; spelled out for the offline stand.
        let accessibilityLabel: String
    }

    /// The day, or — when the board on screen is an older stand — how old it is.
    static func eyebrow(now: Date, fetchedAt: Date?, error: APIError?) -> Eyebrow {
        let today = longDay(now)
        guard let error, error != .unauthorized, let fetchedAt else {
            return Eyebrow(text: today, offline: false, accessibilityLabel: today)
        }
        let stand = stamp(fetchedAt, now: now)
        if case .transport = error {
            return Eyebrow(text: "offline · bijgewerkt \(stand)", offline: true,
                           accessibilityLabel: "Offline. Dit is de stand van \(stand).")
        }
        return Eyebrow(text: "\(today) · bijgewerkt \(stand)", offline: false,
                       accessibilityLabel: "\(today), bijgewerkt \(stand)")
    }

    // MARK: - Wacht op jou

    /// How many rows the card previews: three; two on a short screen (the
    /// iPhone SE); one at the accessibility sizes, where one title fills the
    /// screen (Figma it6: "AX3 and larger: 1 row instead of 3").
    static func previewLimit(accessibilitySize: Bool, compactHeight: Bool) -> Int {
        accessibilitySize ? 1 : compactHeight ? 2 : 3
    }

    /// The first items in the SERVER's order — never re-ranked here. Empty
    /// while the app is locked: the glance shows counts, never titles.
    static func preview(_ inbox: InboxDTO, revealed: Bool, limit: Int = 3) -> [WaitingItem] {
        revealed ? Array(inbox.items.prefix(limit)) : []
    }

    /// The words under the hero number: "ding wacht op je" / "dingen wachten op je".
    static func countCaption(_ count: Int) -> String {
        count == 1 ? "ding wacht op je" : "dingen wachten op je"
    }

    /// The whole sentence, for VoiceOver and the widget's sense of it.
    static func waitingLine(_ count: Int) -> String {
        count == 0 ? nothingWaiting : "\(count) \(countCaption(count))"
    }

    /// Only for a long list: permission to start at the top.
    static func manyHint(_ count: Int, shown: Int) -> String? {
        guard count >= manyThreshold else { return nil }
        let top = switch shown {
        case 3: "Begin bij de bovenste drie."
        case 2: "Begin bij de bovenste twee."
        default: "Begin bovenaan."
        }
        return "Veel, maar niet alles tegelijk. \(top)"
    }

    /// "Alle 10 bekijken", the number bound to its word.
    static func seeAll(_ count: Int) -> String { "Alle \(count)\u{00A0}bekijken" }

    /// A preview row's meta: kind · who · age. `subtitle` is the server's
    /// (the party for a proposal or question, the suggestion's kind label).
    static func meta(_ item: WaitingItem, now: Date) -> [String] {
        [VoorJouList.kindLabel(item.kind), item.subtitle, age(item.at, now: now)].compactMap { s in
            guard let s, !s.isEmpty else { return nil }
            return s
        }
    }

    /// One row, read whole: kind, title, who, "wacht op jou", age.
    static func rowAccessibilityLabel(_ item: WaitingItem, now: Date) -> String {
        let m = meta(item, now: now)
        var parts = [m.first ?? "", item.title]
        if item.subtitle?.isEmpty == false, m.count == 3 { parts.append(m[1]) }
        parts += ["wacht op jou", m.last ?? ""]
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }

    // MARK: - The rest card: tasks, scans, Door verder gedaan

    struct Row: Equatable {
        let title: String
        /// Drawn amber after the title ("1 te laat"); nil when nothing is late.
        let amberSuffix: String?
        let meta: [String]
        /// The amber dot in the gutter: only for overdue tasks.
        var dot: Bool { amberSuffix != nil }

        var accessibilityLabel: String {
            ([title, amberSuffix].compactMap { $0 } + meta).joined(separator: ", ")
        }
    }

    /// "6 taken voor jou · 1 te laat" / "TAKEN · VOLGENDE 3 NOV". The next
    /// deadline is the earliest still-coming `dueAt` among the waiting tasks;
    /// without one the meta says how many wait on someone else.
    static func tasksRow(_ t: DashboardSummaryDTO.Tasks, inbox: InboxDTO?, now: Date) -> Row {
        let title = switch t.openCount {
        case 0: "Geen taken voor jou"
        case 1: "1 taak voor jou"
        default: "\(t.openCount) taken voor jou"
        }
        let start = calendar.startOfDay(for: now)
        let next = (inbox?.items ?? [])
            .filter { $0.kind == .task }
            .compactMap { $0.dueAt.flatMap(parseISODate) }
            .filter { $0 >= start }
            .min()
        var meta = ["taken"]
        if let next, t.openCount > 0 {
            meta.append("volgende \(day(next))")
        } else if t.waitingOnOthersCount > 0 {
            meta.append(t.waitingOnOthersCount == 1 ? "1 wacht op een ander" : "\(t.waitingOnOthersCount) wachten op een ander")
        }
        return Row(title: title, amberSuffix: t.overdueCount > 0 ? "\(t.overdueCount) te laat" : nil, meta: meta)
    }

    /// "Vandaag 2 verstuurd · 1 in de wachtrij". The queue is the phone's own,
    /// so it is live even when the server is not; offline, what is queued is
    /// waiting for a connection, and the line says so.
    static func scansRow(_ q: QueueSummary, offline: Bool) -> Row {
        var parts: [String] = []
        if q.sentToday > 0 { parts.append("Vandaag \(q.sentToday) verstuurd") }
        if q.underway > 0 { parts.append(offline ? "\(q.underway) wacht op verbinding" : "\(q.underway) in de wachtrij") }
        if q.failed > 0 { parts.append("\(q.failed) mislukt") }
        return Row(title: parts.isEmpty ? "Vandaag nog niets gescand" : parts.joined(separator: " · "),
                   amberSuffix: nil, meta: ["scans"])
    }

    /// "Door verder gedaan · 3" / "2 OPGEBORGEN · 1 HERNOEMD". Counts only, so
    /// it shows while locked. NEVER AMBER: what verder already did does not
    /// wait on Martin.
    static func doneRow(_ inbox: InboxDTO) -> Row {
        let all = inbox.doneByVerder
        guard !all.isEmpty else {
            return Row(title: DoneByVerderCopy.title, amberSuffix: nil,
                       meta: [String(DoneByVerderCopy.none.dropLast())])
        }
        let filed = all.count { $0.kind == "auto-file" }
        let renamed = all.count { $0.kind == "auto-name" }
        let other = all.count - filed - renamed
        let meta = [filed > 0 ? "\(filed) opgeborgen" : nil, renamed > 0 ? "\(renamed) hernoemd" : nil,
                    other > 0 ? "\(other) overig" : nil].compactMap { $0 }
        return Row(title: "\(DoneByVerderCopy.title) · \(all.count)", amberSuffix: nil, meta: meta)
    }

    /// Where a tap on "Door verder gedaan" leads; nil when there is nothing.
    static func doneOpens(_ inbox: InboxDTO) -> InboxRoute? {
        inbox.doneByVerder.isEmpty ? nil : .doneByVerder
    }

    /// The cards Overzicht draws, so their tint is decided in ONE place the
    /// view reads, never hard-coded per card.
    enum Card: CaseIterable { case waiting, money, done, tasks, scans, headline }

    /// Whether a card's label is drawn amber. Amber means "waits on Martin",
    /// so only the waiting card can be amber, and only when something waits.
    static func cardAmber(_ card: Card, inbox: InboxDTO?) -> Bool {
        switch card {
        case .waiting: (inbox?.count ?? 0) > 0
        case .money, .done, .tasks, .scans, .headline: false
        }
    }

    // MARK: - The map headline

    /// "Opstart bewind · 28 okt".
    static func headlineMeta(_ h: DashboardSummaryDTO.Headline) -> [String] {
        [h.trackTitle, h.happenedAt.map(day)].compactMap { $0 }
    }

    // MARK: - Errors

    struct ErrorNotice: Equatable {
        /// The one line of the strip above a kept board.
        let strip: String
        /// The first-time card's headline, broken where it reads best.
        let headline: String
        let body: String
        /// "SERVER 503 · VOLGENDE POGING 14:06".
        let readout: [String]
        /// What to do if waiting does not help.
        let step: String?
    }

    /// Nil when there is nothing to say: no error, or a 401 (the app signs out).
    static func errorNotice(_ error: APIError?, attemptedAt: Date?) -> ErrorNotice? {
        guard let error, error != .unauthorized else { return nil }
        let next = attemptedAt.map { "volgende poging \(clock($0.addingTimeInterval(pollInterval)))" }
        let cause: String
        switch error {
        case .transport:
            return ErrorNotice(
                strip: "Geen verbinding.",
                headline: "Je bent nu\noffline.",
                body: "Zodra er weer verbinding is, haalt verder het overzicht op. Er gaat niets verloren; scans in de wachtrij gaan daarna vanzelf mee.",
                readout: ["offline", next].compactMap { $0 },
                step: nil)
        case .server(let code), .rejected(let code): cause = "server \(code)"
        case .rateLimited: cause = "te veel verzoeken"
        case .unauthorized: return nil
        }
        return ErrorNotice(
            strip: "Overzicht nu niet op te halen.",
            headline: "Het overzicht is nu\nniet op te halen.",
            body: "De server van verder werkt even niet. Er gaat niets verloren; verder probeert het elke minuut opnieuw.",
            readout: [cause, next].compactMap { $0 },
            step: "Lukt het na een paar minuten nog niet? Kijk dan of de server thuis aanstaat.")
    }
}

// MARK: - Hyphenation

extension HomeSummary {
    /// A fresh CFLocale per use: CFLocale is not Sendable, so no shared one.
    static let minHyphenatedLength = 10
    static var dutch: CFLocale { Locale(identifier: "nl_NL") as CFLocale }

    /// Soft hyphens (U+00AD) at every Dutch hyphenation point, from the
    /// system's own dictionary, so a long word that must break at AX5 breaks
    /// as "Bewind-kantoor" and never as "Bewindkantoo / r" (Figma it4, F2).
    /// A soft hyphen is invisible unless the line breaks there. Only words of
    /// 10+ letters get them — the compounds that cannot fit a line at AX5;
    /// a shorter word ("wachten") moves to the next line whole instead of
    /// being split where it did not need to be.
    static func hyphenated(_ text: String) -> String {
        guard CFStringIsHyphenationAvailableForLocale(dutch) else { return text }
        var out = ""
        for (i, word) in text.split(separator: " ", omittingEmptySubsequences: false).enumerated() {
            if i > 0 { out.append(" ") }
            out += hyphenatedWord(String(word))
        }
        return out
    }

    /// Leading and trailing punctuation ("leefgeldrekening.") is set aside:
    /// the dictionary only answers for the letters.
    private static func hyphenatedWord(_ word: String) -> String {
        let lead = word.prefix { !$0.isLetter }
        let rest = word.dropFirst(lead.count)
        let core = String(rest.reversed().drop { !$0.isLetter }.reversed())
        let trail = rest.dropFirst(core.count)
        return String(lead) + hyphenatedLetters(core) + String(trail)
    }

    private static func hyphenatedLetters(_ word: String) -> String {
        let ns = word as NSString
        guard ns.length >= minHyphenatedLength else { return word }
        let cf = word as CFString
        let dutch = dutch
        var points: [Int] = []
        var index = ns.length
        while index > 0 {
            var hyphen: UTF32Char = 0
            let at = CFStringGetHyphenationLocationBeforeIndex(cf, index, CFRange(location: 0, length: ns.length),
                                                               0, dutch, &hyphen)
            guard at != kCFNotFound, at > 1, at < ns.length - 1 else { break }
            points.append(at)
            index = at
        }
        guard !points.isEmpty else { return word }
        let result = NSMutableString(string: word)
        for p in points { result.insert("\u{00AD}", at: p) } // descending, so earlier indices hold
        return result as String
    }
}
