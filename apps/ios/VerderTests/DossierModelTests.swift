import Testing
import Foundation
import Synchronization
@testable import Verder

/// The Dossier tab's state (Plan 3 Task 21 review fixes): an interrupted sync
/// is not "offline", and a server answer never lands under a query it was not
/// asked for.
@MainActor
struct DossierModelTests {
    nonisolated static let a = DossierStoreTests.a

    /// A gate the stub's handler waits on, so a reply can be held back while
    /// the test changes the model.
    final class Gate: Sendable {
        let opened = DispatchSemaphore(value: 0)
        let arrived = Mutex(false)
        func wait() { arrived.withLock { $0 = true }; opened.wait() }
        func open() { opened.signal() }
    }

    static func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<500 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    nonisolated static func syncRoutes(file: StubProtocol.Reply) -> StubProtocol.Handler {
        { req in
            let path = req.url?.path() ?? ""
            if path == DossierStore.syncPath {
                return .status(200, headers: ["Content-Type": "application/json"],
                               body: DossierStoreTests.delta(cursor: 3, upserts: [
                                   DossierStoreTests.doc(a, bytes: DossierStoreTests.bytesA)]))
            }
            if path.hasSuffix("/file") { return file }
            return .status(404)
        }
    }

    // MARK: - An interrupted sync is not offline

    @Test func aCancelledDownloadIsNotOffline() async throws {
        // What URLSession throws when SwiftUI cancels the tab's `.task`.
        let server = StubServer()
        server.on(Self.syncRoutes(file: .failure(.cancelled)))
        let model = DossierModel(store: DossierStore(dir: DossierStoreTests.tempDir()), client: server.client())
        await model.refresh(isLocked: false, isActive: true)
        #expect(model.offline == false)
        #expect(model.message == nil)
    }

    @Test func aCancelledTaskIsNotOffline() async throws {
        let gate = Gate()
        let server = StubServer()
        server.on { req in
            if req.url?.path() == DossierStore.syncPath { gate.wait() }
            return .failure(.notConnectedToInternet)
        }
        let model = DossierModel(store: DossierStore(dir: DossierStoreTests.tempDir()), client: server.client())
        let task = Task { await model.refresh(isLocked: false, isActive: true) }
        await Self.waitUntil { gate.arrived.withLock { $0 } }
        task.cancel()
        gate.open()
        await task.value
        #expect(model.offline == false)
        #expect(model.message == nil)
    }

    @Test func aWriteRefusedBecauseThePhoneLockedSaysNothing() async throws {
        let server = StubServer()
        server.on(Self.syncRoutes(file: DossierStoreTests.pdf(DossierStoreTests.bytesA)))
        let store = DossierStore(dir: DossierStoreTests.tempDir()) { data, url, options in
            if url.lastPathComponent != "state.json" { throw CocoaError(.fileWriteNoPermission) }
            try data.write(to: url, options: options)
        }
        let model = DossierModel(store: store, client: server.client(), isProtectedDataAvailable: { false })
        await model.refresh(isLocked: false, isActive: true)
        #expect(model.message == nil)
        #expect(model.offline == false)
    }

    @Test func aRealDiskErrorStillSaysSo() async throws {
        let server = StubServer()
        server.on(Self.syncRoutes(file: DossierStoreTests.pdf(DossierStoreTests.bytesA)))
        let store = DossierStore(dir: DossierStoreTests.tempDir()) { data, url, options in
            if url.lastPathComponent != "state.json" { throw CocoaError(.fileWriteOutOfSpace) }
            try data.write(to: url, options: options)
        }
        let model = DossierModel(store: store, client: server.client(), isProtectedDataAvailable: { true })
        await model.refresh(isLocked: false, isActive: true)
        #expect(model.message == DossierCopy.badDownload)
    }

    @Test func noConnectionIsStillOffline() async throws {
        let server = StubServer()
        server.on { _ in .failure(.notConnectedToInternet) }
        let model = DossierModel(store: DossierStore(dir: DossierStoreTests.tempDir()), client: server.client())
        await model.refresh(isLocked: false, isActive: true)
        #expect(model.offline == true)
        #expect(model.message == DossierCopy.offline)
    }

    // MARK: - Server search answers only the query it was sent

    nonisolated static let hitsBody = Data(#"{"hits":[{"entityType":"document","entityId":"x","title":"Huurcontract","snippet":null,"occurredAt":null,"status":null,"link":null}],"nextCursor":null}"#.utf8)

    @Test func aReplyForAnEarlierQueryIsDropped() async throws {
        let gate = Gate()
        let server = StubServer()
        server.on { _ in
            gate.wait()
            return .status(200, headers: ["Content-Type": "application/json"], body: Self.hitsBody)
        }
        let model = DossierModel(store: DossierStore(dir: DossierStoreTests.tempDir()), client: server.client())
        model.query = "huur"
        let task = Task { await model.searchServer() }
        await Self.waitUntil { gate.arrived.withLock { $0 } }
        #expect(model.server == .loading("huur"))
        model.query = "beschikking"
        gate.open()
        await task.value
        #expect(model.server == .idle)
    }

    @Test func aReplyIsLabelledWithTheQueryThatWasSent() async throws {
        let server = StubServer()
        server.on { _ in .status(200, headers: ["Content-Type": "application/json"], body: Self.hitsBody) }
        let model = DossierModel(store: DossierStore(dir: DossierStoreTests.tempDir()), client: server.client())
        model.query = " huur "
        await model.searchServer()
        guard case .done(let q, let hits) = model.server else {
            Issue.record("expected .done, got \(model.server)")
            return
        }
        #expect(q == " huur ")
        #expect(hits.count == 1)
        #expect(server.requests.first?.url?.query() == "q=huur")
    }

    // MARK: - A document the phone could not take in

    /// A broken download is not a failure Martin can retry away: no message,
    /// the cursor moves on, and the count of what is missing is shown.
    @Test func aBrokenDownloadIsCountedNotReportedAsRetryable() async throws {
        let server = StubServer()
        server.on(Self.syncRoutes(file: DossierStoreTests.pdf(Data("kapot".utf8))))
        let model = DossierModel(store: DossierStore(dir: DossierStoreTests.tempDir()), client: server.client())
        await model.refresh(isLocked: false, isActive: true)
        #expect(model.message == nil)
        #expect(model.notHeldCount == 1)
        #expect(model.notHeldLine == DossierCopy.notHeldLine(1))
        #expect(DossierCopy.notHeldLine(0) == nil)
        #expect(DossierCopy.notHeldLine(3)?.hasPrefix("3 documenten staan") == true)
    }

    // MARK: - The Tijdlijn names a document's soort on every path

    /// Overzicht pushes the Tijdlijn before Dossier was ever opened: the
    /// shared preparation reads (and, never synced, syncs) the phone's copy,
    /// so the row says "document · brief · opent in dossier" there too.
    @Test func theTimelinesDocumentLineNamesTheSoortWithoutOpeningDossierFirst() async throws {
        let server = StubServer()
        server.on(Self.syncRoutes(file: DossierStoreTests.pdf(DossierStoreTests.bytesA)))
        let model = DossierModel(store: DossierStore(dir: DossierStoreTests.tempDir()), client: server.client())
        #expect(model.doc(Self.a) == nil)
        await model.prepareForTimeline(isLocked: false, isActive: true)
        let line = TimelineCopy.documentLine(docType: model.doc(Self.a)?.docType, held: model.doc(Self.a) != nil,
                                             offline: false)
        #expect(line == "document · brief · opent in dossier")
        // Dossier's own path, already synced, prepares to the same answer.
        await model.prepareForTimeline(isLocked: false, isActive: true)
        #expect(model.doc(Self.a)?.docType == "letter")
    }

    @Test func aLockedPhoneDoesNotSyncForTheTimeline() async throws {
        let server = StubServer()
        server.on(Self.syncRoutes(file: DossierStoreTests.pdf(DossierStoreTests.bytesA)))
        let model = DossierModel(store: DossierStore(dir: DossierStoreTests.tempDir()), client: server.client())
        await model.prepareForTimeline(isLocked: true, isActive: true)
        #expect(model.doc(Self.a) == nil)
    }

    @Test func theSearchFieldKeepsOneLine() {
        #expect(DossierCopy.searchLine("bijstand") == "bijstand")
        #expect(DossierCopy.searchLine("bijstand\n") == "bijstand")
        #expect(DossierCopy.searchLine("loon\nstrook") == "loon strook")
    }

    @Test func freshnessReadsTheCasesClock() async throws {
        let at = Date(timeIntervalSince1970: 1_793_522_460) // 1 nov 09:41 Amsterdam
        let server = StubServer()
        server.on(Self.syncRoutes(file: DossierStoreTests.pdf(DossierStoreTests.bytesA)))
        let model = DossierModel(store: DossierStore(dir: DossierStoreTests.tempDir(), now: { at }),
                                 client: server.client(), now: { at })
        await model.refresh(isLocked: false, isActive: true)
        #expect(model.freshness == "bijgewerkt 09:41")
    }
}
