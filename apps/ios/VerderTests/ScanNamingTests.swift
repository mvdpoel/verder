import Testing
import Foundation
@testable import Verder

struct ScanNamingTests {
    static func date(_ iso: String) -> Date {
        try! Date(iso, strategy: .iso8601)
    }

    /// Winter time (CET, UTC+1) on 28 October, summer time (CEST, UTC+2) on
    /// 1 July: the title is the wall clock in Amsterdam, never UTC and never
    /// the simulator's own zone.
    @Test func titleUsesAmsterdamTime() {
        #expect(ScanNaming.title(capturedAt: Self.date("2026-10-28T13:05:00Z")) == "Scan 2026-10-28 14.05.pdf")
        #expect(ScanNaming.title(capturedAt: Self.date("2026-07-01T13:05:00Z")) == "Scan 2026-07-01 15.05.pdf")
    }

    /// Just after midnight in Amsterdam is still the previous day in UTC.
    @Test func titleTakesTheAmsterdamDay() {
        #expect(ScanNaming.title(capturedAt: Self.date("2026-10-27T23:30:00Z")) == "Scan 2026-10-28 00.30.pdf")
    }
}
