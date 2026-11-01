import Testing
import Foundation
import UserNotifications
@testable import Verder

/// The Sunday summary on the phone (Plan 3 Task 26, iOS half): the `/weekly`
/// contract decodes field for field, the window reads as the two Sunday 18:00
/// instants it is (never Monday–Sunday), the screen says only what the stored
/// summary counted — no comparison, nothing invented — and ends with ONE next
/// step to Voor jou. A WEEKLY push opens it.
@MainActor
struct WeeklyDTOTests {
    /// The route's example, with the synthetic case's numbers.
    nonisolated static let json = #"""
    {
      "week": "2026-W44",
      "from": "2026-10-25T17:00:00.000Z",
      "to": "2026-11-01T17:00:00.000Z",
      "sent": 3, "received": 7, "filedByMartin": 3, "filedByVerder": 2, "tasksDone": 2, "waiting": 4,
      "topWaiting": [
        { "kind": "task", "id": "00000000-f1c5-4000-8000-000000000004", "title": "Loonstrook oktober sturen",
          "subtitle": null, "priority": 3, "at": "2026-10-30T10:00:00.000Z", "dueAt": null, "verder": false }
      ]
    }
    """#

    static func decode(_ json: String) throws -> WeeklyDTO {
        try APIClient.jsonDecoder.decode(WeeklyDTO.self, from: Data(json.utf8))
    }

    static func dto(sent: Int = 3, received: Int = 7, filedByMartin: Int = 3, filedByVerder: Int = 2,
                    tasksDone: Int = 2, waiting: Int = 4, top: Int = 1) throws -> WeeklyDTO {
        let item = #"{"kind":"suggestion","id":"x","title":"T","subtitle":null,"priority":3,"at":"2026-10-30T10:00:00.000Z","dueAt":null,"verder":false}"#
        return try decode("""
        {"week":"2026-W44","from":"2026-10-25T17:00:00.000Z","to":"2026-11-01T17:00:00.000Z",
         "sent":\(sent),"received":\(received),"filedByMartin":\(filedByMartin),"filedByVerder":\(filedByVerder),
         "tasksDone":\(tasksDone),"waiting":\(waiting),
         "topWaiting":[\(Array(repeating: item, count: top).joined(separator: ","))]}
        """)
    }

    // MARK: - The contract

    @Test func decodesTheRouteContract() throws {
        let d = try Self.decode(Self.json)
        #expect(d.week == "2026-W44")
        #expect(d.from == Date(timeIntervalSince1970: 1_792_947_600)) // 2026-10-25T17:00:00Z
        #expect(d.to == Date(timeIntervalSince1970: 1_793_552_400))   // 2026-11-01T17:00:00Z
        let counts: [Int] = [d.sent, d.received, d.filedByMartin, d.filedByVerder, d.tasksDone, d.waiting]
        #expect(counts == [3, 7, 3, 2, 2, 4])
        #expect(d.topWaiting.map(\.kind) == [.task])
        #expect(d.topWaiting.first?.title == "Loonstrook oktober sturen")
    }

    /// The server checks the stored row (`isWeeklySummary`); the phone does not
    /// take a negative count or a malformed week key on trust either.
    @Test(arguments: [
        #""week":"2026-44""#, #""week":"W44""#, #""sent":-1"#, #""waiting":-3"#,
    ])
    func refusesWhatTheContractForbids(_ broken: String) throws {
        let key = String(broken.split(separator: ":")[0])
        var json = Self.json
        let pattern = try Regex("\(key):\\s*(\"[^\"]*\"|-?\\d+)")
        json.replace(pattern, maxReplacements: 1) { _ in broken }
        #expect(json.contains(broken))
        #expect(throws: (any Error).self) { try Self.decode(json) }
    }

    @Test func aMissingFieldIsRefusedNotDefaulted() {
        let json = Self.json.replacingOccurrences(of: #""tasksDone": 2, "#, with: "")
        #expect(throws: (any Error).self) { try Self.decode(json) }
    }

    // MARK: - The window

    /// `[from, to)` is previous Sunday 18:00 to this Sunday 18:00 Amsterdam.
    /// Rendered as the two instants; `to` is never turned into "za 31 okt".
    @Test func theWindowReadsSundayToSundayInAmsterdam() throws {
        let d = try Self.decode(Self.json)
        #expect(WeeklyFormat.window(from: d.from, to: d.to) == "zo 25 okt 18:00 – zo 1 nov 18:00")
        #expect(WeeklyFormat.weekLabel("2026-W44") == "week 44")
        #expect(WeeklyFormat.weekLabel("2026-W05") == "week 5")
        #expect(WeeklyFormat.weekLabel("2026-W53") == "week 53")
    }

    /// The window spanning the change to winter time mixes 16:00Z and 17:00Z;
    /// both still read 18:00.
    @Test func theWindowAcrossTheClockChangeStillReads1800() throws {
        let from = try #require(parseISODate("2026-10-18T16:00:00.000Z"))
        let to = try #require(parseISODate("2026-10-25T17:00:00.000Z"))
        #expect(WeeklyFormat.window(from: from, to: to) == "zo 18 okt 18:00 – zo 25 okt 18:00")
    }

    // MARK: - The screen

    @Test func countsAreTheStoredOnesWithSingularForms() throws {
        let s = WeeklyScreen(try Self.dto())
        #expect(s.counts.map(\.text) == ["3 verstuurd", "7 binnen", "5 opgeborgen", "2 taken klaar"])
        let one = WeeklyScreen(try Self.dto(sent: 1, received: 1, filedByMartin: 1, filedByVerder: 0, tasksDone: 1))
        #expect(one.counts.map(\.text) == ["1 verstuurd", "1 binnen", "1 opgeborgen", "1 taak klaar"])
        let none = WeeklyScreen(try Self.dto(sent: 0, received: 0, filedByMartin: 0, filedByVerder: 0, tasksDone: 0))
        #expect(none.counts.map(\.text) == ["0 verstuurd", "0 binnen", "0 opgeborgen", "0 taken klaar"])
    }

    /// What verder filed on its own is stated plainly, beside what Martin filed.
    @Test func whatVerderDidOnItsOwnIsStatedPlainly() throws {
        let s = WeeklyScreen(try Self.dto(filedByMartin: 3, filedByVerder: 2))
        #expect(s.counts[2].detail == "3 door jou · 2 door verder zelf")
        let verderOnly = WeeklyScreen(try Self.dto(filedByMartin: 0, filedByVerder: 1))
        #expect(verderOnly.counts[2].detail == "0 door jou · 1 door verder zelf")
        let nothing = WeeklyScreen(try Self.dto(filedByMartin: 0, filedByVerder: 0))
        #expect(nothing.counts[2].detail == nil)
    }

    /// `/weekly` holds ONE week. Any "meer dan vorige week" would be invented —
    /// on the summary AND on the next step, in every live state.
    @Test func comparedWithNothingInvented() throws {
        let s = WeeklyScreen(try Self.dto())
        let steps = [nil, 0, 1, 4].map { WeeklyScreen.nextStep(liveWaiting: $0) }
        let words = ([s.allText] + steps.flatMap { [$0.title, $0.detail] }).joined(separator: "\n").lowercased()
        for invented in ["vorige week", "meer dan", "minder dan", "gemiddeld", "dan je", "record", "%"] {
            #expect(!words.contains(invented), "\(invented)")
        }
    }

    /// Everything the stored summary says is HISTORY: the counts AND Sunday's
    /// waiting snapshot are drawn in the ink scale, never amber. The view
    /// colours by `tone`, so tinting a count `attn` means changing the model,
    /// and this test.
    @Test func theSummaryIsHistoryAndNeverAmber() throws {
        let s = WeeklyScreen(try Self.dto(waiting: 4, top: 3))
        #expect(s.counts.allSatisfy { $0.tone == .history })
        #expect(s.waiting.tone == .history, "Sunday's snapshot may have been decided long since")
    }

    /// `waiting` is Sunday's snapshot, and the screen says so.
    @Test func waitingIsSundaysSnapshot() throws {
        let s = WeeklyScreen(try Self.dto(waiting: 4, top: 3))
        #expect(s.waiting.headline == "Op zondag wachtten er 4 op je")
        #expect(s.waiting.items.count == 3)
        #expect(s.waiting.items[0].kind == "suggestie")
        let one = WeeklyScreen(try Self.dto(waiting: 1, top: 1))
        #expect(one.waiting.headline == "Op zondag wachtte er 1 op je")
        let none = WeeklyScreen(try Self.dto(waiting: 0, top: 0))
        #expect(none.waiting.headline == "Op zondag wachtte er niets op je")
        #expect(none.waiting.items.isEmpty)
    }

    /// A failed read is not a dead end: it offers "Opnieuw proberen" AND the
    /// same next step as every other state, to Voor jou. Loading offers
    /// nothing yet; the other states end in the one next step.
    @Test func everyStateEndsInANextStepAFailureInTwo() throws {
        let live = WeeklyScreen.nextStep(liveWaiting: 2)
        #expect(WeeklyScreen.steps(for: .failed(.transport("x")), liveWaiting: 2) == [.retry, .voorJou(live)])
        #expect(WeeklyScreen.steps(for: .notYet, liveWaiting: 2) == [.voorJou(live)])
        #expect(WeeklyScreen.steps(for: .loaded(WeeklyScreen(try Self.dto())), liveWaiting: 2) == [.voorJou(live)])
        #expect(WeeklyScreen.steps(for: .loading, liveWaiting: 2) == [])
        #expect(WeeklyScreen.retry == "Opnieuw proberen")
    }

    /// The server sends at most three; a longer list is cut, never all shown.
    @Test func topWaitingIsAtMostThree() throws {
        #expect(WeeklyScreen(try Self.dto(waiting: 9, top: 5)).waiting.items.count == 3)
    }

    /// The screen ends with exactly one next step, to Voor jou. Its amber is
    /// the LIVE count (`loadWaiting`, the same number as the badge), never
    /// Sunday's: on Wednesday with nothing waiting it is not amber, whatever
    /// Sunday said.
    @Test func endsWithOneNextStepToVoorJouAmberOnlyOnTheLiveCount() {
        let four = WeeklyScreen.nextStep(liveWaiting: 4)
        #expect(four.title == "Naar Voor jou")
        #expect(four.detail == "4 wachten nog op je")
        #expect(four.tone == .waitsOnMartin)
        let one = WeeklyScreen.nextStep(liveWaiting: 1)
        #expect(one.detail == "1 wacht nog op je")
        #expect(one.tone == .waitsOnMartin)
        let none = WeeklyScreen.nextStep(liveWaiting: 0)
        #expect(none.title == "Naar Voor jou")
        #expect(none.detail == "Niets wacht nu op je.")
        #expect(none.tone == .history)
        // Voor jou not loaded yet: no number is invented, and nothing is amber.
        let unknown = WeeklyScreen.nextStep(liveWaiting: nil)
        #expect(unknown.detail == "Kijk wat er nu op je wacht.")
        #expect(unknown.tone == .history)
    }

    @Test func theHeaderNamesTheWeekAndItsWindow() throws {
        let s = WeeklyScreen(try Self.dto())
        #expect(s.title == "Weekoverzicht")
        #expect(s.windowLine == "week 44 · zo 25 okt 18:00 – zo 1 nov 18:00")
    }

    // MARK: - The store

    @Test func theStoreReadsTheWeeklyFixture() async throws {
        let store = WeeklyStore(client: FixtureEnvironment.client(fixture: "weekly"))
        #expect(store.state == .loading)
        await store.refresh()
        guard case .loaded(let s) = store.state else { Issue.record("\(store.state)"); return }
        #expect(s.counts.map(\.text) == ["3 verstuurd", "7 binnen", "5 opgeborgen", "2 taken klaar"])
        #expect(s.waiting.items.count == 3)
    }

    /// 404 before the first Sunday is not an error: it says when the first comes.
    @Test func beforeTheFirstSundayItSaysWhenItComes() async {
        let store = WeeklyStore(client: FixtureEnvironment.client(fixture: "empty"))
        await store.refresh()
        #expect(store.state == .notYet)
        #expect(WeeklyStore.Copy.notYet == "Je eerste weekoverzicht komt zondag om 18:00")
    }

    @Test func unauthorizedEndsTheSession() async {
        var rejected = 0
        let store = WeeklyStore(client: FixtureEnvironment.client(fixture: "unauthorized"),
                                onUnauthorized: { rejected += 1 })
        await store.refresh()
        #expect(rejected == 1)
        #expect(store.state == .failed(.unauthorized))
    }

    @Test func offlineFailsWithoutAFigure() async {
        let store = WeeklyStore(client: FixtureEnvironment.client(fixture: "offline"))
        await store.refresh()
        guard case .failed(.transport) = store.state else { Issue.record("\(store.state)"); return }
    }

    /// A failed refresh keeps the summary already on screen.
    @Test func aFailedRefreshKeepsWhatIsShown() async throws {
        let server = StubServer()
        let calls = Calls()
        server.on { _ in
            calls.count() == 0 ? .status(200, body: Data(Self.json.utf8)) : .failure(.notConnectedToInternet)
        }
        let store = WeeklyStore(client: server.client())
        await store.refresh()
        await store.refresh()
        guard case .loaded = store.state else { Issue.record("\(store.state)"); return }
        #expect(server.requests.map { $0.url?.path() } == [WeeklyStore.path, WeeklyStore.path])
    }

    final class Calls: @unchecked Sendable {
        private let lock = NSLock()
        private var n = 0
        func count() -> Int { lock.lock(); defer { n += 1; lock.unlock() }; return n }
    }

    // MARK: - Getting there

    @Test func aWeeklyLinkOpensMeer() {
        #expect(DeepLink.parse("verder://weekly") == .weekly)
        #expect(DeepLink.parse("verder://weekly/2026-W44") == DeepLink.none)
        #expect(DeepLink.weekly.tab == .meer)
    }

    /// The Sunday push carries `verder://inbox` (the worker's link); its
    /// CATEGORY says it is the summary, and a tap opens the summary.
    @Test func aTapOnTheWeeklyPushOpensTheSummary() async {
        let router = NotificationRouter(links: DeepLinkInbox(), client: { nil })
        for action in [UNNotificationDefaultActionIdentifier, "OPEN"] {
            let links = DeepLinkInbox()
            let r = NotificationRouter(links: links, client: { nil })
            let outcome = await r.handle(action: action, category: "WEEKLY", userInfo: ["link": "verder://inbox"])
            #expect(outcome == .opened(.weekly))
            #expect(links.pending == .weekly)
        }
        #expect(await router.handle(action: UNNotificationDismissActionIdentifier, category: "WEEKLY",
                                    userInfo: ["link": "verder://inbox"]) == .ignored)
        // Another category with the same link still opens Voor jou. (FILING's
        // `verder://inbox` is the "Door verder gedaan" digest and opens that
        // section: `LinkDestinationTests.theDigestOpensDoorVerderGedaan`.)
        let links = DeepLinkInbox()
        _ = await NotificationRouter(links: links, client: { nil })
            .handle(action: UNNotificationDefaultActionIdentifier, category: "VERDER_MAIL", userInfo: ["link": "verder://inbox"])
        #expect(links.pending == .inbox)
    }

    @Test func theFixtureRouteTakesTheTapsPath() throws {
        #expect(try FixtureLaunch.parseRoute("weekly") == .link(.weekly))
        let d = try FixtureTests.decode(WeeklyDTO.self, "weekly", "weekly")
        #expect(d.week == "2026-W44" && d.topWaiting.count == 3)
    }
}

