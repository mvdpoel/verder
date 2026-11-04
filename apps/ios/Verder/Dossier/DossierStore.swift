import CryptoKit
import Foundation
import PDFKit

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
/// ONE BAD DOCUMENT NEVER STALLS THE CURSOR: a download that will not get
/// better by asking for the same page again — bytes that do not hash to the
/// delta's sha256 (a `file-hash-mismatch`, which /verify exists to report) or
/// a 5xx from the file route — makes that document NOT HELD: its id goes in
/// the persisted `notHeld` set, the rest of the page is applied and the
/// cursor moves on. Otherwise every later document AND every later tombstone
/// would never arrive, and a web purge would never leave the phone (spec §9).
/// The set is retried after paging on every sync and its size is shown.
/// Only failures that say nothing about the document (offline, 401, 429, a
/// cancelled task) still stop the sync with the old cursor.
///
/// LOADED LAZILY, NEVER IN `init`: the app builds this store on every
/// process launch, background launches included (the badge push, the
/// background upload relaunch, an answer button), and while the phone is
/// locked a `.complete` file cannot be read. A read that FAILS is therefore
/// not an empty dossier: the store stays unloaded and tries again on the next
/// use (the tab's `.task`, a foreground refresh, or
/// `protectedDataDidBecomeAvailable`). Only a MISSING state file is a real
/// first run. Nothing is saved before a successful load, so a locked launch
/// can never write a cursor-0 state over a good one.
///
/// Purge is never offered on the phone. A purge on the web arrives here as a
/// tombstone, and the file route's 410 is read as the same fact.
actor DossierStore {
    typealias Writer = @Sendable (Data, URL, Data.WritingOptions) throws -> Void
    typealias Reader = @Sendable (URL) throws -> Data

    static let syncPath = "/api/mobile/v1/documents/sync"
    static let textsPath = "/api/mobile/v1/documents/texts"
    /// `DOSSIER_PAGE_MAX` / `DOSSIER_TEXTS_MAX` in dossier-sync.ts.
    static let pageSize = 50
    static let textsBatch = 20
    static let writeOptions: Data.WritingOptions = [.atomic, .completeFileProtection]
    static let defaultWriter: Writer = { try $0.write(to: $1, options: $2) }
    static let defaultReader: Reader = { try Data(contentsOf: $0) }

    enum SyncError: Error, Equatable {
        /// The state could not be written; nothing was lost on the server.
        case disk(String)
        /// The phone's copy could not be read yet (protected data is
        /// unavailable while locked). Nothing was synced or written.
        case unavailable
        /// `wipe()` ran while this sync waited on the network (the actor is
        /// reentrant): it stopped and wrote nothing after the wipe.
        case wiped
    }

    /// What the phone holds for one document. `contentType` is the file
    /// route's answer, which is what the viewer renders by.
    struct Record: Codable, Equatable, Sendable {
        var doc: DossierDoc
        var contentType: String?
        /// A PDF's page count, read once when its bytes are stored ("2 blz").
        var pages: Int? = nil
    }

    /// How far the running sync is, for the tab to show while it runs: the
    /// first sync's "5 van 12 documenten", a later one's "2 van 3 nieuw".
    struct Progress: Equatable, Sendable {
        /// Documents this sync has to download, over the pages seen so far.
        var due = 0
        /// Of those, taken in (stored, gone or not held: each is settled).
        var done = 0
        /// Another page follows: `due` is not the end of it.
        var more = false
        /// The whole dossier, when the delta says (`DossierDelta.total`).
        var total: Int?
        var totalBytes: Int?
    }
    typealias ProgressSink = @Sendable (Progress) async -> Void

    struct State: Codable, Equatable, Sendable {
        var cursor: Int
        var records: [String: Record]
        var syncedAt: Date?
        /// Named by a delta, not on the phone: its download failed in a way a
        /// retry of the page would not fix. Retried on every sync; a
        /// tombstone removes it.
        var notHeld: [String: DossierDoc]

        static let empty = State(cursor: 0, records: [:], syncedAt: nil, notHeld: [:])

        init(cursor: Int, records: [String: Record], syncedAt: Date?, notHeld: [String: DossierDoc] = [:]) {
            self.cursor = cursor
            self.records = records
            self.syncedAt = syncedAt
            self.notHeld = notHeld
        }

        /// A state written before `notHeld` existed still decodes: falling
        /// back to `.empty` would throw the whole dossier away.
        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            cursor = try c.decode(Int.self, forKey: .cursor)
            records = try c.decode([String: Record].self, forKey: .records)
            syncedAt = try c.decodeIfPresent(Date.self, forKey: .syncedAt)
            notHeld = try c.decodeIfPresent([String: DossierDoc].self, forKey: .notHeld) ?? [:]
        }
    }

    let dir: URL
    private let reader: Reader
    private let writer: Writer
    private var state: State = .empty
    private var texts: [String: String] = [:]
    /// False until the disk copy has been read successfully (or found absent).
    private var isLoaded = false
    private var syncing = false
    /// Bumped by every `wipe()`. The actor is reentrant: a wipe runs while a
    /// sync waits on the network, so a sync captures this before its first
    /// await and checks it after every await (`ensureLive`), and every write
    /// checks it too — otherwise it resumes and writes the old session's page
    /// into the wiped store (the app-wide rule is `SessionEpoch`).
    private var wipes = 0

    /// `writer` first: a single trailing closure in the tests is the writer.
    init(dir: URL, writer: @escaping Writer = DossierStore.defaultWriter,
         reader: @escaping Reader = DossierStore.defaultReader,
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.dir = dir
        self.reader = reader
        self.writer = writer
        self.now = now
    }
    /// The case's clock (`AppServices.now`): stamps "bijgewerkt".
    private let now: @Sendable () -> Date

    /// Reads the disk copy once. True when the store is loaded (now or
    /// before); false when a read failed for any reason other than the file
    /// being absent — then nothing is assumed and the next call tries again.
    @discardableResult
    func load() -> Bool {
        if isLoaded { return true }
        let loaded: State
        do {
            let data = try reader(Self.stateURL(in: dir))
            // A file that reads but does not decode is not a locked file: it
            // is corrupt, and starting over is the only way forward.
            loaded = (try? APIClient.jsonDecoder.decode(State.self, from: data)) ?? .empty
        } catch where Self.isMissing(error) {
            loaded = .empty
        } catch {
            return false
        }
        var texts: [String: String] = [:]
        for id in loaded.records.keys {
            do {
                texts[id] = String(decoding: try reader(Self.textURL(id, in: dir)), as: UTF8.self)
            } catch where Self.isMissing(error) {
                continue  // no text yet: asked for on the next sync
            } catch {
                return false
            }
        }
        state = loaded
        self.texts = texts
        isLoaded = true
        return true
    }

    /// Absent, as opposed to unreadable.
    static func isMissing(_ error: any Error) -> Bool {
        let ns = error as NSError
        if ns.domain == NSCocoaErrorDomain,
           ns.code == CocoaError.fileReadNoSuchFile.rawValue || ns.code == CocoaError.fileNoSuchFile.rawValue {
            return true
        }
        if ns.domain == NSPOSIXErrorDomain, ns.code == Int(ENOENT) { return true }
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError,
           underlying.domain == NSPOSIXErrorDomain, underlying.code == Int(ENOENT) {
            return true
        }
        return false
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

    var cursor: Int { load(); return state.cursor }
    var lastSyncedAt: Date? { load(); return state.syncedAt }

    /// Newest first: the order the tab lists them in. Empty while the disk
    /// copy cannot be read yet (`load()` says which).
    func documents() -> [DossierDoc] {
        load()
        return state.records.values.map(\.doc).sorted { a, b in
            a.receivedAt != b.receivedAt ? a.receivedAt > b.receivedAt : a.id < b.id
        }
    }

    func indexed() -> [IndexedDoc] {
        documents().map { IndexedDoc(doc: $0, text: texts[$0.id], pages: pages($0.id)) }
    }

    /// A held PDF's pages. A record stored before pages were counted is
    /// counted on first ask and remembered (saved with the next sync).
    private func pages(_ id: String) -> Int? {
        guard let record = state.records[id] else { return nil }
        if let n = record.pages { return n }
        guard ViewerKind(contentType: record.contentType) == .pdf, let url = fileURL(id),
              let n = PDFDocument(url: url)?.pageCount, n > 0 else { return nil }
        state.records[id]?.pages = n
        return n
    }

    func text(_ id: String) -> String? { load(); return texts[id] }

    func contentType(_ id: String) -> String? { load(); return state.records[id]?.contentType }

    /// Documents the server lists that the phone could not take in (see
    /// `State.notHeld`), sorted by id.
    func notHeld() -> [DossierDoc] {
        load()
        return state.notHeld.values.sorted { $0.id < $1.id }
    }

    /// Nil unless the bytes are on disk.
    func fileURL(_ id: String) -> URL? {
        load()
        guard state.records[id] != nil else { return nil }
        let url = Self.fileURL(id, in: dir)
        return FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) ? url : nil
    }

    // MARK: - Sync

    /// Pages through the delta until `more` is false, then asks for the text
    /// of every document that has none yet. A second call while one runs
    /// returns at once: the running one already covers it.
    func sync(client: APIClient, progress: ProgressSink? = nil) async throws {
        guard !syncing else { return }
        // Never sync, and above all never save, over a copy not yet read.
        guard load() else { throw SyncError.unavailable }
        let gen = wipes
        syncing = true
        triedThisSync = []
        sink = progress
        running = Progress()
        // A wipe already reset both for whatever runs next.
        defer { if gen == wipes { syncing = false; sink = nil } }
        try prepareDirectories()

        while true {
            let delta: DossierDelta = try await client.getJSON(
                "\(Self.syncPath)?cursor=\(state.cursor)&limit=\(Self.pageSize)")
            try ensureLive(gen)
            running.due += delta.upserts.filter { !isCurrent($0) }.count
            running.more = delta.more
            running.total = delta.total ?? running.total
            running.totalBytes = delta.totalBytes ?? running.totalBytes
            await report()
            do {
                try await apply(delta, client: client, gen: gen)
            } catch {
                // Keep what was applied — every step is idempotent — but NOT
                // the cursor: the page is asked for again. (After a wipe
                // `save` refuses: there is nothing to keep.)
                try? save(gen)
                throw error
            }
            state.cursor = delta.cursor
            state.syncedAt = now()
            try save(gen)
            if !delta.more { break }
        }
        try await retryNotHeld(client: client, gen: gen)
        try await fetchMissingTexts(client: client, gen: gen)
    }

    /// Forgets everything (sign-out). The server is untouched. A sync
    /// waiting on the network meanwhile stops with `.wiped` when it resumes.
    func wipe() {
        wipes += 1
        try? FileManager.default.removeItem(at: dir)
        state = .empty
        texts = [:]
        isLoaded = true
        triedThisSync = []
        syncing = false
    }

    /// The sink the running sync reports to, and what it last said.
    private var sink: ProgressSink?
    private var running = Progress()

    private func report() async {
        guard let sink else { return }
        await sink(running)
    }

    /// Held with this exact content: nothing to download.
    private func isCurrent(_ doc: DossierDoc) -> Bool {
        guard let held = state.records[doc.id] else { return false }
        return held.doc.sha256 == doc.sha256 && fileURL(doc.id) != nil
    }

    /// "Haal nu op": takes ONE document in outside the delta — a server hit,
    /// a link, a document the sync could not take — checked against its sha
    /// and written like every other download, so it opens offline next
    /// time. True when it is on the phone afterwards. The cursor is untouched:
    /// the next delta still names it, and finds it held.
    func take(_ doc: DossierDoc, client: APIClient) async throws -> Bool {
        guard load() else { throw SyncError.unavailable }
        guard UUID(uuidString: doc.id) != nil else { return false }
        if isCurrent(doc) { return true }
        let gen = wipes
        try prepareDirectories()
        try await take(doc, client: client, gen: gen)
        try save(gen)
        return fileURL(doc.id) != nil
    }

    private func ensureLive(_ gen: Int) throws {
        if gen != wipes { throw SyncError.wiped }
    }

    /// Ids whose download was attempted in the running sync, so a document
    /// that just failed on its page is not asked for twice in one go.
    private var triedThisSync: Set<String> = []

    private func apply(_ delta: DossierDelta, client: APIClient, gen: Int) async throws {
        for t in delta.tombstones { forget(t.id) }
        for doc in delta.upserts {
            // The id becomes a file name: anything but a UUID never reaches the disk.
            guard UUID(uuidString: doc.id) != nil else { continue }
            if isCurrent(doc) {
                state.records[doc.id]?.doc = doc
                state.notHeld[doc.id] = nil
                continue
            }
            try await take(doc, client: client, gen: gen)
            running.done += 1
            await report()
        }
    }

    /// Downloads one document and records what came of it.
    private func take(_ doc: DossierDoc, client: APIClient, gen: Int) async throws {
        triedThisSync.insert(doc.id)
        let outcome = try await download(doc, client: client, gen: gen)
        try ensureLive(gen)
        switch outcome {
        case .stored(let contentType, let pages):
            if state.records[doc.id]?.doc.sha256 != doc.sha256 { dropText(doc.id) }
            state.records[doc.id] = Record(doc: doc, contentType: contentType, pages: pages)
            state.notHeld[doc.id] = nil
        case .gone:
            forget(doc.id)
        case .notHeld:
            // An older version already on the phone stays readable; the new
            // one is asked for again on the next sync.
            state.notHeld[doc.id] = doc
        }
    }

    /// After paging: one more try for every document not held, except those
    /// this sync already tried. Anything that is not about the document
    /// itself (offline, 401) stops the retries; the cursor is already safe.
    private func retryNotHeld(client: APIClient, gen: Int) async throws {
        defer { if gen == wipes { triedThisSync = [] } }
        let due = state.notHeld.values.filter { !triedThisSync.contains($0.id) }.sorted { $0.id < $1.id }
        guard !due.isEmpty else { return }
        do {
            for doc in due { try await take(doc, client: client, gen: gen) }
        } catch SyncError.wiped {
            throw SyncError.wiped
        } catch APIError.unauthorized {
            try? save(gen)
            throw APIError.unauthorized
        } catch {
            try? save(gen)
            if APIError.isCancellation(error) { throw error }
            return
        }
        try save(gen)
    }

    private enum Download { case stored(contentType: String?, pages: Int?), gone, notHeld }

    private func download(_ doc: DossierDoc, client: APIClient, gen: Int) async throws -> Download {
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
        } catch APIError.server {
            // About this document, not the network: asking for the page
            // again would only fail in the same place.
            return .notHeld
        }
        // Bytes that do not hash to the sha are a broken download or a
        // tampered vault; storing them would make them permanent.
        guard Self.sha256Hex(data) == doc.sha256 else { return .notHeld }
        try write(data, to: Self.fileURL(doc.id, in: dir), gen: gen)
        let type = http.value(forHTTPHeaderField: "Content-Type")
        let pages = ViewerKind(contentType: type) == .pdf ? PDFDocument(data: data)?.pageCount : nil
        return .stored(contentType: type, pages: pages)
    }

    private func fetchMissingTexts(client: APIClient, gen: Int) async throws {
        let missing = state.records.keys.filter { texts[$0] == nil }.sorted()
        var start = 0
        while start < missing.count {
            let batch = Array(missing[start..<min(start + Self.textsBatch, missing.count)])
            start += Self.textsBatch
            let rows: [DossierText]
            do {
                rows = try await client.getJSON("\(Self.textsPath)?ids=\(batch.joined(separator: ","))")
            } catch APIError.unauthorized {
                try ensureLive(gen)
                throw APIError.unauthorized
            } catch {
                try ensureLive(gen)
                // The documents are in; their text is asked for again next time.
                return
            }
            try ensureLive(gen)
            let asked = Set(batch)
            for row in rows where asked.contains(row.id) && state.records[row.id] != nil {
                try write(Data(row.text.utf8), to: Self.textURL(row.id, in: dir), gen: gen)
                texts[row.id] = row.text
            }
        }
    }

    private func forget(_ id: String) {
        state.records[id] = nil
        state.notHeld[id] = nil
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

    private func save(_ gen: Int) throws {
        try ensureLive(gen)
        let data: Data
        do { data = try APIClient.jsonEncoder.encode(state) } catch { throw SyncError.disk(String(describing: error)) }
        try write(data, to: Self.stateURL(in: dir), gen: gen)
    }

    /// Refuses after a wipe: nothing of the old session reaches the disk.
    private func write(_ data: Data, to url: URL, gen: Int) throws {
        try ensureLive(gen)
        do { try writer(data, url, Self.writeOptions) } catch { throw SyncError.disk(String(describing: error)) }
    }
}

/// When the dossier may sync: unlocked AND in the foreground. `.complete`
/// files cannot be written while the phone is locked, so a sync anywhere else
/// would fail half-way, and a silent push never triggers one.
enum DossierSyncPolicy {
    static func maySync(isLocked: Bool, isActive: Bool) -> Bool { !isLocked && isActive }
}
