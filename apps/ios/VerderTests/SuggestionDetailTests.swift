import Testing
import Foundation
import Synchronization
@testable import Verder

/// Suggestions as `GET /api/mobile/v1/suggestions/:id` serves them
/// (apps/web/src/lib/mobile-dto.ts `toSuggestionDTO`).
enum SuggestionFixture {
    static let id = "0b0c4a1e-1111-4222-8333-944455556666"
    static let path = "/api/mobile/v1/suggestions/\(id)"

    static func docMeta(docType: String = #""beschikking""#) -> Data {
        Data("""
        {"id":"\(id)","kind":"document-meta","status":"pending","createdAt":"2026-10-30T09:20:01.123Z",
         "proposed":{"title":"Beschikking rechtbank","docType":\(docType)},
         "trigger":null,
         "document":{"id":"d1","title":"scan0001.pdf","docType":null,"status":"inbox"},
         "retrievedRefs":[]}
        """.utf8)
    }

    static let task = Data("""
    {"id":"\(id)","kind":"task","status":"pending","createdAt":"2026-10-30T09:20:01.123Z",
     "proposed":{"title":"Loonstrook opsturen","details":"","dueAt":"2026-11-07","assigneeHint":"martin"},
     "trigger":{"from":"Demi <demi@verdergroep.nl>","subject":"Loonstrook","sentAt":"2026-10-30T09:12:00.000Z"},
     "document":null,"retrievedRefs":[]}
    """.utf8)

    static let entry = Data("""
    {"id":"\(id)","kind":"log-entry","status":"needs-manual","createdAt":"2026-10-30T09:20:01.123Z",
     "proposed":{"occurredAt":"2026-10-30T09:12:00.000Z","channel":"email","direction":"inbound",
       "summary":"Verder vraagt de loonstrook","details":"Voor 7 november.","participantNames":[],
       "actionItems":[],"attachmentDocumentIds":[]},
     "trigger":{"from":"Demi <demi@verdergroep.nl>","subject":"Loonstrook","sentAt":null},
     "document":null,"retrievedRefs":[]}
    """.utf8)

    static let registryItem = Data("""
    {"id":"\(id)","kind":"registry-item","status":"pending","createdAt":"2026-10-30T09:20:01.123Z",
     "proposed":{"name":"Ziggo","amountCents":-4500},"trigger":null,"document":null,"retrievedRefs":[]}
    """.utf8)
}

/// A fake verder for one suggestion.
final class SuggestionServer: Sendable {
    let stub = StubServer()
    let detail: Mutex<Data>
    let approve: Mutex<StubProtocol.Reply>

    init(_ detail: Data, approve: StubProtocol.Reply = .status(200, body: Data(#"{"ok":true}"#.utf8))) {
        self.detail = Mutex(detail)
        self.approve = Mutex(approve)
        stub.on { [self] req in
            switch (req.httpMethod, req.url?.path() ?? "") {
            case ("GET", SuggestionFixture.path): .status(200, body: self.detail.withLock { $0 })
            case ("POST", SuggestionFixture.path + "/approve"): self.approve.withLock { $0 }
            case ("POST", SuggestionFixture.path + "/reject"): .status(200, body: Data(#"{"ok":true}"#.utf8))
            default: .status(404)
            }
        }
    }

    func requests(to suffix: String) -> [URLRequest] {
        stub.requests.filter { $0.url?.path() == SuggestionFixture.path + suffix }
    }
}

@MainActor
struct SuggestionDetailTests {
    func model(_ server: SuggestionServer) -> SuggestionDetailModel {
        SuggestionDetailModel(client: server.stub.client(store: InMemorySessionStore(ProposalModelTests.cookie)))
    }

    func body(_ req: URLRequest?) throws -> [String: Any] {
        let data = try #require(req?.httpBody)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func edits(_ req: URLRequest?) throws -> [String: Any] {
        try #require(try body(req)["edits"] as? [String: Any])
    }

    @Test func approveSendsOnlyChangedFields() async throws {
        let server = SuggestionServer(SuggestionFixture.docMeta())
        let m = model(server)
        await m.load(id: SuggestionFixture.id)
        #expect(m.fields.map(\.key) == ["title", "docType"])
        m.set("title", "Beschikking rechtbank Midden-Nederland")

        #expect(await m.approve())
        let sent = try body(server.requests(to: "/approve").first)
        #expect(Set(sent.keys) == ["edits"], "never a kind, never the whole proposal")
        let e = try edits(server.requests(to: "/approve").first)
        #expect(e.count == 1)
        #expect(e["title"] as? String == "Beschikking rechtbank Midden-Nederland")
        #expect(m.decided)
    }

    @Test func approveUntouchedSendsNoEdits() async throws {
        let server = SuggestionServer(SuggestionFixture.task)
        let m = model(server)
        await m.load(id: SuggestionFixture.id)
        // "" in proposed and "" on screen: untouched, even though the box is empty.
        m.set("details", "")
        #expect(await m.approve())
        #expect(try edits(server.requests(to: "/approve").first).isEmpty)
    }

    @Test func clearedSoortIsSentAsNull() async throws {
        let server = SuggestionServer(SuggestionFixture.docMeta())
        let m = model(server)
        await m.load(id: SuggestionFixture.id)
        m.set("docType", "")
        #expect(await m.approve())
        let e = try edits(server.requests(to: "/approve").first)
        #expect(e.keys.sorted() == ["docType"])
        #expect(e["docType"] is NSNull)
    }

    @Test func fieldsPerKindMirrorTheQueueCard() async {
        for (data, keys) in [(SuggestionFixture.entry, ["summary", "details"]),
                             (SuggestionFixture.task, ["title", "details", "dueAt"]),
                             (SuggestionFixture.docMeta(), ["title", "docType"])] {
            let m = model(SuggestionServer(data))
            await m.load(id: SuggestionFixture.id)
            #expect(m.fields.map(\.key) == keys)
            #expect(m.canApprove)
        }
    }

    @Test func registryItemOffersOnlyTheWebsite() async throws {
        let server = SuggestionServer(SuggestionFixture.registryItem)
        let m = model(server)
        await m.load(id: SuggestionFixture.id)
        #expect(!m.canApprove)
        #expect(m.opensOnWebsite)
        #expect(await m.approve() == false)
        #expect(server.requests(to: "/approve").isEmpty)
    }

    @Test func rejectSendsTheReason() async throws {
        let server = SuggestionServer(SuggestionFixture.docMeta())
        let m = model(server)
        await m.load(id: SuggestionFixture.id)
        #expect(await m.reject(reason: "  geen brief  "))
        let sent = try body(server.requests(to: "/reject").first)
        #expect(sent["reason"] as? String == "geen brief")
        #expect(m.decided)
    }

    @Test func conflictSaysAlreadyDecided() async throws {
        let server = SuggestionServer(SuggestionFixture.docMeta(), approve: .status(409, body: Data(#"{"error":"x"}"#.utf8)))
        let m = model(server)
        await m.load(id: SuggestionFixture.id)
        #expect(await m.approve() == false)
        #expect(m.message == SuggestionDetailModel.Copy.alreadyDecided)
    }
}

/// A task as `GET /api/mobile/v1/tasks` serves it.
@MainActor
struct TaskScreenTests {
    nonisolated static let id = "1a2b3c4d-1111-4222-8333-944455556666"
    nonisolated static let list = Data("""
    [{"id":"other","title":"Ander","details":null,"dueAt":null,"status":"open","assigneeName":null,
      "validNext":["in-progress","waiting","done","dropped"]},
     {"id":"\(id)","title":"Polis opvragen","details":"Bij Centraal Beheer","dueAt":"2026-10-31T23:00:00.000Z",
      "status":"in-progress","assigneeName":null,"validNext":["waiting","done","dropped"]}]
    """.utf8)

    func rig() -> (StubServer, TaskModel) {
        let server = StubServer()
        server.on { req in
            switch (req.httpMethod, req.url?.path() ?? "") {
            case ("GET", "/api/mobile/v1/tasks"): .status(200, body: Self.list)
            case ("POST", "/api/mobile/v1/tasks/\(Self.id)/status"):
                .status(200, body: Data(#"{"taskId":"\#(Self.id)","status":"done","validNext":[]}"#.utf8))
            default: .status(404)
            }
        }
        return (server, TaskModel(client: server.client(store: InMemorySessionStore(ProposalModelTests.cookie))))
    }

    @Test func statusPickerOffersOnlyValidNext() async {
        let (_, m) = rig()
        await m.load(id: Self.id)
        #expect(m.task?.title == "Polis opvragen")
        #expect(m.choices.map(\.status) == ["waiting", "done", "dropped"])
        #expect(m.choices.map(\.label) == ["wacht op iemand", "klaar", "laten vallen"])
    }

    @Test func setStatusPostsTheStatusOnlyAndTakesTheServersNext() async throws {
        let (server, m) = rig()
        await m.load(id: Self.id)
        #expect(await m.setStatus("done"))
        let req = try #require(server.requests.first { $0.httpMethod == "POST" })
        let data = try #require(req.httpBody)
        let sent = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(sent.keys) == ["status"])
        #expect(m.task?.status == "done")
        #expect(m.choices.isEmpty)
    }

    @Test func aStatusNotOfferedIsNeverSent() async {
        let (server, m) = rig()
        await m.load(id: Self.id)
        #expect(await m.setStatus("open") == false)
        #expect(server.requests.allSatisfy { $0.httpMethod == "GET" })
    }
}
