import Testing
import Foundation
import Synchronization
@testable import Verder

/// The pocket dossier's sync (Plan 3 Task 21) against a stub of the three
/// routes Task 20 built: `/documents/sync`, `/documents/:id/file`,
/// `/documents/texts`.
struct DossierStoreTests {
    static let a = "00000000-0000-4000-8000-00000000000a"
    static let b = "00000000-0000-4000-8000-00000000000b"
    static let bytesA = Data("%PDF-1.4 a".utf8)
    static let bytesB = Data("%PDF-1.4 b".utf8)

    static func doc(_ id: String, title: String = "Brief", bytes: Data, hasText: Bool = true) -> String {
        """
        {"id":"\(id)","title":"\(title)","docType":"letter","status":"inbox",
         "receivedAt":"2026-10-30T09:00:00.000Z","mime":"application/pdf","sizeBytes":\(bytes.count),
         "sha256":"\(DossierStore.sha256Hex(bytes))","hasText":\(hasText)}
        """
    }

    static func delta(cursor: Int, more: Bool = false, upserts: [String] = [], tombstones: [(String, String)] = []) -> Data {
        let t = tombstones.map { #"{"id":"\#($0.0)","reason":"\#($0.1)"}"# }
        return Data(#"{"cursor":\#(cursor),"more":\#(more),"upserts":[\#(upserts.joined(separator: ","))],"tombstones":[\#(t.joined(separator: ","))]}"#.utf8)
    }

    static func texts(_ pairs: [(String, String)]) -> Data {
        Data(("[" + pairs.map { #"{"id":"\#($0.0)","text":"\#($0.1)","truncated":false}"# }.joined(separator: ",") + "]").utf8)
    }

    static func tempDir() -> URL {
        URL.temporaryDirectory.appending(path: "dossier-\(UUID().uuidString)", directoryHint: .isDirectory)
    }

    /// A stub server whose answers the test can change between syncs.
    final class Routes: Sendable {
        let deltas = Mutex<[Int: Data]>([:])
        let files = Mutex<[String: StubProtocol.Reply]>([:])
        let texts = Mutex<Data>(Data("[]".utf8))

        func handle(_ req: URLRequest) -> StubProtocol.Reply {
            guard let url = req.url else { return .status(400) }
            let path = url.path()
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            if path == "/api/mobile/v1/documents/sync" {
                let cursor = Int(query.first { $0.name == "cursor" }?.value ?? "") ?? -1
                guard let body = deltas.withLock({ $0[cursor] }) else { return .status(400) }
                return .status(200, headers: ["Content-Type": "application/json"], body: body)
            }
            if path == "/api/mobile/v1/documents/texts" {
                return .status(200, headers: ["Content-Type": "application/json"], body: texts.withLock { $0 })
            }
            let parts = path.split(separator: "/")
            if parts.count == 6, parts[3] == "documents", parts[5] == "file" {
                return files.withLock { $0[String(parts[4])] } ?? .status(404)
            }
            return .status(404)
        }
    }

    struct Rig {
        let server: StubServer
        let routes: Routes
        let dir: URL
        let client: APIClient
    }

    func rig() -> Rig {
        let server = StubServer()
        let routes = Routes()
        server.on { routes.handle($0) }
        return Rig(server: server, routes: routes, dir: Self.tempDir(), client: server.client())
    }

    static func pdf(_ data: Data) -> StubProtocol.Reply {
        .status(200, headers: ["Content-Type": "application/pdf"], body: data)
    }

    func fileRequests(_ r: Rig, _ id: String) -> Int {
        r.server.requests.filter { $0.url?.path() == "/api/mobile/v1/documents/\(id)/file" }.count
    }

    // MARK: - The plan's tests

    @Test func tombstoneDeletesFileAndText() async throws {
        let r = rig()
        r.routes.deltas.withLock {
            $0[0] = Self.delta(cursor: 5, upserts: [Self.doc(Self.a, bytes: Self.bytesA)])
            $0[5] = Self.delta(cursor: 9, tombstones: [(Self.a, "purged")])
        }
        r.routes.files.withLock { $0[Self.a] = Self.pdf(Self.bytesA) }
        r.routes.texts.withLock { $0 = Self.texts([(Self.a, "Beschikking van de rechtbank")]) }
        let store = DossierStore(dir: r.dir)

        try await store.sync(client: r.client)
        let file = try #require(await store.fileURL(Self.a))
        #expect(try Data(contentsOf: file) == Self.bytesA)
        #expect(await store.text(Self.a) == "Beschikking van de rechtbank")
        let textFile = DossierStore.textURL(Self.a, in: r.dir)
        #expect(FileManager.default.fileExists(atPath: textFile.path()))

        try await store.sync(client: r.client)
        #expect(await store.fileURL(Self.a) == nil)
        #expect(!FileManager.default.fileExists(atPath: file.path()))
        #expect(!FileManager.default.fileExists(atPath: textFile.path()))
        #expect(await store.text(Self.a) == nil)
        #expect(await store.documents().isEmpty)
        #expect(await store.cursor == 9)
        // And it stays gone after a relaunch.
        #expect(await DossierStore(dir: r.dir).documents().isEmpty)
    }

    /// A download that throws leaves the cursor where it was, on disk too, so
    /// the next sync asks for the same page again.
    @Test func cursorSavedOnlyAfterApply() async throws {
        let r = rig()
        r.routes.deltas.withLock {
            $0[0] = Self.delta(cursor: 7, upserts: [Self.doc(Self.a, bytes: Self.bytesA), Self.doc(Self.b, bytes: Self.bytesB)])
        }
        r.routes.files.withLock {
            $0[Self.a] = Self.pdf(Self.bytesA)
            $0[Self.b] = .status(500)
        }
        let store = DossierStore(dir: r.dir)
        await #expect(throws: APIError.server(500)) { try await store.sync(client: r.client) }
        #expect(await store.cursor == 0)
        #expect(await DossierStore(dir: r.dir).cursor == 0)

        r.routes.files.withLock { $0[Self.b] = Self.pdf(Self.bytesB) }
        try await store.sync(client: r.client)
        #expect(await store.cursor == 7)
        #expect(await DossierStore(dir: r.dir).cursor == 7)
        #expect(Set(await store.documents().map(\.id)) == [Self.a, Self.b])
        // A was already applied the first time; the retry did not fetch it again.
        #expect(fileRequests(r, Self.a) == 1)
    }

    /// The simulator does not enforce data protection, so the OPTIONS handed
    /// to every write are what is asserted (see WidgetSnapshotTests for why
    /// the nibble is compared whole, never with `contains`).
    @Test func filesAreCompleteProtection() async throws {
        let r = rig()
        r.routes.deltas.withLock { $0[0] = Self.delta(cursor: 3, upserts: [Self.doc(Self.a, bytes: Self.bytesA)]) }
        r.routes.files.withLock { $0[Self.a] = Self.pdf(Self.bytesA) }
        r.routes.texts.withLock { $0 = Self.texts([(Self.a, "tekst")]) }
        let seen = Mutex<[(URL, Data.WritingOptions)]>([])
        let store = DossierStore(dir: r.dir) { data, url, options in
            seen.withLock { $0.append((url, options)) }
            try data.write(to: url, options: options)
        }
        try await store.sync(client: r.client)

        let writes = seen.withLock { $0 }
        let names = Set(writes.map { $0.0.lastPathComponent })
        #expect(names.contains(Self.a))                  // the document
        #expect(names.contains("\(Self.a).txt"))         // its text
        #expect(names.contains("state.json"))            // the cursor and the index
        for (url, options) in writes {
            #expect(options.contains(.atomic), "\(url.lastPathComponent)")
            #expect(options.rawValue & 0xF000_0000 == Data.WritingOptions.completeFileProtection.rawValue,
                    "\(url.lastPathComponent)")
        }
        // Rebuildable from the server, so never carried into a backup.
        let values = try r.dir.resourceValues(forKeys: [.isExcludedFromBackupKey])
        #expect(values.isExcludedFromBackup == true)
    }

    @Test func unchangedShaDoesNotRedownload() async throws {
        let r = rig()
        r.routes.deltas.withLock {
            $0[0] = Self.delta(cursor: 2, upserts: [Self.doc(Self.a, title: "Scan 2026-10-30", bytes: Self.bytesA)])
            // A rename travels as an upsert with the same bytes.
            $0[2] = Self.delta(cursor: 4, upserts: [Self.doc(Self.a, title: "Brief Gemeente", bytes: Self.bytesA)])
        }
        r.routes.files.withLock { $0[Self.a] = Self.pdf(Self.bytesA) }
        let store = DossierStore(dir: r.dir)
        try await store.sync(client: r.client)
        try await store.sync(client: r.client)
        #expect(fileRequests(r, Self.a) == 1)
        #expect(await store.documents().map(\.title) == ["Brief Gemeente"])
        #expect(await store.cursor == 4)
    }

    // MARK: - Beside the plan's

    /// The vault is content-addressed: bytes that do not hash to the delta's
    /// sha256 are a broken download, and storing them would make them
    /// permanent (an unchanged sha is never fetched again).
    @Test func bytesThatDoNotMatchTheShaAreRefused() async throws {
        let r = rig()
        r.routes.deltas.withLock { $0[0] = Self.delta(cursor: 3, upserts: [Self.doc(Self.a, bytes: Self.bytesA)]) }
        r.routes.files.withLock { $0[Self.a] = Self.pdf(Data("%PDF-1.4 truncat".utf8)) }
        let store = DossierStore(dir: r.dir)
        await #expect(throws: DossierStore.SyncError.hashMismatch(Self.a)) { try await store.sync(client: r.client) }
        #expect(await store.fileURL(Self.a) == nil)
        #expect(await store.cursor == 0)
    }

    /// Purged between the delta and the download: the file route's 410 is the
    /// same fact as a tombstone.
    @Test func a410FromTheFileRouteDropsTheDocument() async throws {
        let r = rig()
        r.routes.deltas.withLock { $0[0] = Self.delta(cursor: 3, upserts: [Self.doc(Self.a, bytes: Self.bytesA)]) }
        r.routes.files.withLock { $0[Self.a] = .status(410) }
        let store = DossierStore(dir: r.dir)
        try await store.sync(client: r.client)
        #expect(await store.documents().isEmpty)
        #expect(await store.cursor == 3)
    }

    @Test func followsMoreUntilTheLastPage() async throws {
        let r = rig()
        r.routes.deltas.withLock {
            $0[0] = Self.delta(cursor: 3, more: true, upserts: [Self.doc(Self.a, bytes: Self.bytesA)])
            $0[3] = Self.delta(cursor: 8, upserts: [Self.doc(Self.b, bytes: Self.bytesB)])
        }
        r.routes.files.withLock {
            $0[Self.a] = Self.pdf(Self.bytesA)
            $0[Self.b] = Self.pdf(Self.bytesB)
        }
        let store = DossierStore(dir: r.dir)
        try await store.sync(client: r.client)
        #expect(await store.cursor == 8)
        #expect(await store.documents().count == 2)
        let limits = r.server.requests.compactMap { req -> String? in
            guard req.url?.path() == "/api/mobile/v1/documents/sync" else { return nil }
            return req.url?.query()
        }
        #expect(limits == ["cursor=0&limit=50", "cursor=3&limit=50"])
    }

    /// Extraction appends no ledger event, so a document that synced before
    /// its text existed is asked about again on every sync until it has one.
    @Test func textIsAskedForUntilItArrives() async throws {
        let r = rig()
        r.routes.deltas.withLock {
            $0[0] = Self.delta(cursor: 2, upserts: [Self.doc(Self.a, bytes: Self.bytesA, hasText: false),
                                                    Self.doc(Self.b, bytes: Self.bytesB)])
            $0[2] = Self.delta(cursor: 2)
        }
        r.routes.files.withLock {
            $0[Self.a] = Self.pdf(Self.bytesA)
            $0[Self.b] = Self.pdf(Self.bytesB)
        }
        // The server answers more than was asked: only asked-for ids are kept.
        r.routes.texts.withLock { $0 = Self.texts([(Self.b, "tekst b")]) }
        let store = DossierStore(dir: r.dir)
        try await store.sync(client: r.client)
        #expect(await store.text(Self.b) == "tekst b")
        #expect(await store.text(Self.a) == nil)

        r.routes.texts.withLock { $0 = Self.texts([(Self.a, "later gelezen")]) }
        try await store.sync(client: r.client)
        #expect(await store.text(Self.a) == "later gelezen")
        let asked = r.server.requests.filter { $0.url?.path() == "/api/mobile/v1/documents/texts" }
            .compactMap { $0.url?.query(percentEncoded: false) }
        #expect(asked == ["ids=\(Self.a),\(Self.b)", "ids=\(Self.a)"])
    }

    /// The id becomes a file name: anything that is not a UUID never reaches the disk.
    @Test func anIdThatIsNotAUUIDIsIgnored() async throws {
        let r = rig()
        r.routes.deltas.withLock { $0[0] = Self.delta(cursor: 3, upserts: [Self.doc("../state", bytes: Self.bytesA)]) }
        let store = DossierStore(dir: r.dir)
        try await store.sync(client: r.client)
        #expect(await store.documents().isEmpty)
        #expect(r.server.requests.allSatisfy { !($0.url?.path().contains("/file") ?? false) })
    }

    @Test func unauthorizedIsThrown() async throws {
        let r = rig()
        let store = DossierStore(dir: r.dir)
        r.server.on { _ in .status(401) }
        await #expect(throws: APIError.unauthorized) { try await store.sync(client: r.client) }
    }

    @Test func documentsAreNewestFirstAndWipeForgetsEverything() async throws {
        let r = rig()
        let older = Self.doc(Self.b, bytes: Self.bytesB).replacingOccurrences(of: "2026-10-30", with: "2026-06-03")
        r.routes.deltas.withLock { $0[0] = Self.delta(cursor: 3, upserts: [older, Self.doc(Self.a, bytes: Self.bytesA)]) }
        r.routes.files.withLock {
            $0[Self.a] = Self.pdf(Self.bytesA)
            $0[Self.b] = Self.pdf(Self.bytesB)
        }
        let store = DossierStore(dir: r.dir)
        try await store.sync(client: r.client)
        #expect(await store.documents().map(\.id) == [Self.a, Self.b])
        #expect(await store.contentType(Self.a) == "application/pdf")
        #expect(await store.lastSyncedAt != nil)

        await store.wipe()
        #expect(await store.documents().isEmpty)
        #expect(await store.cursor == 0)
        #expect(await DossierStore(dir: r.dir).documents().isEmpty)
    }

    // MARK: - A launch while the phone is locked

    /// What a `.complete` file answers while the phone is locked: a read
    /// error that is NOT "no such file".
    static let lockedError = NSError(domain: NSCocoaErrorDomain, code: CocoaError.fileReadNoPermission.rawValue)

    /// A reader that fails like protected data until `unlocked` is set.
    final class LockableReader: Sendable {
        let unlocked = Mutex(false)
        let attempts = Mutex(0)
        var read: DossierStore.Reader {
            { url in
                self.attempts.withLock { $0 += 1 }
                guard self.unlocked.withLock({ $0 }) else { throw DossierStoreTests.lockedError }
                return try Data(contentsOf: url)
            }
        }
    }

    /// The store is built on every process launch, background ones too. A
    /// read that fails while locked must not become an empty dossier: once
    /// readable, the records and texts are all there, the cursor is kept, and
    /// nothing is downloaded again.
    @Test func aReadThatFailsWhileLockedIsRetriedAndLosesNothing() async throws {
        let r = rig()
        r.routes.deltas.withLock {
            $0[0] = Self.delta(cursor: 5, upserts: [Self.doc(Self.a, bytes: Self.bytesA)])
            $0[5] = Self.delta(cursor: 5)
        }
        r.routes.files.withLock { $0[Self.a] = Self.pdf(Self.bytesA) }
        r.routes.texts.withLock { $0 = Self.texts([(Self.a, "Beschikking")]) }
        try await DossierStore(dir: r.dir).sync(client: r.client)
        let goodState = try Data(contentsOf: DossierStore.stateURL(in: r.dir))

        let lock = LockableReader()
        let store = DossierStore(dir: r.dir, reader: lock.read)
        #expect(lock.attempts.withLock { $0 } == 0)  // nothing read in init
        #expect(await store.load() == false)
        #expect(await store.documents().isEmpty)
        // A sync while unreadable neither asks the server nor writes the state.
        let before = r.server.requests.count
        await #expect(throws: DossierStore.SyncError.unavailable) { try await store.sync(client: r.client) }
        #expect(r.server.requests.count == before)
        #expect(try Data(contentsOf: DossierStore.stateURL(in: r.dir)) == goodState)

        lock.unlocked.withLock { $0 = true }
        #expect(await store.load() == true)
        #expect(await store.documents().map(\.id) == [Self.a])
        #expect(await store.text(Self.a) == "Beschikking")
        #expect(await store.cursor == 5)

        try await store.sync(client: r.client)
        #expect(fileRequests(r, Self.a) == 1)
        let syncs = r.server.requests.filter { $0.url?.path() == "/api/mobile/v1/documents/sync" }
            .compactMap { $0.url?.query() }
        #expect(syncs == ["cursor=0&limit=50", "cursor=5&limit=50"])
    }

    /// A text file that cannot be read is the same lock, not "no text".
    @Test func anUnreadableTextFileKeepsTheStoreUnloaded() async throws {
        let r = rig()
        r.routes.deltas.withLock { $0[0] = Self.delta(cursor: 5, upserts: [Self.doc(Self.a, bytes: Self.bytesA)]) }
        r.routes.files.withLock { $0[Self.a] = Self.pdf(Self.bytesA) }
        r.routes.texts.withLock { $0 = Self.texts([(Self.a, "Beschikking")]) }
        try await DossierStore(dir: r.dir).sync(client: r.client)

        let unlocked = Mutex(false)
        let store = DossierStore(dir: r.dir, reader: { url in
            if url.pathExtension == "txt", !unlocked.withLock({ $0 }) { throw Self.lockedError }
            return try Data(contentsOf: url)
        })
        #expect(await store.load() == false)
        unlocked.withLock { $0 = true }
        #expect(await store.text(Self.a) == "Beschikking")
    }

    /// A first run has no state file at all: that IS an empty dossier.
    @Test func aMissingStateFileIsAFirstRun() async throws {
        let store = DossierStore(dir: Self.tempDir())
        #expect(await store.load() == true)
        #expect(await store.cursor == 0)
    }
}
