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

    /// Sends each drop in turn and returns the ids that were marked sent.
    static func send(_ ids: [UUID], groupDir: URL, client: APIClient) async -> [UUID] {
        let dir = IncomingDrop.directory(groupDir: groupDir)
        var sent: [UUID] = []
        for id in ids {
            guard !Task.isCancelled,
                  let drop = IncomingDrop.read(IncomingDrop.jsonURL(id, in: dir)),
                  let bytes = try? Data(contentsOf: IncomingDrop.binURL(id, in: dir))
            else { continue }
            let item = UploadItem(id: drop.id, fileName: drop.fileName, capturedAt: drop.capturedAt,
                                  source: IncomingDrop.source, state: .sending, attempts: 0,
                                  nextAttemptAt: nil, sentAt: nil, mime: drop.mime, fileExtension: drop.fileExtension)
            var (req, body) = UploadRequest.build(item, file: bytes, client: client)
            req.httpBody = body
            req.timeoutInterval = timeout
            do {
                let (data, _) = try await client.send(req)
                guard (try? JSONDecoder().decode(UploadResponse.self, from: data)) != nil else { continue }
                try IncomingDrop.markSent(id, groupDir: groupDir)
                sent.append(id)
            } catch {
                continue
            }
        }
        return sent
    }
}
