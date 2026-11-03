import Testing
import Foundation
import Synchronization
@testable import Verder

/// The Tijdlijn's data: `GET /api/mobile/v1/case-map`, kept on the phone so
/// it shows offline with its age, written `.completeFileProtection`, and
/// forgotten when the session ends.
@MainActor
struct TimelineStoreTests {
    static func tempDir() -> URL {
        URL.temporaryDirectory.appending(path: "timeline-\(UUID().uuidString)", directoryHint: .isDirectory)
    }

    static func fixtureBody(_ hidden: Bool = false) throws -> Data {
        try #require(try FixtureTests.body("timeline", "case-map" + (hidden ? "~schuldeisers=verborgen" : "")))
    }

    final class Writes: Sendable {
        let m = Mutex<[(URL, Data.WritingOptions)]>([])
        var all: [(URL, Data.WritingOptions)] { m.withLock { $0 } }
    }

    static func cache(_ dir: URL, writes: Writes? = nil) -> TimelineCache {
        TimelineCache(dir: dir, write: { data, url, options in
            writes?.m.withLock { $0.append((url, options)) }
            try TimelineCache.defaultWriter(data, url, options)
        })
    }

    @Test func thePathCarriesTheWebsFilter() {
        #expect(TimelineStore.path(hidingDebts: false) == "/api/mobile/v1/case-map")
        #expect(TimelineStore.path(hidingDebts: true) == "/api/mobile/v1/case-map?schuldeisers=verborgen")
    }

    @Test func aFetchedMapIsShownAndCachedCompleteProtection() async throws {
        let body = try Self.fixtureBody()
        let server = StubServer()
        server.on { _ in .status(200, headers: ["Content-Type": "application/json"], body: body) }
        let writes = Writes()
        let store = TimelineStore(client: server.client(), cache: Self.cache(Self.tempDir(), writes: writes))
        await store.load()
        #expect(store.map?.currentStopId != nil)
        #expect(store.offline == false)
        #expect(store.savedAt != nil)
        #expect(writes.all.count == 1)
        #expect(writes.all.allSatisfy { $0.1.contains(.completeFileProtection) && $0.1.contains(.atomic) })
        #expect(server.requests.map { $0.url?.path() } == ["/api/mobile/v1/case-map"])
    }

    @Test func offlineShowsTheCachedMapWithItsAge() async throws {
        let dir = Self.tempDir()
        let body = try Self.fixtureBody()
        let online = StubServer()
        online.on { _ in .status(200, body: body) }
        let first = TimelineStore(client: online.client(), cache: Self.cache(dir))
        await first.load()
        let saved = try #require(first.savedAt)

        let offline = StubServer()
        offline.on { _ in .failure(.notConnectedToInternet) }
        let second = TimelineStore(client: offline.client(), cache: Self.cache(dir))
        await second.load()
        #expect(second.map == first.map)
        #expect(second.offline)
        #expect(abs((second.savedAt ?? .distantPast).timeIntervalSince(saved)) < 1)
        #expect(second.freshness?.hasPrefix("offline · bijgewerkt") == true)
    }

    @Test func offlineWithNothingCachedSaysSo() async {
        let server = StubServer()
        server.on { _ in .failure(.notConnectedToInternet) }
        let store = TimelineStore(client: server.client(), cache: Self.cache(Self.tempDir()))
        await store.load()
        #expect(store.map == nil)
        #expect(store.offline)
        #expect(store.screen == .offlineNothingCached)
    }

    @Test func aServerErrorKeepsTheMapAlreadyShown() async throws {
        let body = try Self.fixtureBody()
        let fail = Mutex(false)
        let server = StubServer()
        server.on { _ in fail.withLock { $0 } ? .status(503) : .status(200, body: body) }
        let store = TimelineStore(client: server.client(), cache: Self.cache(Self.tempDir()))
        await store.load()
        fail.withLock { $0 = true }
        await store.refresh()
        #expect(store.map != nil)
        #expect(store.lastError == .server(503))
        #expect(store.offline == false)
    }

    @Test func aServerErrorWithNothingShownIsTheErrorState() async {
        let server = StubServer()
        server.on { _ in .status(500) }
        let store = TimelineStore(client: server.client(), cache: Self.cache(Self.tempDir()))
        await store.load()
        #expect(store.screen == .failed(.server(500)))
    }

    @Test func unauthorizedSignsOut() async {
        let server = StubServer()
        server.on { _ in .status(401) }
        var rejected = 0
        let store = TimelineStore(client: server.client(), cache: Self.cache(Self.tempDir()),
                                  onUnauthorized: { rejected += 1 })
        await store.load()
        #expect(rejected == 1)
    }

    @Test func hidingSchuldeisersAsksForTheFilteredMapAndCachesItApart() async throws {
        let shown = try Self.fixtureBody()
        let hidden = try Self.fixtureBody(true)
        let server = StubServer()
        server.on { req in .status(200, body: req.url?.query() == "schuldeisers=verborgen" ? hidden : shown) }
        let dir = Self.tempDir()
        let store = TimelineStore(client: server.client(), cache: Self.cache(dir))
        await store.load()
        let full = try #require(store.map)
        await store.setHideDebts(true)
        let filtered = try #require(store.map)
        #expect(store.hideDebts)
        #expect(filtered.debtEpisodesHidden)
        #expect(filtered.stops.count < full.stops.count)
        #expect(filtered.hiddenDebtTrackCount == 1)
        // Both views are on disk, each under its own name.
        #expect(Self.cache(dir).load(hidingDebts: false)?.map == full)
        #expect(Self.cache(dir).load(hidingDebts: true)?.map == filtered)
    }

    @Test func theSessionEndingForgetsTheMapAndTheCache() async throws {
        let body = try Self.fixtureBody()
        let server = StubServer()
        server.on { _ in .status(200, body: body) }
        let dir = Self.tempDir()
        let epoch = SessionEpoch()
        let store = TimelineStore(client: server.client(), cache: Self.cache(dir), epoch: epoch)
        await store.load()
        #expect(store.map != nil)
        epoch.end()
        #expect(store.map == nil)
        #expect(store.savedAt == nil)
        #expect(Self.cache(dir).load(hidingDebts: false) == nil)
    }

    @Test func anAnswerAfterTheSessionEndedIsDropped() async throws {
        let body = try Self.fixtureBody()
        let gate = DossierModelTests.Gate()
        let server = StubServer()
        server.on { _ in gate.wait(); return .status(200, body: body) }
        let dir = Self.tempDir()
        let epoch = SessionEpoch()
        let store = TimelineStore(client: server.client(), cache: Self.cache(dir), epoch: epoch)
        let task = Task { await store.refresh() }
        await DossierModelTests.waitUntil { gate.arrived.withLock { $0 } }
        epoch.end()
        gate.open()
        await task.value
        #expect(store.map == nil)
        #expect(Self.cache(dir).load(hidingDebts: false) == nil)
    }

    @Test func theScreenStateFollowsWhatIsKnown() async throws {
        let body = try Self.fixtureBody()
        let server = StubServer()
        server.on { _ in .status(200, body: body) }
        let store = TimelineStore(client: server.client(), cache: Self.cache(Self.tempDir()))
        #expect(store.screen == .loading)
        await store.load()
        guard case .map = store.screen else { Issue.record("expected the map, got \(store.screen)"); return }
        let empty = try #require(try FixtureTests.body("empty", "case-map"))
        let emptyServer = StubServer()
        emptyServer.on { _ in .status(200, body: empty) }
        let emptyStore = TimelineStore(client: emptyServer.client(), cache: Self.cache(Self.tempDir()))
        await emptyStore.load()
        #expect(emptyStore.screen == .empty)
    }
}
