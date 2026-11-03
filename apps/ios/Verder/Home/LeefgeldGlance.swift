import Foundation

/// Overzicht's Leefgeld card, decided outside the view (Figma "leefgeld-kaart
/// · varianten"). The figures are `leefgeld-week.ts`'s; this only words and
/// shapes them. Geld keeps its own fuller card (`LeefgeldCard`).
///
/// Shown WHILE LOCKED: amounts and the week, never an account — the
/// footnote says which KIND of account ("je leefgeldrekening"), not which one.
///
/// THE CARD KEEPS ITS OWN COVERAGE. A partial week says "onvolledig" and
/// shows what was spent up to the last statement, with the uncovered days
/// hatched — never what is "left", which is not known yet. No age of the
/// board around it (an offline eyebrow) ever upgrades it to complete.
///
/// NEVER AMBER: an overspent week is information about money, not something
/// waiting on Martin.
struct LeefgeldGlance: Equatable, Sendable {
    struct Column: Equatable, Sendable {
        let label: String
        let value: String
    }

    /// The 4 pt bar. Fractions of the bar's width, 0…1.
    struct Bar: Equatable, Sendable {
        /// What is left (complete) or the covered days (partial), solid.
        let solid: Double
        /// From here to the end is hatched: days no statement covers yet, or
        /// what was spent past the weekly amount.
        let hatchedFrom: Double?
        /// The 100 % point of an overspent week, drawn as a tick.
        let tick: Double?
    }

    struct Figure: Equatable, Sendable {
        let hero: String
        let caption: String
        /// "boven het weekbedrag" sits under the figure, not beside it.
        let captionBelow: Bool
        let bar: Bar
        /// "vr–zo: nog geen afschrift".
        let coverageNote: String?
        let columns: [Column]
    }

    enum Body: Equatable, Sendable {
        case figure(Figure)
        /// No figure to give: what is the matter and where to fix it.
        case message(title: String, readout: String?, text: String, link: String)
    }

    /// "26 okt – 1 nov"; nil when there is no week to name.
    let range: String?
    /// A partial week: the header says "onvolledig" before the range.
    let incomplete: Bool
    let body: Body
    let footnote: String?

    static let footnoteText = "Alleen je leefgeldrekening."
    static let openWebsite = "Open op de website"
    static let chooseOnWebsite = "Kies hem op de website"
    /// Where every message's link leads: the web app's /money.
    static let websitePath = "money"

    /// The header's right-hand readout.
    var headerReadout: String? {
        guard let range else { return nil }
        return incomplete ? "onvolledig · \(range)" : range
    }

    /// The whole card in one sentence, for VoiceOver (one element).
    var accessibilityLabel: String {
        var parts = ["Leefgeld", headerReadout].compactMap { $0 }
        switch body {
        case .figure(let f):
            parts.append("\(f.hero) \(f.caption)")
            if f.bar.tick == nil, !incomplete, f.bar.hatchedFrom == nil {
                parts.append("\(Int((f.bar.solid * 100).rounded())) procent over")
            }
            if let note = f.coverageNote { parts.append(note) }
            parts += f.columns.map { "\($0.label) \($0.value)" }
        case .message(let title, let readout, let text, _):
            parts += [title, readout, text].compactMap { $0 }
        }
        if let footnote { parts.append(footnote) }
        return parts.joined(separator: ", ")
    }

    /// Nil when the card is not drawn at all (no weekly amount set).
    static func make(_ week: LeefgeldWeek, newestBooking: String?) -> LeefgeldGlance? {
        switch week {
        case .noBudget:
            return nil
        case .noAccount(let candidates):
            if newestBooking == nil { return nothingImported }
            let why = switch candidates.count {
            case 0: "Geen rekening krijgt wekelijks geld binnen."
            case 1: "1 rekening krijgt wekelijks geld binnen."
            default: "\(candidates.count) rekeningen krijgen wekelijks geld binnen; verder kiest er niet zelf een."
            }
            return LeefgeldGlance(range: nil, incomplete: false,
                                  body: .message(title: "Leefgeldrekening niet herkend", readout: nil, text: why,
                                                 link: chooseOnWebsite),
                                  footnote: nil)
        case .geenData(_, _, let w, let newest):
            guard let newest, let shown = MoneyFormat.dayWithWeekday(newest) else { return nothingImported }
            return LeefgeldGlance(range: range(w), incomplete: false,
                                  body: .message(title: "Geen data voor deze week",
                                                 readout: "laatste afschrift t/m \(shown)",
                                                 text: "Importeer een nieuw afschrift op de website. Daarna rekent verder deze week uit.",
                                                 link: openWebsite),
                                  footnote: nil)
        case .figure(let f):
            return LeefgeldGlance(range: range(f.week), incomplete: f.partial, body: .figure(figure(f)),
                                  footnote: footnoteText)
        }
    }

    private static let nothingImported = LeefgeldGlance(
        range: nil, incomplete: false,
        body: .message(title: "Nog geen afschriften", readout: nil,
                       text: "Importeer je eerste afschrift op de website. Daarna zie je hier wat er deze week over is.",
                       link: openWebsite),
        footnote: nil)

    /// An amount that never breaks: NBSP after the € and after a minus.
    static func euro(_ cents: Int) -> String {
        let plain = MoneyFormat.euro(cents: abs(cents)).replacingOccurrences(of: " ", with: "\u{00A0}")
        return cents < 0 ? "−\u{00A0}\(plain)" : plain
    }

    private static func figure(_ f: LeefgeldWeek.Figure) -> Figure {
        let spent = Column(label: "uitgegeven", value: euro(f.spentCents))
        let received = Column(label: "ontvangen", value: euro(f.depositCents))
        if f.partial {
            let covered = coveredDays(f.week.from, f.coveredThrough)
            let solid = Double(covered) / 7
            let through = MoneyFormat.dayWithWeekday(f.coveredThrough) ?? f.coveredThrough
            return Figure(hero: euro(f.spentCents), caption: "uitgegeven t/m \(through)", captionBelow: false,
                          bar: Bar(solid: solid, hatchedFrom: covered < 7 ? solid : nil, tick: nil),
                          coverageNote: uncoveredNote(f.week.from, covered: covered),
                          columns: [Column(label: "over", value: "nog niet bekend")])
        }
        if f.leftCents < 0, f.spentCents > 0 {
            let point = min(1, max(0, Double(f.budgetCents) / Double(f.spentCents)))
            return Figure(hero: euro(f.leftCents), caption: "boven het weekbedrag", captionBelow: true,
                          bar: Bar(solid: 0, hatchedFrom: point, tick: point),
                          coverageNote: nil, columns: [spent, received])
        }
        let left = f.budgetCents > 0 ? min(1, max(0, Double(f.leftCents) / Double(f.budgetCents))) : 0
        return Figure(hero: euro(f.leftCents), caption: "over van \(euro(f.budgetCents))", captionBelow: false,
                      bar: Bar(solid: left, hatchedFrom: nil, tick: nil), coverageNote: nil,
                      columns: [spent, received])
    }

    /// "26 okt – 1 nov".
    private static func range(_ w: LeefgeldWeek.Week) -> String? {
        guard let from = MoneyFormat.day(w.from), let to = MoneyFormat.day(w.to) else { return nil }
        return "\(from) – \(to)"
    }

    /// Days of the week (from its Monday) a statement covers, 0…7.
    static func coveredDays(_ from: String, _ through: String) -> Int {
        guard let a = civilDate(from), let b = civilDate(through) else { return 0 }
        let days = (utc.dateComponents([.day], from: a, to: b).day ?? -1) + 1
        return min(7, max(0, days))
    }

    /// "vr–zo: nog geen afschrift", or "zo: …" for one day; nil when covered.
    static func uncoveredNote(_ from: String, covered: Int) -> String? {
        guard covered < 7, let start = civilDate(from) else { return nil }
        func weekday(_ offset: Int) -> String {
            let d = utc.date(byAdding: .day, value: offset, to: start)!
            return MoneyFormat.weekdays[utc.component(.weekday, from: d) - 1]
        }
        let first = weekday(covered), last = weekday(6)
        return "\(covered == 6 ? first : "\(first)–\(last)"): nog geen afschrift"
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
