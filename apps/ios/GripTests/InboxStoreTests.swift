import Testing
import Foundation
import Synchronization
@testable import Grip

/// The read routes as `apps/web/src/lib/mobile-dto.ts` serves them.
enum InboxFixture {
    static let inboxPath = "/api/mobile/v1/inbox"
    static let summaryPath = "/api/mobile/v1/dashboard/summary"

    /// A proposal whose `dueAt` is a plain DATE ("2026-11-07"), as
    /// `waitingOnMartin` copies it from the proposal payload, beside a task
    /// whose `dueAt` is an ISO instant: both must decode.
    static let inbox = Data("""
    {"count":3,"items":[
      {"kind":"proposal","id":"6f9619ff-8b86-d011-b42d-00c04fc964ff","title":"Loonstrook oktober aanleveren",
       "subtitle":"Verder Bewind","priority":1,"at":"2026-10-30T09:20:01.123Z","dueAt":"2026-11-07","verder":true},
      {"kind":"suggestion","id":"s1","title":"Brief CAK","subtitle":"Document","priority":3,
       "at":"2026-10-29T08:00:00.000Z","dueAt":null,"verder":false},
      {"kind":"task","id":"t1","title":"Polis opvragen","subtitle":null,"priority":1,
       "at":"2026-10-20T08:00:00.000Z","dueAt":"2026-10-31T23:00:00.000Z","verder":false}
    ],"doneByGrip":[]}
    """.utf8)

    static let emptyInbox = Data(#"{"count":0,"items":[],"doneByGrip":[]}"#.utf8)

    static let summary = Data("""
    {"headline":{"stopTitle":"Stukken aanleveren","trackTitle":"Opstart en stukken",
      "happenedAt":null,"note":null},
     "waitingCount":3,"tasks":{"openCount":2,"overdueCount":0,"waitingOnOthersCount":1}}
    """.utf8)
}

@MainActor
struct InboxStoreTests {
    final class Badges: Sendable {
        let m = Mutex<[Int]>([])
        var values: [Int] { m.withLock { $0 } }
    }

    final class Flags { var unauthorized = 0; var widgetReloads = 0 }

    struct Rig {
        let server: StubServer
        let dir: URL
        let badges: Badges
        let flags: Flags
        let store: InboxStore
    }

    nonisolated static let now = Date(timeIntervalSince1970: 1_793_400_000)

    func rig(_ handler: @escaping StubProtocol.Handler) -> Rig {
        let server = StubServer()
        server.on(handler)
        let dir = WidgetSnapshotTests.tempDir()
        let badges = Badges()
        let flags = Flags()
        let store = InboxStore(client: server.client(), snapshotDir: dir,
                               setBadge: { n in badges.m.withLock { $0.append(n) } },
                               onUnauthorized: { flags.unauthorized += 1 },
                               now: { Self.now },
                               reloadWidgets: { flags.widgetReloads += 1 })
        return Rig(server: server, dir: dir, badges: badges, flags: flags, store: store)
    }

    static func serving(inbox: StubProtocol.Reply = .status(200, body: InboxFixture.inbox),
                        summary: StubProtocol.Reply = .status(200, body: InboxFixture.summary)) -> StubProtocol.Handler {
        { req in
            switch req.url?.path() {
            case InboxFixture.inboxPath: inbox
            case InboxFixture.summaryPath: summary
            default: .status(404)
            }
        }
    }

    @Test func refreshWritesSnapshotWithTopItem() async throws {
        let r = rig(Self.serving())
        await r.store.refresh()
        let snap = try #require(WidgetSnapshot.read(from: r.dir))
        #expect(snap.count == 3)
        #expect(snap.topTitle == "Loonstrook oktober aanleveren")
        #expect(snap.topKind == "proposal")
        #expect(snap.headline == "Stukken aanleveren")
        #expect(snap.updatedAt == Self.now)
    }

    /// The widget's rows (Task 23): the server's top five in server order,
    /// each with its id for the deep link, and the oldest `at` over ALL items.
    @Test func refreshWritesTheItemsAndTheOldestForTheWidget() async throws {
        let r = rig(Self.serving())
        await r.store.refresh()
        let snap = try #require(WidgetSnapshot.read(from: r.dir))
        #expect(snap.items.map(\.id) == ["6f9619ff-8b86-d011-b42d-00c04fc964ff", "s1", "t1"])
        #expect(snap.items.map(\.kind) == ["proposal", "suggestion", "task"])
        #expect(snap.items.first?.title == "Loonstrook oktober aanleveren")
        #expect(snap.oldestAt == ISO8601DateFormatter().date(from: "2026-10-20T08:00:00Z"))
    }

    @Test func refreshKeepsAtMostFiveItems() async throws {
        let rows = (0..<7).map { n in
            #"{"kind":"task","id":"t\#(n)","title":"Taak \#(n)","subtitle":null,"priority":3,"at":"2026-10-2\#(6 - n)T08:00:00Z","dueAt":null,"verder":false}"#
        }
        let body = Data(#"{"count":7,"items":[\#(rows.joined(separator: ","))],"doneByGrip":[]}"#.utf8)
        let r = rig(Self.serving(inbox: .status(200, body: body)))
        await r.store.refresh()
        let snap = try #require(WidgetSnapshot.read(from: r.dir))
        #expect(snap.items.map(\.id) == ["t0", "t1", "t2", "t3", "t4"])
        #expect(snap.count == 7)
        // The oldest over all seven, not over the five kept.
        #expect(snap.oldestAt == ISO8601DateFormatter().date(from: "2026-10-20T08:00:00Z"))
    }

    @Test func aWrittenSnapshotReloadsTheWidgetAndAFailedRefreshDoesNot() async {
        let r = rig(Self.serving())
        await r.store.refresh()
        #expect(r.flags.widgetReloads == 1)
        StubProtocol.register(host: r.server.host, Self.serving(inbox: .status(503)))
        await r.store.refresh()
        #expect(r.flags.widgetReloads == 1)
    }

    @Test func refreshSetsTheBadgeToTheCount() async {
        let r = rig(Self.serving())
        await r.store.refresh()
        #expect(r.badges.values == [3])
        #expect(r.store.inbox?.count == 3)
        #expect(r.store.lastError == nil)
    }

    @Test func refreshDecodesTheServerOrderAndBothDueAtShapes() async throws {
        let r = rig(Self.serving())
        await r.store.refresh()
        let items = try #require(r.store.inbox?.items)
        #expect(items.map(\.id) == ["6f9619ff-8b86-d011-b42d-00c04fc964ff", "s1", "t1"])
        #expect(items.map(\.kind) == [.proposal, .suggestion, .task])
        #expect(items[0].dueAt == "2026-11-07")
        #expect(items[0].verder)
        #expect(items[2].dueAt == "2026-10-31T23:00:00.000Z")
        #expect(r.store.summary?.headline?.trackTitle == "Opstart en stukken")
    }

    @Test func anEmptyInboxClearsTheBadgeAndTheTopItem() async throws {
        let r = rig(Self.serving(inbox: .status(200, body: InboxFixture.emptyInbox)))
        await r.store.refresh()
        #expect(r.badges.values == [0])
        let snap = try #require(WidgetSnapshot.read(from: r.dir))
        #expect(snap.count == 0)
        #expect(snap.topTitle == nil)
        #expect(snap.topKind == nil)
    }

    @Test func anUnknownKindStillDecodes() async throws {
        let body = Data("""
        {"count":1,"items":[{"kind":"reminder","id":"x","title":"Iets nieuws","subtitle":null,"priority":3,
          "at":"2026-10-30T09:20:01Z","dueAt":null,"verder":false}],"doneByGrip":[]}
        """.utf8)
        let r = rig(Self.serving(inbox: .status(200, body: body)))
        await r.store.refresh()
        #expect(r.store.inbox?.items.first?.kind == .other("reminder"))
        #expect(WidgetSnapshot.read(from: r.dir)?.topKind == "reminder")
    }

    /// A failed refresh says nothing new, so it changes nothing the phone
    /// already shows: the last snapshot and the icon badge stay as they were.
    @Test func aFailedRefreshKeepsTheSnapshotAndTheBadge() async throws {
        let r = rig(Self.serving())
        await r.store.refresh()
        let before = try #require(WidgetSnapshot.read(from: r.dir))

        StubProtocol.register(host: r.server.host, Self.serving(inbox: .status(503)))
        await r.store.refresh()
        #expect(r.store.lastError == .server(503))
        #expect(r.badges.values == [3])
        #expect(WidgetSnapshot.read(from: r.dir) == before)
        #expect(r.store.inbox?.count == 3)
    }

    @Test func unauthorizedReportsTheRejectedSession() async {
        let r = rig(Self.serving(inbox: .status(401)))
        await r.store.refresh()
        #expect(r.store.lastError == .unauthorized)
        #expect(r.flags.unauthorized == 1)
        #expect(r.badges.values.isEmpty)
        #expect(WidgetSnapshot.read(from: r.dir) == nil)
    }

    /// A revoked session (a lost phone, revoked in /settings/security) must not
    /// leave the widget drawing the case: the 401 erases the snapshot — its
    /// titles, ids and headline — and reloads the widget, which then reads
    /// "Open Grip om bij te werken". The pocket dossier is wiped for the same
    /// reason; the widget's copy of the same content may not outlive it.
    @Test func unauthorizedErasesTheWidgetSnapshotAndReloads() async throws {
        let r = rig(Self.serving())
        await r.store.refresh()
        _ = try #require(WidgetSnapshot.read(from: r.dir))
        #expect(r.flags.widgetReloads == 1)

        StubProtocol.register(host: r.server.host, Self.serving(inbox: .status(401)))
        await r.store.refresh()
        #expect(!FileManager.default.fileExists(atPath: WidgetSnapshot.fileURL(in: r.dir).path))
        #expect(r.flags.widgetReloads == 2)
        // Nor does the store keep the content in memory for the next screen.
        #expect(r.store.inbox == nil)
        #expect(r.store.summary == nil)
    }

    /// The headline is decoration; the count is the point. A summary that
    /// fails still lets the count through, with the last known headline.
    @Test func aFailedSummaryStillUpdatesTheCountAndKeepsTheHeadline() async throws {
        let r = rig(Self.serving())
        await r.store.refresh()
        StubProtocol.register(host: r.server.host,
                              Self.serving(inbox: .status(200, body: InboxFixture.emptyInbox), summary: .status(500)))
        await r.store.refresh()
        let snap = try #require(WidgetSnapshot.read(from: r.dir))
        #expect(snap.count == 0)
        #expect(snap.headline == "Stukken aanleveren")
        #expect(r.badges.values == [3, 0])
        #expect(r.store.lastError == nil)
    }

    @Test func noOpenStopMeansNoHeadline() async throws {
        let summary = Data(#"{"headline":null,"waitingCount":0,"tasks":{"openCount":0,"overdueCount":0,"waitingOnOthersCount":0}}"#.utf8)
        let r = rig(Self.serving(summary: .status(200, body: summary)))
        await r.store.refresh()
        #expect(WidgetSnapshot.read(from: r.dir)?.headline == nil)
    }
}

struct InboxModelsTests {
    @Test func suggestionDecodesWithFreeFormProposed() throws {
        let data = Data("""
        {"id":"s1","kind":"document-meta","status":"pending","createdAt":"2026-10-29T08:00:00.000Z",
         "proposed":{"title":"Brief CAK","docType":"brief","confidence":0.82,"tags":["cak",null],"nested":{"a":true}},
         "trigger":{"from":"CAK <info@hetcak.nl>","subject":"Uw bijdrage","sentAt":"2026-10-28T12:00:00.000Z"},
         "document":{"id":"d1","title":"Brief CAK","docType":null,"status":"inbox"},
         "retrievedRefs":[]}
        """.utf8)
        let s: SuggestionDTO = try APIClient.decode(data)
        #expect(s.kind == "document-meta")
        #expect(s.proposed["title"] == .string("Brief CAK"))
        #expect(s.proposed["confidence"] == .number(0.82))
        #expect(s.proposed["tags"] == .array([.string("cak"), .null]))
        #expect(s.proposed["nested"]?["a"] == .bool(true))
        #expect(s.trigger?.from == "CAK <info@hetcak.nl>")
        #expect(s.document?.docType == nil)
        #expect(s.retrievedRefs.isEmpty)
    }

    @Test func suggestionWithoutTriggerOrDocumentDecodes() throws {
        let data = Data("""
        {"id":"s2","kind":"task","status":"needs-manual","createdAt":"2026-10-29T08:00:00Z",
         "proposed":null,"trigger":null,"document":null,"retrievedRefs":[{"type":"entry","id":"e1"}]}
        """.utf8)
        let s: SuggestionDTO = try APIClient.decode(data)
        #expect(s.proposed == .null)
        #expect(s.trigger == nil)
        #expect(s.document == nil)
        #expect(s.retrievedRefs.count == 1)
    }

    @Test func taskListDecodes() throws {
        let data = Data("""
        [{"id":"t1","title":"Polis opvragen","details":null,"dueAt":"2026-10-31T23:00:00.000Z",
          "status":"open","assigneeName":null,"validNext":["in-progress","waiting","done"]},
         {"id":"t2","title":"Bellen","details":"met Demi","dueAt":null,"status":"waiting",
          "assigneeName":"Verder Bewind","validNext":["open"]}]
        """.utf8)
        let tasks: [TaskDTO] = try APIClient.decode(data)
        #expect(tasks.map(\.id) == ["t1", "t2"])
        #expect(tasks[0].dueAt != nil)
        #expect(tasks[1].validNext == ["open"])
        #expect(tasks[1].assigneeName == "Verder Bewind")
    }

    @Test func jsonValueRoundTrips() throws {
        let v: JSONValue = .object(["a": .array([.number(1), .string("x"), .bool(false), .null])])
        let data = try JSONEncoder().encode(v)
        #expect(try JSONDecoder().decode(JSONValue.self, from: data) == v)
    }
}
