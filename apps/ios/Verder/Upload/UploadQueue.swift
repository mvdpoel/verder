import Foundation

/// One capture waiting to reach verder, or that has.
///
/// `id` IS the upload's `clientId`: the server stores it as
/// `sourceRef = "phone:<clientId>"` and answers a second upload with the same
/// id as a duplicate, so a retry after a lost response can never ingest the
/// letter twice (Review Focus 1). It is therefore minted once, at enqueue, and
/// never changes — not on retry, not on a manual "opnieuw".
struct UploadItem: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    let fileName: String
    let capturedAt: Date
    let source: String
    var state: State
    var attempts: Int
    var nextAttemptAt: Date?
    /// When the server confirmed it. Added beside the plan's fields for the
    /// strip's "verstuurd vandaag" and for pruning.
    var sentAt: Date?

    enum State: String, Codable, Sendable {
        case pending, sending, sent, failed
    }

    /// The form value: lower-case, as the server spells it in `sourceRef`.
    var clientId: String { id.uuidString.lowercased() }
}

/// The durable upload queue: `queue.json` plus `<id>.pdf` in one directory
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

    nonisolated func pdfURL(_ id: UUID) -> URL { dir.appending(path: "\(id.uuidString).pdf") }

    /// Where the uploader writes an item's multipart body for the duration of
    /// one upload (a background upload needs a file, not bytes in memory).
    nonisolated func bodyURL(_ id: UUID) -> URL { dir.appending(path: "\(id.uuidString).body") }

    @discardableResult
    func enqueue(pdf: Data, capturedAt: Date, source: String) throws -> UploadItem {
        let item = UploadItem(id: UUID(), fileName: ScanNaming.title(capturedAt: capturedAt), capturedAt: capturedAt,
                              source: source, state: .pending, attempts: 0, nextAttemptAt: nil, sentAt: nil)
        // The PDF first: an index entry pointing at no file is worse than a
        // file no entry points at.
        try pdf.write(to: pdfURL(item.id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        index.items.append(item)
        try persist()
        return item
    }

    /// Every pending item that is due, flipped to `sending` in the same step,
    /// so two drains at once can never send one item twice. Nothing while a
    /// sign-in is required. An item whose PDF is gone is marked `failed`
    /// rather than dropped: a scan must never vanish without a word.
    func claimDue(now: Date) -> [UploadItem] {
        guard !index.signInRequired else { return [] }
        var claimed: [UploadItem] = []
        for i in index.items.indices where index.items[i].state == .pending
            && (index.items[i].nextAttemptAt ?? .distantPast) <= now {
            if FileManager.default.fileExists(atPath: pdfURL(index.items[i].id).path()) {
                index.items[i].state = .sending
                claimed.append(index.items[i])
            } else {
                index.items[i].state = .failed
            }
        }
        try? persist()
        return claimed
    }

    func markSent(_ id: UUID, now: Date = Date()) {
        guard let i = index.items.firstIndex(where: { $0.id == id }) else { return }
        index.items[i].state = .sent
        index.items[i].sentAt = now
        index.items[i].nextAttemptAt = nil
        try? persist()
        try? FileManager.default.removeItem(at: pdfURL(id))
    }

    func markFailure(_ id: UUID, error: APIError, now: Date = Date()) {
        guard let i = index.items.firstIndex(where: { $0.id == id }) else { return }
        switch error {
        case .unauthorized:
            index.items[i].state = .pending
            index.items[i].nextAttemptAt = nil
            index.signInRequired = true
        case .rejected:
            index.items[i].attempts += 1
            index.items[i].state = .failed
            index.items[i].nextAttemptAt = nil
        case .server, .rateLimited, .transport:
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
