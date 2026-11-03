import Foundation

/// Everything the Geld screen says, decided outside the view (Figma
/// "money · final", Geld frames). The figures are `money-series.ts`'s; this
/// only words and shapes them, and the view only lays them out.
///
/// ACCOUNTS ARE NEVER MERGED. One `GeldAccount` per account in the server's
/// order, each with its OWN six months, its own chart scale and its own sheet.
/// There is no total across accounts here and none may be added.
///
/// Text is stored in lower/sentence case. The mono meta lines are drawn
/// upper-case at the ordinary sizes and in sentence case at the accessibility
/// sizes (the frames' rule), which is the view's one decision.
struct GeldAccount: Equatable, Identifiable, Sendable {
    /// "Beheerrekening", "Leefgeldrekening", "Rekening", "Onbekende rekening".
    let title: String
    /// "··6789"; nil for the unknown-account series.
    let tail: String?
    /// "nieuwste boeking za 24 okt"; nil when the server did not say.
    let newestLine: String?
    /// "Inkomen" on most accounts; "Ontvangen" on the leefgeldrekening, whose
    /// money arrives as a weekly amount rather than as income.
    let inTitle: String
    let months: [GeldMonth]
    /// The month the chart opens on: the newest with data, else the newest.
    let defaultSelection: Int
    /// "€ 2.400" over the chart: this account's own largest month, in euros.
    let scaleLabel: String?
    /// "2 posten · 1 maand deels".
    let disclosureMeta: String
    let sheet: GeldSheet
    let id: String

    static let disclosureTitle = "Wat niet in de balken zit"

    /// "Beheer\u{AD}rekening": at the accessibility sizes an account name may
    /// break ONLY at its compound, never as "Beheerreken-ing" (Figma it4).
    static func compoundHyphenated(_ title: String) -> String {
        let tail = "rekening"
        guard title.count > tail.count, title.hasSuffix(tail) else { return title }
        // WORD JOINER between every other letter: the system's own
        // hyphenation would otherwise prefer "Beheerreken-ing", a later break.
        func joined(_ s: Substring) -> String { s.map(String.init).joined(separator: "\u{2060}") }
        return joined(title.dropLast(tail.count)) + "\u{AD}" + joined(Substring(tail))
    }

    var legend: [String] { [inTitle.lowercased(), "uitgegeven"] }
    var showsPartialLegend: Bool { months.contains { $0.coverage == .partial } }

    /// "Beheerrekening, eindigend op 6789" — the VoiceOver heading.
    var accessibilityTitle: String {
        guard let id = tail else { return title }
        return "\(title), eindigend op \(id.dropFirst(2))"
    }

    init(_ account: MoneySummaryDTO.Account, name: String) {
        id = account.accountIban ?? "onbekend"
        title = name
        tail = account.accountIban.map(MoneyFormat.ibanDots)
        let newest = account.newestBooking
        newestLine = newest.flatMap(MoneyFormat.dayWithWeekday).map { "nieuwste boeking \($0)" }
        inTitle = account.isLeefgeldAccount ? "Ontvangen" : "Inkomen"

        let covered = account.months.filter { $0.coverage != .none }
        let peak = covered.map { max($0.inCents, $0.outCents) }.max() ?? 0
        scaleLabel = peak > 0 ? MoneyFormat.euroWhole(cents: peak) : nil
        let inTitle = inTitle
        months = account.months.map { GeldMonth($0, peak: peak, newestBooking: newest, inTitle: inTitle) }
        defaultSelection = months.lastIndex { $0.coverage != .none } ?? max(0, months.count - 1)

        let incidental = account.months.flatMap(\.incidentalRows)
        let internalGroups = GeldSheet.internalGroups(account.months.flatMap(\.internalRows))
        let posten = incidental.count + internalGroups.count
        let partial = months.filter { $0.coverage == .partial }.count
        var parts = ["\(posten) \(posten == 1 ? "post" : "posten")"]
        if partial > 0 { parts.append("\(partial) \(partial == 1 ? "maand" : "maanden") deels") }
        disclosureMeta = parts.joined(separator: " · ")
        sheet = GeldSheet(account, title: name, tail: tail, months: months, internalGroups: internalGroups)
    }

    /// One card per account, named. The leefgeldrekening is the account the
    /// server marks (LEEFGELD_IBAN, or the one the leefgeld week recognised);
    /// beside exactly one of it, the one other known account is the
    /// beheerrekening — under bewind those are the two. Anything else is
    /// "Rekening": the phone never guesses which account is which.
    static func make(_ accounts: [MoneySummaryDTO.Account]) -> [GeldAccount] {
        let known = accounts.filter { $0.accountIban != nil }
        let leefgeld = known.filter(\.isLeefgeldAccount)
        let beheerIban: String? = leefgeld.count == 1 && known.count == 2
            ? known.first { !$0.isLeefgeldAccount }?.accountIban : nil
        return accounts.map { a in
            let name: String
            if a.accountIban == nil { name = "Onbekende rekening" }
            else if a.isLeefgeldAccount && leefgeld.count == 1 { name = "Leefgeldrekening" }
            else if a.accountIban == beheerIban { name = "Beheerrekening" }
            else { name = "Rekening" }
            return GeldAccount(a, name: name)
        }
    }
}

/// One month of one account on the chart and in the readouts.
struct GeldMonth: Equatable, Identifiable, Sendable {
    struct Readout: Equatable, Sendable {
        let title: String
        let amount: String
        /// "t/m 24 okt" on a partial month's spending; nil when there is
        /// nothing honest to add.
        let meta: String?
    }

    var id: String { month }
    let month: String
    /// "jun" — the chart column.
    let short: String
    /// "juni".
    let long: String
    let coverage: MonthSeries.Coverage
    /// Bar lengths 0…1 against THIS account's largest month.
    let inFraction: Double
    let outFraction: Double
    /// "oktober · deels · t/m 24 okt", "september · hele maand", "november · geen data".
    let groupLabel: String
    /// Inkomen/Ontvangen then Uitgegeven; empty for a month with no data.
    let readouts: [Readout]
    /// A month with no rows: the sentence that stands where the amounts would.
    let noDataText: String?
    /// The AX list's state line: "hele maand", "deels · t/m 24 okt", "geen data · geen afschrift".
    let stateLine: String
    /// The sheet's month line, with the weekday: "deels · t/m za 24 okt".
    let sheetLine: String
    /// "3 regels onleesbaar".
    let parseErrorText: String?

    var hatched: Bool { coverage == .partial }

    /// "Oktober, deels, tot en met 24 oktober. Inkomen 2400 euro…" for VoiceOver.
    var accessibilityLabel: String {
        var parts = [MoneyFormat.sentence(long), stateLine]
        parts += readouts.map { "\($0.title) \($0.amount)" }
        if let parseErrorText { parts.append(parseErrorText) }
        return MoneyFormat.spokenDates(parts.joined(separator: ", "))
    }

    init(_ m: MonthSeries, peak: Int, newestBooking: String?, inTitle: String) {
        month = m.month
        short = MoneyFormat.monthShort(m.month) ?? m.month
        long = MoneyFormat.monthLong(m.month) ?? m.month
        coverage = m.coverage
        let has = m.coverage != .none
        inFraction = has && peak > 0 ? Double(m.inCents) / Double(peak) : 0
        outFraction = has && peak > 0 ? Double(m.outCents) / Double(peak) : 0
        // The partial month the statement stops in says where it stops; a
        // partial month at the START of the statements only says "deels".
        let through = m.coverage == .partial && newestBooking?.hasPrefix(m.month) == true
            ? newestBooking.flatMap(MoneyFormat.day).map { "t/m \($0)" } : nil
        let throughLong = m.coverage == .partial && newestBooking?.hasPrefix(m.month) == true
            ? newestBooking.flatMap(MoneyFormat.dayWithWeekday).map { "t/m \($0)" } : nil
        switch m.coverage {
        case .complete:
            groupLabel = "\(long) · hele maand"
            stateLine = "hele maand"
            sheetLine = stateLine
        case .partial:
            groupLabel = ([long, "deels", through].compactMap { $0 }).joined(separator: " · ")
            stateLine = (["deels", through].compactMap { $0 }).joined(separator: " · ")
            sheetLine = (["deels", throughLong].compactMap { $0 }).joined(separator: " · ")
        case .none:
            groupLabel = "\(long) · geen data"
            stateLine = "geen data · geen afschrift"
            sheetLine = stateLine
        }
        readouts = has ? [
            Readout(title: inTitle, amount: MoneyFormat.euro(cents: m.inCents), meta: nil),
            Readout(title: "Uitgegeven", amount: MoneyFormat.euro(cents: m.outCents), meta: through),
        ] : []
        noDataText = has ? nil
            : "Van \(long) is er nog geen afschrift. Lees het afschrift in op de computer, onder Register → Afschrift inlezen."
        parseErrorText = has && m.parseErrorRows > 0
            ? "\(m.parseErrorRows) \(m.parseErrorRows == 1 ? "regel" : "regels") onleesbaar" : nil
    }
}

/// "Niet in de balken": what the bars leave out, for one account.
struct GeldSheet: Equatable, Sendable {
    struct Row: Equatable, Identifiable, Sendable {
        let id: String
        let title: String
        let amount: String?
        let meta: String
    }

    struct Section: Equatable, Identifiable, Sendable {
        var id: String { heading }
        let heading: String
        let rows: [Row]
        /// A sentence under the rows.
        let note: String?
    }

    static let title = "Niet in de balken"

    /// "beheerrekening · ··6789 · jun – nov".
    let meta: String
    let sections: [Section]

    /// Internal transfers grouped by counterparty, oldest first.
    static func internalGroups(_ rows: [DisclosedRow]) -> [[DisclosedRow]] {
        var order: [String] = []
        var groups: [String: [DisclosedRow]] = [:]
        for r in rows.sorted(by: { $0.bookedAt < $1.bookedAt }) {
            let key = r.counterpartyName ?? ""
            if groups[key] == nil { order.append(key) }
            groups[key, default: []].append(r)
        }
        return order.compactMap { groups[$0] }
    }

    init(_ account: MoneySummaryDTO.Account, title: String, tail: String?, months: [GeldMonth],
         internalGroups: [[DisclosedRow]]) {
        let span = [months.first?.short, months.last?.short].compactMap { $0 }
        meta = ([title.lowercased(), tail, span.count == 2 ? "\(span[0]) – \(span[1])" : nil]
            .compactMap { $0 }).joined(separator: " · ")
        var sections: [Section] = []

        let incidental = account.months.flatMap(\.incidentalRows).sorted { $0.bookedAt < $1.bookedAt }
        if !incidental.isEmpty {
            sections.append(Section(heading: "Eenmalig binnengekomen", rows: incidental.map {
                Row(id: $0.id, title: $0.counterpartyName ?? "Onbekend",
                    amount: MoneyFormat.euro(cents: $0.amountCents), meta: MoneyFormat.day($0.bookedAt))
            }, note: nil))
        }
        if !internalGroups.isEmpty {
            sections.append(Section(heading: "Tussen je eigen rekeningen", rows: internalGroups.compactMap { g in
                guard let first = g.first, let last = g.last else { return nil }
                let total = g.reduce(0) { $0 + $1.amountCents }
                let n = g.count
                let range = n == 1 ? MoneyFormat.day(first.bookedAt)
                    : "\(MoneyFormat.day(first.bookedAt)) t/m \(MoneyFormat.day(last.bookedAt))"
                return Row(id: first.id, title: first.counterpartyName ?? "Eigen rekening",
                           amount: MoneyFormat.euro(cents: total),
                           meta: "\(n)× · \(range)")
            }, note: "Staat op de andere rekening als ontvangen. Geld tussen je eigen rekeningen is geen inkomen en geen uitgave."))
        }
        let open = months.filter { $0.coverage != .complete }
        if !open.isEmpty {
            sections.append(Section(heading: "Welke maanden op een afschrift staan", rows: open.map {
                Row(id: $0.month, title: MoneyFormat.sentence($0.long), amount: nil, meta: $0.sheetLine)
            }, note: nil))
        }
        let unreadable = months.compactMap { m in m.parseErrorText.map { (m, $0) } }
        if !unreadable.isEmpty {
            sections.append(Section(heading: "Onleesbare regels", rows: unreadable.map { m, text in
                Row(id: "parse-\(m.month)", title: MoneyFormat.sentence(m.long), amount: nil, meta: text)
            }, note: nil))
        }
        self.sections = sections
    }
}

/// The screen around the cards: the freshness line, the offline strip, the
/// failure card. Pure, so the copy is tested.
enum GeldCopy {
    static let empty = (
        title: "Nog geen afschriften",
        body: "Zodra je een afschrift inleest, staan hier per rekening zes maanden inkomen en uitgaven. Lees het in op de computer, onder Register → Afschrift inlezen."
    )

    /// "bijgewerkt 08:14" / "bijgewerkt gisteren 22:14"; "bijwerken…" while
    /// the first answer is still on its way.
    static func freshness(fetchedAt: Date?, now: Date) -> String {
        fetchedAt.map { "bijgewerkt \(HomeSummary.stamp($0, now: now))" } ?? "bijwerken…"
    }

    struct Offline: Equatable, Sendable {
        let badge: String
        let stamp: String
        let sentence: String
    }

    /// The strip above a kept stand when the phone is offline; nil otherwise.
    static func offline(error: APIError?, fetchedAt: Date?, now: Date) -> Offline? {
        guard case .transport? = error, let fetchedAt else { return nil }
        let stand = HomeSummary.stamp(fetchedAt, now: now)
        return Offline(badge: "offline", stamp: "bijgewerkt \(stand)",
                       sentence: "Je ziet de stand van \(stand). Zodra er weer verbinding is, wordt Geld vanzelf bijgewerkt.")
    }

    struct Failure: Equatable, Sendable {
        let headline: String
        let body: String
        /// "server 503 · 14:05 · volgende poging 14:06".
        let readout: String
    }

    /// The card when there is nothing to show and the last attempt failed;
    /// nil for a 401 (the app signs out) or no error.
    static func failure(_ error: APIError?, attemptedAt: Date?) -> Failure? {
        guard let error, error != .unauthorized else { return nil }
        let at = attemptedAt.map(HomeSummary.clock)
        let next = attemptedAt.map { "volgende poging \(HomeSummary.clock($0.addingTimeInterval(HomeSummary.pollInterval)))" }
        switch error {
        case .transport:
            return Failure(headline: "Je bent nu offline.",
                           body: "Zodra er weer verbinding is, haalt verder Geld op. Je afschriften zijn niet weg; ze staan veilig op de server.",
                           readout: (["offline", at, next].compactMap { $0 }).joined(separator: " · "))
        case .server(let code), .rejected(let code):
            return Failure(headline: "Geld is nu niet op te halen.",
                           body: "De server van verder antwoordt niet. Je afschriften zijn niet weg; ze staan veilig op de server.",
                           readout: (["server \(code)", at, next].compactMap { $0 }).joined(separator: " · "))
        case .rateLimited:
            return Failure(headline: "Geld is nu niet op te halen.",
                           body: "Er waren even te veel verzoeken. Je afschriften zijn niet weg; ze staan veilig op de server.",
                           readout: (["te veel verzoeken", at, next].compactMap { $0 }).joined(separator: " · "))
        case .unauthorized:
            return nil
        }
    }
}
