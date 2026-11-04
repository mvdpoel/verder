import Foundation
import Testing
@testable import Grip

/// The Geld screen's words and numbers (GeldModel.swift), on the synthetic
/// fixtures the Figma "money · final" Geld frames draw.
@MainActor
struct GeldModelTests {
    private func geld(_ fixture: String) throws -> [GeldAccount] {
        MoneyGlance(try FixtureTests.decode(MoneySummaryDTO.self, fixture, "money/summary")).geld
    }

    // MARK: naming

    @Test func accountsAreNamedFromTheServersMarkNeverGuessed() throws {
        let cards = try geld("money-partial")
        #expect(cards.map(\.title) == ["Beheerrekening", "Leefgeldrekening"])
        #expect(cards.map(\.tail) == ["··6789", "··3210"])
        #expect(cards.map(\.inTitle) == ["Inkomen", "Ontvangen"])
        #expect(cards[0].accessibilityTitle == "Beheerrekening, eindigend op 6789")

        // Two weekly-income candidates and no LEEFGELD_IBAN: nothing is marked,
        // so neither account gets a name it might not have.
        #expect(try geld("money-unrecognised").map(\.title) == ["Rekening", "Rekening"])
    }

    @Test func namesNeedExactlyOneLeefgeldAccountBesideOneOther() {
        func month(_ key: String) -> MonthSeries {
            MonthSeries(month: key, coverage: .complete, inCents: 100, outCents: 50, outByCategory: [],
                        incidentalCents: 0, internalCents: 0, parseErrorRows: 0, internalRows: [], incidentalRows: [])
        }
        let three = GeldAccount.make([
            .init(accountIban: "NL00TEST0000000001", months: [month("2026-10")], isLeefgeldAccount: true),
            .init(accountIban: "NL00TEST0000000002", months: [month("2026-10")]),
            .init(accountIban: "NL00TEST0000000003", months: [month("2026-10")]),
            .init(accountIban: nil, months: [month("2026-10")]),
        ])
        #expect(three.map(\.title) == ["Leefgeldrekening", "Rekening", "Rekening", "Onbekende rekening"])
        #expect(three[3].tail == nil)
    }

    /// An older server sends neither field: the card simply leaves the lines out.
    @Test func anOlderServerStillDecodes() throws {
        let json = #"{"accountIban":"NL00TEST0123456789","months":[]}"#
        let a = try JSONDecoder().decode(MoneySummaryDTO.Account.self, from: Data(json.utf8))
        #expect(a.newestBooking == nil && !a.isLeefgeldAccount)
        #expect(GeldAccount(a, name: "Rekening").newestLine == nil)
    }

    // MARK: months and readouts

    @Test func opensOnTheNewestMonthWithData() throws {
        let beheer = try #require(try geld("money-partial").first)
        #expect(beheer.months[beheer.defaultSelection].month == "2026-10")
        #expect(beheer.newestLine == "nieuwste boeking za 24 okt")
        #expect(beheer.scaleLabel == "€ 2.400")
    }

    @Test func aPartialMonthSaysWhereTheStatementStops() throws {
        let beheer = try #require(try geld("money-partial").first)
        let october = try #require(beheer.months.first { $0.month == "2026-10" })
        #expect(october.groupLabel == "oktober · deels · t/m 24 okt")
        #expect(october.hatched)
        #expect(october.readouts == [
            .init(title: "Inkomen", amount: "€ 2.400,00", meta: "Atelier Sterrenwacht"),
            .init(title: "Uitgegeven", amount: "€ 1.210,35", meta: "14 boekingen · t/m 24 okt"),
        ])
        #expect(october.stateLine == "deels · t/m 24 okt")
        #expect(october.sheetLine == "deels · t/m za 24 okt")
        #expect(october.accessibilityLabel.contains("tot en met 24 okt"))
        #expect(!october.accessibilityLabel.contains("t/m"))

        let september = try #require(beheer.months.first { $0.month == "2026-09" })
        #expect(september.groupLabel == "september · hele maand")
        #expect(september.readouts.map(\.meta) == ["Atelier Sterrenwacht", "17 boekingen"])
    }

    /// The leefgeldrekening's deposits name the beheerrekening as their payer,
    /// in this screen's own name for it (Figma: "5× weekbedrag · van
    /// beheerrekening"), and the spending names its bookings.
    @Test func theLeefgeldDepositsNameTheirOwnAccount() throws {
        let cards = try geld("money-complete")
        let leefgeld = try #require(cards.last)
        let october = try #require(leefgeld.months.first { $0.month == "2026-10" })
        #expect(october.groupLabel == "oktober · deels · t/m 30 okt")
        #expect(october.readouts.map(\.meta) == ["5× weekbedrag · van beheerrekening", "38 boekingen · t/m 30 okt"])
        let september = try #require(leefgeld.months.first { $0.month == "2026-09" })
        #expect(september.readouts.map(\.meta) == ["4× weekbedrag · van beheerrekening", "35 boekingen"])
        // No names known: never a guessed one.
        #expect(try geld("money-unrecognised").last?.months[4].readouts.first?.meta == "5× van eigen rekening")
    }

    @Test func sourcesLineSaysOnlyWhatTheServerGave() {
        func src(_ label: String?, _ n: Int, _ cadence: String = "monthly", from: String? = nil) -> InSource {
            InSource(label: label, count: n, cadence: cadence, fromAccountIban: from)
        }
        #expect(GeldMonth.sourcesLine([], leefgeld: false, accountNames: [:]) == nil)
        #expect(GeldMonth.sourcesLine([src("Atelier", 1)], leefgeld: false, accountNames: [:]) == "Atelier")
        #expect(GeldMonth.sourcesLine([src("Atelier", 2)], leefgeld: false, accountNames: [:]) == "2× Atelier")
        #expect(GeldMonth.sourcesLine([src(nil, 1, "weekly", from: "X")], leefgeld: true,
                                      accountNames: ["X": "Beheerrekening"]) == "weekbedrag · van beheerrekening")
        #expect(GeldMonth.sourcesLine([src("A", 1), src("B", 1)], leefgeld: false, accountNames: [:]) == "A · B")
        #expect(GeldMonth.sourcesLine([src("A", 1), src("B", 1), src("C", 1)], leefgeld: false, accountNames: [:]) == "3 bronnen")
        // An older server sends no captions: none are drawn.
        let old = MonthSeries(month: "2026-10", coverage: .complete, inCents: 100, outCents: 50, outByCategory: [],
                              incidentalCents: 0, internalCents: 0, parseErrorRows: 0, internalRows: [], incidentalRows: [])
        #expect(GeldMonth(old, peak: 100, newestBooking: nil, inTitle: "Inkomen").readouts.allSatisfy { $0.meta == nil })
    }

    /// A month with no rows is "geen data" with its sentence — never € 0,00.
    @Test func aMonthWithoutRowsHasNoAmount() throws {
        let beheer = try #require(try geld("money-partial").first)
        let november = try #require(beheer.months.first { $0.month == "2026-11" })
        #expect(november.groupLabel == "november · geen data")
        #expect(november.readouts.isEmpty)
        #expect(november.inFraction == 0 && november.outFraction == 0)
        #expect(november.noDataText == "Van november is er nog geen afschrift. Lees het afschrift in op de computer, onder Register → Afschrift inlezen.")
        #expect(!november.accessibilityLabel.contains("€"))
    }

    /// Each account's bars scale to ITS OWN largest month.
    @Test func barsScalePerAccount() throws {
        for account in try geld("money-partial") {
            #expect(account.months.flatMap { [$0.inFraction, $0.outFraction] }.max() == 1)
        }
        #expect(try geld("money-partial").map(\.scaleLabel) == ["€ 2.400", "€ 500"])
    }

    // MARK: the disclosure and its sheet

    @Test func theSheetListsWhatTheBarsLeaveOut() throws {
        let beheer = try #require(try geld("money-partial").first)
        #expect(beheer.disclosureMeta == "2 posten · 1 maand deels")
        #expect(beheer.sheet.meta == "beheerrekening · ··6789 · jun – nov")
        #expect(beheer.sheet.sections.map(\.heading)
                == ["Eenmalig binnengekomen", "Tussen je eigen rekeningen", "Welke maanden op een afschrift staan"])
        #expect(beheer.sheet.sections[0].rows == [
            .init(id: "00000000-f1c5-4000-8000-500000000001", title: "Zorgverzekeraar Duinzorg",
                  amount: "€ 85,00", meta: "19 aug"),
        ])
        // The weekly transfers to the leefgeldrekening, named by the one other
        // own account; the note names what only the other statement reaches.
        let transfers = beheer.sheet.sections[1]
        #expect(transfers.rows.map(\.title) == ["Naar leefgeldrekening"])
        #expect(transfers.rows.map(\.amount) == ["€ 2.100,00"])
        #expect(transfers.rows.map(\.meta) == ["··3210 · 21× weekbedrag · jun t/m 24 okt"])
        #expect(transfers.note == "Staat daar als ontvangen. Do 29 okt staat alleen op de leefgeldrekening: het afschrift van deze rekening loopt t/m 24 okt.")
        #expect(beheer.sheet.sections[2].rows.map(\.meta) == ["deels · t/m za 24 okt", "geen data · geen afschrift"])

        let leefgeld = try #require(try geld("money-partial").last)
        #expect(leefgeld.disclosureMeta == "0 posten · 1 maand deels")
    }

    /// Without exactly two own accounts the phone cannot say which account a
    /// transfer went to, so the row keeps the bank's counterparty name.
    @Test func internalTransfersWithoutACounterpartKeepTheBanksName() throws {
        let rows = (0..<2).map { i in
            DisclosedRow(id: "t\(i)", bookedAt: ISO8601DateFormatter().date(from: "2026-10-0\(i + 1)T10:00:00Z")!,
                         amountCents: -10_000, counterpartyName: "Eigen")
        }
        let m = MonthSeries(month: "2026-10", coverage: .complete, inCents: 0, outCents: 0, outByCategory: [],
                            incidentalCents: 0, internalCents: -20_000, parseErrorRows: 0, internalRows: rows,
                            incidentalRows: [])
        let a = GeldAccount(.init(accountIban: "NL00TEST0000000001", months: [m]), name: "Rekening")
        let section = try #require(a.sheet.sections.first)
        #expect(section.rows.map(\.title) == ["Eigen"])
        #expect(section.rows.map(\.meta) == ["2× · 1 okt t/m 2 okt"])
        #expect(section.rows.map(\.amount) == ["€ 200,00"])
    }

    @Test func internalTransfersAreGroupedPerCounterparty() {
        func row(_ id: String, _ day: Int, _ cents: Int, _ name: String) -> DisclosedRow {
            DisclosedRow(id: id, bookedAt: Date(timeIntervalSince1970: 1_790_000_000 + Double(day) * 86_400),
                         amountCents: cents, counterpartyName: name)
        }
        let groups = GeldSheet.internalGroups([row("b", 7, 10_000, "Eigen"), row("a", 0, 10_000, "Eigen"),
                                               row("c", 3, 5_000, "Spaar")])
        #expect(groups.map { $0.map(\.id) } == [["a", "b"], ["c"]])
    }

    // MARK: the accessibility sizes

    @Test func aCompoundBreaksOnlyAtItsJoint() {
        let s = GeldAccount.compoundHyphenated("Beheerrekening")
        #expect(s.replacingOccurrences(of: "\u{2060}", with: "") == "Beheer\u{AD}rekening")
        #expect(s.components(separatedBy: "\u{AD}").count == 2)
        #expect(GeldAccount.compoundHyphenated("Rekening") == "Rekening")
        #expect(MoneyFormat.joinDates("deels · t/m 24 okt") == "deels\u{A0}· t/m\u{A0}24\u{A0}okt")
    }

    // MARK: the screen around the cards

    @Test func freshnessOfflineAndFailureCopy() throws {
        let cal = HomeSummary.calendar
        let now = try #require(cal.date(from: DateComponents(year: 2026, month: 11, day: 1, hour: 14, minute: 5)))
        let fetched = try #require(cal.date(from: DateComponents(year: 2026, month: 10, day: 31, hour: 22, minute: 14)))
        #expect(GeldCopy.freshness(fetchedAt: nil, now: now) == "bijwerken…")
        #expect(GeldCopy.freshness(fetchedAt: now, now: now) == "bijgewerkt 14:05")

        let offline = try #require(GeldCopy.offline(error: .transport("x"), fetchedAt: fetched, now: now))
        #expect(offline.stamp == "bijgewerkt gisteren 22:14")
        #expect(offline.sentence.hasPrefix("Je ziet de stand van gisteravond."))
        let afternoon = try #require(cal.date(from: DateComponents(year: 2026, month: 10, day: 31, hour: 14, minute: 2)))
        #expect(GeldCopy.spoken(afternoon, now: now) == "gisteren 14:02")
        #expect(GeldCopy.spoken(now, now: now) == "14:05")
        let older = try #require(cal.date(from: DateComponents(year: 2026, month: 10, day: 30, hour: 22, minute: 14)))
        #expect(GeldCopy.spoken(older, now: now) == "vr 30 okt 22:14")
        #expect(GeldCopy.offline(error: .server(503), fetchedAt: fetched, now: now) == nil)
        #expect(GeldCopy.offline(error: .transport("x"), fetchedAt: nil, now: now) == nil)

        let failure = try #require(GeldCopy.failure(.server(503), attemptedAt: now))
        #expect(failure.headline == "Geld is nu niet op te halen.")
        #expect(failure.readout == "server 503 · 14:05 · volgende poging 14:06")
        #expect(GeldCopy.failure(.unauthorized, attemptedAt: now) == nil)
        #expect(GeldCopy.failure(nil, attemptedAt: now) == nil)
    }

    @Test func noAmberAnywhere() throws {
        // Nothing on Geld waits on Martin: no copy speaks of waiting.
        for account in try geld("money-partial") {
            let all = ([account.title, account.disclosureMeta, account.sheet.meta]
                       + account.months.flatMap { [$0.groupLabel, $0.accessibilityLabel] }).joined(separator: " ")
            #expect(!all.lowercased().contains("wacht"))
        }
    }
}

/// Overzicht without a weekly amount (Figma "Money glance / no-budget").
@MainActor
struct MoneyAccountRowsTests {
    @Test func noBudgetListsTheAccountsUnlockedOnly() throws {
        let g = MoneyGlance(try FixtureTests.decode(MoneySummaryDTO.self, "money-no-budget", "money/summary"))
        #expect(g.accountRows(revealed: false).isEmpty, "the tail names an account: not on the locked glance")
        let rows = g.accountRows(revealed: true)
        #expect(rows.map(\.title) == ["Beheerrekening", "Leefgeldrekening"])
        #expect(rows.map(\.meta) == [["··6789", "nieuwste boeking za 24 okt"], ["··3210", "nieuwste boeking vr 30 okt"]])
        #expect(rows.allSatisfy { !$0.meta.joined().contains("€") }, "no amounts, so no total either")
        #expect(rows[0].accessibilityLabel == "Beheerrekening, eindigend op 6789, nieuwste boeking za 24 okt")
    }

    @Test func withALeefgeldCardThereAreNoRows() throws {
        let g = MoneyGlance(try FixtureTests.decode(MoneySummaryDTO.self, "money-complete", "money/summary"))
        #expect(g.accountRows(revealed: true).isEmpty)
        #expect(g.leefgeldAccountID == "NL00TEST9876543210")
    }
}

/// The store keeps when it last fetched, and a cancelled refresh writes nothing.
@MainActor
struct MoneyStoreClockTests {
    @Test func recordsWhenItFetched() async throws {
        let at = Date(timeIntervalSince1970: 1_793_000_000)
        let store = MoneyStore(client: FixtureEnvironment.client(fixture: "money-complete"), now: { at })
        await store.refresh()
        #expect(store.fetchedAt == at && store.attemptedAt == at)
    }

    @Test func aFailureKeepsTheStandAndItsAge() async throws {
        let at = Date(timeIntervalSince1970: 1_793_000_000)
        let store = MoneyStore(client: FixtureEnvironment.client(fixture: "server-error"), now: { at })
        await store.refresh()
        #expect(store.glance == nil && store.fetchedAt == nil)
        #expect(store.attemptedAt == at)
        #expect(store.lastError == .server(503))
    }

    /// Overzicht's poll is cancelled when Geld is pushed over it; that must
    /// not turn the kept stand into "offline".
    @Test func aCancelledRefreshWritesNothing() async throws {
        let store = MoneyStore(client: FixtureEnvironment.client(fixture: "money-complete"))
        await store.refresh()
        let kept = store.glance
        let task = Task { @MainActor in await store.refresh() }
        task.cancel()
        await task.value
        #expect(store.lastError == nil)
        #expect(store.glance == kept)
    }
}
