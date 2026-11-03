import Foundation

/// The durable upload queue: `queue.json` plus `<id>.<ext>` in one directory
/// (the App Group container on the phone). The files ARE the queue — the
/// actor only serialises access — so a killed app or a rebooted phone loses
/// nothing that was enqueued (Review Focus 3).
///
/// The rules:
/// - `401` (or any redirect) is not the item's fault: it stays `pending`, costs
///   no attempt, and `signInRequired` stops ALL sending until Martin signs in,
///   because every send before that would be another 401 (Review Focus 2).
/// - `5xx`, `429` and transport failures back off 30 s, 2 min, 10 min, 1 h, 1 h;
///   the fifth failure marks the item `failed`.
/// - Any other `4xx` fails at once: the server refused these bytes and will
///   refuse them again.
/// - `failed` is never final: `retry` sends it again from a clean slate.
actor UploadQueue {
    static let maxAttempts = 5
    /// Sent items stay listed this long (the strip counts today's), then go.
    static let keepSent: TimeInterval = 7 * 86_400

    let dir: URL
    private var index: Index

    private struct Index: Codable {
        var items: [UploadItem] = []
        var signInRequired = false
        /// Whether anything was ever enqueued on this phone: the Scan tab's
        /// "Nog geen scans" must not come back once sent items are pruned.
        /// Optional, so a queue.json from before it decodes (nil = look at
        /// the items).
        var everEnqueued: Bool? = nil
    }

    init(dir: URL, now: Date = Date()) {
        self.dir = dir
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var loaded = (try? Data(contentsOf: dir.appending(path: "queue.json")))
            .flatMap { try? JSONDecoder.queue.decode(Index.self, from: $0) } ?? Index()
        loaded.items.removeAll { $0.state == .sent && ($0.sentAt ?? .distantPast) < now - Self.keepSent }
        self.index = loaded
    }

    static func backoff(attempt: Int) -> TimeInterval {
        switch attempt {
        case ...1: 30
        case 2: 120
        case 3: 600
        default: 3600
        }
    }

    var signInRequired: Bool { index.signInRequired }

    func items() -> [UploadItem] { index.items }

    /// False only on a phone that never queued a scan or a share.
    var everEnqueued: Bool { index.everEnqueued ?? !index.items.isEmpty }

    /// Where an item's bytes live: `<id>.<resolvedExtension>`. An item from
    /// before the share extension has no extension recorded and is a PDF.
    nonisolated func fileURL(_ item: UploadItem) -> URL {
        dir.appending(path: "\(item.id.uuidString).\(item.resolvedExtension)")
    }

    /// `fileURL` of an item stored without an extension: a scan's PDF.
    nonisolated func pdfURL(_ id: UUID) -> URL { dir.appending(path: "\(id.uuidString).pdf") }

    /// Where the uploader writes an item's multipart body for the duration of
    /// one upload (a background upload needs a file, not bytes in memory).
    nonisolated func bodyURL(_ id: UUID) -> URL { dir.appending(path: "\(id.uuidString).body") }

    /// A scan: always a PDF, named by the Amsterdam clock.
    @discardableResult
    func enqueue(pdf: Data, capturedAt: Date, source: String, pages: Int? = nil) throws -> UploadItem {
        try enqueue(file: pdf, fileName: ScanNaming.title(capturedAt: capturedAt), mime: "application/pdf",
                    fileExtension: "pdf", capturedAt: capturedAt, source: source, pages: pages)
    }

    /// Any file. `id` is what lets a share's drop UUID become the clientId.
    /// If an item with that `id` is already queued, it is returned and NOTHING
    /// is written — not even the file, which may have been sent and deleted
    /// already. That is what makes `importIncoming` safe to repeat.
    @discardableResult
    func enqueue(file: Data, id: UUID = UUID(), fileName: String, mime: String, fileExtension: String,
                 capturedAt: Date, source: String, pages: Int? = nil) throws -> UploadItem {
        if let existing = index.items.first(where: { $0.id == id }) { return existing }
        let item = UploadItem(id: id, fileName: fileName, capturedAt: capturedAt, source: source,
                              state: .pending, attempts: 0, nextAttemptAt: nil, sentAt: nil,
                              mime: mime, fileExtension: UploadItem.safeExtension(fileExtension) ?? "bin",
                              pages: pages, byteCount: file.count)
        // The file first: an index entry pointing at no file is worse than a
        // file no entry points at.
        try file.write(to: fileURL(item), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        index.items.append(item)
        index.everEnqueued = true
        try persist()
        return item
    }

    /// Every pending item that is due, flipped to `sending` in the same step,
    /// so two drains at once can never send one item twice. Nothing while a
    /// sign-in is required. An item whose file is gone is marked `failed`
    /// rather than dropped: a scan must never vanish without a word.
    func claimDue(now: Date) -> [UploadItem] {
        guard !index.signInRequired else { return [] }
        var claimed: [UploadItem] = []
        for i in index.items.indices where index.items[i].state == .pending
            && (index.items[i].nextAttemptAt ?? .distantPast) <= now {
            if FileManager.default.fileExists(atPath: fileURL(index.items[i]).path()) {
                index.items[i].state = .sending
                claimed.append(index.items[i])
            } else {
                index.items[i].state = .failed
                index.items[i].failure = .missingFile
            }
        }
        try? persist()
        return claimed
    }

    func markSent(_ id: UUID, documentId: String? = nil, now: Date = Date()) {
        guard let i = index.items.firstIndex(where: { $0.id == id }) else { return }
        index.items[i].state = .sent
        index.items[i].sentAt = now
        index.items[i].nextAttemptAt = nil
        index.items[i].failure = nil
        if let documentId { index.items[i].documentId = documentId }
        try? persist()
        try? FileManager.default.removeItem(at: fileURL(index.items[i]))
    }

    func markFailure(_ id: UUID, error: APIError, now: Date = Date()) {
        guard let i = index.items.firstIndex(where: { $0.id == id }) else { return }
        switch error {
        case .unauthorized:
            index.items[i].state = .pending
            index.items[i].nextAttemptAt = nil
            index.signInRequired = true
        case .rejected:
            index.items[i].failure = .refused
            index.items[i].attempts += 1
            index.items[i].state = .failed
            index.items[i].nextAttemptAt = nil
        case .server, .rateLimited, .transport:
            index.items[i].failure = .noAnswer
            index.items[i].attempts += 1
            let n = index.items[i].attempts
            if n >= Self.maxAttempts {
                index.items[i].state = .failed
                index.items[i].nextAttemptAt = nil
            } else {
                index.items[i].state = .pending
                index.items[i].nextAttemptAt = now + Self.backoff(attempt: n)
            }
        }
        try? persist()
    }

    /// Martin's "opnieuw": a failed item goes back to pending, from attempt 0.
    func retry(_ id: UUID) {
        guard let i = index.items.firstIndex(where: { $0.id == id }), index.items[i].state == .failed else { return }
        index.items[i].state = .pending
        index.items[i].attempts = 0
        index.items[i].nextAttemptAt = nil
        try? persist()
    }

    /// "Iets bijzonders?": Martin's note on one capture, kept with it on the
    /// phone and sent along as a `note` field. Blank clears it. Not on a sent
    /// item: its upload has already gone.
    func setNote(_ id: UUID, _ note: String?) {
        guard let i = index.items.firstIndex(where: { $0.id == id }), index.items[i].state != .sent else { return }
        let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        index.items[i].note = trimmed.isEmpty ? nil : trimmed
        try? persist()
    }

    /// The row menu's "Verwijder": a scan Martin decided not to send. Only
    /// one that is not on its way right now (`sending` belongs to the
    /// uploader) and not sent (a sent one is already in the dossier, where
    /// this queue cannot reach). The entry goes first, then the file.
    @discardableResult
    func remove(_ id: UUID) -> Bool {
        guard let i = index.items.firstIndex(where: { $0.id == id }),
              index.items[i].state == .pending || index.items[i].state == .failed else { return false }
        let item = index.items.remove(at: i)
        try? persist()
        try? FileManager.default.removeItem(at: fileURL(item))
        return true
    }

    func retryAllFailed() {
        for item in index.items where item.state == .failed { retry(item.id) }
    }

    /// After a sign-in: sending may start again.
    func clearSignInRequired() {
        guard index.signInRequired else { return }
        index.signInRequired = false
        try? persist()
    }

    /// On launch: an item left `sending` by a killed process goes back to
    /// pending unless the upload session still owns a task for it.
    func resetSending(except live: Set<UUID>) {
        var changed = false
        for i in index.items.indices where index.items[i].state == .sending && !live.contains(index.items[i].id) {
            index.items[i].state = .pending
            changed = true
        }
        if changed { try? persist() }
    }

    private func persist() throws {
        let data = try JSONEncoder.queue.encode(index)
        try data.write(to: dir.appending(path: "queue.json"),
                       options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

private extension JSONEncoder {
    static var queue: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = .sortedKeys
        return e
    }
}

private extension JSONDecoder {
    static var queue: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}

/// The strip under the camera, as counts: "1 wordt verstuurd · 3 verstuurd
/// vandaag · 1 mislukt". Pending and sending read the same to Martin — both
/// are "on its way". "Vandaag" is the Amsterdam calendar day.
struct QueueSummary: Equatable {
    var underway: Int
    var sentToday: Int
    var failed: Int

    init(items: [UploadItem], now: Date) {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
        underway = items.count { $0.state == .pending || $0.state == .sending }
        sentToday = items.count { $0.state == .sent && $0.sentAt.map { cal.isDate($0, inSameDayAs: now) } == true }
        failed = items.count { $0.state == .failed }
    }

    var parts: [String] {
        var out: [String] = []
        if underway > 0 { out.append("\(underway) \(underway == 1 ? "wordt" : "worden") verstuurd") }
        if sentToday > 0 { out.append("\(sentToday) verstuurd vandaag") }
        if failed > 0 { out.append("\(failed) mislukt") }
        return out
    }

    var isEmpty: Bool { parts.isEmpty }
}
