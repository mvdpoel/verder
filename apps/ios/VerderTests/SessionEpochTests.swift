import Testing
import Foundation
import Synchronization
@testable import Verder

/// ONE sign-out epoch for every store: a refresh or sync suspended at an
/// await when the session ends resumes into a later epoch and writes nothing
/// back — no widget snapshot, no badge, no money, no dossier.
@MainActor
struct SessionEpochTests {
    typealias Gate = DossierModelTests.Gate

    static let setCookie = AuthModelTests.setCookie

    // MARK: - The epoch itself

    @Test func endingTheSessionMovesTheEpochAndRunsEveryEnder() {
        let epoch = SessionEpoch()
        let before = epoch.current
        var ran = 0
        epoch.whenEnded { ran += 1 }
        epoch.whenEnded { ran += 10 }
        epoch.end()
        #expect(!epoch.isCurrent(before))
        #expect(ran == 11)
    }

    @Test func signOutAndARejectedSessionBothEndTheEpoch() async {
        let server = StubServer()
        server.on { _ in .status(200) }
        let store = InMemorySessionStore(SessionCookie(name: "__Secure-better-auth.session_token", value: "v", expires: nil))
        let auth = AuthModel(client: server.client(store: store), store: store)
        let first = auth.epoch.current
        await auth.signOut()
        #expect(!auth.epoch.isCurrent(first))
        let second = auth.epoch.current
        auth.sessionRejected()
        #expect(!auth.epoch.isCurrent(second))
    }

    // MARK: - Inbox: no snapshot, badge 0

    @Test func aSessionEndedDuringASuspendedInboxRefreshLeavesNoSnapshotAndBadgeZero() async throws {
        let gate = Gate()
        let server = StubServer()
        let serving = InboxStoreTests.serving()
        server.on { req in
            if req.url?.path() == InboxFixture.inboxPath { gate.wait() }
            return serving(req)
        }
        let session = InMemorySessionStore(SessionCookie(name: "__Secure-better-auth.session_token", value: "v", expires: nil))
        let client = server.client(store: session)
        let auth = AuthModel(client: client, store: session)
        let dir = WidgetSnapshotTests.tempDir()
        let badges = InboxStoreTests.Badges()
        let inbox = InboxStore(client: client, snapshotDir: dir,
                               setBadge: { n in badges.m.withLock { $0.append(n) } },
                               onUnauthorized: { auth.sessionRejected() },
                               reloadWidgets: {}, epoch: auth.epoch)

        let refresh = Task { await inbox.refresh() }
        await DossierModelTests.waitUntil { gate.arrived.withLock { $0 } }
        // `forgetLocally`, the end of both ways out. (`signOut` itself would
        // queue its POST behind the held request on the stub's one host.)
        auth.sessionRejected()
        gate.open()
        await refresh.value
        await DossierModelTests.waitUntil { badges.values.contains(0) }

        #expect(WidgetSnapshot.read(from: dir) == nil)
        #expect(badges.values == [0])
        #expect(inbox.inbox == nil)
        #expect(inbox.summary == nil)
    }

    /// A 401 that arrives for a session already ended (Martin signed in again
    /// meanwhile) is about the OLD session: it must not sign the new one out.
    @Test func aStaleUnauthorizedDoesNotEndTheNextSession() async {
        let gate = Gate()
        let server = StubServer()
        server.on { req in
            if req.url?.path() == InboxFixture.inboxPath { gate.wait(); return .status(401) }
            return .status(200, body: InboxFixture.summary)
        }
        let epoch = SessionEpoch()
        var rejected = 0
        let inbox = InboxStore(client: server.client(), snapshotDir: nil, setBadge: { _ in },
                               onUnauthorized: { rejected += 1 }, epoch: epoch)
        let refresh = Task { await inbox.refresh() }
        await DossierModelTests.waitUntil { gate.arrived.withLock { $0 } }
        epoch.end()
        gate.open()
        await refresh.value
        #expect(rejected == 0)
        #expect(inbox.lastError == nil)
    }

    // MARK: - Money

    @Test func aStaleEpochMoneyRefreshDoesNotRepopulate() async throws {
        let gate = Gate()
        let server = StubServer()
        let fixture = FixtureEnvironment.client(fixture: "money-complete")
        let (body, _) = try await fixture.send(
            fixture.request(MoneyStore.path, method: "GET", body: nil, contentType: nil))
        server.on { _ in
            gate.wait()
            return .status(200, headers: ["Content-Type": "application/json"], body: body)
        }
        let epoch = SessionEpoch()
        let money = MoneyStore(client: server.client(), epoch: epoch)
        let refresh = Task { await money.refresh() }
        await DossierModelTests.waitUntil { gate.arrived.withLock { $0 } }
        epoch.end()
        gate.open()
        await refresh.value
        #expect(money.glance == nil)
        #expect(money.lastError == nil)
    }

    @Test func endingTheSessionForgetsTheMoneyAlreadyShown() async throws {
        let epoch = SessionEpoch()
        let money = MoneyStore(client: FixtureEnvironment.client(fixture: "money-complete"), epoch: epoch)
        await money.refresh()
        #expect(money.glance != nil)
        epoch.end()
        #expect(money.glance == nil)
    }

    // MARK: - Dossier

    /// The actor is reentrant: a `wipe()` runs while `sync` waits on the
    /// network, and without its own wipe count the sync resumes and writes
    /// the page into the wiped store.
    @Test func aWipeDuringASuspendedDossierGetJSONLeavesTheStoreEmpty() async throws {
        let gate = Gate()
        let server = StubServer()
        let routes = DossierModelTests.syncRoutes(file: DossierStoreTests.pdf(DossierStoreTests.bytesA))
        server.on { req in
            if req.url?.path() == DossierStore.syncPath { gate.wait() }
            return routes(req)
        }
        let dir = DossierStoreTests.tempDir()
        let store = DossierStore(dir: dir)
        let client = server.client()
        let sync = Task { try await store.sync(client: client) }
        await DossierModelTests.waitUntil { gate.arrived.withLock { $0 } }
        await store.wipe()
        gate.open()
        await #expect(throws: DossierStore.SyncError.wiped) { try await sync.value }

        #expect(await store.documents().isEmpty)
        #expect(await store.cursor == 0)
        #expect(!FileManager.default.fileExists(atPath: DossierStore.stateURL(in: dir).path(percentEncoded: false)))
        #expect(!FileManager.default.fileExists(
            atPath: DossierStore.fileURL(DossierStoreTests.a, in: dir).path(percentEncoded: false)))
        #expect(!server.requests.contains { $0.url?.path().hasSuffix("/file") == true })
    }

    @Test func endingTheSessionDuringADossierRefreshLeavesTheTabEmpty() async throws {
        let gate = Gate()
        let server = StubServer()
        let routes = DossierModelTests.syncRoutes(file: DossierStoreTests.pdf(DossierStoreTests.bytesA))
        server.on { req in
            let path = req.url?.path() ?? ""
            if path == DossierStore.syncPath { gate.wait() }
            if path == "/api/mobile/v1/tasks" { return .status(200, body: Data("[]".utf8)) }
            return routes(req)
        }
        let epoch = SessionEpoch()
        let dir = DossierStoreTests.tempDir()
        let model = DossierModel(store: DossierStore(dir: dir), client: server.client(), epoch: epoch)
        model.query = "huur"
        let refresh = Task { await model.refresh(isLocked: false, isActive: true) }
        await DossierModelTests.waitUntil { gate.arrived.withLock { $0 } }
        epoch.end()
        gate.open()
        await refresh.value
        await model.wipe()  // what Meer's sign-out awaits; the ender already started it

        #expect(model.docs.isEmpty)
        #expect(model.query == "")
        #expect(model.server == .idle)
        #expect(model.message == nil)
        #expect(model.offline == false)
        #expect(model.tasks == nil)
        #expect(model.syncedAt == nil)
        #expect(await model.store.documents().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: DossierStore.stateURL(in: dir).path(percentEncoded: false)))
    }

    @Test func endingTheSessionClearsAnOfflineDossierAndItsServerHits() async throws {
        let server = StubServer()
        server.on { _ in .failure(.notConnectedToInternet) }
        let epoch = SessionEpoch()
        let model = DossierModel(store: DossierStore(dir: DossierStoreTests.tempDir()), client: server.client(), epoch: epoch)
        await model.refresh(isLocked: false, isActive: true)
        #expect(model.offline)
        #expect(model.message != nil)
        model.query = "beschikking"
        epoch.end()
        #expect(model.offline == false)
        #expect(model.message == nil)
        #expect(model.query == "")
        #expect(model.server == .idle)
    }
}
