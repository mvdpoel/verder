import Testing
import Foundation
@testable import Verder

/// The Voor jou list as the final frames draw it: sections that never
/// re-rank, the server's count, honest words for age, deadline and freshness.
struct VoorJouListTests {
    static let now = parseISODate("2026-11-02T13:02:00Z")!

    static func item(_ kind: WaitingKind, _ id: String, at: String = "2026-11-01T10:00:00Z", due: String? = nil,
                     subtitle: String? = nil) -> WaitingItem {
        WaitingItem(kind: kind, id: id, title: "T \(id)", subtitle: subtitle, priority: 3, at: parseISODate(at)!,
                    dueAt: due, verder: false)
    }

    static func inbox(_ items: [WaitingItem], count: Int? = nil) -> InboxDTO {
        InboxDTO(count: count ?? items.count, items: items, doneByVerder: [])
    }

    @Test func sectionsSplitWithoutReranking() {
        let items = [Self.item(.proposal, "p"), Self.item(.question, "q"), Self.item(.suggestion, "s"),
                     Self.item(.task, "t"), Self.item(.stop, "st")]
        let sections = VoorJouList.sections(Self.inbox(items))
        #expect(sections.map(\.kind) == [.nu, .kanWachten])
        #expect(sections[0].rows.map(\.item.id) == ["p", "q"])
        #expect(sections[1].rows.map(\.item.id) == ["s", "t", "st"])
        #expect(sections[0].rows.allSatisfy { $0.amber })
        #expect(!sections[1].rows.contains { $0.amber })
    }

    @Test func onlyKanWachtenIsCutShort() {
        let nu = (0..<25).map { Self.item(.proposal, "p\($0)") }
        let rest = (0..<30).map { Self.item(.suggestion, "s\($0)") }
        let sections = VoorJouList.sections(Self.inbox(nu + rest))
        #expect(sections[0].rows.count == 25, "a limit never hides what waits now")
        #expect(sections[1].rows.count == VoorJouList.sectionLimit)
        #expect(sections[1].total == 30)
        #expect(sections[1].truncated)
        #expect(VoorJouList.sections(Self.inbox(nu + rest), expanded: true)[1].rows.count == 30)
    }

    @Test func theHeaderCountIsTheServersLessWhatIsHeld() {
        let inbox = Self.inbox([Self.item(.suggestion, "s")], count: 498)
        #expect(VoorJouList.count(inbox, hidden: 0) == 498, "never items.count")
        #expect(VoorJouList.count(inbox, hidden: 1) == 497)
        #expect(VoorJouList.sections(inbox, hiding: ["suggestion:s"]).isEmpty)
    }

    @Test func singularAndPlural() {
        #expect(VoorJouList.countLine(1) == "1 wacht op jou")
        #expect(VoorJouList.countLine(498) == "498 wachten op jou")
        #expect(VoorJouList.countLine(0) == "0 wachten op jou")
    }

    @Test func freshnessSaysWhatTheStandIs() {
        let at = parseISODate("2026-11-02T13:02:00Z")
        #expect(VoorJouList.freshness(now: Self.now, fetchedAt: at, error: nil) == "bijgewerkt 14:02")
        #expect(VoorJouList.freshness(now: Self.now, fetchedAt: at, error: .transport("x")) == "offline · bijgewerkt 14:02")
        #expect(VoorJouList.freshness(now: Self.now, fetchedAt: at, error: .server(503)) == "laatste stand 14:02")
        #expect(VoorJouList.notice(.transport("x"), hasList: true) == .offline)
        #expect(VoorJouList.notice(.server(503), hasList: true) == .failure)
        #expect(VoorJouList.notice(.unauthorized, hasList: true) == nil)
        #expect(VoorJouList.lastAttempt(.server(502), attemptedAt: at, now: Self.now) == "laatste poging 14:02 · serverfout 502")
    }

    @Test func ageAndDeadline() {
        #expect(VoorJouList.age(parseISODate("2026-11-02T07:30:00Z")!, now: Self.now) == "vandaag")
        #expect(VoorJouList.age(parseISODate("2026-11-01T10:00:00Z")!, now: Self.now) == "gisteren")
        #expect(VoorJouList.age(parseISODate("2026-10-31T14:05:00Z")!, now: Self.now) == "31 okt")
        #expect(VoorJouList.deadline("2026-11-03T16:00:00.000Z", now: Self.now) == "uiterlijk morgen")
        #expect(VoorJouList.deadline("2026-11-02", now: Self.now) == "uiterlijk vandaag")
        #expect(VoorJouList.deadline("2026-11-07", now: Self.now) == "uiterlijk 7 nov")
    }

    @Test func metaAndTheSentenceVoiceOverReads() {
        var stop = Self.item(.stop, "st")
        stop.taskCount = 1
        #expect(VoorJouList.meta(stop, now: Self.now) == ["halte", "1 taak"])
        let task = Self.item(.task, "t", due: "2026-11-03T16:00:00Z")
        #expect(VoorJouList.meta(task, now: Self.now) == ["taak", "uiterlijk morgen"])
        let p = Self.item(.proposal, "p", at: "2026-11-02T07:30:00Z", subtitle: "Bewindkantoor Noordkust")
        #expect(VoorJouList.accessibilityLabel(p, now: Self.now)
                == "Voorstel, T p, Bewindkantoor Noordkust, wacht op jou, vandaag")
    }

    @Test func swipesAndMenusOfferOnlyWhatTheServerAllows() {
        var s = Self.item(.suggestion, "s")
        let plain = VoorJouList.rows(Self.inbox([s]))[0]
        #expect(!plain.approvable, "absent means no: never approved unseen")
        s.approvable = true
        #expect(VoorJouList.rows(Self.inbox([s]))[0].approvable)
        var t = Self.item(.task, "t")
        t.validNext = ["waiting", "dropped"]
        let row = VoorJouList.rows(Self.inbox([t]))[0]
        #expect(!row.canDone)
        #expect(VoorJouMenu.taskSteps(row.taskNext).map(\.status) == ["waiting", "dropped"])
        // Only suggestions are selected together.
        let rows = VoorJouList.rows(Self.inbox([Self.item(.proposal, "p"), Self.item(.question, "q"), t, s]))
        #expect(rows.filter(\.selectable).map(\.item.id) == ["s"])
    }

    @Test func fileNamesAreCutInTheMiddle() {
        #expect(VoorJouList.looksLikeFileName("Loonstrook.2026-10.Atelier-Sterrenwacht.definitief.Noordkust.pdf"))
        #expect(!VoorJouList.looksLikeFileName("Antwoord aan Bewindkantoor Noordkust: loonstrook oktober"))
    }

    @Test func theConfirmationNamesEveryItem() {
        let msg = VoorJouList.confirmMessage(["A", "B", "C"], window: 5)
        #expect(msg == "A, B en C. Daarna heb je 5 seconden om het ongedaan te maken.")
        #expect(VoorJouList.confirmTitle(3) == "3 suggesties goedkeuren?")
    }

    @Test func emptyListSaysWhenTheLastWasDone() {
        let body = VoorJouList.emptyBody(lastClearedAt: parseISODate("2026-10-31T15:20:00Z"), now: Self.now)
        #expect(body == "Goed bezig. Je rondde zaterdag 31 okt het laatste af. Komt er iets nieuws binnen, dan krijg je een melding.")
        #expect(VoorJouList.emptyBody(lastClearedAt: nil, now: Self.now).hasPrefix("Goed bezig. Komt"))
    }

    @Test func doneByVerderReadsAsSentences() throws {
        let inbox = try APIClient.jsonDecoder.decode(InboxDTO.self, from: InboxRankingTests.inbox)
        let file = try #require(inbox.doneByVerder.first { $0.kind == "auto-file" })
        #expect(DoneByVerderList.title(file).hasPrefix("Opgeborgen"))
        let name = try #require(inbox.doneByVerder.first { $0.kind == "auto-name" })
        #expect(DoneByVerderList.title(name).hasPrefix("Hernoemd: "))
        #expect(DoneByVerderList.meta(name).first == "hernoemd")
        #expect(DoneByVerderList.soort("bank-statement") == "bankafschrift")
        #expect(DoneByVerderList.summary(1).hasPrefix("1 ding deed"))
    }
}

/// Decisions from the list are HELD for their undo window, then posted on
/// the detail screens' own routes; nothing posts while held.
@MainActor
struct InboxDecisionsTests {
    final class Posts: @unchecked Sendable {
        var calls: [(String, DecisionBody)] = []
        var fail: APIError?
    }

    func make(_ posts: Posts) -> InboxDecisions {
        InboxDecisions(post: { path, body in
            posts.calls.append((path, body))
            if let e = posts.fail { throw e }
        }, sleep: { _ in try await Task.sleep(for: .seconds(3600)) })
    }

    func d(_ key: String, _ action: ListDecision.Action, target: String = "x") -> ListDecision {
        ListDecision(id: UUID(), key: key, title: "T", action: action, target: target)
    }

    @Test func heldDecisionsPostNothingUntilFlushed() async {
        let posts = Posts()
        let m = make(posts)
        m.decide(d("suggestion:s", .approve, target: "s"))
        #expect(posts.calls.isEmpty)
        #expect(m.hiddenKeys == ["suggestion:s"])
        await m.flush()
        #expect(posts.calls.map(\.0) == ["/api/mobile/v1/suggestions/s/approve"])
        #expect(posts.calls.first?.1 == .approve)
        #expect(m.successes == 1)
    }

    @Test func undoInsideTheWindowRecordsNothing() async {
        let posts = Posts()
        let m = make(posts)
        m.decide(d("suggestion:s", .approve))
        m.decide(d("task:t", .task("done"), target: "t"))
        m.undoLast()
        await m.flush()
        #expect(posts.calls.map(\.0) == ["/api/mobile/v1/suggestions/x/approve"])
        #expect(m.undos == 1)
    }

    @Test func aFailedPostComesBackWithItsCause() async {
        let posts = Posts()
        posts.fail = .server(503)
        let m = make(posts)
        m.decide(d("suggestion:s", .approve))
        await m.flush()
        let f = m.failures["suggestion:s"]
        #expect(f?.message.contains("de server van verder heeft een storing") == true)
        #expect(f?.decision.withdrawLabel == "Goedkeuring intrekken")
        #expect(m.hiddenKeys.isEmpty, "the row is back where it was")
        m.withdraw("suggestion:s")
        #expect(m.failures.isEmpty)
    }

    @Test func aConflictIsDecidedElsewhereNotAFailure() async {
        let posts = Posts()
        posts.fail = .rejected(409)
        let m = make(posts)
        m.decide(d("suggestion:s", .reject))
        await m.flush()
        #expect(m.failures.isEmpty)
    }

    @Test func theToastMergesDecisions() {
        let one = DecisionToast.content([d("a", .approve)])
        #expect(one?.title == "Goedgekeurd")
        #expect(one?.reviewAll == nil)
        let two = DecisionToast.content([d("a", .approve), ListDecision(id: UUID(), key: "b", title: "Formulier",
                                                                         action: .task("done"), target: "t")])
        #expect(two?.title == "2 beslissingen")
        #expect(two?.body == "Laatste: Gedaan — Formulier. Ook 1 goedgekeurd.")
        #expect(two?.reviewAll == "Bekijk beide")
    }

    @Test func bodiesMatchTheDetailScreens() throws {
        let enc = JSONEncoder()
        enc.outputFormatting = .sortedKeys
        #expect(String(decoding: try enc.encode(DecisionBody.approve), as: UTF8.self) == #"{"edits":{}}"#)
        #expect(String(decoding: try enc.encode(DecisionBody.reject), as: UTF8.self) == "{}")
        #expect(String(decoding: try enc.encode(DecisionBody.status("done")), as: UTF8.self) == #"{"status":"done"}"#)
        #expect(String(decoding: try enc.encode(DecisionBody.empty), as: UTF8.self) == "{}")
    }

    // MARK: - Fixes from the final frames (2026-11-04)

    static func verder(_ n: Int, undoable: Bool = true) -> VerderAction {
        VerderAction(changeId: "c\(n)", documentId: "d\(n)", documentTitle: "Afschrift \(n)",
                     at: parseISODate("2026-10-30T09:00:00Z")!, kind: "auto-file",
                     before: .init(status: "inbox", title: nil, docType: nil),
                     after: .init(status: "filed", title: nil, docType: "bank-statement"),
                     proposedTitle: nil, undone: false, undoable: undoable, notUndoableReason: undoable ? nil : "al aangepast")
    }

    /// The undo of "Door verder gedaan" moves its document into Kan wachten
    /// AT ONCE: the hero, Kan wachten and the section's own count all follow
    /// it, so "Terug in Kan wachten" is never contradicted by the list.
    @Test func anUndoOfVerderMovesTheDocumentBackAtOnce() {
        let items = [VoorJouListTests.item(.proposal, "p"), VoorJouListTests.item(.suggestion, "s"), VoorJouListTests.item(.task, "t")]
        let inbox = InboxDTO(count: 3, items: items, doneByVerder: [Self.verder(1), Self.verder(2), Self.verder(3, undoable: false)])
        let keys: Set<String> = [ListDecision.key(verder: "c1"), ListDecision.key(verder: "c3")]
        let restoring = VoorJouList.restoring(inbox, keys: keys)
        #expect(restoring.map(\.changeId) == ["c1"], "only what the server called undoable comes back")
        let sections = VoorJouList.sections(inbox, hiding: keys, restoring: restoring)
        let kan = sections[1]
        #expect(kan.rows.first?.item.title == "Afschrift 1", "at the top of Kan wachten")
        #expect(kan.total == 3)
        #expect(VoorJouList.count(inbox, hidden: 0, restored: restoring.count) == 4)
        #expect(VoorJouList.doneCount(inbox, restored: restoring.count) == 2)
        let back = kan.rows[0]
        #expect(back.restored && back.route == nil && !back.selectable && !back.approvable,
                "no server id yet: nothing to open, tick or approve")
        #expect(VoorJouList.restoring(inbox, keys: []).isEmpty)
    }

    /// Selecteer only on a list with several suggestions, online, and never
    /// while a decision sits in its undo window.
    @Test func selecteerNeedsSeveralSuggestionsAndNoHeldDecision() {
        #expect(!VoorJouList.canSelect(selectable: 2, readOnly: false, holding: false), "the five-item lists")
        #expect(VoorJouList.canSelect(selectable: 3, readOnly: false, holding: false))
        #expect(!VoorJouList.canSelect(selectable: 18, readOnly: true, holding: false))
        #expect(!VoorJouList.canSelect(selectable: 18, readOnly: false, holding: true))
    }

    /// The bulk confirmation and the AX5 toast name items short.
    @Test func shortTitlesDropTheirOverTail() {
        #expect(VoorJouList.shortTitle("Brief Gemeente Westerlaan over de woonkostentoeslag") == "Brief Gemeente Westerlaan")
        #expect(VoorJouList.shortTitle("Afschrift oktober Stroomnet Energie") == "Afschrift oktober Stroomnet Energie")
        #expect(VoorJouList.shortTitle("Brief over de huur") == "Brief over de huur", "never down to one word")
        let msg = VoorJouList.confirmMessage(["Telefoongesprek met Woonstichting Lindehof over de betalingsregeling",
                                              "Afschrift oktober Stroomnet Energie",
                                              "Brief Gemeente Westerlaan over de woonkostentoeslag"], window: 5)
        #expect(msg == "Telefoongesprek met Woonstichting Lindehof, Afschrift oktober Stroomnet Energie en Brief Gemeente Westerlaan. Daarna heb je 5 seconden om het ongedaan te maken.")
        let d = ListDecision(id: UUID(), key: "suggestion:s", title: "Telefoongesprek met Woonstichting Lindehof over de betalingsregeling",
                             action: .approve, target: "s")
        #expect(DecisionToast.content([d], short: true)?.body == "Telefoongesprek met Woonstichting Lindehof")
        #expect(DecisionToast.content([d])?.body == d.title)
    }

    /// Stacked, the kind keeps the age's line and the rest wraps under it:
    /// no line ever ends in a separator.
    @Test func stackedMetaNeverEndsALineInASeparator() {
        let m = VoorJouList.metaLines(["VRAAG", "INCASSOBUREAU KADE & PARTNERS"])
        #expect(m.kind == "VRAAG")
        #expect(m.rest == HomeSummary.metaLine(["INCASSOBUREAU KADE & PARTNERS"]))
        #expect(m.oneLine == HomeSummary.metaLine(["VRAAG", "INCASSOBUREAU KADE & PARTNERS"]))
        #expect(!m.kind.hasSuffix("·") && !(m.rest ?? "").hasSuffix("·"))
        #expect(VoorJouList.metaLines(["HALTE"]).rest == nil)
    }
}

/// The kept list: shown at once on the next launch, gone with the session.
struct InboxCacheTests {
    @Test func roundTripsAndWipes() throws {
        let dir = URL.temporaryDirectory.appending(path: "inbox-cache-\(UUID().uuidString)")
        let cache = InboxCache(dir: dir)
        let inbox = InboxDTO(count: 0, items: [], doneByVerder: [])
        let at = Date(timeIntervalSince1970: 1_793_600_000)
        try cache.save(.init(savedAt: at, inbox: inbox))
        #expect(cache.load() == .init(savedAt: at, inbox: inbox))
        let values = try dir.resourceValues(forKeys: [.isExcludedFromBackupKey])
        #expect(values.isExcludedFromBackup == true)
        cache.wipe()
        #expect(cache.load() == nil)
    }

    @MainActor @Test func aStoreShowsTheKeptListAndForgetsItWithTheSession() throws {
        let dir = URL.temporaryDirectory.appending(path: "inbox-cache-\(UUID().uuidString)")
        let cache = InboxCache(dir: dir)
        let at = Date(timeIntervalSince1970: 1_793_600_000)
        try cache.save(.init(savedAt: at, inbox: InboxDTO(count: 0, items: [], doneByVerder: [])))
        let epoch = SessionEpoch()
        let store = InboxStore(client: FixtureEnvironment.client(fixture: "offline"), snapshotDir: nil,
                               setBadge: { _ in }, epoch: epoch, cache: cache)
        #expect(store.inbox != nil)
        #expect(store.fetchedAt == at)
        epoch.end()
        #expect(store.inbox == nil)
        #expect(cache.load() == nil)
    }
}
