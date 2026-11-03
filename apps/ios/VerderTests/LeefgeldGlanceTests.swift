import Foundation
import Testing
@testable import Verder

/// Overzicht's Leefgeld card (Figma "leefgeld-kaart · varianten"): one shape
/// per state of `leefgeld-week.ts`, and the coverage it states is its own.
struct LeefgeldGlanceTests {
    private static let week = LeefgeldWeek.Week(from: "2026-10-26", to: "2026-11-01")

    private static func figure(partial: Bool = false, covered: String = "2026-11-01", spent: Int = 6240,
                               deposit: Int = 10000, budget: Int = 10000) -> LeefgeldWeek {
        .figure(.init(partial: partial, accountIban: "NL00TEST9876543210", accountReason: .configured, week: week,
                      coveredThrough: covered, budgetCents: budget, spentCents: spent, leftCents: budget - spent,
                      spentRows: [], depositCents: deposit, depositRows: []))
    }

    private static func fig(_ g: LeefgeldGlance?) -> LeefgeldGlance.Figure? {
        if case .figure(let f)? = g?.body { return f }
        return nil
    }

    @Test func completeWeekShowsWhatIsLeftOfTheBudget() throws {
        let g = try #require(LeefgeldGlance.make(Self.figure(), newestBooking: "2026-11-01"))
        let f = try #require(Self.fig(g))
        #expect(g.headerReadout == "26 okt – 1 nov")
        #expect(f.hero == "€\u{00A0}37,60")
        #expect(f.caption == "over van €\u{00A0}100,00")
        #expect(abs(f.bar.solid - 0.376) < 0.0001, "the fill is what is LEFT")
        #expect(f.bar.hatchedFrom == nil && f.bar.tick == nil)
        #expect(f.columns.map(\.label) == ["uitgegeven", "ontvangen"])
        #expect(f.columns.map(\.value) == ["€\u{00A0}62,40", "€\u{00A0}100,00"])
        #expect(g.footnote == "Alleen je leefgeldrekening.")
        #expect(!g.accessibilityLabel.contains("NL00"), "never an account on the glance")
    }

    /// A partial week never claims what is left: it shows what was spent up to
    /// the last statement, hatches the days no statement covers, and says so.
    @Test func partialWeekSaysWhatIsNotKnownYet() throws {
        let g = try #require(LeefgeldGlance.make(Self.figure(partial: true, covered: "2026-10-29", spent: 4790),
                                                 newestBooking: "2026-10-29"))
        let f = try #require(Self.fig(g))
        #expect(g.headerReadout == "onvolledig · 26 okt – 1 nov")
        #expect(g.headerReadoutUnbroken == "onvolledig · 26 okt\u{00A0}– 1 nov")
        #expect(f.hero == "€\u{00A0}47,90")
        #expect(f.caption == "uitgegeven t/m do 29 okt")
        #expect(abs(f.bar.solid - 4.0 / 7) < 0.0001)
        #expect(f.bar.hatchedFrom == f.bar.solid)
        #expect(f.coverageNote == "vr–zo: nog geen afschrift")
        #expect(f.columns == [.init(label: "over", value: "nog niet bekend")])
    }

    @Test func oneUncoveredDayIsNamedAlone() throws {
        let g = LeefgeldGlance.make(Self.figure(partial: true, covered: "2026-10-31"), newestBooking: "2026-10-31")
        #expect(Self.fig(g)?.coverageNote == "zo: nog geen afschrift")
        #expect(Self.fig(g)?.caption == "uitgegeven t/m za 31 okt")
    }

    /// Overspent: the amount over the weekly budget, with a minus, on its own
    /// line, the bar ticked at the 100 % point — and never amber (there is no
    /// tint in the model to give).
    @Test func overspentWeekTicksTheBudget() throws {
        let f = try #require(Self.fig(LeefgeldGlance.make(Self.figure(spent: 11240), newestBooking: "2026-11-01")))
        #expect(f.hero == "−\u{00A0}€\u{00A0}12,40")
        #expect(f.caption == "boven het weekbedrag")
        #expect(f.captionBelow)
        let tick = try #require(f.bar.tick)
        #expect(abs(tick - 10000.0 / 11240) < 0.0001)
        #expect(f.bar.hatchedFrom == tick)
        #expect(f.bar.solid == 0)
    }

    @Test func messagesSayWhatIsMissingAndWhereToFixIt() {
        let geen = LeefgeldGlance.make(.geenData(accountIban: "NL00TEST9876543210", accountReason: .configured,
                                                 week: Self.week, newestBooking: "2026-10-18"), newestBooking: "2026-10-18")
        #expect(geen?.body == .message(title: "Geen data voor deze week", readout: "laatste afschrift t/m zo 18 okt",
                                       text: "Importeer een nieuw afschrift op de website. Daarna rekent verder deze week uit.",
                                       link: "Open op de website"))
        #expect(geen?.headerReadout == "26 okt – 1 nov")

        let nothing = LeefgeldGlance.make(.noAccount(candidates: []), newestBooking: nil)
        let empty = LeefgeldGlance.make(.geenData(accountIban: "NL00TEST9876543210", accountReason: .configured,
                                                  week: Self.week, newestBooking: nil), newestBooking: nil)
        #expect(nothing == empty, "no statements at all reads the same whether or not an IBAN is set")
        guard case .message(let title, _, _, _)? = nothing?.body else { Issue.record("no message"); return }
        #expect(title == "Nog geen afschriften")
        #expect(nothing?.headerReadout == nil)

        let unrecognised = LeefgeldGlance.make(.noAccount(candidates: ["a", "b"]), newestBooking: "2026-10-29")
        #expect(unrecognised?.body == .message(title: "Leefgeldrekening niet herkend", readout: nil,
                                               text: "2 rekeningen krijgen wekelijks geld binnen; verder kiest er niet zelf een.",
                                               link: "Kies hem op de website"))
    }

    @Test func noBudgetDrawsNoCard() {
        #expect(LeefgeldGlance.make(.noBudget, newestBooking: "2026-10-29") == nil)
    }

    /// The fixture states decode into the card the Figma variants draw.
    @MainActor @Test(arguments: ["money-complete", "money-partial", "money-overspent", "money-geen-data",
                                 "money-no-account", "money-empty", "money-unrecognised", "offline-cached"])
    func everyMoneyFixtureHasACard(_ name: String) throws {
        let dto = try FixtureTests.decode(MoneySummaryDTO.self, name, "money/summary")
        #expect(MoneyGlance(dto).leefgeldGlance != nil, "\(name)")
    }
}
