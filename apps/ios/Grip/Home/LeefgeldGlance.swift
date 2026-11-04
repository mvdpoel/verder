import Foundation

/// Overzicht's Leefgeld card, decided outside the view (Figma "money · final",
/// the Money glance frames). The figures are `leefgeld-week.ts`'s; this only
/// words and shapes them. Geld keeps its own fuller card (`LeefgeldCard`).
///
/// Shown WHILE LOCKED: amounts and the week, never an account. The one place
/// the card names an account ("van beheerrekening" under Ontvangen) has a
/// locked spelling ("weekbedrag"), and `Row.meta(revealed:)` picks it.
///
/// THE CARD KEEPS ITS OWN COVERAGE. A partial week carries a "deels" chip, a
/// sentence saying which days are on a statement and which are not, and a
/// meter hatched past what is known. No age of the board around it (an
/// offline eyebrow) ever upgrades it to complete.
///
/// THE METER FILLS WHAT WAS SPENT, as a share of the weekly amount: solid up
/// to it (clamped at the weekly amount, where an overspent week is ticked
/// "€ 100"), hatched past it on an overspent or partial week.
///
/// NEVER AMBER: an overspent week is information about money, not something
/// waiting on Martin.
struct LeefgeldGlance: Equatable, Sendable {
    /// "Uitgegeven € 62,40 / 3 boekingen", full width.
    struct Row: Equatable, Sendable {
        let label: String
        let value: String
        /// The facts under the label, unlocked.
        let meta: [String]
        /// The same facts while locked: nothing that names an account.
        let lockedMeta: [String]

        func meta(revealed: Bool) -> [String] { revealed ? meta : lockedMeta }
    }

    /// The 4 pt meter. Fractions of its width, 0…1.
    struct Bar: Equatable, Sendable {
        /// What was spent, as a share of the weekly amount (clamped to the
        /// weekly amount's point on an overspent week).
        let solid: Double
        /// From here to the end is hatched: past the weekly amount, or the
        /// part of the week no statement covers yet.
        let hatchedFrom: Double?
        /// The weekly amount's point on an overspent week, drawn as a tick.
        let tick: Double?
        /// "€ 100" over the tick.
        let tickLabel: String?
    }

    struct Figure: Equatable, Sendable {
        /// "€ 37,60"; "↑ € 12,40" on an overspent week.
        let hero: String
        /// "over deze week", "over", "meer uitgegeven dan het weekbedrag".
        let caption: String
        /// At the accessibility sizes the partial week's sentence goes and
        /// the caption carries the date instead: "over t/m do 29 okt".
        let axCaption: String
        /// "Gaat over ma t/m do 29 okt. Vr t/m zo staan nog niet op een afschrift."
        let note: String?
        let bar: Bar
        let rows: [Row]
    }

    /// No figure to give: what is the matter, and where it is fixed.
    struct Message: Equatable, Sendable {
        /// "geen data" is set large, as the display line of the card.
        let display: Bool
        let title: String
        let meta: String?
        let text: String
    }

    enum Body: Equatable, Sendable {
        case figure(Figure)
        case message(Message)
    }

    /// "26 okt – 1 nov"; nil when there is no week to name.
    let range: String?
    /// A partial week: the header carries the "deels" chip.
    let partial: Bool
    let body: Body

    static let partialChip = "deels"

    /// The range as drawn: each date unbroken, so a wrapped range (AX5)
    /// breaks only after "–" and never inside "26 okt".
    var rangeUnbroken: String? {
        guard let range else { return nil }
        let halves = range.components(separatedBy: " – ")
        guard halves.count == 2 else { return range }
        let a = halves[0].replacingOccurrences(of: " ", with: "\u{00A0}")
        let b = halves[1].replacingOccurrences(of: " ", with: "\u{00A0}")
        return "\(a)\u{00A0}– \(b)"
    }

    /// The whole card in one sentence, for VoiceOver (one element).
    func accessibilityLabel(revealed: Bool) -> String {
        var parts = ["Leefgeld", partial ? Self.partialChip : nil, range].compactMap { $0 }
        switch body {
        case .figure(let f):
            parts.append("\(f.hero.replacingOccurrences(of: "↑", with: "").trimmingCharacters(in: .whitespaces)) \(f.caption)")
            if let note = f.note { parts.append(note) }
            parts += f.rows.map { ([$0.label, $0.value] + $0.meta(revealed: revealed)).joined(separator: " ") }
        case .message(let m):
            parts += [m.title, m.meta, m.text].compactMap { $0 }
        }
        return MoneyFormat.spokenDates(parts.joined(separator: ", "))
    }

    /// Nil when the card is not drawn at all (no weekly amount set).
    /// `currentWeek` names the week of a state that carries none (no account
    /// recognised); `depositSource` is what the deposits' account is called
    /// ("beheerrekening"), nil when the phone cannot say.
    static func make(_ week: LeefgeldWeek, newestBooking: String?, currentWeek: LeefgeldWeek.Week? = nil,
                     depositSource: String? = nil) -> LeefgeldGlance? {
        switch week {
        case .noBudget:
            return nil
        case .noAccount(let candidates):
            if newestBooking == nil { return nothingImported(currentWeek) }
            let n = candidates.count
            let meta = switch n {
            case 0: "geen rekening krijgt wekelijks geld binnen"
            case 1: "1 rekening krijgt wekelijks geld binnen"
            default: "\(n) rekeningen krijgen wekelijks geld binnen"
            }
            let setUp = "Welke je leefgeldrekening is, stel je in bij de installatie van Grip."
            let text = (n >= 2 ? "Grip kiest er niet zelf een. \(setUp)" : setUp)
                + "\n" + (n == 2 ? "Tik om beide rekeningen te bekijken." : "Tik om de rekeningen te bekijken.")
            return LeefgeldGlance(range: currentWeek.flatMap(range), partial: false,
                                  body: .message(Message(display: false, title: "Leefgeldrekening niet herkend",
                                                         meta: meta, text: text)))
        case .geenData(_, _, let w, let newest):
            guard let newest, let shown = MoneyFormat.dayWithWeekday(newest) else { return nothingImported(w) }
            return LeefgeldGlance(range: range(w), partial: false,
                                  body: .message(Message(
                                      display: true, title: "geen data",
                                      meta: "laatste afschrift t/m \(shown)",
                                      text: "Lees het nieuwste afschrift in op de computer, onder Register → Afschrift inlezen.")))
        case .figure(let f):
            return LeefgeldGlance(range: range(f.week), partial: f.partial,
                                  body: .figure(figure(f, depositSource: depositSource)))
        }
    }

    private static func nothingImported(_ week: LeefgeldWeek.Week?) -> LeefgeldGlance {
        LeefgeldGlance(
            range: week.flatMap(range), partial: false,
            body: .message(Message(
                display: false, title: "Nog geen afschriften", meta: "0 boekingen in Grip",
                text: "Lees je eerste afschrift in op de computer, onder Register → Afschrift inlezen. Daarna staat hier wat er deze week over is.")))
    }

    /// An amount that never breaks: NBSP after the €.
    static func euro(_ cents: Int) -> String {
        MoneyFormat.euro(cents: cents).replacingOccurrences(of: " ", with: "\u{00A0}")
    }

    private static func figure(_ f: LeefgeldWeek.Figure, depositSource: String?) -> Figure {
        let overspent = f.leftCents < 0
        let rows = [spentRow(f, overspent: overspent), receivedRow(f, source: depositSource)]
        let budget = Double(max(f.budgetCents, 0))
        let spentShare = budget > 0 ? min(1, max(0, Double(f.spentCents) / budget)) : 0

        let covered = f.partial ? coveredDays(f.week.from, f.coveredThrough) : 7
        let note = f.partial ? partialNote(f.week.from, through: f.coveredThrough, covered: covered) : nil
        // "t/m" never splits at its slash and a date never leaves its month.
        let through = MoneyFormat.dayWithWeekday(f.coveredThrough)
            .map { " " + MoneyFormat.joinDates("t/m \($0)").replacingOccurrences(of: "t/m", with: "t/\u{2060}m") } ?? ""

        if overspent {
            let point = f.spentCents > 0 ? min(1, max(0, Double(f.budgetCents) / Double(f.spentCents))) : 1
            let caption = "meer uitgegeven dan het weekbedrag"
            return Figure(hero: "↑\u{00A0}\(euro(-f.leftCents))", caption: caption,
                          axCaption: f.partial ? caption + through : caption, note: note,
                          bar: Bar(solid: point, hatchedFrom: point, tick: point,
                                   tickLabel: MoneyFormat.euroWhole(cents: f.budgetCents)),
                          rows: rows)
        }
        if f.partial {
            return Figure(hero: euro(f.leftCents), caption: "over", axCaption: "over\(through)", note: note,
                          bar: Bar(solid: spentShare, hatchedFrom: covered < 7 ? spentShare : nil, tick: nil, tickLabel: nil),
                          rows: rows)
        }
        return Figure(hero: euro(f.leftCents), caption: "over deze week", axCaption: "over deze week", note: nil,
                      bar: Bar(solid: spentShare, hatchedFrom: nil, tick: nil, tickLabel: nil), rows: rows)
    }

    /// "3 boekingen"; on an overspent week also "laatste za 31 okt", the
    /// booking that took it over.
    private static func spentRow(_ f: LeefgeldWeek.Figure, overspent: Bool) -> Row {
        let n = f.spentRows.count
        var meta = [n == 1 ? "1 boeking" : "\(n) boekingen"]
        if overspent, let last = f.spentRows.max(by: { $0.bookedAt < $1.bookedAt }) {
            meta.append("laatste \(MoneyFormat.dayWithWeekday(last.bookedAt))")
        }
        return Row(label: "Uitgegeven", value: euro(f.spentCents), meta: meta, lockedMeta: meta)
    }

    /// "do 29 okt · van beheerrekening"; locked "do 29 okt · weekbedrag".
    private static func receivedRow(_ f: LeefgeldWeek.Figure, source: String?) -> Row {
        let rows = f.depositRows.sorted { $0.bookedAt < $1.bookedAt }
        guard let last = rows.last else {
            let meta = ["nog niets ontvangen"]
            return Row(label: "Ontvangen", value: euro(f.depositCents), meta: meta, lockedMeta: meta)
        }
        let when = rows.count == 1 ? [MoneyFormat.dayWithWeekday(last.bookedAt)]
            : ["\(rows.count)×", "laatste \(MoneyFormat.dayWithWeekday(last.bookedAt))"]
        let locked = when + ["weekbedrag"]
        return Row(label: "Ontvangen", value: euro(f.depositCents),
                   meta: source.map { when + ["van \($0)"] } ?? locked, lockedMeta: locked)
    }

    /// "26 okt – 1 nov".
    private static func range(_ w: LeefgeldWeek.Week) -> String? {
        guard let from = MoneyFormat.day(w.from), let to = MoneyFormat.day(w.to) else { return nil }
        return "\(from) – \(to)"
    }

    /// The Monday-to-Sunday week (Amsterdam) that holds `date`.
    static func week(containing date: Date) -> LeefgeldWeek.Week {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
        let weekday = cal.component(.weekday, from: date) // 1 = zondag
        let back = (weekday + 5) % 7
        let monday = cal.date(byAdding: .day, value: -back, to: date)!
        let sunday = cal.date(byAdding: .day, value: 6, to: monday)!
        return .init(from: MoneyFormat.dayKey(monday), to: MoneyFormat.dayKey(sunday))
    }

    /// Days of the week (from its Monday) a statement covers, 0…7.
    static func coveredDays(_ from: String, _ through: String) -> Int {
        guard let a = civilDate(from), let b = civilDate(through) else { return 0 }
        let days = (utc.dateComponents([.day], from: a, to: b).day ?? -1) + 1
        return min(7, max(0, days))
    }

    /// "Gaat over ma t/m do 29 okt. Vr t/m zo staan nog niet op een afschrift."
    /// Nil when the whole week is covered.
    static func partialNote(_ from: String, through: String, covered: Int) -> String? {
        guard covered < 7, let start = civilDate(from) else { return nil }
        func weekday(_ offset: Int) -> String {
            let d = utc.date(byAdding: .day, value: offset, to: start)!
            return MoneyFormat.weekdays[utc.component(.weekday, from: d) - 1]
        }
        guard covered > 0, let last = MoneyFormat.dayWithWeekday(through) else {
            return "Deze week staat nog niet op een afschrift."
        }
        let known = covered == 1 ? "Gaat alleen over \(last)." : "Gaat over \(weekday(0)) t/m \(last)."
        let missing = covered == 6
            ? "\(MoneyFormat.sentence(weekday(6))) staat nog niet op een afschrift."
            : "\(MoneyFormat.sentence(weekday(covered))) t/m \(weekday(6)) staan nog niet op een afschrift."
        return "\(known) \(missing)"
    }

    private static var utc: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }

    private static func civilDate(_ key: String) -> Date? {
        let p = key.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return utc.date(from: DateComponents(year: p[0], month: p[1], day: p[2], hour: 12))
    }
}
