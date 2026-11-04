import Foundation
import Testing
@testable import Grip

/// Plan 3 Task 19: money is integer cents end to end; the phone formats it
/// and never does arithmetic in floating point.
struct MoneyFormatTests {
    @Test func euroFormatsDutch() {
        #expect(MoneyFormat.euro(cents: 0) == "€ 0,00")
        #expect(MoneyFormat.euro(cents: 5) == "€ 0,05")
        #expect(MoneyFormat.euro(cents: 6240) == "€ 62,40")
        #expect(MoneyFormat.euro(cents: 123_456) == "€ 1.234,56")
        #expect(MoneyFormat.euro(cents: 100_000_000) == "€ 1.000.000,00")
    }

    @Test func negativeEuroCarriesAMinusSign() {
        #expect(MoneyFormat.euro(cents: -6240) == "−€ 62,40")
        // The magnitude of Int.min does not fit an Int; it must not trap.
        #expect(MoneyFormat.euro(cents: Int.min).hasPrefix("−€ "))
    }

    /// The weekday is the DATE's, computed, never a table indexed by position.
    @Test func dayKeysReadAsDutchCivilDays() {
        #expect(MoneyFormat.day("2026-10-29") == "29 okt")
        #expect(MoneyFormat.dayWithWeekday("2026-10-29") == "do 29 okt")
        #expect(MoneyFormat.dayWithWeekday("2026-11-01") == "zo 1 nov")
        // 25 October 2026 is the DST change in Amsterdam; a civil day still.
        #expect(MoneyFormat.dayWithWeekday("2026-10-25") == "zo 25 okt")
        #expect(MoneyFormat.day("2026-13-01") == nil)
        #expect(MoneyFormat.day("29 okt") == nil)
    }

    @Test func monthKeysReadAsShortDutchMonths() {
        #expect(MoneyFormat.month("2026-10") == "okt '26")
        #expect(MoneyFormat.month("2027-03") == "mrt '27")
        #expect(MoneyFormat.month("2026-00") == nil)
    }

    /// A booking instant is shown on Amsterdam's calendar: 23:30 UTC on
    /// 18 August is already 19 August there.
    @Test func bookingInstantsUseAmsterdamsCalendar() {
        let at = ISO8601DateFormatter().date(from: "2026-08-18T23:30:00Z")!
        #expect(MoneyFormat.day(at) == "19 aug")
    }

    @Test func ibanIsGroupedAndShortened() {
        #expect(MoneyFormat.iban("NL00TEST0123456789") == "NL00 TEST 0123 4567 89")
        #expect(MoneyFormat.ibanTail("NL00TEST0123456789") == "…6789")
    }
}
