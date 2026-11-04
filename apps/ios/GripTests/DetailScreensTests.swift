import Testing
import Foundation
@testable import Verder

/// The words and rules of the three detail screens (Figma "detail · final"):
/// `DetailText`, `QuestionText`, "Volgende in Voor jou", the suggestion's
/// per-field diff, and the task's segmented status.
struct DetailTextTests {
    static func date(_ s: String) -> Date { parseISODate(s)! }

    @Test func dayNameIsDutchWithNoBreakSpaces() {
        #expect(DetailText.dayName(Self.date("2026-11-01T09:50:00.000Z")) == "zo\u{00A0}1\u{00A0}nov")
        // 23:30 UTC on 2 nov is already Tuesday 3 nov in Amsterdam.
        #expect(DetailText.dayName(Self.date("2026-11-02T23:30:00.000Z")) == "di\u{00A0}3\u{00A0}nov")
    }

    @Test func longDateTimeKeepsTheDateWhole() {
        let s = DetailText.longDateTime(Self.date("2026-11-03T16:00:00.000Z"))
        #expect(s == "di\u{00A0}3\u{00A0}nov\u{00A0}2026 · 17:00")
    }

    @Test func ageCountsCalendarDays() {
        let now = Self.date("2026-11-02T13:02:00.000Z")
        #expect(DetailText.age(since: Self.date("2026-11-02T07:00:00.000Z"), now: now) == "sinds vandaag")
        #expect(DetailText.age(since: Self.date("2026-11-01T22:30:00.000Z"), now: now) == "sinds\u{00A0}1\u{00A0}dag")
        #expect(DetailText.age(since: Self.date("2026-10-30T10:00:00.000Z"), now: now) == "sinds\u{00A0}3\u{00A0}dagen")
        // A clock that runs behind never says "sinds -1".
        #expect(DetailText.age(since: Self.date("2026-11-04T10:00:00.000Z"), now: now) == "sinds vandaag")
    }

    @Test func relativeDueReadsAsTheFramesSayIt() {
        let now = Self.date("2026-11-01T13:02:00.000Z")
        #expect(DetailText.relativeDue(Self.date("2026-11-01T20:00:00.000Z"), now: now) == "vandaag")
        #expect(DetailText.relativeDue(Self.date("2026-11-02T16:00:00.000Z"), now: now) == "morgen")
        #expect(DetailText.relativeDue(Self.date("2026-11-03T16:00:00.000Z"), now: now) == "over 2 dagen")
        #expect(DetailText.relativeDue(Self.date("2026-10-31T16:00:00.000Z"), now: now) == "gisteren")
        #expect(DetailText.relativeDue(Self.date("2026-10-29T16:00:00.000Z"), now: now) == "3 dagen te laat")
    }

    @Test func offlineStampNamesWhenTheCopyWasLoaded() {
        let at = Self.date("2026-11-02T13:02:00.000Z")
        #expect(DetailText.offlineStamp(loadedAt: at, now: at) == "Offline · bijgewerkt\u{00A0}14:02")
    }

    static func item(_ kind: String, _ id: String) -> WaitingItem {
        let json = """
        {"kind":"\(kind)","id":"\(id)","title":"t","subtitle":null,"priority":3,
         "at":"2026-11-01T08:30:00Z","dueAt":null,"verder":false}
        """
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return try! d.decode(WaitingItem.self, from: Data(json.utf8))
    }

    @Test func nextSkipsTheItemOnScreenAndCountsTheRest() throws {
        let items = [Self.item("question", "Q1"), Self.item("suggestion", "s1"), Self.item("task", "t1")]
        let pick = try #require(VoorJouNextPick.pick(items: items, excluding: "q1"))
        #expect(pick.route == .suggestion("s1"))
        #expect(pick.remaining == 2)
        #expect(VoorJouNextPick.pick(items: [Self.item("task", "t1")], excluding: "t1") == nil)
    }

    @Test func aSoftHyphenIsABreakPointMeasuredWithItsHyphen() {
        #expect(WholeWords.splitAfterHyphens("Betalings\u{00AD}regeling") == ["Betalings-", "regeling"])
        #expect(WholeWords.candidates(in: HomeSummary.hyphenated("Woonstichting")).allSatisfy { $0.count < 13 })
    }

    @Test func aDecisionHandedBackHidesTheListsOwnRow() {
        let d = VoorJouTab.handBack(id: "abc", action: .answer(option: 1, revision: 2, label: "Nee"), title: "Vraag", items: [])
        #expect(d.key == "question:abc")
        #expect(d.path == "/api/mobile/v1/proposals/abc/answer")
        #expect(d.body == .answer(revision: 2, option: 1))
        #expect(d.verb == "Beantwoord: Nee")
        #expect(VoorJouTab.handBack(id: "s1", action: .reject, title: "S", items: []).key == "suggestion:s1")
    }

    @Test func aWordIsRemeasuredOnceTheLineWidens() {
        #expect(WholeWords.widened(from: 120, to: 370))
        #expect(!WholeWords.widened(from: 370, to: 372))
    }
}

struct QuestionTextTests {
    static func option(_ action: String, label: String = "Ja", target: String = "Iets") -> ProposalDetail.Option {
        ProposalDetail.Option(index: 0, action: action, label: label, target: target)
    }

    @Test func onlyAnOptionWithConsequencesAsksFirst() {
        #expect(QuestionText.needsConfirmation(Self.option("link-document-to-debt")))
        #expect(QuestionText.needsConfirmation(Self.option("set-task-status")))
        #expect(QuestionText.needsConfirmation(Self.option("create-task")))
        #expect(!QuestionText.needsConfirmation(Self.option("none")))
    }

    @Test func theLineUnderAnOptionIsNeverOnlyTheModelsWords() {
        #expect(QuestionText.consequence(Self.option("none", target: "Geen actie")) == "Geen actie")
        #expect(QuestionText.consequence(Self.option("link-document-to-debt")) == "Vraagt eerst bevestiging")
        // ...and that option's sheet carries the server's description.
        let o = Self.option("link-document-to-debt", target: "Document 'Brief' koppelen aan vordering Stroomnet")
        #expect(QuestionText.confirmText(o).hasPrefix("Document 'Brief' koppelen aan vordering Stroomnet."))
        #expect(QuestionText.confirmTitle(o, triggerType: "document") == "Brief koppelen aan de vordering?")
    }

    @Test func onlyAnOptionThatChangesNothingGoesBackToTheList() {
        let nee = ProposalDetail.Option(index: 1, action: "none", label: "Nee", target: "Brief blijft los")
        #expect(QuestionText.handBack(nee, revision: 3) == .answer(option: 1, revision: 3, label: "Nee"))
        #expect(QuestionText.handBack(nee, revision: nil) == nil, "an answer must name its revision")
        #expect(QuestionText.handBack(Self.option("link-document-to-debt"), revision: 3) == nil, "it asks first")
    }

    @Test func aLinkSaysWhereItIsUndoneAndNothingElseDoes() {
        #expect(QuestionText.undoNote(Self.option("link-document-to-debt")) == "Verkeerd gekozen? Maak de brief weer los op de website.")
        #expect(QuestionText.undoNote(Self.option("none")) == nil)
        // "Brief losmaken" opens the vordering itself where the server names it.
        var linked = Self.option("link-document-to-debt")
        #expect(QuestionText.unlinkPath(linked) == "registry")
        linked.debtId = "d-1"
        #expect(QuestionText.unlinkPath(linked) == "registry/debts/d-1")
        #expect(QuestionText.unlinkPath(Self.option("none")) == nil)
    }

    @Test func aLinkAnswerSaysWhatHappened() throws {
        let o = try #require(QuestionText.outcome(Self.option("link-document-to-debt"), partyName: "Stroomnet Energie"))
        #expect(o.title == "Brief gekoppeld aan de vordering")
        #expect(o.meta == "Vordering · Stroomnet Energie")
        #expect(QuestionText.outcome(Self.option("none"), partyName: nil) == nil)
    }
}

@MainActor
struct QuestionAnswerTests {
    func rig(answer: StubProtocol.Reply) -> ProposalModel {
        let stub = StubServer()
        stub.on { req in
            switch (req.httpMethod, req.url?.path() ?? "") {
            case ("GET", ProposalFixture.path): .status(200, body: ProposalFixture.question())
            case ("POST", ProposalFixture.path + "/answer"): answer
            default: .status(404)
            }
        }
        return ProposalModel(client: stub.client(store: InMemorySessionStore(ProposalModelTests.cookie)),
                             gate: ApprovalGate(authenticator: StubOwnerAuth(.success(()))))
    }

    @Test func anAnswerThatNeverArrivedIsOfferedAgainByName() async {
        let m = rig(answer: .status(503))
        await m.load(id: ProposalFixture.id)
        #expect(await m.answer(option: 0) == false)
        #expect(m.failedOption == 0, "the NIET AANGEKOMEN card and 'Opnieuw: Klaar'")
        #expect(m.message == nil, "the card says it, not a second line")
        #expect(m.errors == 1)
    }

    @Test func aRefusalIsNotOfferedAgain() async {
        let m = rig(answer: .status(400, body: Data(#"{"error":"x"}"#.utf8)))
        await m.load(id: ProposalFixture.id)
        #expect(await m.answer(option: 0) == false)
        #expect(m.failedOption == nil)
        #expect(m.message != nil)
    }

    @Test func theAnswerGivenHereIsShownAfterwards() async {
        let m = rig(answer: .status(200, body: Data(#"{"id":"x","status":"sent","revision":5}"#.utf8)))
        await m.load(id: ProposalFixture.id)
        #expect(await m.answer(option: 1))
        #expect(m.shownAnswer?.option == 1)
        #expect(m.shownAnsweredAt != nil)
        #expect(m.failedOption == nil)
    }
}

@MainActor
struct SuggestionDiffTests {
    func model(_ data: Data, approve: StubProtocol.Reply = .status(200, body: Data(#"{"ok":true}"#.utf8))) -> (SuggestionServer, SuggestionDetailModel) {
        let server = SuggestionServer(data, approve: approve)
        return (server, SuggestionDetailModel(client: server.stub.client(store: InMemorySessionStore(ProposalModelTests.cookie))))
    }

    static let debt = Data("""
    {"id":"\(SuggestionFixture.id)","kind":"debt","status":"pending","createdAt":"2026-10-30T09:20:01.123Z",
     "proposed":{"creditorName":"Stroomnet Energie","claimedCents":42000},
     "trigger":null,"document":null,"retrievedRefs":[]}
    """.utf8)

    static let debtUnknown = Data("""
    {"id":"\(SuggestionFixture.id)","kind":"debt","status":"pending","createdAt":"2026-10-30T09:20:01.123Z",
     "proposed":{"creditorName":"Stroomnet Energie","collectorName":"Kade & Partners","isDebtCollector":true},
     "trigger":null,"document":null,"retrievedRefs":[]}
    """.utf8)

    static let timedTask = Data("""
    {"id":"\(SuggestionFixture.id)","kind":"task","status":"pending","createdAt":"2026-10-30T09:20:01.123Z",
     "proposed":{"title":"Formulier ondertekenen","details":"","dueAt":"2026-11-03T16:00:00.000Z"},
     "trigger":null,"document":null,"retrievedRefs":[],
     "origin":{"kind":"brief","from":"Gemeente Westerlaan","at":"2026-10-30T09:00:00.000Z"}}
    """.utf8)

    func edits(_ req: URLRequest?) throws -> [String: Any] {
        let data = try #require(req?.httpBody)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try #require(body["edits"] as? [String: Any])
    }

    @Test func theConversationsWhenAndHowAreSentOnlyWhenChanged() async throws {
        let (server, m) = model(SuggestionFixture.entry)
        await m.load(id: SuggestionFixture.id)
        #expect(m.cardFields.map(\.key) == ["summary", "details", "occurredAt"], "the channel is drawn inside Gesprek")
        #expect(m.parts(of: "occurredAt").map(\.key) == ["channel"])
        #expect(m.edits.isEmpty, "an untouched instant compares equal")
        #expect(m.conversationLine == "e-mail")
        m.set("channel", "call")
        m.set("occurredAt", "2026-10-29T15:00:00.000Z")
        #expect(m.changedCount == 2)
        #expect(m.conversationLine == "telefoon")
        #expect(await m.approve())
        let e = try edits(server.requests(to: "/approve").first)
        #expect(e.keys.sorted() == ["channel", "occurredAt"])
        #expect(e["channel"] as? String == "call")
    }

    @Test func aTaskSuggestionsIntroLeavesOutTheTapHint() async {
        let (_, m) = model(Self.timedTask)
        await m.load(id: SuggestionFixture.id)
        #expect(!m.provenance().contains(SuggestionDetailModel.Copy.tapToEdit))
        let (_, e) = model(SuggestionFixture.entry)
        await e.load(id: SuggestionFixture.id)
        #expect(e.provenance().hasSuffix(SuggestionDetailModel.Copy.tapToEdit))
    }

    @Test func aMadeTaskSaysWhyTheCountStayed() {
        #expect(SuggestionDetailModel.taskMadeText(waiting: 3)
                == "De suggestie staat niet meer in Voor jou, de nieuwe taak wel: die wacht op jou. Daarom blijft Voor jou op 3.")
        #expect(SuggestionDetailModel.taskMadeText(waiting: nil).hasSuffix("die wacht op jou."))
    }

    @Test func aChangedFieldCountsAndPutsBack() async {
        let (_, m) = model(SuggestionFixture.entry)
        await m.load(id: SuggestionFixture.id)
        #expect(m.changedCount == 0)
        #expect(m.approveLabel == "Goedkeuren")
        m.set("summary", "Iets anders")
        m.set("details", "Nog iets")
        #expect(m.isChanged("summary"))
        #expect(m.changedCount == 2)
        #expect(m.approveLabel == "Goedkeuren ·\u{00A0}2 aangepast")
        #expect(m.title == "Iets anders", "the title follows the edit")
        m.revert("summary")
        #expect(!m.isChanged("summary"))
        #expect(m.value("summary") == "Verder vraagt de loonstrook")
        #expect(m.edits.keys.sorted() == ["details"])
    }

    @Test func anAmountIsSentInWholeCents() async throws {
        let (server, m) = model(Self.debt)
        await m.load(id: SuggestionFixture.id)
        #expect(m.fields.map(\.key) == ["claimedCents", "creditorName"])
        #expect(m.display(m.field("claimedCents")!) == "€ 420,00")
        m.set("claimedCents", "240,00")
        #expect(m.was(m.field("claimedCents")!) == "€ 420,00")
        #expect(await m.approve())
        let data = try #require(server.requests(to: "/approve").first?.httpBody)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let edits = try #require(body["edits"] as? [String: Any])
        #expect((edits["claimedCents"] as? NSNumber)?.intValue == 24000)
    }

    @Test func anUnknownAmountStaysUnknown() async {
        let (_, m) = model(Self.debtUnknown)
        await m.load(id: SuggestionFixture.id)
        #expect(m.display(m.field("claimedCents")!) == "onbekend — de brief noemt geen totaal")
        #expect(m.edits.isEmpty, "an untouched unknown amount is no edit, and never € 0,00")
        m.set("claimedCents", "abc")
        #expect(!m.canApprove, "an amount that is not one is never sent")
        #expect(m.readOnly.first?.label == "Namens hen")
        #expect(m.collectorNote != nil, "only where the model concluded it")
    }

    @Test func centsParseByStringsOnly() {
        #expect(SuggestionFormat.cents(from: "240") == 24000)
        #expect(SuggestionFormat.cents(from: "240,5") == 24050)
        #expect(SuggestionFormat.cents(from: "€ 1.234,56") == 123456)
        #expect(SuggestionFormat.cents(from: "") == nil)
        #expect(SuggestionFormat.cents(from: "12,345") == nil)
        #expect(SuggestionFormat.plainEuro(cents: 123456) == "1.234,56")
    }

    @Test func aDeadlineWithATimeKeepsItsTime() async throws {
        let (server, m) = model(Self.timedTask)
        await m.load(id: SuggestionFixture.id)
        let due = try #require(m.field("dueAt"))
        #expect(due.style == .dateTime)
        #expect(m.edits.isEmpty, "the server's own instant, normalised, is no edit")
        m.set("dueAt", "2026-11-04T16:00:00.000Z")
        #expect(await m.approve())
        let data = try #require(server.requests(to: "/approve").first?.httpBody)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect((body["edits"] as? [String: Any])?["dueAt"] as? String == "2026-11-04T16:00:00.000Z")
        #expect(m.provenance() == "Gevonden door verder in de brief van Gemeente Westerlaan van vr\u{00A0}30\u{00A0}okt.")
    }

    @Test func anApprovalThatNeverArrivedKeepsTheEdits() async {
        let (_, m) = model(SuggestionFixture.entry, approve: .status(503))
        await m.load(id: SuggestionFixture.id)
        m.set("summary", "Iets anders")
        #expect(await m.approve() == false)
        #expect(m.approveFailed)
        #expect(m.value("summary") == "Iets anders")
        #expect(m.approveLabel == "Opnieuw goedkeuren ·\u{00A0}1 aangepast")
        #expect(m.failureText?.contains("je aanpassing staat hier nog") == true)
        #expect(!m.decided)
    }

    @Test func anApprovalNamesWhatItMade() async {
        let (_, m) = model(SuggestionFixture.task, approve: .status(200, body: Data(#"{"taskId":"t9"}"#.utf8)))
        await m.load(id: SuggestionFixture.id)
        #expect(await m.approve())
        #expect(m.outcome?.taskId == "t9")
        #expect(m.successes == 1)
    }
}

@MainActor
struct TaskStatusControlTests {
    func rig(status: StubProtocol.Reply) -> TaskModel {
        let server = StubServer()
        server.on { req in
            switch (req.httpMethod, req.url?.path() ?? "") {
            case ("GET", "/api/mobile/v1/tasks"): .status(200, body: TaskScreenTests.list)
            case ("POST", "/api/mobile/v1/tasks/\(TaskScreenTests.id)/status"): status
            default: .status(404)
            }
        }
        return TaskModel(client: server.client(store: InMemorySessionStore(ProposalModelTests.cookie)))
    }

    @Test func onlyTheServersStepsCanBeChosen() async {
        let m = rig(status: .status(200))
        await m.load(id: TaskScreenTests.id)
        // in-progress: "open" never comes back once left.
        #expect(!m.segmentEnabled("open"))
        #expect(m.segmentEnabled("waiting"))
        #expect(TaskModel.isFinal("done") && TaskModel.isFinal("dropped") && !TaskModel.isFinal("waiting"))
        #expect(m.badge?.tone == .waiting)
        #expect(m.badgeNote == "bezig")
    }

    @Test func aStepThatNeverArrivedIsOfferedAgainByName() async {
        let m = rig(status: .status(503))
        await m.load(id: TaskScreenTests.id)
        #expect(await m.setStatus("done") == false)
        #expect(m.failedStatus == "done")
        #expect(m.retryLabel == "Opnieuw: zet op gedaan")
        #expect(m.failureText == "Gedaan is niet opgeslagen: je telefoon kreeg geen antwoord van verder. De status staat nog op bezig.")
        #expect(m.task?.status == "in-progress", "nothing changed on screen")
    }

    @Test func aFinalStepIsHeldAndAnUndoPostsNothing() async {
        let server = StubServer()
        let ok = Data(#"{"taskId":"\#(TaskScreenTests.id)","status":"done","validNext":[]}"#.utf8)
        server.on { req in
            switch (req.httpMethod, req.url?.path() ?? "") {
            case ("GET", "/api/mobile/v1/tasks"): .status(200, body: TaskScreenTests.list)
            case ("POST", "/api/mobile/v1/tasks/\(TaskScreenTests.id)/status"): .status(200, body: ok)
            default: .status(404)
            }
        }
        let posts = { server.requests.filter { $0.httpMethod == "POST" }.count }
        let m = TaskModel(client: server.client(store: InMemorySessionStore(ProposalModelTests.cookie)),
                          sleep: { _ in try await Task.sleep(for: .seconds(3600)) })
        await m.load(id: TaskScreenTests.id)
        m.hold("done", window: 5)
        #expect(m.shownStatus == "done")
        #expect(m.heldText == "Taak gedaan")
        #expect(m.explanation(offline: false) == "Gedaan. Vergist? Kies een andere status.")
        #expect(m.segmentEnabled("in-progress"), "the status it left can be chosen again")
        #expect(m.badge?.tone == .okay)
        m.undoHeld()
        #expect(m.shownStatus == "in-progress")
        #expect(posts() == 0, "nothing was ever recorded")
        m.hold("waiting", window: 5)
        #expect(m.held == nil, "only a final step is held")
        m.hold("done", window: 5)
        await m.commitHeld()
        #expect(posts() == 1)
        #expect(m.task?.status == "done")
        #expect(m.held == nil)
    }

    @Test func waitingIsNotAmber() async {
        let m = rig(status: .status(200, body: Data(#"{"taskId":"\#(TaskScreenTests.id)","status":"waiting","validNext":["in-progress","done","dropped"]}"#.utf8)))
        await m.load(id: TaskScreenTests.id)
        #expect(await m.setStatus("waiting"))
        #expect(m.badge?.tone == .neutral)
        #expect(m.badge?.text == "Wacht op ander")
        #expect(m.explanation(offline: true) == TaskModel.Copy.offline)
    }
}
