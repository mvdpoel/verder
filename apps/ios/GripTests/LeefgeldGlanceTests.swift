import Foundation
import Testing
@testable import Grip

/// Overzicht's Leefgeld card (Figma "money · final", the Money glance frames):
/// one shape per state of `leefgeld-week.ts`, and the coverage it states is its own.
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

    private static func msg(_ g: LeefgeldGlance?) -> LeefgeldGlance.Message? {
        if case .message(let m)? = g?.body { return m }
        return nil
    }

    private static func row(_ id: String, _ day: String, _ cents: Int) -> DisclosedRow {
        DisclosedRow(id: id, bookedAt: ISO8601DateFormatter().date(from: "\(day)T10:00:00Z")!,
                     amountCents: cents, counterpartyName: "x")
    }

    @MainActor private static func fixture(_ name: String) throws -> LeefgeldGlance {
        let dto = try FixtureTests.decode(MoneySummaryDTO.self, name, "money/summary")
        return try #require(MoneyGlance(dto, now: sunday).leefgeldGlance)
    }

    /// The fixtures' clock: zo 1 nov 2026 09:41 Amsterdam.
    static let sunday = ISO8601DateFormatter().date(from: "2026-11-01T08:41:00Z")!

    /// money · final, "Money glance / complete".
    @MainActor @Test func completeWeekShowsWhatIsLeftAndStackedRows() throws {
        let g = try Self.fixture("money-complete")
        let f = try #require(Self.fig(g))
        #expect(g.range == "26 okt – 1 nov" && !g.partial)
        #expect(f.hero == "€\u{00A0}37,60")
        #expect(f.caption == "over deze week")
        #expect(abs(f.bar.solid - 0.624) < 0.0001, "the fill is what was SPENT of the weekly amount")
        #expect(f.bar.hatchedFrom == nil && f.bar.tick == nil)
        #expect(f.rows.map(\.label) == ["Uitgegeven", "Ontvangen"])
        #expect(f.rows.map(\.value) == ["€\u{00A0}62,40", "€\u{00A0}100,00"])
        #expect(f.rows[0].meta(revealed: true) == ["3 boekingen"])
        #expect(f.rows[1].meta(revealed: true) == ["do 29 okt", "van beheerrekening"])
        #expect(f.rows[1].meta(revealed: false) == ["do 29 okt", "weekbedrag"], "locked: no account named")
        #expect(!g.accessibilityLabel(revealed: false).contains("rekening"))
    }

    /// "Money glance / partial": what is left, said to be partial three ways.
    @MainActor @Test func partialWeekSaysWhichDaysAreKnown() throws {
        let g = try Self.fixture("money-partial")
        let f = try #require(Self.fig(g))
        #expect(g.partial && g.range == "26 okt – 1 nov")
        #expect(g.rangeUnbroken == "26\u{00A0}okt\u{00A0}– 1\u{00A0}nov")
        #expect(f.hero == "€\u{00A0}52,10" && f.caption == "over")
        #expect(f.axCaption == "over t/\u{2060}m\u{00A0}do 29\u{00A0}okt", "AX5 must not break \"t/m\" or \"29 okt\"")
        #expect(f.note == "Gaat over ma t/m do 29 okt. Vr t/m zo staan nog niet op een afschrift.")
        #expect(abs(f.bar.solid - 0.479) < 0.0001)
        #expect(f.bar.hatchedFrom == f.bar.solid)
        #expect(f.rows[0].meta(revealed: true) == ["2 boekingen"])
    }

    @Test func oneUncoveredDayIsNamedAlone() {
        #expect(LeefgeldGlance.partialNote("2026-10-26", through: "2026-10-31", covered: 6)
                == "Gaat over ma t/m za 31 okt. Zo staat nog niet op een afschrift.")
        #expect(LeefgeldGlance.partialNote("2026-10-26", through: "2026-10-26", covered: 1)
                == "Gaat alleen over ma 26 okt. Di t/m zo staan nog niet op een afschrift.")
        #expect(LeefgeldGlance.partialNote("2026-10-26", through: "2026-11-01", covered: 7) == nil)
    }

    /// "Money glance / overspend": full to the € 100 tick, hatched past it,
    /// and never amber (there is no tint in the model to give).
    @MainActor @Test func overspentWeekTicksTheBudget() throws {
        let f = try #require(Self.fig(try Self.fixture("money-overspent")))
        #expect(f.hero == "↑\u{00A0}€\u{00A0}12,40")
        #expect(f.caption == "meer uitgegeven dan het weekbedrag")
        let tick = try #require(f.bar.tick)
        #expect(abs(tick - 10000.0 / 11240) < 0.0001)
        #expect(f.bar.solid == tick && f.bar.hatchedFrom == tick)
        #expect(f.bar.tickLabel == "€ 100")
        #expect(f.rows[0].meta(revealed: true) == ["4 boekingen", "laatste za 31 okt"])
    }

    @Test func spentShareIsClampedAndOverspentWithoutRowsStillTicks() throws {
        let f = try #require(Self.fig(LeefgeldGlance.make(Self.figure(spent: 11240), newestBooking: "2026-11-01")))
        #expect(f.bar.tick != nil && f.rows[0].meta(revealed: true) == ["0 boekingen"])
        #expect(f.rows[1].meta(revealed: true) == ["nog niets ontvangen"])
        let two = LeefgeldGlance.make(.figure(.init(
            partial: false, accountIban: "i", accountReason: .configured, week: Self.week, coveredThrough: "2026-11-01",
            budgetCents: 10000, spentCents: 100, leftCents: 9900, spentRows: [Self.row("s", "2026-10-27", -100)],
            depositCents: 10000, depositRows: [Self.row("a", "2026-10-26", 5000), Self.row("b", "2026-10-29", 5000)])),
            newestBooking: "2026-11-01")
        #expect(Self.fig(two)?.rows[1].meta(revealed: false) == ["2×", "laatste do 29 okt", "weekbedrag"])
    }

    @MainActor @Test func messagesSayWhatIsMissingAndWhereToFixIt() throws {
        let geen = try #require(Self.msg(try Self.fixture("money-geen-data")))
        #expect(geen == .init(display: true, title: "geen data", meta: "laatste afschrift t/m zo 18 okt",
                              text: "Lees het nieuwste afschrift in op de computer, onder Register → Afschrift inlezen."))

        let nothing = try Self.fixture("money-no-account")
        let empty = try Self.fixture("money-empty")
        #expect(nothing == empty, "no statements at all reads the same whether or not an IBAN is set")
        #expect(nothing.range == "26 okt – 1 nov", "the week is named even with no account")
        #expect(Self.msg(nothing) == .init(
            display: false, title: "Nog geen afschriften", meta: "0 boekingen in verder",
            text: "Lees je eerste afschrift in op de computer, onder Register → Afschrift inlezen. Daarna staat hier wat er deze week over is."))

        let unrecognised = try Self.fixture("money-unrecognised")
        #expect(unrecognised.range == "26 okt – 1 nov")
        #expect(Self.msg(unrecognised) == .init(
            display: false, title: "Leefgeldrekening niet herkend", meta: "2 rekeningen krijgen wekelijks geld binnen",
            text: "verder kiest er niet zelf een. Welke je leefgeldrekening is, stel je in bij de installatie van verder.\nTik om beide rekeningen te bekijken."))
        #expect(!unrecognised.accessibilityLabel(revealed: true).contains("website"))
    }

    @Test func theWeekRunsMondayToSundayInAmsterdam() {
        #expect(LeefgeldGlance.week(containing: Self.sunday) == .init(from: "2026-10-26", to: "2026-11-01"))
        let mondayEarly = ISO8601DateFormatter().date(from: "2026-11-01T23:30:00Z")! // ma 2 nov 00:30
        #expect(LeefgeldGlance.week(containing: mondayEarly) == .init(from: "2026-11-02", to: "2026-11-08"))
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
