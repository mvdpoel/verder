import Foundation
import Testing
@testable import Verder

struct DetailWheelTests {
    static func date(_ s: String) -> Date { parseISODate(s)! }

    @Test func theDaysAreNamedOnTheScreensClockAroundTheChosenDay() {
        let now = Self.date("2026-11-02T13:02:00.000Z")
        let chosen = Self.date("2026-11-04T16:00:00.000Z")
        let days = DetailWheel.days(selected: chosen, now: now)
        #expect(days.count == 2 * DetailWheel.span + 1)
        #expect(days.map(DetailText.dayName).contains("wo\u{00A0}4\u{00A0}nov"))
        #expect(!days.map(DetailText.dayName).contains { $0.lowercased().contains("vandaag") })
        // A day far outside the span is still offered.
        let far = Self.date("2029-01-01T10:00:00.000Z")
        #expect(DetailWheel.days(selected: far, now: now).last == DetailWheel.parts(of: far).day)
    }

    @Test func theMinutesStepByFiveAndKeepTheProposalsOwn() {
        #expect(DetailWheel.minutes(including: 55) == [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
        #expect(DetailWheel.minutes(including: 2).prefix(3) == [0, 2, 5])
    }

    @Test func aDayAndTimeComposeInAmsterdam() {
        let p = DetailWheel.parts(of: Self.date("2026-11-03T16:00:00.000Z"))
        #expect(p.hour == 17 && p.minute == 0, "CET is UTC+1 in November")
        let moved = DetailWheel.compose(day: p.day, hour: 9, minute: 5)
        #expect(SuggestionFormat.iso(moved) == "2026-11-03T08:05:00.000Z")
        // Across the clock change (25 Oct 2026): still the wall-clock hour.
        let summer = DetailWheel.parts(of: Self.date("2026-10-20T15:00:00.000Z"))
        #expect(summer.hour == 17)
    }
}

@MainActor
struct SessionExpiredTests {
    @Test func anExpiredSessionKeepsTheScreenAndTheEditsForTheNextSignIn() async {
        let kept = KeptSuggestionEdits()
        var asked = 0
        let server = SuggestionServer(SuggestionFixture.entry, approve: .status(401))
        let m = SuggestionDetailModel(client: server.stub.client(store: InMemorySessionStore(ProposalModelTests.cookie)),
                                      onUnauthorized: { asked += 1 }, kept: kept)
        await m.load(id: SuggestionFixture.id)
        m.set("summary", "Betalingsregeling afgesproken")
        m.set("details", "Vijftig euro per maand.")
        #expect(await m.approve() == false)
        #expect(m.sessionExpired)
        #expect(asked == 0, "only the button opens sign-in")
        #expect(m.isOpen, "still waiting on Martin")
        #expect(m.changedCount == 2)
        #expect(m.expiredText == "Je sessie op deze telefoon is verlopen. Je 2 aanpassingen blijven op deze telefoon bewaard.")
        m.signInAgain()
        #expect(asked == 1)

        // Signed in again: the same suggestion opens with the edits back, once.
        let again = SuggestionServer(SuggestionFixture.entry)
        let n = SuggestionDetailModel(client: again.stub.client(store: InMemorySessionStore(ProposalModelTests.cookie)), kept: kept)
        await n.load(id: SuggestionFixture.id)
        #expect(n.value("summary") == "Betalingsregeling afgesproken")
        #expect(n.changedCount == 2)
        #expect(kept.peek(SuggestionFixture.id) == nil)
    }

    @Test func oneKeptEditIsSaidInTheSingular() async {
        let kept = KeptSuggestionEdits()
        let server = SuggestionServer(SuggestionFixture.entry, approve: .status(401))
        let m = SuggestionDetailModel(client: server.stub.client(store: InMemorySessionStore(ProposalModelTests.cookie)), kept: kept)
        await m.load(id: SuggestionFixture.id)
        m.set("summary", "Anders")
        _ = await m.approve()
        #expect(m.expiredText.hasSuffix("Je aanpassing blijft op deze telefoon bewaard."))
        kept.forgetAll()
        #expect(kept.peek(SuggestionFixture.id) == nil)
    }
}
