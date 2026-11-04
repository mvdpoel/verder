import Testing
import Foundation
@testable import Grip

/// Vraag Grip on the phone (frames "Vraag Grip · it6"): the fixtures decode
/// into the real DTOs, the server's folding and failed-waits rules arrive
/// intact, the three review findings hold in the copy, the links land, and a
/// question written offline is sent once — idempotently — when it can be.
@MainActor
struct VraagGripTests {
    nonisolated static let ids = (1...0x14).map { String(format: "00000000-f1c5-4000-8000-a000000000%02x", $0) }
    nonisolated static let now = parseISODate("2026-11-02T13:06:00Z")!

    static func fixtureNames() -> [String] {
        FixtureTests.expectedNames.filter { $0.hasPrefix("vraag-") }
    }

    // MARK: - Fixtures

    @Test func everyStateDecodesIntoTheRealDTOs() throws {
        for name in Self.fixtureNames() {
            let list = try FixtureTests.decode(RequestListDTO.self, name, "requests")
            _ = try FixtureTests.decode(InboxDTO.self, name, "inbox")
            for item in list.requests {
                let d = try FixtureTests.decode(RequestDetail.self, name, "requests/\(item.id)")
                #expect(d.id == item.id)
            }
        }
        let attachable = try FixtureTests.decode(AttachableDTO.self, "vraag-overzicht", "requests/attachable")
        #expect(Set(attachable.items.map(\.type)) == ["mail", "document", "party", "stop", "task"])
    }

    /// The folding rule: one row for a question and its proposal.
    @Test func aQuestionCarriesItsProposalAndLaatMaarReleasesIt() throws {
        let unread = try FixtureTests.decode(InboxDTO.self, "vraag-ongelezen", "inbox")
        #expect(unread.items.map(\.kind) == [.request, .proposal])
        #expect(!unread.items.contains { $0.id == "00000000-f1c5-4000-8000-0000000000c1" })
        #expect(unread.todoCount == 2)
        let after = try FixtureTests.decode(InboxDTO.self, "vraag-laatmaar", "inbox")
        #expect(after.items.map(\.kind) == [.proposal, .proposal])
        #expect(after.items.first?.subtitle == "Uit je vraag")
        #expect(after.todoCount == unread.todoCount, "putting a question away moves nothing out of the count")
        let rewriting = try FixtureTests.decode(InboxDTO.self, "vraag-bijgewerkt", "inbox")
        #expect(rewriting.items.map(\.kind) == [.proposal], "version 1 is not offered while version 2 is drafted")
    }

    /// A failed question waits on Martin: amber, counted, in Nu.
    @Test func aFailureIsAmberAndCounted() throws {
        let inbox = try FixtureTests.decode(InboxDTO.self, "vraag-mislukt", "inbox")
        let row = try #require(VoorJouList.rows(inbox).first)
        #expect(row.item.kind == .request && row.amber && row.section == .nu)
        #expect(VoorJouList.meta(row.item, now: Self.now) == ["Lukte niet", "Opnieuw"])
        #expect(VoorJouList.count(inbox, hidden: 0) == 2)
        #expect(row.route == .request(row.item.id))
    }

    @Test func questionsThatWaitOnGripAreNeverAmber() throws {
        let list = try FixtureTests.decode(RequestListDTO.self, "vraag-bezig", "requests")
        let store = RequestStore(client: StubServer().client(), outbox: nil, now: { Self.now })
        _ = store
        #expect(list.requests.contains { $0.phase == .working })
        #expect(!VoorJouList.amber(.suggestion) && !VoorJouList.amber(.task))
        #expect(VoorJouList.amber(.request) && VoorJouList.amber(.proposal))
    }

    // MARK: - The todo/review split

    @Test func theHeadlineIsTodoAndSuggestionsFoldAway() {
        func item(_ k: WaitingKind, _ id: String) -> WaitingItem {
            WaitingItem(kind: k, id: id, title: id, subtitle: nil, priority: 3, at: Self.now, dueAt: nil, verder: false)
        }
        let inbox = InboxDTO(count: 4, todo: 2, review: 2,
                             items: [item(.proposal, "p"), item(.task, "t"), item(.suggestion, "s1"), item(.suggestion, "s2")],
                             doneByGrip: [])
        #expect(VoorJouList.count(inbox, hidden: 0) == 2)
        #expect(VoorJouList.sections(inbox).map(\.kind) == [.nu, .review])
        #expect(VoorJouList.reviewCount(inbox, keys: ["suggestion:s1"]) == 1)
        #expect(VoorJouList.hiddenTodo(inbox, keys: ["suggestion:s1", "task:t"]) == 1)
        #expect(HomeSummary.preview(inbox, revealed: true).map(\.id) == ["p", "t"])
        // An older server without `todo`: everything counts, as before.
        #expect(InboxDTO(count: 3, items: [], doneByGrip: []).todoCount == 3)
    }

    // MARK: - The words (the three review findings)

    @Test func theFindingsHoldInTheCopy() {
        #expect(RequestText.undo == "Ongedaan maken")
        #expect(VoorJouCopy.undo == "Ongedaan maken")
        #expect(RequestText.earlierCount(3) == "3 klaar")
        #expect(!RequestText.earlierCount(3).lowercased().contains("afgerond"))
        #expect(RequestText.followUpWaiting == "Vraag door kan zodra Grip klaar is")
    }

    @Test func rowsWordWhereAQuestionStands() throws {
        let list = try FixtureTests.decode(RequestListDTO.self, "vraag-wachtrij", "requests")
        let q = try #require(list.requests.first { $0.phase == .queued })
        #expect(RequestText.openMeta(q, now: Self.now) == "Vraag Grip · in de wachtrij")
        let w = try FixtureTests.decode(RequestListDTO.self, "vraag-bezig", "requests").requests.first { $0.phase == .working }!
        #expect(RequestText.openMeta(w, now: parseISODate("2026-11-02T13:05:00Z")!) == "Grip zoekt het uit · 2 min")
        let u = try FixtureTests.decode(RequestListDTO.self, "vraag-bijgewerkt", "requests").requests.first { $0.phase == .updating }!
        #expect(RequestText.openMeta(u, now: Self.now) == "Voorstel wordt bijgewerkt")
        let done = try FixtureTests.decode(RequestListDTO.self, "vraag-eerdere", "requests").requests.filter { $0.phase == .done }
        #expect(Set(done.map(RequestText.doneMeta)) == ["Afgerond · 1 stap gedaan", "Weggelegd · voorstel in Nu",
                                                       "Beantwoord · geen stappen", "Gestopt door jou"])
        let groups = RequestText.earlierGroups(done, now: parseISODate("2026-11-02T14:45:00Z")!)
        #expect(groups.map(\.label) == ["Vandaag", "Oktober"])
    }

    @Test func theAnswerScreenWordsItsState() throws {
        let d = try FixtureTests.decode(RequestDetail.self, "vraag-ongelezen", "requests/\(Self.ids[2])")
        #expect(RequestText.headline(d) == "Er ontbreken twee dingen")
        #expect(RequestText.status(d, now: Self.now).text == "Beantwoord · 14:06 · 3 min gezocht")
        let card = try #require(RequestText.card(d))
        #expect(card.label == "Voorstel · wacht op jou" && card.amber && card.opens)
        #expect(card.meta == "Re: Boedelbeschrijving · 2 bijlagen")
        #expect(RequestText.blocks(d.answer!).filter { if case .bullet = $0 { true } else { false } }.count == 2)

        let v2 = try FixtureTests.decode(RequestDetail.self, "vraag-vervolg", "requests/\(Self.ids[10])")
        #expect(RequestText.card(v2)?.meta == "Versie 2 · 3 bijlagen")
        #expect(RequestText.questionLabel(v2) == "Vraag door · 14:12")
        let sentFirst = try FixtureTests.decode(RequestDetail.self, "vraag-verstuurd", "requests/\(Self.ids[12])")
        #expect(RequestText.card(sentFirst)?.label == "Nieuw voorstel · wacht op jou")
        let rewriting = try FixtureTests.decode(RequestDetail.self, "vraag-bijgewerkt", "requests/\(Self.ids[8])")
        #expect(RequestText.card(rewriting).map { [$0.label, $0.meta ?? ""] } == ["Voorstel · wordt bijgewerkt", "Versie 2 wordt opgesteld"])
        #expect(RequestText.card(rewriting)?.amber == false && RequestText.card(rewriting)?.opens == false)

        let failed = try FixtureTests.decode(RequestDetail.self, "vraag-mislukt", "requests/\(Self.ids[4])")
        #expect(RequestText.headline(failed) == "Dit lukte niet")
        #expect(failed.failureDetail?.contains("langer dan 10 minuten") == true)
        #expect(failed.progress?.steps.last?.state == "failed")
        let gift = try FixtureTests.decode(RequestDetail.self, "vraag-gift-klaar", "requests/\(Self.ids[16])")
        #expect(RequestText.status(gift, now: Self.now).text == "Afgerond · 15:42")
    }

    @Test func sourcesReadInTheAppsDutch() throws {
        let d = try FixtureTests.decode(RequestDetail.self, "vraag-ongelezen", "requests/\(Self.ids[2])")
        let none: (String) -> String? = { _ in nil }
        #expect(RequestText.sourceMeta(d.sources[1], accountName: none) == ["Dossier", "contract"])
        #expect(RequestText.sourceMeta(d.sources[2], accountName: none) == ["Dossier", "brief"])
        #expect(d.sources[3].type == "gmail" && !d.sources[3].inDossier && d.sources[3].gmail != nil)
        #expect(RequestText.sourceWhen(d.sources[1].at, now: Self.now) == "2025")
        let gift = try FixtureTests.decode(RequestDetail.self, "vraag-gift", "requests/\(Self.ids[15])")
        #expect(RequestText.sourceMeta(gift.sources[0], accountName: { _ in "Leefgeldrekening" }) == ["Leefgeld · ··3210"])
    }

    // MARK: - Links

    @Test func aRequestLinkOpensItsAnswerAndTheOldSchemeStillWorks() {
        let id = UUID(uuidString: Self.ids[2])!
        #expect(DeepLink.parse("grip://request/\(Self.ids[2])") == .request(id))
        #expect(DeepLink.parse("verder://request/\(Self.ids[2])") == .request(id))
        #expect(DeepLink.request(id).destination == .init(tab: .voorJou, stack: .inbox([.request(Self.ids[2])])))
        for junk in ["grip://request/", "grip://request/x", "grip://request/\(Self.ids[2])?a=1"] {
            #expect(DeepLink.parse(junk) == DeepLink.none, "\(junk)")
        }
        #expect(LockedTarget(.request(id))?.tab == .voorJou)
        #expect(WidgetContent.url(for: .init(kind: "request", id: Self.ids[2], title: "x", at: nil, dueAt: nil)).absoluteString
                == "grip://request/\(Self.ids[2])")
    }

    @Test func aFixtureRouteReachesTheAnswerAndEerdereVragen() throws {
        #expect(try FixtureLaunch.parseRoute("request:\(Self.ids[0])") == .link(.request(UUID(uuidString: Self.ids[0])!)))
        #expect(try FixtureLaunch.parseRoute("vraag-eerder") == .voorJou([.earlierRequests]))
        let launch = try #require(try FixtureLaunch.parse(["-fixtures", "vraag-overzicht", "-fixtures-vraag", "opstellen-leeg,netwerk"]))
        #expect(launch.vraag == [.opstellenLeeg, .netwerk])
    }

    // MARK: - The outbox: idempotent resend

    @Test func anOfflineQuestionWaitsAndIsSentOnceWithItsOwnClientId() async throws {
        let server = StubServer()
        nonisolated(unsafe) var offline = true
        server.on { req in
            switch req.url?.path() {
            case "/api/mobile/v1/requests":
                req.httpMethod == "POST"
                    ? .status(200, body: Data(#"{"id":"00000000-f1c5-4000-8000-a00000000001","status":"queued","duplicate":false}"#.utf8))
                    : .status(200, body: Data(#"{"requests":[]}"#.utf8))
            default: .status(200, body: Data("{}".utf8))
            }
        }
        let dir = URL.temporaryDirectory.appending(path: "vraag-outbox-\(UUID().uuidString)")
        let outbox = RequestOutbox(dir: dir)
        let store = RequestStore(client: server.client(), outbox: outbox, now: { Self.now })
        store.isOffline = { offline }
        let outcome = await store.send(RequestDraft(text: "  Zoek de polis  "))
        #expect(outcome == .queued)
        #expect(store.pending.count == 1 && outbox.load().count == 1, "written to disk before any network")
        #expect(server.requests.filter { $0.httpMethod == "POST" }.isEmpty)
        let clientId = store.pending[0].clientId
        #expect(store.pending[0].text == "Zoek de polis")

        // A relaunch finds it; going online sends it — with the SAME clientId.
        let relaunched = RequestStore(client: server.client(), outbox: outbox, now: { Self.now })
        offline = false
        relaunched.isOffline = { offline }
        #expect(relaunched.pending.map(\.clientId) == [clientId])
        await relaunched.flush()
        await relaunched.flush()
        let posts = server.requests.filter { $0.httpMethod == "POST" }
        #expect(posts.count == 1, "sent once, then gone from the outbox")
        let body = try #require(posts.first?.httpBody)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["clientId"] as? String == clientId)
        #expect(relaunched.pending.isEmpty && outbox.load().isEmpty)
        outbox.wipe()
    }

    @Test func aPostWhoseAnswerIsLostIsRetriedWithTheSameClientId() async throws {
        let server = StubServer()
        nonisolated(unsafe) var fail = true
        server.on { req in
            if req.httpMethod == "POST" {
                if fail { return .failure(.networkConnectionLost) }
                return .status(200, body: Data(#"{"id":"x","status":"queued","duplicate":true}"#.utf8))
            }
            return .status(200, body: Data(#"{"requests":[]}"#.utf8))
        }
        let store = RequestStore(client: server.client(), outbox: nil, now: { Self.now })
        #expect(await store.send(RequestDraft(text: "Loopt er nog een incasso?")) == .queued)
        let first = try #require(store.pending.first?.clientId, "a lost answer keeps the question on the phone")
        fail = false
        await store.flush()
        let ids = try server.requests.filter { $0.httpMethod == "POST" }.compactMap { req -> String? in
            guard let body = req.httpBody else { return nil }
            return (try JSONSerialization.jsonObject(with: body) as? [String: Any])?["clientId"] as? String
        }
        #expect(!ids.isEmpty && Set(ids) == [first], "every attempt carries the first post's clientId")
        #expect(store.pending.isEmpty)
    }

    @Test func aQuestionAboutAnItemPostsExactlyOneKey() {
        let p = PendingRequest(clientId: "c", text: "t", about: RequestAbout(type: "stop", id: "s", label: "Halte"),
                               parentRequestId: nil, createdAt: Self.now)
        #expect(p.post.about == ["stopId": "s"])
        #expect(RequestAbout(type: "mail", id: "m", label: "x").postKey == "rawEmailId")
    }
}
