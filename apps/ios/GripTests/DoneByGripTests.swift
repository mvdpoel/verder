import Testing
import Foundation
import Synchronization
@testable import Grip

/// "Door verder gedaan" rows as `verderActions.list` serves them
/// (packages/api/src/routers/verder-actions.ts).
enum DoneByGripFixture {
    static let fileId = "5d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6"
    static let nameId = "6e2f3a4b-5c6d-4e7f-8a81-92a3b4c5d6e7"

    static let autoFile = """
    {"changeId":"\(fileId)","documentId":"d1","documentTitle":"Loonstrook.MP.2026-10.pdf",
     "at":"2026-10-31T17:00:00.123Z","kind":"auto-file",
     "before":{"status":"inbox","title":"Loonstrook.MP.2026-10.pdf","docType":null},
     "after":{"status":"filed","title":"Loonstrook.MP.2026-10.pdf","docType":"Loonstrook"},
     "proposedTitle":"Loonstrook oktober","undone":false,"undoable":true,"notUndoableReason":null}
    """

    static let autoName = """
    {"changeId":"\(nameId)","documentId":"d2","documentTitle":"Beschikking.UWV.2026.pdf",
     "at":"2026-10-31T16:00:00Z","kind":"auto-name",
     "before":{"status":"inbox","title":"scan0004.pdf","docType":null},
     "after":{"status":"inbox","title":"Beschikking.UWV.2026.pdf","docType":null},
     "proposedTitle":null,"undone":false,"undoable":false,"notUndoableReason":"naam staat ook op de NAS"}
    """

    static func action(_ json: String) throws -> GripAction {
        try APIClient.jsonDecoder.decode(GripAction.self, from: Data(json.utf8))
    }
}

@MainActor
struct DoneByGripTests {
    final class Calls: Sendable {
        let m = Mutex(0)
        var count: Int { m.withLock { $0 } }
        func bump() { m.withLock { $0 += 1 } }
    }

    func model(_ stub: StubServer, refreshes: Calls) -> DoneByGripModel {
        DoneByGripModel(client: stub.client(store: InMemorySessionStore(ProposalModelTests.cookie)),
                          onChanged: { refreshes.bump() })
    }

    @Test func decodesTheServersRow() throws {
        let a = try DoneByGripFixture.action(DoneByGripFixture.autoFile)
        #expect(a.kind == "auto-file")
        #expect(a.before.docType == nil)
        #expect(a.after.docType == "Loonstrook")
        #expect(a.undoable)
        #expect(DoneByGripCopy.changes(a) == ["inbox → opgeborgen", "soort zonder soort → Loonstrook"])
        #expect(DoneByGripCopy.headline(a) == "Opgeborgen door verder")
    }

    @Test func undoPostsAnEmptyBodyToTheChangeRouteAndRefreshes() async throws {
        let stub = StubServer()
        stub.on { req in
            req.httpMethod == "POST" && req.url?.path() == DoneByGripModel.undoPath(DoneByGripFixture.fileId)
                ? .status(200, body: Data(#"{"ok":true,"documentId":"d1"}"#.utf8)) : .status(404)
        }
        let refreshes = Calls()
        let m = model(stub, refreshes: refreshes)
        let a = try DoneByGripFixture.action(DoneByGripFixture.autoFile)
        #expect(await m.undo(a))
        let req = try #require(stub.requests.first)
        #expect(req.url?.path() == "/api/mobile/v1/verder-actions/\(DoneByGripFixture.fileId)/undo")
        #expect(req.httpBody == Data("{}".utf8))
        #expect(m.messages[a.changeId] == DoneByGripCopy.undone)
        #expect(refreshes.count == 1)
    }

    @Test func notUndoableRowIsNeverPostedAndShowsTheReason() async throws {
        let stub = StubServer()
        stub.on { _ in .status(200, body: Data(#"{"ok":true}"#.utf8)) }
        let refreshes = Calls()
        let m = model(stub, refreshes: refreshes)
        let a = try DoneByGripFixture.action(DoneByGripFixture.autoName)
        #expect(!m.canUndo(a))
        #expect(await m.undo(a) == false)
        #expect(stub.requests.isEmpty)
        #expect(DoneByGripCopy.note(a)?.contains("NAS") == true)
    }

    @Test func aConflictSaysSoAndRefreshesTheList() async throws {
        let stub = StubServer()
        stub.on { _ in .status(409, body: Data(#"{"error":"al aangepast"}"#.utf8)) }
        let refreshes = Calls()
        let m = model(stub, refreshes: refreshes)
        let a = try DoneByGripFixture.action(DoneByGripFixture.autoFile)
        #expect(await m.undo(a) == false)
        #expect(m.messages[a.changeId] == DoneByGripCopy.changedSince)
        #expect(refreshes.count == 1)
    }

    @Test func anUndoneRowOffersNoButton() throws {
        let json = DoneByGripFixture.autoFile
            .replacingOccurrences(of: #""undone":false,"undoable":true,"notUndoableReason":null"#,
                                  with: #""undone":true,"undoable":false,"notUndoableReason":"al aangepast""#)
        let a = try DoneByGripFixture.action(json)
        let m = DoneByGripModel(client: StubServer().client())
        #expect(!m.canUndo(a))
        #expect(DoneByGripCopy.note(a) == "Ongedaan gemaakt")
    }
}
