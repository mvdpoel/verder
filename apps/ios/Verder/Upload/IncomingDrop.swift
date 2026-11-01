import Foundation
import UniformTypeIdentifiers

/// A file the share extension hands to the app (spec §7.8, plan 3 Task 22).
///
/// The extension NEVER touches `queue.json`: `UploadQueue` loads it once and
/// keeps it in memory, so two processes writing it would leave whichever wrote
/// last and lose the other's items. Instead the extension leaves a drop in
/// `<group>/uploads/incoming/`:
///
/// - `<uuid>.bin` — the bytes, written FIRST;
/// - `<uuid>.json` — this struct, written LAST, so the app never reads half a
///   drop (a `.bin` without its `.json` is invisible);
/// - `<uuid>.sent` — written by the extension only after its own upload got a
///   2xx with the endpoint's answer.
///
/// The drop's UUID becomes the upload's clientId (`UploadQueue.importIncoming`),
/// so the extension's attempt and the app's can never make two documents: the
/// second one is answered `duplicate: true` through `phone:<clientId>`.
///
/// Foundation only: compiled into the app and the extension.
struct IncomingDrop: Codable, Equatable, Sendable {
    let id: UUID
    let fileName: String
    let mime: String
    let fileExtension: String
    let capturedAt: Date

    static let source = "phone-share"

    static func directory(groupDir: URL) -> URL {
        groupDir.appending(path: "uploads/incoming", directoryHint: .isDirectory)
    }

    static func binURL(_ id: UUID, in dir: URL) -> URL { dir.appending(path: "\(id.uuidString).bin") }
    static func jsonURL(_ id: UUID, in dir: URL) -> URL { dir.appending(path: "\(id.uuidString).json") }
    static func sentURL(_ id: UUID, in dir: URL) -> URL { dir.appending(path: "\(id.uuidString).sent") }

    /// Writes the bytes, then the description, and returns the drop's UUID.
    @discardableResult
    static func write(file: Data, fileName: String, mime: String, capturedAt: Date,
                      to groupDir: URL) throws -> UUID {
        let dir = directory(groupDir: groupDir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let drop = IncomingDrop(id: UUID(), fileName: fileName, mime: mime,
                                fileExtension: fileExtension(fileName: fileName, mime: mime),
                                capturedAt: capturedAt)
        let protection: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        try file.write(to: binURL(drop.id, in: dir), options: protection)
        try encoder.encode(drop).write(to: jsonURL(drop.id, in: dir), options: protection)
        return drop.id
    }

    /// The extension's own upload got through.
    static func markSent(_ id: UUID, groupDir: URL) throws {
        try Data().write(to: sentURL(id, in: directory(groupDir: groupDir)),
                         options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// The drop described by `<uuid>.json`, or nil when it is unreadable or
    /// describes some other UUID than its own name.
    static func read(_ json: URL) -> IncomingDrop? {
        guard let id = UUID(uuidString: json.deletingPathExtension().lastPathComponent),
              let data = try? Data(contentsOf: json),
              let drop = try? decoder.decode(IncomingDrop.self, from: data),
              drop.id == id
        else { return nil }
        return drop
    }

    /// The extension a shared file is stored under: its own, if that is a safe
    /// one, else the mime's preferred one, else `bin`. Never a path.
    static func fileExtension(fileName: String, mime: String) -> String {
        let own = (fileName as NSString).pathExtension
        if !own.isEmpty { return UploadItem.safeExtension(own) ?? "bin" }
        if let preferred = UTType(mimeType: mime)?.preferredFilenameExtension,
           let safe = UploadItem.safeExtension(preferred) {
            return safe
        }
        return "bin"
    }

    static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = .sortedKeys
        return e
    }

    static var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}
