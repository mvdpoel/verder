import Foundation
import Testing
@testable import Grip

/// Plan 3 Task 19: the leefgeld card's five states and the per-account month
/// cards. The figure is the SERVER's (leefgeld-week.ts); the phone only says it.
@MainActor
struct LeefgeldCardTests {
    private static let week = LeefgeldWeek.Week(from: "2026-10-26", to: "2026-11-01")

    private static func figure(partial: Bool = false, coveredThrough: String = "2026-11-01",
                               spent: Int = 6240, left: Int = 3760, deposit: Int = 10_000) -> LeefgeldWeek {
        .figure(.init(partial: partial, accountIban: "NL00TEST9876543210", accountReason: .configured,
                      week: week, coveredThrough: coveredThrough, budgetCents: 10_000, spentCents: spent,
                      leftCents: left, spentRows: [], depositCents: deposit, depositRows: []))
    }

    @Test func completeWeekReadsTheFigure() throws {
        let card = try #require(LeefgeldCard.make(Self.figure(), newestBooking: "2026-11-01"))
        #expect(card.headline == "Leefgeld over deze week: € 37,60")
        #expect(card.hero == "€ 37,60")
        #expect(card.lines.contains("uitgegeven € 62,40 · ontvangen € 100,00"))
        #expect(!card.hatched)
    }

    /// 29 October 2026 is a Thursday; the expectation is built from the date.
    @Test func partialWeekdayMatchesTheDate() throws {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
        let date = try #require(cal.date(from: DateComponents(year: 2026, month: 10, day: 29, hour: 12)))
        let weekday = date.formatted(Date.FormatStyle(locale: Locale(identifier: "nl_NL"), timeZone: cal.timeZone)
            .weekday(.abbreviated))
            .lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))

        let card = try #require(LeefgeldCard.make(Self.figure(partial: true, coveredThrough: "2026-10-29",
                                                              spent: 4790, left: 5210),
                                                  newestBooking: "2026-10-29"))
        #expect(card.hatched)
        #expect(card.lines.contains("t/m \(weekday) 29 okt"))
        #expect(card.hero == "€ 52,10")
    }

    /// Overspent is information, not something waiting on Martin: no minus
    /// sign as a scare, and the card has no amber to give.
    @Test func negativeLeftReadsOverspent() throws {
        let card = try #require(LeefgeldCard.make(Self.figure(spent: 11_240, left: -1240), newestBooking: "2026-11-01"))
        #expect(card.overspent)
        #expect(card.headline == "€ 12,40 meer uitgegeven dan het weekbedrag")
        #expect(card.hero == "€ 12,40")
        #expect(!card.text.contains("−"))
    }

    @Test func geenDataShowsNoAmount() throws {
        let card = try #require(LeefgeldCard.make(
            .geenData(accountIban: "NL00TEST9876543210", accountReason: .configured, week: Self.week,
                      newestBooking: "2026-10-18"),
            newestBooking: "2026-10-18"))
        #expect(card.headline == "geen data — laatste afschrift t/m 18 okt")
        #expect(card.hero == nil)
        #expect(!card.text.contains("€"))
    }

    @Test func geenDataOverAnEmptyTableSaysThereAreNoStatements() throws {
        let card = try #require(LeefgeldCard.make(
            .geenData(accountIban: "NL00TEST9876543210", accountReason: .configured, week: Self.week,
                      newestBooking: nil),
            newestBooking: nil))
        #expect(card.headline == "geen data — nog geen afschriften")
        #expect(!card.text.contains("€"))
    }

    @Test func noBudgetHidesCard() {
        #expect(LeefgeldCard.make(.noBudget, newestBooking: "2026-11-01") == nil)
    }

    /// Production on 2026-11-01: no rows at all, LEEFGELD_IBAN unset. That is
    /// not a broken recogniser — there is nothing to recognise yet — so the
    /// card must not say "niet herkend".
    @Test func noAccountWithoutStatementsSaysNoStatementsYet() throws {
        let card = try #require(LeefgeldCard.make(.noAccount(candidates: []), newestBooking: nil))
        #expect(card.headline == "Nog geen afschriften")
        #expect(!card.text.contains("niet herkend"))
        #expect(!card.text.contains("€"))
        #expect(card.hero == nil)
    }

    @Test func noAccountWithStatementsIsNotRecognised() throws {
        let card = try #require(LeefgeldCard.make(.noAccount(candidates: []), newestBooking: "2026-10-30"))
        #expect(card.headline == "Leefgeldrekening niet herkend")
        #expect(card.lines.contains("Geen rekening krijgt wekelijks geld binnen."))
        #expect(!card.text.contains("€"))
    }

    @Test func severalCandidatesAreNamedAsSeveral() throws {
        let card = try #require(LeefgeldCard.make(
            .noAccount(candidates: ["NL00TEST0123456789", "NL00TEST9876543210"]), newestBooking: "2026-10-30"))
        #expect(card.headline == "Leefgeldrekening niet herkend")
        #expect(card.lines.contains("2 rekeningen krijgen wekelijks geld binnen; Grip kiest er niet zelf een."))
    }

    @Test func previousWeekLineOnlyForAFigure() {
        #expect(LeefgeldCard.previousWeekLine(Self.figure(spent: 9150, left: 850)) == "Vorige week: € 8,50 over")
        #expect(LeefgeldCard.previousWeekLine(Self.figure(spent: 10_500, left: -500))
                == "Vorige week: € 5,00 meer uitgegeven dan het weekbedrag")
        #expect(LeefgeldCard.previousWeekLine(.noBudget) == nil)
        #expect(LeefgeldCard.previousWeekLine(.noAccount(candidates: [])) == nil)
    }

    // MARK: account cards (on the synthetic fixtures)

    private func glance(_ fixture: String) throws -> MoneyGlance {
        MoneyGlance(try FixtureTests.decode(MoneySummaryDTO.self, fixture, "money/summary"))
    }

    /// Accounts are never merged: one card per IBAN, and nothing anywhere in
    /// the glance states a figure across them.
    @Test func cardsAreNeverSummed() throws {
        let dto = try FixtureTests.decode(MoneySummaryDTO.self, "money-complete", "money/summary")
        let g = MoneyGlance(dto)
        #expect(g.accounts.map(\.id) == ["NL00TEST0123456789", "NL00TEST9876543210"])
        let labels = Mirror(reflecting: g).children.compactMap(\.label)
        #expect(!labels.contains { $0.lowercased().contains("total") || $0.lowercased().contains("sum") })

        // No text equals any cross-account sum of a month's in or out.
        let all = g.allText
        let first = dto.accounts[0].months, second = dto.accounts[1].months
        // Only months where both sides are non-zero: a sum with a zero is just
        // the other account's own figure, which is rightly on its own card.
        for (a, b) in zip(first, second) where a.month == b.month {
            if a.outCents > 0 && b.outCents > 0 { #expect(!all.contains(MoneyFormat.euro(cents: a.outCents + b.outCents))) }
            if a.inCents > 0 && b.inCents > 0 { #expect(!all.contains(MoneyFormat.euro(cents: a.inCents + b.inCents))) }
        }
    }

    @Test func monthWithoutCoverageSaysGeenData() throws {
        let beheer = try #require(try glance("money-complete").accounts.first)
        let november = try #require(beheer.months.first { $0.month == "2026-11" })
        #expect(november.coverage == .none)
        #expect(november.status == "geen data")
        #expect(november.inText == nil && november.outText == nil)
        #expect(!november.text.contains("€"))
    }

    @Test func partialMonthIsHatched() throws {
        let beheer = try #require(try glance("money-complete").accounts.first)
        let october = try #require(beheer.months.first { $0.month == "2026-10" })
        #expect(october.hatched)
        #expect(october.status == "deels")
        let september = try #require(beheer.months.first { $0.month == "2026-09" })
        #expect(!september.hatched)
    }

    @Test func disclosuresTravelWithTheirMonth() throws {
        let beheer = try #require(try glance("money-complete").accounts.first)
        let august = try #require(beheer.months.first { $0.month == "2026-08" })
        #expect(august.disclosures.first == .init(id: "00000000-f1c5-4000-8000-500000000001", kind: "eenmalig",
                                                  day: "19 aug", name: "Zorgverzekeraar Duinzorg", amount: "€ 85,00"))
        // August's four weekly transfers to the leefgeldrekening follow it.
        #expect(august.disclosures.dropFirst().map(\.kind) == Array(repeating: "eigen overboeking", count: 4))
        #expect(august.disclosures.dropFirst().map(\.day) == ["6 aug", "13 aug", "20 aug", "27 aug"])
    }

    /// Bars scale to their OWN account's largest month, never to another's.
    @Test func barsScalePerAccount() throws {
        for account in try glance("money-complete").accounts {
            let peak = account.months.flatMap { [$0.inFraction, $0.outFraction] }.max() ?? 0
            #expect(peak == 1)
        }
    }

    @Test func productionsEmptyStateReadsHonestly() throws {
        let g = try glance("money-no-account")
        #expect(g.accounts.isEmpty)
        #expect(g.leefgeld?.headline == "Nog geen afschriften")
        #expect(g.freshness == "nog geen afschriften ingelezen")
        #expect(!g.allText.contains("€"))
    }

    @Test func noBudgetFixtureHidesTheLeefgeldCardButKeepsTheAccounts() throws {
        let g = try glance("money-no-budget")
        #expect(g.leefgeld == nil)
        #expect(g.accounts.count == 2)
        #expect(!g.overview.isEmpty, "the Overzicht card still has something to say")
        // The leefgeldrekening's November has no rows: its line falls back to
        // October, and no line draws a month without rows as € 0,00.
        #expect(g.overview.count == 2)
        #expect(!g.overview.contains { $0.contains(/€\s0,00/) })
        #expect(g.overview.allSatisfy { !$0.contains("nov") })
    }

    @Test func freshnessNamesTheNewestBooking() throws {
        #expect(try glance("money-partial").freshness == "laatste afschrift t/m do 29 okt")
    }

    // MARK: the store

    @Test func storeLoadsTheSummary() async throws {
        let store = MoneyStore(client: FixtureEnvironment.client(fixture: "money-complete"))
        await store.refresh()
        #expect(store.glance?.leefgeld?.hero == "€ 37,60")
        #expect(store.lastError == nil)
    }

    @Test func storeReportsAnExpiredSession() async {
        final class Seen { var rejected = 0 }
        let seen = Seen()
        let store = MoneyStore(client: FixtureEnvironment.client(fixture: "unauthorized"),
                               onUnauthorized: { seen.rejected += 1 })
        await store.refresh()
        #expect(store.glance == nil)
        #expect(store.lastError == .unauthorized)
        #expect(seen.rejected == 1)
    }
}

/// Review fix: the Overzicht money card renders WHILE LOCKED, and VoiceOver
/// reads the figure's accessibility text. That text must never identify an
/// account — the account line belongs to Geld, behind the lock.
@MainActor
struct LeefgeldGlanceTextTests {
    @Test(arguments: ["money-complete", "money-geen-data"])
    func glanceTextNamesNoAccount(_ name: String) throws {
        let dto = try FixtureTests.decode(MoneySummaryDTO.self, name, "money/summary")
        let card = try #require(MoneyGlance(dto).leefgeld)
        let iban: String
        switch dto.leefgeld {
        case .figure(let f): iban = f.accountIban
        case .geenData(let i, _, _, _): iban = i
        default: Issue.record("\(name) has no account"); return
        }
        #expect(card.accountLine != nil, "fixture should carry an account line, or this test proves nothing")
        #expect(!card.glanceText.contains("rekening"))
        #expect(!card.glanceText.contains(MoneyFormat.ibanTail(iban)))
        #expect(!card.glanceText.contains(String(iban.suffix(4))))
        #expect(card.glanceText.contains(card.headline))
    }
}

/// Review fix: what the Overzicht money card shows WHILE LOCKED is decided by
/// `MoneyGlance.summary(revealed:)`, not inside the view — so dropping the
/// lock check, or giving VoiceOver the account line, fails here.
@MainActor
struct MoneyGlanceSummaryTests {
    private static func ibans(_ dto: MoneySummaryDTO) -> [String] {
        var all = dto.accounts.compactMap(\.accountIban)
        for week in [dto.leefgeld, dto.previousWeek] {
            switch week {
            case .figure(let f): all.append(f.accountIban)
            case .geenData(let i, _, _, _): all.append(i)
            case .noAccount(let c): all += c
            case .noBudget: break
            }
        }
        return all
    }

    @Test(arguments: ["money-no-budget", "money-complete", "money-geen-data",
                      "money-partial", "money-overspent", "money-unrecognised"])
    func lockedSummaryNamesNoAccount(_ name: String) throws {
        let dto = try FixtureTests.decode(MoneySummaryDTO.self, name, "money/summary")
        let ibans = Self.ibans(dto)
        #expect(!ibans.isEmpty, "fixture should carry an account, or this test proves nothing")
        let locked = MoneyGlance(dto).summary(revealed: false)
        #expect(locked.lines.isEmpty)
        let text = locked.allText.lowercased()
        // "Leefgeldrekening niet herkend" names no account and stays; what
        // must not appear is a NAMED account ("rekening …3210" / "rekening NL…").
        #expect(!text.contains("rekening …"))
        #expect(!text.contains("rekening nl"))
        #expect(!text.contains("…"))
        if case .noAccount = dto.leefgeld {} else { #expect(!text.contains("rekening")) }
        for iban in ibans {
            #expect(!text.contains(MoneyFormat.ibanTail(iban).lowercased()))
            #expect(!text.contains(String(iban.suffix(4))))
        }
        if let a11y = locked.figureAccessibilityText {
            #expect(a11y == locked.figure?.glanceText)
            #expect(!a11y.contains(locked.figure?.accountLine ?? "\u{0}"))
        }
    }

    @Test func revealedSummaryShowsTheAccountLines() throws {
        let dto = try FixtureTests.decode(MoneySummaryDTO.self, "money-no-budget", "money/summary")
        let glance = MoneyGlance(dto)
        #expect(glance.leefgeld == nil)
        #expect(!glance.overview.isEmpty, "fixture should carry an account month, or this test proves nothing")
        let revealed = glance.summary(revealed: true)
        #expect(revealed.lines == glance.overview)
        // A wrap never splits a label from its amount: "uit" and "€ 1.760,00" are one word.
        for line in glance.overview {
            for label in ["in", "uit"] {
                #expect(line.contains("· \(label)\u{00A0}€\u{00A0}"), "\(label) is bound to its amount in \(line)")
                #expect(!line.contains("\(label) €"))
            }
        }
        let iban = try #require(dto.accounts.first?.accountIban)
        #expect(revealed.allText.contains(MoneyFormat.ibanTail(iban)))
        #expect(revealed.freshness == glance.freshness)
    }

    @Test func revealedFigureStillLeavesTheAccountToGeld() throws {
        let dto = try FixtureTests.decode(MoneySummaryDTO.self, "money-complete", "money/summary")
        let s = MoneyGlance(dto).summary(revealed: true)
        let card = try #require(s.figure)
        #expect(card.accountLine != nil)
        #expect(s.figureAccessibilityText == card.glanceText)
        #expect(!s.allText.contains("rekening"))
    }
}
