import Foundation

/// The share extension's ONE foreground attempt at each drop it just wrote.
///
/// Progress belongs to the app's queue (design brief R22), so this is a
/// courtesy, not a delivery mechanism: success writes `<uuid>.sent` so the app
/// records the item as sent instead of sending it again; anything else
/// (offline, not signed in, a slow 4G) leaves the drop for the queue, which
/// knows how to wait and back off. Even a lost answer is safe, because the
/// app's retry carries the same clientId.
enum ShareSender {
    /// Per request. The extension bounds the whole attempt separately.
    static let timeout: TimeInterval = 30

    /// The largest drop the extension sends itself. The request is built in
    /// memory (the bytes, then the multipart body beside them), and an
    /// extension is killed around 120 MB; a larger drop is left to the app's
    /// queue, which streams its body from a file in a background session.
    /// It is also what a 4G upload can plausibly finish inside the bound.
    static let foregroundLimit = 8 * 1024 * 1024

    /// Sends each drop in turn and returns the ids that were marked sent.
    /// A drop over `foregroundLimit` is not attempted (and not read).
    static func send(_ ids: [UUID], groupDir: URL, client: APIClient,
                     foregroundLimit: Int = foregroundLimit) async -> [UUID] {
        var sent: [UUID] = []
        for id in ids {
            guard !Task.isCancelled else { break }
            if await sendOne(id, groupDir: groupDir, client: client, foregroundLimit: foregroundLimit) == .sent {
                sent.append(id)
            }
        }
        return sent
    }

    /// One drop, and WHY it did not go when it did not: the share screen
    /// names the reason ("offline · in wachtrij", "groot bestand · in
    /// wachtrij", "log in") instead of one line for every failure.
    static func sendOne(_ id: UUID, groupDir: URL, client: APIClient,
                        foregroundLimit: Int = foregroundLimit) async -> ShareSendResult {
        let dir = IncomingDrop.directory(groupDir: groupDir)
        guard let size = ShareStaging.byteCount(IncomingDrop.binURL(id, in: dir)) else { return .failed }
        guard size <= foregroundLimit else { return .tooLargeForExtension }
        guard let drop = IncomingDrop.read(IncomingDrop.jsonURL(id, in: dir)),
              let bytes = try? Data(contentsOf: IncomingDrop.binURL(id, in: dir))
        else { return .failed }
        let item = UploadItem(id: drop.id, fileName: drop.fileName, capturedAt: drop.capturedAt,
                              source: IncomingDrop.source, state: .sending, attempts: 0,
                              nextAttemptAt: nil, sentAt: nil, mime: drop.mime, fileExtension: drop.fileExtension)
        var (req, body) = UploadRequest.build(item, file: bytes, client: client)
        req.httpBody = body
        req.timeoutInterval = timeout
        do {
            let (data, _) = try await client.send(req)
            guard (try? JSONDecoder().decode(UploadResponse.self, from: data)) != nil else { return .failed }
            try IncomingDrop.markSent(id, groupDir: groupDir)
            return .sent
        } catch {
            return ShareSendResult(error)
        }
    }
}

/// How the extension's own attempt at one drop ended. Every case but `.sent`
/// leaves the drop for the app's queue.
enum ShareSendResult: Equatable, Sendable {
    case sent
    /// Over `ShareSender.foregroundLimit`: not tried here at all.
    case tooLargeForExtension
    /// 401 or any 3xx: no session, or an expired one.
    case unauthorized
    /// No network at all (not a slow one: that is `.failed`).
    case offline
    case failed

    init(_ error: any Error) {
        switch error as? APIError {
        case .unauthorized: self = .unauthorized
        case .transport(let what) where Self.offlineCodes.contains(where: {
            what == APIError.transportDescription(URLError($0))
        }): self = .offline
        default: self = .failed
        }
    }

    /// The URLErrors that mean "this phone has no connection", as opposed to
    /// a server that is slow or unreachable.
    static let offlineCodes: [URLError.Code] = [
        .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff,
    ]
}
