import Foundation

/// The app's half of the share hand-off (`IncomingDrop`): every complete drop
/// in `<queue dir>/incoming/` becomes a queue item whose id IS the drop's UUID,
/// so the extension's own upload attempt and the queue's can never make two
/// documents (`phone:<clientId>` answers the second one `duplicate: true`).
extension UploadQueue {
    /// A `.bin` or `.sent` with no `.json` beside it is either a drop the
    /// extension is still writing or the leftover of a crash mid-cleanup. Only
    /// its age tells the two apart.
    static let orphanAge: TimeInterval = 86_400

    /// `<group>/uploads/incoming`, the same folder `IncomingDrop.directory(groupDir:)`
    /// names, because the queue lives in `<group>/uploads`.
    nonisolated var incomingDir: URL { dir.appending(path: "incoming", directoryHint: .isDirectory) }

    /// Imports every complete drop, oldest first, and returns the items.
    ///
    /// Idempotent: a drop imported before a crash and imported again is the
    /// same queue item (`enqueue` returns an id it already holds and writes
    /// nothing). Cleanup deletes `<uuid>.json` FIRST, so the drop is invisible
    /// before its bytes go; a crash in between leaves an orphan `.bin`, swept
    /// once it is older than `orphanAge`.
    ///
    /// A drop the extension already delivered (`<uuid>.sent`) is recorded as
    /// sent instead of being uploaded again. The extension writes that marker
    /// only after a 2xx carrying the endpoint's answer, from a client that
    /// never follows a redirect, so it means what the queue's own `markSent`
    /// means.
    @discardableResult
    func importIncoming(now: Date = Date()) -> [UploadItem] {
        let fm = FileManager.default
        let dir = incomingDir
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path()) else { return [] }

        var drops: [IncomingDrop] = []
        var unreadable: [URL] = []
        for name in names where name.hasSuffix(".json") {
            let json = dir.appending(path: name)
            guard let drop = IncomingDrop.read(json) else { unreadable.append(json); continue }
            // A call recording is the voice log's, never an upload
            // (`IncomingDrop.Kind.audio`): it stays where it is.
            if drop.kind == .document { drops.append(drop) }
        }

        var imported: [UploadItem] = []
        for drop in drops.sorted(by: { $0.capturedAt < $1.capturedAt }) {
            let bin = IncomingDrop.binURL(drop.id, in: dir)
            let sent = IncomingDrop.sentURL(drop.id, in: dir)
            guard let bytes = try? Data(contentsOf: bin) else {
                // A description with no bytes cannot become anything; it
                // waits out the orphan age like any other half-drop.
                if isOlder(IncomingDrop.jsonURL(drop.id, in: dir), than: now) { remove(drop.id, in: dir) }
                continue
            }
            do {
                var item = try enqueue(file: bytes, id: drop.id, fileName: drop.fileName, mime: drop.mime,
                                       fileExtension: drop.fileExtension, capturedAt: drop.capturedAt,
                                       source: IncomingDrop.source)
                if fm.fileExists(atPath: sent.path()), item.state == .pending {
                    markSent(item.id, now: now)
                    item = items().first { $0.id == item.id } ?? item
                }
                imported.append(item)
                remove(drop.id, in: dir)
            } catch {
                // Not persisted: the drop stays and is imported next time.
                continue
            }
        }

        for json in unreadable where isOlder(json, than: now) { try? fm.removeItem(at: json) }
        sweepOrphans(in: dir, now: now)
        return imported
    }

    /// JSON first: once it is gone the drop is invisible, whatever happens next.
    private nonisolated func remove(_ id: UUID, in dir: URL) {
        let fm = FileManager.default
        try? fm.removeItem(at: IncomingDrop.jsonURL(id, in: dir))
        try? fm.removeItem(at: IncomingDrop.binURL(id, in: dir))
        try? fm.removeItem(at: IncomingDrop.sentURL(id, in: dir))
    }

    private nonisolated func sweepOrphans(in dir: URL, now: Date) {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path()) else { return }
        for name in names where name.hasSuffix(".bin") || name.hasSuffix(".sent") {
            let file = dir.appending(path: name)
            let stem = file.deletingPathExtension().lastPathComponent
            if fm.fileExists(atPath: dir.appending(path: "\(stem).json").path()) { continue }
            if isOlder(file, than: now) { try? fm.removeItem(at: file) }
        }
    }

    private nonisolated func isOlder(_ file: URL, than now: Date) -> Bool {
        guard let modified = (try? FileManager.default.attributesOfItem(atPath: file.path()))?[.modificationDate] as? Date
        else { return false }
        return modified < now - Self.orphanAge
    }
}
