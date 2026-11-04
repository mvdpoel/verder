import Testing
import Foundation
import UserNotifications
@testable import Verder

/// The Sunday summary on the phone (Plan 3 Task 26, iOS half): the `/weekly`
/// contract decodes field for field, the window reads as the two Sunday 18:00
/// instants it is (never Monday–Sunday), the screen says only what the stored
/// summary counted — compared only with weeks the server counted, nothing
/// invented — and ends with the LIVE card to Voor jou. A WEEKLY push opens it.
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

    /// Martin's seven earlier weeks as the fixture holds them: 3 6 4 5 7 4 5.
    nonisolated static let history = #"""
    [{"week":"2026-W37","sent":1,"received":5,"filedByMartin":1,"filedByVerder":0,"tasksDone":1,"waiting":3},
     {"week":"2026-W38","sent":2,"received":8,"filedByMartin":2,"filedByVerder":1,"tasksDone":2,"waiting":4},
     {"week":"2026-W39","sent":1,"received":6,"filedByMartin":2,"filedByVerder":1,"tasksDone":1,"waiting":5},
     {"week":"2026-W40","sent":2,"received":7,"filedByMartin":1,"filedByVerder":2,"tasksDone":2,"waiting":5},
     {"week":"2026-W41","sent":3,"received":10,"filedByMartin":2,"filedByVerder":1,"tasksDone":2,"waiting":4},
     {"week":"2026-W42","sent":1,"received":6,"filedByMartin":1,"filedByVerder":2,"tasksDone":2,"waiting":7},
     {"week":"2026-W43","sent":1,"received":9,"filedByMartin":2,"filedByVerder":2,"tasksDone":2,"waiting":6}]
    """#

    static func withHistory(_ history: String = Self.history, renamed: Int? = 1, sent: Int = 3, received: Int = 7,
                            filedByMartin: Int = 3, filedByVerder: Int = 2, tasksDone: Int = 2,
                            waiting: Int = 4) throws -> WeeklyDTO {
        try decode("""
        {"week":"2026-W44","from":"2026-10-25T17:00:00.000Z","to":"2026-11-01T17:00:00.000Z",
         "sent":\(sent),"received":\(received),"filedByMartin":\(filedByMartin),"filedByVerder":\(filedByVerder),
         "tasksDone":\(tasksDone),"waiting":\(waiting),"topWaiting":[],
         "history":\(history)\(renamed.map { #","renamedByVerder":\#($0)"# } ?? "")}
        """)
    }

    /// Mon 2 nov 2026 09:41 Amsterdam: week 44 has been composed.
    nonisolated static let monday = parseISODate("2026-11-02T08:41:00.000Z")!

    @Test func theHeroCountsMartinsOwnSteps() throws {
        let s = WeeklyScreen(try Self.dto())
        #expect(s.hero.value == 8)
        #expect(s.hero.words == "stappen door jou")
        #expect(s.hero.parts == ["3 verstuurd", "3 door jou opgeborgen", "2 taken klaar"])
        let one = WeeklyScreen(try Self.dto(sent: 0, filedByMartin: 0, tasksDone: 1))
        #expect(one.hero.words == "stap door jou")
        #expect(one.hero.parts == ["niets verstuurd", "niets door jou opgeborgen", "1 taak klaar"])
        #expect(s.eyebrow == ["WEEK 44", "T/M ZO 1 NOV 18:00"])
    }

    /// Without `history` the server counted no earlier week: no chart, no
    /// average, no "vorige week" — nothing invented.
    @Test func withoutHistoryNothingIsCompared() throws {
        let s = WeeklyScreen(try Self.dto())
        #expect(s.chart == nil)
        #expect(s.sentence == nil)
        let words = s.allText.lowercased()
        for invented in ["vorige week", "gemiddeld", "dan je", "rustige", "%"] {
            #expect(!words.contains(invented), "\(invented)")
        }
    }

    @Test func theChartIsEightWeeksAgainstTheAverageOfTheSevenBefore() throws {
        let s = WeeklyScreen(try Self.withHistory())
        let chart = try #require(s.chart)
        #expect(chart.title == "JOUW STAPPEN · 8 WEKEN")
        #expect(chart.bars.map(\.label) == ["W37", "W38", "W39", "W40", "W41", "W42", "W43", "W44"])
        #expect(chart.bars.map(\.value) == [3, 6, 4, 5, 7, 4, 5, 8])
        #expect(chart.bars.map(\.isCurrent) == [false, false, false, false, false, false, false, true])
        #expect(chart.average == 5) // 34 / 7 = 4.86
        #expect(chart.caption == nil)
        #expect(s.sentence == .init(full: "Meer dan je gemiddelde van 5 per week. Goed bezig.",
                                    compact: "Meer dan je gemiddelde (5). Goed bezig."))
    }

    /// The frames' rule: a value keeps 8 to the dashed line — above its bar,
    /// inside a bar whose top is near the line, or above the line for a bar
    /// too short to hold it.
    @Test func noValueTouchesTheAverageLine() throws {
        let chart = try #require(WeeklyScreen(try Self.withHistory()).chart)
        #expect(chart.bars.map { chart.placement($0.value ?? 0) } ==
                [.aboveLine, .above, .inside, .inside, .above, .inside, .inside, .above])
        let calm = try #require(WeeklyScreen(try Self.withHistory(sent: 0, filedByMartin: 0, tasksDone: 1)).chart)
        #expect(calm.placement(1) == .above)
        #expect(calm.placement(3) == .aboveLine)
    }

    /// Below the average is never a deficit (brief: Gentler Streak).
    @Test func aQuietWeekIsNeverADeficit() throws {
        let s = WeeklyScreen(try Self.withHistory(sent: 0, received: 2, filedByMartin: 0, tasksDone: 1, waiting: 0))
        #expect(s.sentence?.full == "Een rustige week — en dat mag.")
        for word in ["minder", "−", "slechter", "achter"] { #expect(!s.allText.contains(word), "\(word)") }
        #expect(s.rows.map(\.title) == ["Niets verstuurd", "2 ontvangen", "2 opgeborgen", "1 taak klaar",
                                        "Niets wachtte op je"])
    }

    @Test func theSecondWeekWaitsForAnAverage() throws {
        let s = WeeklyScreen(try Self.withHistory(#"[{"week":"2026-W43","sent":1,"received":3,"filedByMartin":2,"filedByVerder":0,"tasksDone":1,"waiting":3}]"#,
                                                  renamed: 0, sent: 2, received: 5, filedByMartin: 2, filedByVerder: 1))
        let chart = try #require(s.chart)
        #expect(chart.title == "JOUW STAPPEN · 2 WEKEN")
        #expect(chart.bars.map(\.value) == [nil, nil, nil, nil, nil, nil, 4, 6])
        #expect(chart.average == nil)
        #expect(chart.caption == "geen data vóór week 43")
        #expect(s.sentence?.full == "Je tweede week met verder. Een gemiddelde volgt vanaf 3 weken.")
        #expect(s.verder.map(\.title) == ["1 stuk opgeborgen"])
        #expect(s.verder[0].lines == [["Klopt het niet? In de lijst maak je het met één tik ongedaan."]])
    }

    /// Each row compares with the week before only, from `history`; an equal
    /// week reads "ook". Only rows with a list in the app carry a way there.
    @Test func rowsCompareWithLastWeek() throws {
        let s = WeeklyScreen(try Self.withHistory())
        #expect(s.rows.map(\.title) == ["3 verstuurd", "7 ontvangen", "5 opgeborgen", "2 taken klaar", "4 wachtten op je"])
        #expect(s.rows.map(\.lines) == [
            [["vorige week: 1"]],
            [["mail en scans", "vorige week: 9"]],
            [["3 door jou", "2 door verder"], ["vorige week: 4"]],
            [["vorige week: ook 2"]],
            [["momentopname zo 18:00", "vorige week: 6"]],
        ])
        #expect(s.rows.map(\.destination) == [nil, .dossier, .dossier, nil, nil])
    }

    /// What verder did on its own is stated plainly, and the rename says why
    /// it cannot be undone here.
    @Test func whatVerderDidOnItsOwnIsStatedPlainly() throws {
        let s = WeeklyScreen(try Self.withHistory())
        #expect(s.verder.map(\.title) == ["2 stukken opgeborgen", "1 scan een naam gegeven"])
        #expect(s.verder.map(\.destination) == [.doneByVerder, nil])
        #expect(s.verder[1].lines == [["Die naam staat ook op de NAS, dus terugzetten kan niet in de app."]])
        #expect(WeeklyScreen(try Self.dto(filedByVerder: 0)).verder.isEmpty)
    }

    /// AMBER IS LIVE OR NOT AT ALL: nothing in the stored summary carries a
    /// tone, and the live card says what waits NOW, by Voor jou's count.
    @Test func theLiveCardIsTheOnlyAmberAndItIsLive() {
        let oldest = parseISODate("2026-10-31T09:00:00.000Z")
        #expect(LiveCard.make(.init(count: 4, oldestAt: oldest), .summary)
                == .waiting("4 wachten nog op je — de oudste sinds 31 okt."))
        #expect(LiveCard.make(.init(count: 4, oldestAt: oldest), .notYet)
                == .waiting("4 wachten nu op je — de oudste sinds 31 okt."))
        #expect(LiveCard.make(.init(count: 1, oldestAt: oldest), .summary) == .waiting("1 wacht nog op je — sinds 31 okt."))
        let kept = parseISODate("2026-11-01T18:02:00.000Z")
        #expect(LiveCard.make(.init(count: 4, oldestAt: oldest, keptAt: kept), .summary)
                == .waiting("4 wachten op je — stand van 19:02. Voor\u{00A0}jou laat zien wat er bewaard is."))
        #expect(LiveCard.make(.init(count: 4, oldestAt: oldest, keptAt: kept), .notFetched)
                == .waiting("4 wachten op je — stand van 19:02."))
        #expect(LiveCard.make(.init(count: 0, lastClearedAt: parseISODate("2026-10-30T15:10:00.000Z")), .summary)
                == .calm(caption: "laatst afgehandeld: vr 30 okt"))
        #expect(LiveCard.make(.init(), .summary) == .unknown)
    }

    // MARK: - The page per state

    @Test func loadingNamesTheWeekThePhoneExpects() {
        let page = WeeklyPage.make(.loading, now: Self.monday, live: .init(count: 4))
        #expect(page.eyebrow == ["WEEK 44"])
        #expect(page.body == .skeleton)
        #expect(page.live == nil)
    }

    @Test func beforeTheFirstSundayItSaysWhichSunday() throws {
        let page = WeeklyPage.make(.notYet, now: Self.monday, live: .init(count: 4))
        #expect(page.eyebrow == ["EERSTE WEEK"])
        guard case .notYet(let e, let preview) = page.body else { Issue.record("\(page.body)"); return }
        #expect(e.title == "Je eerste weekoverzicht komt zondag 8\u{00A0}november\u{00A0}om\u{00A0}18:00")
        // The only ordinary spaces are before the date: it wraps as one unit.
        #expect(!e.title.hasSuffix(" 18:00"))
        #expect(e.title.split(separator: " ").last == "8\u{00A0}november\u{00A0}om\u{00A0}18:00")
        #expect(preview.title == "ZO ZIET HET ERUIT")
        #expect(preview.bars.map(\.label) == ["W38", "W39", "W40", "W41", "W42", "W43", "W44", "W45"])
        #expect(preview.bars.allSatisfy { $0.value == nil })
        #expect(preview.caption == "eerste balk: W45 · zo 8 nov")
    }

    @Test func aKeptSummaryShowsItsStand() throws {
        let kept = WeeklyStore.Kept(screen: WeeklyScreen(try Self.withHistory()),
                                    savedAt: try #require(parseISODate("2026-11-01T18:02:00.000Z")))
        let page = WeeklyPage.make(.kept(kept, cause: .transport("x")), now: Self.monday, live: .init(count: 4))
        #expect(page.status == .init(badge: "GEEN VERBINDING", stand: "stand van zo 1 nov 19:02", retry: true))
        #expect(page.eyebrow == ["WEEK 44", "T/M ZO 1 NOV 18:00"])
    }

    @Test func offlineWithAnOlderWeekOffersIt() throws {
        let older = try Self.decode(Self.json.replacingOccurrences(of: "2026-W44", with: "2026-W43"))
        let kept = WeeklyStore.Kept(screen: WeeklyScreen(older),
                                    savedAt: try #require(parseISODate("2026-11-01T16:40:00.000Z")))
        let page = WeeklyPage.make(.missing(cause: .transport("x"), older: kept), now: Self.monday, live: .init(count: 4))
        #expect(page.status == .init(badge: "GEEN VERBINDING", stand: "stand van zo 1 nov 17:40", retry: false))
        guard case .empty(let e) = page.body else { Issue.record("\(page.body)"); return }
        #expect(e.title == "Je weekoverzicht van week 44 staat klaar zodra je weer online bent")
        #expect(e.retry && e.older == "Bekijk week 43 (bewaard)")
    }

    @Test func aServerFailureSaysNothingIsLost() {
        let page = WeeklyPage.make(.missing(cause: .server(503), older: nil), now: Self.monday, live: .init())
        #expect(page.eyebrow == ["WEEK 44"])
        guard case .empty(let e) = page.body else { Issue.record("\(page.body)"); return }
        #expect(e.title == "Je weekoverzicht kon niet worden opgehaald")
        #expect(e.body == "Er is niets verloren. De server is even niet bereikbaar (fout 503); probeer het zo opnieuw.")
        #expect(e.retry && e.older == nil)
        #expect(page.live == .unknown)
    }

    /// Sunday 18:00 Amsterdam, across the change to winter time too.
    @Test func theSundayCloseIsAmsterdams() throws {
        #expect(WeeklyFormat.lastClose(atOrBefore: Self.monday) == parseISODate("2026-11-01T17:00:00.000Z"))
        #expect(WeeklyFormat.nextClose(after: Self.monday) == parseISODate("2026-11-08T17:00:00.000Z"))
        let sundayMorning = try #require(parseISODate("2026-11-01T08:41:00.000Z"))
        #expect(WeeklyFormat.lastClose(atOrBefore: sundayMorning) == parseISODate("2026-10-25T17:00:00.000Z"))
        #expect(WeeklyFormat.weekKey(Self.monday) == "2026-W45")
        #expect(WeeklyFormat.weekKey(try #require(parseISODate("2026-11-01T17:00:00.000Z"))) == "2026-W44")
        #expect(WeeklyFormat.weekKey(try #require(parseISODate("2026-01-01T12:00:00.000Z"))) == "2026-W01")
    }

    // MARK: - The store

    @Test func theStoreReadsTheWeeklyFixture() async throws {
        let store = WeeklyStore(client: FixtureEnvironment.client(fixture: "weekly"))
        #expect(store.state == .loading)
        await store.refresh()
        guard case .loaded(let s) = store.state else { Issue.record("\(store.state)"); return }
        #expect(s.hero.value == 8)
        #expect(s.chart?.average == 5)
        #expect(s.verder.count == 2)
    }

    /// 404 before the first Sunday is not an error.
    @Test func beforeTheFirstSundayTheStoreSaysNotYet() async {
        let store = WeeklyStore(client: FixtureEnvironment.client(fixture: "empty"))
        await store.refresh()
        #expect(store.state == .notYet)
    }

    @Test func unauthorizedEndsTheSessionAndKeepsNothing() async {
        var rejected = 0
        let store = WeeklyStore(client: FixtureEnvironment.client(fixture: "unauthorized"),
                                onUnauthorized: { rejected += 1 })
        await store.refresh()
        #expect(rejected == 1)
        #expect(store.state == .missing(cause: .unauthorized, older: nil))
    }

    @Test func offlineWithNothingKeptIsMissing() async {
        let store = WeeklyStore(client: FixtureEnvironment.client(fixture: "offline"))
        await store.refresh()
        guard case .missing(.transport, nil) = store.state else { Issue.record("\(store.state)"); return }
    }

    static func flaky() -> StubServer {
        let server = StubServer()
        let calls = Calls()
        server.on { _ in
            calls.count() == 0 ? .status(200, body: Data(Self.json.utf8)) : .failure(.notConnectedToInternet)
        }
        return server
    }

    /// A failed refresh keeps the expected week, with when it was read.
    @Test func aFailedRefreshKeepsTheExpectedWeek() async throws {
        let server = Self.flaky()
        let store = WeeklyStore(client: server.client(), now: { Self.monday })
        await store.refresh()
        await store.refresh()
        guard case .kept(let k, .transport) = store.state else { Issue.record("\(store.state)"); return }
        #expect(k.screen.week == "2026-W44" && k.savedAt == Self.monday)
        #expect(server.requests.map { $0.url?.path() } == [WeeklyStore.path, WeeklyStore.path])
    }

    /// A week later the same copy is OLDER than the expected week: the screen
    /// says the new one is missing and offers the old one as "bewaard".
    @Test func anOlderKeptWeekIsOfferedNotShownAsCurrent() async throws {
        let later = Self.monday.addingTimeInterval(7 * 86_400)
        let clock = Clock(Self.monday)
        let store = WeeklyStore(client: Self.flaky().client(), now: { clock.now })
        await store.refresh()
        clock.now = later
        await store.retry()
        guard case .missing(.transport, let older?) = store.state else { Issue.record("\(store.state)"); return }
        #expect(older.screen.week == "2026-W44")
        #expect(store.failedRetries == 1)
        store.showOlder()
        guard case .kept(let k, _) = store.state else { Issue.record("\(store.state)"); return }
        #expect(k.screen.week == "2026-W44")
    }

    /// The copy on disk outlives the store: a relaunch offline shows it with its stand.
    @Test func theKeptCopySurvivesARelaunch() async throws {
        let dir = URL.temporaryDirectory.appending(path: "weekly-cache-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: dir) }
        let server = StubServer()
        server.on { _ in .status(200, body: Data(Self.json.utf8)) }
        let first = WeeklyStore(client: server.client(), cache: WeeklyCache(dir: dir), now: { Self.monday })
        await first.refresh()
        let offline = WeeklyStore(client: FixtureEnvironment.client(fixture: "offline"), cache: WeeklyCache(dir: dir),
                                  now: { Self.monday.addingTimeInterval(3600) })
        await offline.refresh()
        guard case .kept(let k, _) = offline.state else { Issue.record("\(offline.state)"); return }
        #expect(k.savedAt == Self.monday)
    }

    /// Meer and the screen both refresh when a link opens it: one request.
    @Test func concurrentRefreshesShareOneRead() async {
        let server = StubServer()
        server.on { _ in .status(200, body: Data(Self.json.utf8)) }
        let store = WeeklyStore(client: server.client())
        async let a: Void = store.refresh()
        async let b: Void = store.refresh()
        _ = await (a, b)
        #expect(server.requests.count == 1)
    }

    final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var value: Date
        init(_ now: Date) { value = now }
        var now: Date {
            get { lock.lock(); defer { lock.unlock() }; return value }
            set { lock.lock(); value = newValue; lock.unlock() }
        }
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

