import Foundation
import Observation

/// One disclosed bank row, as a line: "19 aug · Zorgverzekeraar Duinzorg · € 85,00".
struct DisclosureLine: Equatable, Identifiable, Sendable {
    let id: String
    /// "eenmalig", "eigen overboeking", "uitgegeven", "ontvangen".
    let kind: String
    let day: String
    let name: String
    let amount: String

    init(id: String, kind: String, day: String, name: String, amount: String) {
        self.id = id; self.kind = kind; self.day = day; self.name = name; self.amount = amount
    }

    init(_ row: DisclosedRow, kind: String) {
        self.init(id: row.id, kind: kind, day: MoneyFormat.day(row.bookedAt),
                  name: row.counterpartyName ?? "onbekend", amount: MoneyFormat.euro(cents: row.amountCents))
    }
}

/// "Leefgeld over deze week", decided outside the view (spec §7.6, Plan 3
/// Task 19). The figure is `leefgeld-week.ts`'s; this only words it.
///
/// - `noBudget` → no card at all (`make` returns nil).
/// - `noAccount` over an EMPTY table → "Nog geen afschriften": nothing has been
///   imported, so there is nothing to recognise — not a fault (production on
///   2026-11-01). With statements present → "Leefgeldrekening niet herkend".
/// - `geenData` → no amount anywhere on the card, only how far the statements go.
/// - `figure` → what is left; `partial` is hatched and says "t/m <dag>".
///
/// NEVER AMBER: an overspent week is information about money, not something
/// waiting on Martin. The card has no amber to give.
struct LeefgeldCard: Equatable, Sendable {
    static let label = "LEEFGELD OVER DEZE WEEK"

    let headline: String
    /// The big number, or nil when there is no figure to show.
    let hero: String?
    /// The words beside the hero: "over deze week" / "meer uitgegeven dan het weekbedrag".
    let heroCaption: String?
    /// Breakdown, coverage, the week itself, or what explains a missing figure.
    let lines: [String]
    /// Which account and why it was chosen — only shown once unlocked
    /// (it identifies an account, which the counts-only glance does not).
    let accountLine: String?
    let hatched: Bool
    let overspent: Bool
    /// The debits and deposits behind the figure, oldest first.
    let rows: [DisclosureLine]

    var text: String { ([headline] + lines + [accountLine].compactMap { $0 }).joined(separator: "\n") }
    /// What VoiceOver reads for the figure. The figure renders on the
    /// Overzicht card WHILE LOCKED, so it carries no account line — the
    /// account reaches VoiceOver on Geld through its own readout.
    var glanceText: String { ([headline] + lines).joined(separator: "\n") }

    static func make(_ week: LeefgeldWeek, newestBooking: String?) -> LeefgeldCard? {
        switch week {
        case .noBudget:
            return nil
        case .noAccount(let candidates):
            if newestBooking == nil {
                return LeefgeldCard(
                    headline: "Nog geen afschriften", hero: nil, heroCaption: nil,
                    lines: ["Zodra een bankafschrift is ingelezen, staat hier wat er deze week over is."],
                    accountLine: nil, hatched: false, overspent: false, rows: [])
            }
            let why = switch candidates.count {
            case 0: "Geen rekening krijgt wekelijks geld binnen."
            case 1: "1 rekening krijgt wekelijks geld binnen."
            default: "\(candidates.count) rekeningen krijgen wekelijks geld binnen; verder kiest er niet zelf een."
            }
            return LeefgeldCard(headline: "Leefgeldrekening niet herkend", hero: nil, heroCaption: nil,
                                lines: [why], accountLine: nil, hatched: false, overspent: false, rows: [])
        case .geenData(let iban, let reason, let w, let newest):
            let headline = newest.flatMap(MoneyFormat.day).map { "geen data — laatste afschrift t/m \($0)" }
                ?? "geen data — nog geen afschriften"
            return LeefgeldCard(headline: headline, hero: nil, heroCaption: nil,
                                lines: [weekLine(w)].compactMap { $0 },
                                accountLine: accountLine(iban, reason), hatched: false, overspent: false, rows: [])
        case .figure(let f):
            let overspent = f.leftCents < 0
            let hero = MoneyFormat.euro(cents: overspent ? -f.leftCents : f.leftCents)
            let caption = overspent ? "meer uitgegeven dan het weekbedrag" : "over deze week"
            let headline = overspent ? "\(hero) \(caption)" : "Leefgeld over deze week: \(hero)"
            let breakdown = "uitgegeven \(MoneyFormat.euro(cents: f.spentCents)) · ontvangen \(MoneyFormat.euro(cents: f.depositCents))"
            let covered = f.partial ? MoneyFormat.dayWithWeekday(f.coveredThrough).map { "t/m \($0)" } : nil
            let rows = (f.spentRows.map { DisclosureLine($0, kind: "uitgegeven") }
                        + f.depositRows.map { DisclosureLine($0, kind: "ontvangen") })
            return LeefgeldCard(headline: headline, hero: hero, heroCaption: caption,
                                lines: [breakdown, covered, weekLine(f.week)].compactMap { $0 },
                                accountLine: accountLine(f.accountIban, f.accountReason),
                                hatched: f.partial, overspent: overspent, rows: rows)
        }
    }

    /// The week before, in one line — only when there is something to say.
    static func previousWeekLine(_ week: LeefgeldWeek) -> String? {
        switch week {
        case .noBudget, .noAccount: return nil
        case .geenData: return "Vorige week: geen data"
        case .figure(let f):
            let line = f.leftCents < 0
                ? "Vorige week: \(MoneyFormat.euro(cents: -f.leftCents)) meer uitgegeven dan het weekbedrag"
                : "Vorige week: \(MoneyFormat.euro(cents: f.leftCents)) over"
            guard f.partial, let day = MoneyFormat.dayWithWeekday(f.coveredThrough) else { return line }
            return "\(line) (t/m \(day))"
        }
    }

    private static func weekLine(_ w: LeefgeldWeek.Week) -> String? {
        guard let from = MoneyFormat.dayWithWeekday(w.from), let to = MoneyFormat.dayWithWeekday(w.to) else { return nil }
        return "week \(from) – \(to)"
    }

    private static func accountLine(_ iban: String, _ reason: LeefgeldWeek.Reason) -> String {
        let why = switch reason {
        case .configured: "ingesteld"
        case .weeklyIncome: "herkend aan wekelijks leefgeld"
        }
        return "rekening \(MoneyFormat.ibanTail(iban)) · \(why)"
    }
}

/// One month of one account. `none` months say "geen data" and carry no
/// amount — never € 0,00; `partial` months are hatched and say "deels".
struct MonthBar: Equatable, Identifiable, Sendable {
    var id: String { month }
    let month: String
    let label: String
    let coverage: MonthSeries.Coverage
    let inText: String?
    let outText: String?
    let status: String?
    /// Bar lengths, 0…1, relative to THIS account's largest month only.
    let inFraction: Double
    let outFraction: Double
    let disclosures: [DisclosureLine]
    let parseErrorText: String?

    var hatched: Bool { coverage == .partial }
    var text: String {
        ([label, status, inText.map { "in \($0)" }, outText.map { "uit \($0)" }, parseErrorText].compactMap { $0 }
         + disclosures.map { "\($0.kind) \($0.day) \($0.name) \($0.amount)" }).joined(separator: " · ")
    }
}

/// One account, never summed with another.
struct AccountCard: Equatable, Identifiable, Sendable {
    let id: String
    let title: String
    let shortTitle: String
    let months: [MonthBar]

    init(_ account: MoneySummaryDTO.Account) {
        id = account.accountIban ?? "onbekend"
        title = account.accountIban.map { "Rekening \(MoneyFormat.iban($0))" } ?? "Onbekende rekening"
        shortTitle = account.accountIban.map(MoneyFormat.ibanTail) ?? "onbekende rekening"
        let covered = account.months.filter { $0.coverage != .none }
        // The scale is this account's own; integer max first, one division per bar.
        let peak = covered.map { max($0.inCents, $0.outCents) }.max() ?? 0
        func fraction(_ cents: Int, _ m: MonthSeries) -> Double {
            m.coverage == .none || peak <= 0 ? 0 : Double(cents) / Double(peak)
        }
        months = account.months.map { m in
            let has = m.coverage != .none
            let status: String? = switch m.coverage {
            case .complete: nil
            case .partial: "deels"
            case .none: "geen data"
            }
            return MonthBar(
                month: m.month, label: MoneyFormat.month(m.month) ?? m.month, coverage: m.coverage,
                inText: has ? MoneyFormat.euro(cents: m.inCents) : nil,
                outText: has ? MoneyFormat.euro(cents: m.outCents) : nil,
                status: status,
                inFraction: fraction(m.inCents, m), outFraction: fraction(m.outCents, m),
                disclosures: has ? m.incidentalRows.map { DisclosureLine($0, kind: "eenmalig") }
                    + m.internalRows.map { DisclosureLine($0, kind: "eigen overboeking") } : [],
                parseErrorText: has && m.parseErrorRows > 0
                    ? "\(m.parseErrorRows) \(m.parseErrorRows == 1 ? "regel" : "regels") onleesbaar" : nil)
        }
    }
}

/// Everything the Geld screen and the Overzicht money card say.
///
/// THERE IS NO TOTAL HERE and there must never be one: accounts are never
/// merged at any layer (Global Constraints; `cardsAreNeverSummed`).
struct MoneyGlance: Equatable, Sendable {
    let leefgeld: LeefgeldCard?
    /// Overzicht's shape of the same week (Verder/Home/LeefgeldGlance.swift).
    let leefgeldGlance: LeefgeldGlance?
    let previousWeek: String?
    let accounts: [AccountCard]
    /// "laatste afschrift t/m do 29 okt" — the honest age of every figure.
    let freshness: String
    /// One line per account for the Overzicht card: its newest month with data.
    let overview: [String]

    init(_ dto: MoneySummaryDTO) {
        leefgeld = LeefgeldCard.make(dto.leefgeld, newestBooking: dto.newestBooking)
        leefgeldGlance = LeefgeldGlance.make(dto.leefgeld, newestBooking: dto.newestBooking)
        previousWeek = LeefgeldCard.previousWeekLine(dto.previousWeek)
        accounts = dto.accounts.map(AccountCard.init)
        freshness = dto.newestBooking.flatMap(MoneyFormat.dayWithWeekday).map { "laatste afschrift t/m \($0)" }
            ?? "nog geen afschriften ingelezen"
        overview = accounts.compactMap { a in
            guard let m = a.months.last(where: { $0.coverage != .none }),
                  let inText = m.inText, let outText = m.outText else { return nil }
            let deels = m.hatched ? " deels" : ""
            return "\(a.shortTitle) · \(m.label)\(deels) · in \(inText) · uit \(outText)"
        }
    }

    /// What the Overzicht money card renders, decided here so the lock rule
    /// is tested rather than buried in a view (the `HomeSummary.preview(_:revealed:)`
    /// pattern). The card shows WHILE LOCKED: amounts and the statement age,
    /// never an account. Locked, the per-account lines (which carry the IBAN
    /// tail) are dropped; the leefgeld figure never carries its account line
    /// in either state — that belongs to Geld.
    struct Summary: Equatable, Sendable {
        let figure: LeefgeldCard?
        /// What VoiceOver reads for the figure; never the account line.
        let figureAccessibilityText: String?
        let lines: [String]
        let freshness: String

        /// Every string and VoiceOver label the card can produce, whole.
        var allText: String {
            ([figure?.headline, figure?.hero, figure?.heroCaption].compactMap { $0 }
             + (figure?.lines ?? []) + [figureAccessibilityText].compactMap { $0 }
             + lines + [freshness]).joined(separator: "\n")
        }
    }

    func summary(revealed: Bool) -> Summary {
        Summary(figure: leefgeld,
                figureAccessibilityText: leefgeld?.glanceText,
                lines: leefgeld == nil && revealed ? overview : [],
                freshness: freshness)
    }

    /// Every string the glance can render, for tests that read it whole.
    var allText: String {
        ([leefgeld?.text, previousWeek, freshness].compactMap { $0 } + overview
         + accounts.flatMap { [$0.title] + $0.months.map(\.text) }).joined(separator: "\n")
    }
}

/// The money summary, fetched for Overzicht and Geld. A failed refresh keeps
/// the last good answer: it learned nothing, so it changes nothing.
@MainActor
@Observable
final class MoneyStore {
    static let path = "/api/mobile/v1/money/summary"

    private(set) var glance: MoneyGlance?
    private(set) var lastError: APIError?

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void

    @ObservationIgnored private let epoch: SessionEpoch

    init(client: APIClient, onUnauthorized: @escaping @MainActor () -> Void = {}, epoch: SessionEpoch = SessionEpoch()) {
        self.client = client
        self.onUnauthorized = onUnauthorized
        self.epoch = epoch
        epoch.whenEnded { [weak self] in
            self?.glance = nil
            self?.lastError = nil
        }
    }

    /// An answer that arrives after the session ended (`SessionEpoch`) is
    /// dropped, its 401 included: it belongs to a session already gone.
    func refresh() async {
        let started = epoch.current
        let result = await Self.fetch(client)
        guard epoch.isCurrent(started) else { return }
        switch result {
        case .success(let dto):
            glance = MoneyGlance(dto)
            lastError = nil
        case .failure(let error):
            lastError = error
            if error == .unauthorized { onUnauthorized() }
        }
    }

    nonisolated private static func fetch(_ client: APIClient) async -> Result<MoneySummaryDTO, APIError> {
        do {
            let dto: MoneySummaryDTO = try await client.getJSON(path)
            return .success(dto)
        } catch let error as APIError {
            return .failure(error)
        } catch {
            return .failure(.transport(String(describing: error)))
        }
    }
}
