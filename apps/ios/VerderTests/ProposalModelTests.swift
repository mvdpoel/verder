import Testing
import Foundation
import Synchronization
@testable import Verder

/// A proposal as `GET /api/mobile/v1/proposals/<id>` serves it
/// (packages/api/src/routers/proposals.ts `get`).
enum ProposalFixture {
    static let id = "6f9619ff-8b86-d011-b42d-00c04fc964ff"
    static let path = "/api/mobile/v1/proposals/\(id)"

    static func reply(revision: Int = 1, status: String = "pending", body: String = "Beste Demi,\\n\\nIn de bijlage de loonstrook.\\n\\nMet vriendelijke groet,\\nMartin",
                      attachments: String = #"[{"id":"a1","title":"Loonstrook september","sizeBytes":81234,"unavailable":false}]"#,
                      attachmentIds: String = #"["a1"]"#,
                      dueAt: String = #""2026-11-07""#,
                      missing: String = #"["Loonstrook oktober"]"#,
                      proposedTask: String = #"{"title":"Loonstrook oktober opvragen","dueAt":null}"#,
                      createdTaskId: String = "null",
                      senderUnconfirmed: Bool = false,
                      error: String = "null") -> Data {
        Data("""
        {"id":"\(id)","kind":"reply","status":"\(status)","priority":"verder",
         "ask":"Loonstrook oktober aanleveren","partyName":"Verder Bewind",
         "triggerAt":"2026-10-30T09:12:00.000Z","createdAt":"2026-10-30T09:20:01.123Z",
         "trigger":{"type":"email","id":"e1","from":"Demi <demi@verdergroep.nl>","subject":"Loonstrook","date":"2026-10-30T09:12:00.000Z","excerpt":"Wil je de loonstrook van oktober sturen?"},
         "dueAt":\(dueAt),"missing":\(missing),"entrySummary":"Loonstrook gestuurd aan Verder",
         "proposedTask":\(proposedTask),"createdTaskId":\(createdTaskId),"senderUnconfirmed":\(senderUnconfirmed),
         "reliedOn":[{"type":"document","id":"a1","label":"Loonstrook september","why":"de vorige maand"}],
         "payload":{"ask":"Loonstrook oktober aanleveren","dueAt":\(dueAt),"missing":\(missing),"entrySummary":"Loonstrook gestuurd aan Verder",
           "reply":{"to":["demi@verdergroep.nl"],"cc":[],"subject":"Re: Loonstrook","body":"\(body)","attachmentDocumentIds":\(attachmentIds)},
           "task":\(proposedTask),"question":null,"reliedOn":[{"type":"document","id":"a1","why":"de vorige maand"}]},
         "revision":\(revision),
         "attachments":\(attachments),
         "attachable":[{"id":"a1","title":"Loonstrook september"},{"id":"a3","title":"Paspoort"}],
         "options":[],"error":\(error)}
        """.utf8)
    }

    static func question() -> Data {
        Data("""
        {"id":"\(id)","kind":"question","status":"pending","priority":"verder",
         "ask":"Is de stukkenlijst al compleet?","partyName":"Verder Bewind",
         "triggerAt":null,"createdAt":"2026-10-30T09:20:01.123Z",
         "trigger":{"type":"document","id":"d9","from":"Verder","subject":"Brief","date":null,"excerpt":null},
         "dueAt":null,"missing":[],"entrySummary":null,"proposedTask":null,"createdTaskId":null,"senderUnconfirmed":true,
         "reliedOn":[],"payload":{"ask":"x","dueAt":null,"missing":[],"entrySummary":"","reply":null,"task":null,
           "question":{"prompt":"Wat moet er met de taak gebeuren?","options":[]},"reliedOn":[]},
         "revision":4,"attachments":[],"attachable":[],
         "options":[{"index":0,"action":"set-task-status","label":"Klaar","target":"Taak 'Loonstroken aanleveren' → klaar"},
                    {"index":1,"action":"none","label":"Niets doen","target":"Geen actie"}],
         "error":null}
        """.utf8)
    }
}

/// A fake verder that answers the proposal routes and remembers what it was asked.
final class ProposalServer: Sendable {
    let stub = StubServer()
    final class State: Sendable {
        let m: Mutex<(detail: Data, approve: StubProtocol.Reply)>
        init(_ detail: Data, _ approve: StubProtocol.Reply) { m = Mutex((detail, approve)) }
    }
    private let state: State

    init(detail: Data, approve: StubProtocol.Reply = .status(200, body: Data(#"{"id":"x","status":"approved","verdict":"edited","revision":2}"#.utf8))) {
        state = State(detail, approve)
        stub.on { [state] req in
            let path = req.url?.path() ?? ""
            let s = state.m.withLock { $0 }
            switch (req.httpMethod, path) {
            case ("GET", ProposalFixture.path): return .status(200, body: s.detail)
            case ("POST", ProposalFixture.path + "/approve"): return s.approve
            case ("POST", ProposalFixture.path + "/task"): return .status(200, body: Data(#"{"taskId":"t1","created":true}"#.utf8))
            case ("POST", ProposalFixture.path + "/reject"): return .status(200, body: Data(#"{"id":"x","status":"rejected","revision":2}"#.utf8))
            case ("POST", ProposalFixture.path + "/answer"): return .status(200, body: Data(#"{"id":"x","status":"sent","revision":5,"taskId":null}"#.utf8))
            default: return .status(404)
            }
        }
    }

    func serve(detail: Data) { state.m.withLock { $0.detail = detail } }
    func onApprove(_ reply: StubProtocol.Reply) { state.m.withLock { $0.approve = reply } }

    var requests: [URLRequest] { stub.requests }
    func requests(to suffix: String) -> [URLRequest] {
        requests.filter { $0.url?.path() == ProposalFixture.path + suffix }
    }
}

@MainActor
struct ProposalModelTests {
    static let cookie = SessionCookie(name: "__Secure-better-auth.session_token", value: "tok.sig", expires: nil)

    func model(_ server: ProposalServer, auth: any DeviceOwnerAuthenticator = StubOwnerAuth(.success(()))) -> ProposalModel {
        let client = server.stub.client(store: InMemorySessionStore(Self.cookie))
        return ProposalModel(client: client, gate: ApprovalGate(authenticator: auth))
    }

    func json(_ req: URLRequest?) throws -> [String: Any] {
        let body = try #require(req?.httpBody)
        let object = try JSONSerialization.jsonObject(with: body)
        return try #require(object as? [String: Any])
    }

    func payload(_ req: URLRequest?) throws -> [String: Any] {
        let sent = try json(req)
        return try #require(sent["payload"] as? [String: Any])
    }

    @Test func approveSendsTheExactEditedPayloadAndRevision() async throws {
        let server = ProposalServer(detail: ProposalFixture.reply(revision: 3,
            attachments: #"[{"id":"a1","title":"Loonstrook september","sizeBytes":81234,"unavailable":false}]"#))
        let m = model(server)
        await m.load(id: ProposalFixture.id)
        m.edit(body: "Beste Demi,\n\nHierbij.\n\nMartin", subject: "Re: Loonstrook oktober", removing: "a1")
        m.attach("a3")
        m.setRecipients(to: ["demi@verdergroep.nl"], cc: ["opstart@verdergroep.nl"])
        m.setEntrySummary("Loonstrook en paspoort gestuurd")

        let outcome = await m.approve()
        #expect(outcome == .approved)
        let posts = server.requests(to: "/approve")
        #expect(posts.count == 1)
        let sent = try json(posts.first)
        #expect(sent["revision"] as? Int == 3)
        let payload = try payload(posts.first)
        #expect(payload["to"] as? [String] == ["demi@verdergroep.nl"])
        #expect(payload["cc"] as? [String] == ["opstart@verdergroep.nl"])
        #expect(payload["subject"] as? String == "Re: Loonstrook oktober")
        #expect(payload["body"] as? String == "Beste Demi,\n\nHierbij.\n\nMartin")
        #expect(payload["attachmentDocumentIds"] as? [String] == ["a3"])
        #expect(payload["entrySummary"] as? String == "Loonstrook en paspoort gestuurd")
        #expect(Set(payload.keys) == ["to", "cc", "subject", "body", "attachmentDocumentIds", "entrySummary"])
        #expect(Set(sent.keys) == ["revision", "payload"])
    }

    /// The unedited draft goes out exactly as the model wrote it.
    @Test func approveUneditedSendsTheModelsDraft() async throws {
        let server = ProposalServer(detail: ProposalFixture.reply())
        let m = model(server)
        await m.load(id: ProposalFixture.id)
        #expect(await m.approve() == .approved)
        let payload = try payload(server.requests(to: "/approve").first)
        #expect(payload["body"] as? String == "Beste Demi,\n\nIn de bijlage de loonstrook.\n\nMet vriendelijke groet,\nMartin")
        #expect(payload["attachmentDocumentIds"] as? [String] == ["a1"])
        #expect(payload["entrySummary"] as? String == "Loonstrook gestuurd aan Verder")
    }

    @Test func dueAtAndMissingAreShown() async throws {
        let server = ProposalServer(detail: ProposalFixture.reply())
        let m = model(server)
        await m.load(id: ProposalFixture.id)
        #expect(m.dueText == "Uiterlijk 7-11")
        #expect(m.missing == ["Loonstrook oktober"])
        #expect(m.showsMissing)

        server.serve(detail: ProposalFixture.reply(dueAt: "null", missing: "[]"))
        await m.load(id: ProposalFixture.id)
        #expect(m.dueText == nil)
        #expect(!m.showsMissing)
    }

    /// A timestamp is read on the Amsterdam calendar, not UTC's: 23:30 UTC on
    /// 6 November is already the 7th in Amsterdam.
    @Test func dueAtTimestampIsAnAmsterdamDay() {
        #expect(ProposalFormat.dayMonth("2026-11-06T23:30:00.000Z") == "7-11")
        #expect(ProposalFormat.dayMonth("2026-01-05") == "5-1")
        #expect(ProposalFormat.dayMonth("niet een datum") == nil)
    }

    @Test func proposedTaskIsCreatedOnlyOnTap() async throws {
        let server = ProposalServer(detail: ProposalFixture.reply())
        let m = model(server)
        await m.load(id: ProposalFixture.id)
        #expect(m.proposedTaskTitle == "Loonstrook oktober opvragen")
        #expect(server.requests(to: "/task").isEmpty, "loading creates no task")
        _ = await m.approve()
        #expect(server.requests(to: "/task").isEmpty, "approving creates no task")

        await m.createTask()
        #expect(server.requests(to: "/task").count == 1)
        #expect(m.taskCreated)
        await m.createTask()
        #expect(server.requests(to: "/task").count == 1, "a second tap sends nothing")
    }

    @Test func alreadyCreatedTaskOffersNoButton() async {
        let server = ProposalServer(detail: ProposalFixture.reply(createdTaskId: #""t1""#))
        let m = model(server)
        await m.load(id: ProposalFixture.id)
        #expect(m.taskCreated)
    }

    @Test func optionButtonShowsServerTarget() async throws {
        let server = ProposalServer(detail: ProposalFixture.question())
        let m = model(server)
        await m.load(id: ProposalFixture.id)
        let buttons = m.optionButtons
        #expect(buttons.map(\.label) == ["Klaar", "Niets doen"])
        #expect(buttons.map(\.target) == ["Taak 'Loonstroken aanleveren' → klaar", "Geen actie"])
        #expect(m.questionPrompt == "Wat moet er met de taak gebeuren?")

        #expect(await m.answer(option: 0))
        let sent = try json(server.requests(to: "/answer").first)
        #expect(sent["option"] as? Int == 0)
        #expect(sent["revision"] as? Int == 4)
        #expect(Set(sent.keys) == ["option", "revision"])
    }

    @Test func cancelledFaceIDSendsNothing() async {
        let server = ProposalServer(detail: ProposalFixture.reply())
        let auth = StubOwnerAuth(.failure(.cancelled))
        let m = model(server, auth: auth)
        await m.load(id: ProposalFixture.id)
        let before = server.requests.count
        #expect(await m.approve() == .cancelled)
        #expect(auth.calls == 1)
        #expect(server.requests.count == before, "no request of any kind after a cancelled Face ID")
        #expect(m.status == "pending")
    }

    /// Face ID was asked for the text on screen. An edit while the sheet is up
    /// must not ride along: the snapshot is taken before the gate.
    @Test func approveSendsTheSnapshotTakenBeforeFaceID() async throws {
        let server = ProposalServer(detail: ProposalFixture.reply())
        let holder = ModelHolder()
        let auth = EditingOwnerAuth { await holder.model?.edit(body: "ingevoegd tijdens Face ID") }
        let m = model(server, auth: auth)
        holder.model = m
        await m.load(id: ProposalFixture.id)
        #expect(await m.approve() == .approved)
        let payload = try payload(server.requests(to: "/approve").first)
        #expect(payload["body"] as? String != "ingevoegd tijdens Face ID")
    }

    @Test func conflictReloadsAndShowsNewerVersion() async throws {
        let server = ProposalServer(detail: ProposalFixture.reply(revision: 1))
        let m = model(server)
        await m.load(id: ProposalFixture.id)
        m.edit(body: "mijn versie")
        server.onApprove(.status(409, body: Data(#"{"error":"proposal is at revision 2, not 1"}"#.utf8)))
        server.serve(detail: ProposalFixture.reply(revision: 2, body: "nieuwere versie"))

        #expect(await m.approve() == .newerVersion)
        #expect(m.revision == 2)
        #expect(m.draft?.body == "nieuwere versie")
        #expect(m.message == ProposalModel.Copy.newerVersion)
        #expect(server.requests(to: "/approve").count == 1, "a conflict is never retried by itself")
    }

    @Test func getJSONMaps401ToUnauthorized() async {
        let server = StubServer()
        server.on { _ in .status(401) }
        let box = Flag()
        let m = ProposalModel(client: server.client(), gate: ApprovalGate(authenticator: StubOwnerAuth(.success(()))),
                              onUnauthorized: { box.set() })
        await m.load(id: ProposalFixture.id)
        #expect(box.isSet)
        #expect(m.detail == nil)
    }

    @Test func purgedAttachmentIsShownUnavailable() async throws {
        let server = ProposalServer(detail: ProposalFixture.reply(
            attachments: #"[{"id":"a1","title":"Loonstrook september","sizeBytes":81234,"unavailable":false},{"id":"a2","title":"Oude beschikking","sizeBytes":0,"unavailable":true}]"#,
            attachmentIds: #"["a1","a2"]"#))
        let m = model(server)
        await m.load(id: ProposalFixture.id)
        let rows = m.attachmentRows
        #expect(rows.map(\.id) == ["a1", "a2"])
        #expect(rows.map(\.unavailable) == [false, true])
        #expect(!m.canSend, "the server would refuse it; say so before Face ID")
        #expect(await m.approve() == .notReady)
        #expect(server.requests(to: "/approve").isEmpty)

        m.edit(removing: "a2")
        #expect(m.canSend)
    }

    /// The picker offers only what the server offered; anything else is ignored.
    @Test func attachOffersOnlyAttachable() async {
        let server = ProposalServer(detail: ProposalFixture.reply())
        let m = model(server)
        await m.load(id: ProposalFixture.id)
        #expect(m.attachableNotAttached.map(\.id) == ["a3"])
        m.attach("zz-not-offered")
        #expect(m.draft?.attachmentDocumentIds == ["a1"])
    }

    @Test func senderUnconfirmedIsShown() async {
        let server = ProposalServer(detail: ProposalFixture.question())
        let m = model(server)
        await m.load(id: ProposalFixture.id)
        #expect(m.senderNote == "lijkt van Verder — afzender niet bevestigd")
    }

    @Test func rejectSendsTheReason() async throws {
        let server = ProposalServer(detail: ProposalFixture.reply())
        let m = model(server)
        await m.load(id: ProposalFixture.id)
        #expect(await m.reject(reason: "Al gebeld"))
        let sent = try json(server.requests(to: "/reject").first)
        #expect(sent["reason"] as? String == "Al gebeld")
    }

    @Test func followSendStopsWhenSent() async {
        let server = ProposalServer(detail: ProposalFixture.reply(status: "sending"))
        let m = model(server)
        await m.load(id: ProposalFixture.id)
        #expect(m.isSending)
        #expect(m.statusLine == ProposalModel.Copy.sending)
        server.serve(detail: ProposalFixture.reply(status: "sent"))
        await m.followSend(every: .milliseconds(1), limit: 5)
        #expect(m.status == "sent")
        #expect(!m.isSending)
        #expect(m.statusLine == ProposalModel.Copy.sent)
    }
}

@MainActor final class ModelHolder { var model: ProposalModel? }

final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.withLock { value = true } }
    var isSet: Bool { lock.withLock { value } }
}

/// Succeeds, but runs `during` while "the sheet is up".
final class EditingOwnerAuth: DeviceOwnerAuthenticator, @unchecked Sendable {
    let during: @Sendable () async -> Void
    init(_ during: @escaping @Sendable () async -> Void) { self.during = during }
    func authenticate(reason: String) async throws(DeviceOwnerAuthError) { await during() }
}
