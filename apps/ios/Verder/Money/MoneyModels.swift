import Foundation

/// `GET /api/mobile/v1/money/summary`
/// (apps/web/src/app/api/mobile/v1/money/summary/route.ts): each account's
/// last six months and "leefgeld over deze week" with the week before it.
///
/// There is NO total across accounts in this answer and none may be added on
/// the phone: under bewind the money moves between accounts, and one summed
/// line draws a collapse that never happened (CLAUDE.md, money in/out).
struct MoneySummaryDTO: Decodable, Equatable, Sendable {
    struct Account: Decodable, Equatable, Sendable {
        /// Nil is the "unknown account" series: rows with no IBAN, never merged
        /// into a known one.
        let accountIban: String?
        let months: [MonthSeries]
        /// This account's own newest readable booking (Amsterdam day key).
        /// Nil from a server that predates the field, or an account with no
        /// readable row: the card then simply leaves the line out.
        let newestBooking: String?
        /// The leefgeldrekening (LEEFGELD_IBAN, or the account the leefgeld
        /// week recognised). False from a server that predates the field.
        let isLeefgeldAccount: Bool

        init(accountIban: String?, months: [MonthSeries], newestBooking: String? = nil, isLeefgeldAccount: Bool = false) {
            self.accountIban = accountIban
            self.months = months
            self.newestBooking = newestBooking
            self.isLeefgeldAccount = isLeefgeldAccount
        }

        private enum Key: String, CodingKey { case accountIban, months, newestBooking, isLeefgeldAccount }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            accountIban = try c.decodeIfPresent(String.self, forKey: .accountIban)
            months = try c.decode([MonthSeries].self, forKey: .months)
            newestBooking = try c.decodeIfPresent(String.self, forKey: .newestBooking)
            isLeefgeldAccount = try c.decodeIfPresent(Bool.self, forKey: .isLeefgeldAccount) ?? false
        }
    }

    let accounts: [Account]
    let leefgeld: LeefgeldWeek
    let previousWeek: LeefgeldWeek
    /// Newest readable booking (Amsterdam day key), nil on an empty table:
    /// "deze week" is only as fresh as the last imported statement.
    let newestBooking: String?
}

/// `MonthSeries` (packages/api/src/money-series.ts).
struct MonthSeries: Decodable, Equatable, Sendable {
    enum Coverage: String, Decodable, Sendable { case complete, partial, none }
    struct Category: Decodable, Equatable, Sendable { let category: String; let cents: Int }

    let month: String
    let coverage: Coverage
    let inCents: Int
    let outCents: Int
    let outByCategory: [Category]
    let incidentalCents: Int
    let internalCents: Int
    let parseErrorRows: Int
    let internalRows: [DisclosedRow]
    let incidentalRows: [DisclosedRow]
}

/// `DisclosedRow` (money-series.ts): one bank row behind a disclosed total.
struct DisclosedRow: Decodable, Equatable, Sendable {
    let id: String
    let bookedAt: Date
    let amountCents: Int
    let counterpartyName: String?
}

/// `LeefgeldWeek` (packages/api/src/leefgeld-week.ts). `complete` and
/// `partial` share one shape and are one case here, told apart by `partial`.
/// An unknown `state` fails the decode: a 2xx the phone cannot read did not
/// answer the question.
enum LeefgeldWeek: Decodable, Equatable, Sendable {
    struct Week: Decodable, Equatable, Sendable { let from: String; let to: String }
    enum Reason: String, Decodable, Sendable {
        case configured
        case weeklyIncome = "weekly-income"
    }

    struct Figure: Equatable, Sendable {
        let partial: Bool
        let accountIban: String
        let accountReason: Reason
        let week: Week
        let coveredThrough: String
        let budgetCents: Int
        let spentCents: Int
        /// May be negative: more was spent than the weekly amount.
        let leftCents: Int
        /// Debits as booked (negative), oldest first; `spentCents` is their negated sum.
        let spentRows: [DisclosedRow]
        let depositCents: Int
        let depositRows: [DisclosedRow]
    }

    case noBudget
    case noAccount(candidates: [String])
    case geenData(accountIban: String, accountReason: Reason, week: Week, newestBooking: String?)
    case figure(Figure)

    private enum Key: String, CodingKey {
        case state, candidates, accountIban, accountReason, week, newestBooking, coveredThrough
        case budgetCents, spentCents, leftCents, spentRows, depositCents, depositRows
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let state = try c.decode(String.self, forKey: .state)
        switch state {
        case "no-budget":
            self = .noBudget
        case "no-account":
            self = .noAccount(candidates: try c.decode([String].self, forKey: .candidates))
        case "geen-data":
            self = .geenData(accountIban: try c.decode(String.self, forKey: .accountIban),
                             accountReason: try c.decode(Reason.self, forKey: .accountReason),
                             week: try c.decode(Week.self, forKey: .week),
                             newestBooking: try c.decodeIfPresent(String.self, forKey: .newestBooking))
        case "complete", "partial":
            self = .figure(Figure(
                partial: state == "partial",
                accountIban: try c.decode(String.self, forKey: .accountIban),
                accountReason: try c.decode(Reason.self, forKey: .accountReason),
                week: try c.decode(Week.self, forKey: .week),
                coveredThrough: try c.decode(String.self, forKey: .coveredThrough),
                budgetCents: try c.decode(Int.self, forKey: .budgetCents),
                spentCents: try c.decode(Int.self, forKey: .spentCents),
                leftCents: try c.decode(Int.self, forKey: .leftCents),
                spentRows: try c.decode([DisclosedRow].self, forKey: .spentRows),
                depositCents: try c.decode(Int.self, forKey: .depositCents),
                depositRows: try c.decode([DisclosedRow].self, forKey: .depositRows)))
        default:
            throw DecodingError.dataCorruptedError(forKey: .state, in: c,
                                                   debugDescription: "unknown leefgeld state \(state)")
        }
    }
}
