import CryptoKit
import Foundation

/// The pocket dossier: every document that is neither discarded nor purged,
/// with its bytes and its extracted text, kept on the phone so it can be shown
/// at a counter with no network (spec §7.4, Plan 3 Task 21).
///
/// WHERE: `Application Support/dossier`, NOT the App Group — no extension
/// reads it, and the widget must never be able to. Every file is written with
/// `.completeFileProtection` (unreadable while the phone is locked), and the
/// folder is excluded from backups: it is rebuilt from the server, and a
/// backup would carry the whole dossier into iCloud.
///
/// WHEN: in the foreground after unlock only (`DossierSyncPolicy`). A silent
/// push never syncs the dossier, because a `.complete` file cannot be written
/// while the phone is locked.
///
/// HOW (`dossierSync.delta`, the server half): ONE cursor, the ledger seq.
/// Each page is applied tombstones first (file, text and index entry
/// deleted), then upserts (bytes downloaded only when `sha256` changed, and
/// checked against it — the vault is content-addressed). THE CURSOR IS SAVED
/// ONLY AFTER THE WHOLE PAGE IS APPLIED: a download that fails keeps what was
/// already applied and the old cursor, so the next sync asks for the same
/// page and skips what it already holds.
///
/// Purge is never offered on the phone. A purge on the web arrives here as a
/// tombstone, and the file route's 410 is read as the same fact.
actor DossierStore {
    typealias Writer = @Sendable (Data, URL, Data.WritingOptions) throws -> Void

    static let syncPath = "/api/mobile/v1/documents/sync"
    static let textsPath = "/api/mobile/v1/documents/texts"
    /// `DOSSIER_PAGE_MAX` / `DOSSIER_TEXTS_MAX` in dossier-sync.ts.
    static let pageSize = 50
    static let textsBatch = 20
    static let writeOptions: Data.WritingOptions = [.atomic, .completeFileProtection]
    static let defaultWriter: Writer = { try $0.write(to: $1, options: $2) }

    enum SyncError: Error, Equatable {
        /// The downloaded bytes do not hash to the delta's sha256.
        case hashMismatch(String)
        /// The state could not be written; nothing was lost on the server.
        case disk(String)
    }

    /// What the phone holds for one document. `contentType` is the file
    /// route's answer, which is what the viewer renders by.
    struct Record: Codable, Equatable, Sendable {
        var doc: DossierDoc
        var contentType: String?
    }

    struct State: Codable, Equatable, Sendable {
        var cursor: Int
        var records: [String: Record]
        var syncedAt: Date?

        static let empty = State(cursor: 0, records: [:], syncedAt: nil)
    }

    let dir: URL
    private let writer: Writer
    private var state: State
    private var texts: [String: String]
    private var syncing = false

    init(dir: URL, writer: @escaping Writer = DossierStore.defaultWriter) {
        self.dir = dir
        self.writer = writer
        let loaded = (try? Data(contentsOf: Self.stateURL(in: dir)))
            .flatMap { try? APIClient.jsonDecoder.decode(State.self, from: $0) } ?? .empty
        state = loaded
        var texts: [String: String] = [:]
        for id in loaded.records.keys {
            if let data = try? Data(contentsOf: Self.textURL(id, in: dir)) {
                texts[id] = String(decoding: data, as: UTF8.self)
            }
        }
        self.texts = texts
    }

    // MARK: - Paths

    static func stateURL(in dir: URL) -> URL { dir.appending(path: "state.json") }
    static func fileURL(_ id: String, in dir: URL) -> URL {
        dir.appending(path: "files", directoryHint: .isDirectory).appending(path: id)
    }
    static func textURL(_ id: String, in dir: URL) -> URL {
        dir.appending(path: "texts", directoryHint: .isDirectory).appending(path: "\(id).txt")
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Reading

    var cursor: Int { state.cursor }
    var lastSyncedAt: Date? { state.syncedAt }

    /// Newest first: the order the tab lists them in.
    func documents() -> [DossierDoc] {
        state.records.values.map(\.doc).sorted { a, b in
            a.receivedAt != b.receivedAt ? a.receivedAt > b.receivedAt : a.id < b.id
        }
    }

    func indexed() -> [IndexedDoc] {
        documents().map { IndexedDoc(doc: $0, text: texts[$0.id]) }
    }

    func text(_ id: String) -> String? { texts[id] }

    func contentType(_ id: String) -> String? { state.records[id]?.contentType }

    /// Nil unless the bytes are on disk.
    func fileURL(_ id: String) -> URL? {
        guard state.records[id] != nil else { return nil }
        let url = Self.fileURL(id, in: dir)
        return FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) ? url : nil
    }

    // MARK: - Sync

    /// Pages through the delta until `more` is false, then asks for the text
    /// of every document that has none yet. A second call while one runs
    /// returns at once: the running one already covers it.
    func sync(client: APIClient) async throws {
        guard !syncing else { return }
        syncing = true
        defer { syncing = false }
        try prepareDirectories()

        while true {
            let delta: DossierDelta = try await client.getJSON(
                "\(Self.syncPath)?cursor=\(state.cursor)&limit=\(Self.pageSize)")
            do {
                try await apply(delta, client: client)
            } catch {
                // Keep what was applied — every step is idempotent — but NOT
                // the cursor: the page is asked for again.
                try? save()
                throw error
            }
            state.cursor = delta.cursor
            state.syncedAt = Date()
            try save()
            if !delta.more { break }
        }
        try await fetchMissingTexts(client: client)
    }

    /// Forgets everything (sign-out). The server is untouched.
    func wipe() {
        try? FileManager.default.removeItem(at: dir)
        state = .empty
        texts = [:]
    }

    private func apply(_ delta: DossierDelta, client: APIClient) async throws {
        for t in delta.tombstones { forget(t.id) }
        for doc in delta.upserts {
            // The id becomes a file name: anything but a UUID never reaches the disk.
            guard UUID(uuidString: doc.id) != nil else { continue }
            if let held = state.records[doc.id], held.doc.sha256 == doc.sha256, fileURL(doc.id) != nil {
                state.records[doc.id]?.doc = doc
                continue
            }
            switch try await download(doc, client: client) {
            case .stored(let contentType):
                if state.records[doc.id]?.doc.sha256 != doc.sha256 { dropText(doc.id) }
                state.records[doc.id] = Record(doc: doc, contentType: contentType)
            case .gone:
                forget(doc.id)
            }
        }
    }

    private enum Download { case stored(contentType: String?), gone }

    private func download(_ doc: DossierDoc, client: APIClient) async throws -> Download {
        let req = client.request("/api/mobile/v1/documents/\(doc.id)/file", method: "GET", body: nil, contentType: nil)
        let data: Data
        let http: HTTPURLResponse
        do {
            (data, http) = try await client.send(req)
        } catch APIError.rejected(let status) where status == 410 || status == 404 {
            // 410: purged since the delta. 404: discarded since, or its bytes
            // are missing from the vault (which /verify reports). Either way
            // the phone holds nothing for it; a later delta says what it is.
            return .gone
        }
        guard Self.sha256Hex(data) == doc.sha256 else { throw SyncError.hashMismatch(doc.id) }
        try write(data, to: Self.fileURL(doc.id, in: dir))
        return .stored(contentType: http.value(forHTTPHeaderField: "Content-Type"))
    }

    private func fetchMissingTexts(client: APIClient) async throws {
        let missing = state.records.keys.filter { texts[$0] == nil }.sorted()
        var start = 0
        while start < missing.count {
            let batch = Array(missing[start..<min(start + Self.textsBatch, missing.count)])
            start += Self.textsBatch
            let rows: [DossierText]
            do {
                rows = try await client.getJSON("\(Self.textsPath)?ids=\(batch.joined(separator: ","))")
            } catch APIError.unauthorized {
                throw APIError.unauthorized
            } catch {
                // The documents are in; their text is asked for again next time.
                return
            }
            let asked = Set(batch)
            for row in rows where asked.contains(row.id) && state.records[row.id] != nil {
                try write(Data(row.text.utf8), to: Self.textURL(row.id, in: dir))
                texts[row.id] = row.text
            }
        }
    }

    private func forget(_ id: String) {
        state.records[id] = nil
        guard UUID(uuidString: id) != nil else { return }
        try? FileManager.default.removeItem(at: Self.fileURL(id, in: dir))
        dropText(id)
    }

    private func dropText(_ id: String) {
        texts[id] = nil
        try? FileManager.default.removeItem(at: Self.textURL(id, in: dir))
    }

    // MARK: - Disk

    private func prepareDirectories() throws {
        let fm = FileManager.default
        let attributes: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.complete]
        do {
            for sub in ["files", "texts"] {
                try fm.createDirectory(at: dir.appending(path: sub, directoryHint: .isDirectory),
                                       withIntermediateDirectories: true, attributes: attributes)
            }
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var url = dir
            try url.setResourceValues(values)
        } catch {
            throw SyncError.disk(String(describing: error))
        }
    }

    private func save() throws {
        let data: Data
        do { data = try APIClient.jsonEncoder.encode(state) } catch { throw SyncError.disk(String(describing: error)) }
        try write(data, to: Self.stateURL(in: dir))
    }

    private func write(_ data: Data, to url: URL) throws {
        do { try writer(data, url, Self.writeOptions) } catch { throw SyncError.disk(String(describing: error)) }
    }
}

/// When the dossier may sync: unlocked AND in the foreground. `.complete`
/// files cannot be written while the phone is locked, so a sync anywhere else
/// would fail half-way, and a silent push never triggers one.
enum DossierSyncPolicy {
    static func maySync(isLocked: Bool, isActive: Bool) -> Bool { !isLocked && isActive }
}
