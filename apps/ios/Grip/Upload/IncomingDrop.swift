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
/// AUDIO DROPS (Added 2026-11-03): a call recording shared from any app — a
/// call-recording app, Voice Memos, Files, AirDrop (Grip itself can never
/// record a call — iOS gives no third-party app the call audio, and the
/// iPhone's built-in recording is not available in the Netherlands) — is a drop of
/// kind `.audio`. It is NOT an upload: `importIncoming` leaves it alone, and
/// the voice log (`VoiceLogSession.openPendingRecording`) transcribes it ON
/// the phone and deletes it after sending or cancelling. Its bytes reach the
/// server only when Martin turns on "bewaar opname".
///
/// Foundation only: compiled into the app and the extension.
struct IncomingDrop: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable {
        /// A file for the upload queue (the default, and every drop written
        /// before audio existed).
        case document
        /// A recording for the voice log; never uploaded as a document.
        case audio
    }

    let id: UUID
    let fileName: String
    let mime: String
    let fileExtension: String
    let capturedAt: Date
    let kind: Kind

    static let source = "phone-share"

    static func directory(groupDir: URL) -> URL {
        groupDir.appending(path: "uploads/incoming", directoryHint: .isDirectory)
    }

    static func binURL(_ id: UUID, in dir: URL) -> URL { dir.appending(path: "\(id.uuidString).bin") }
    static func jsonURL(_ id: UUID, in dir: URL) -> URL { dir.appending(path: "\(id.uuidString).json") }
    static func sentURL(_ id: UUID, in dir: URL) -> URL { dir.appending(path: "\(id.uuidString).sent") }

    /// Writes the bytes, then the description, and returns the drop's UUID.
    @discardableResult
    static func write(file: Data, fileName: String, mime: String, kind: Kind = .document, capturedAt: Date,
                      to groupDir: URL) throws -> UUID {
        let dir = directory(groupDir: groupDir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let drop = IncomingDrop(id: UUID(), fileName: fileName, mime: mime,
                                fileExtension: fileExtension(fileName: fileName, mime: mime),
                                capturedAt: capturedAt, kind: kind)
        let protection: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        try file.write(to: binURL(drop.id, in: dir), options: protection)
        try encoder.encode(drop).write(to: jsonURL(drop.id, in: dir), options: protection)
        return drop.id
    }

    /// Writes a drop whose bytes are a file on disk, copied without being read
    /// into memory (a shared file of tens of MB must not cost tens of MB of
    /// the extension's budget). Same order: bytes first, description last.
    @discardableResult
    static func write(fileAt source: URL, fileName: String, mime: String, kind: Kind = .document,
                      capturedAt: Date, to groupDir: URL) throws -> UUID {
        let dir = directory(groupDir: groupDir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let drop = IncomingDrop(id: UUID(), fileName: fileName, mime: mime,
                                fileExtension: fileExtension(fileName: fileName, mime: mime),
                                capturedAt: capturedAt, kind: kind)
        let bin = binURL(drop.id, in: dir)
        try FileManager.default.copyItem(at: source, to: bin)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: bin.path())
        try encoder.encode(drop).write(to: jsonURL(drop.id, in: dir),
                                       options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return drop.id
    }

    /// Takes a drop back before the app has seen it: description FIRST, so a
    /// crash in between leaves an invisible orphan `.bin` (swept after 24 h),
    /// never a drop without its bytes being imported.
    static func remove(_ id: UUID, groupDir: URL) {
        let dir = directory(groupDir: groupDir)
        let fm = FileManager.default
        try? fm.removeItem(at: jsonURL(id, in: dir))
        try? fm.removeItem(at: binURL(id, in: dir))
        try? fm.removeItem(at: sentURL(id, in: dir))
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

    /// The extensions a call recording arrives with: Voice Memos and most
    /// recording apps give `.m4a`; others give `.aac`, `.wav` or `.caf`. Anything with an `audio/*` type counts too.
    static let audioExtensions: Set<String> = ["m4a", "aac", "wav", "caf"]

    /// A recording, by its type or (when the type is uninformative, as
    /// `application/octet-stream` often is) by its extension.
    static func isAudio(fileName: String, mime: String) -> Bool {
        if mime.lowercased().hasPrefix("audio/") { return true }
        return audioExtensions.contains((fileName as NSString).pathExtension.lowercased())
    }

    /// How long a shared recording waits for the voice log before it ages
    /// out. Longer than `UploadQueue.orphanAge` (24 h) on purpose: sharing
    /// from another app does not open Grip, so a recording Martin has not yet
    /// opened the app for is not an orphan — a day of not opening the app
    /// must not lose it. A week is the bound on a drop that, for whatever
    /// reason, keeps coming back; the original stays in its own app either way.
    static let audioMaxAge: TimeInterval = 7 * 86_400

    /// The audio drops waiting for the voice log, oldest first. Complete
    /// drops only (a `.json` is written last). A drop whose `.bin` is gone
    /// (it can never be written out — the extension writes the bytes FIRST,
    /// so this is never a drop mid-write) or that has waited longer than
    /// `audioMaxAge` is removed here rather than returned: returned, it
    /// would open the voice sheet on every foreground with nothing to show.
    static func pendingAudio(groupDir: URL, now: Date = Date()) -> [IncomingDrop] {
        let dir = directory(groupDir: groupDir)
        let fm = FileManager.default
        let names = (try? fm.contentsOfDirectory(atPath: dir.path(percentEncoded: false))) ?? []
        return names.filter { $0.hasSuffix(".json") }
            .compactMap { read(dir.appending(path: $0)) }
            .filter { $0.kind == .audio }
            .filter { drop in
                let json = jsonURL(drop.id, in: dir)
                let written = (try? fm.attributesOfItem(atPath: json.path(percentEncoded: false)))?[.modificationDate] as? Date
                let tooOld = written.map { $0 < now - audioMaxAge } ?? false
                guard fm.fileExists(atPath: binURL(drop.id, in: dir).path(percentEncoded: false)), !tooOld else {
                    remove(drop.id, groupDir: groupDir)
                    return false
                }
                return true
            }
            .sorted { ($0.capturedAt, $0.id.uuidString) < ($1.capturedAt, $1.id.uuidString) }
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

extension IncomingDrop {
    private enum CodingKeys: String, CodingKey { case id, fileName, mime, fileExtension, capturedAt, kind }

    /// A drop written before audio existed carries no `kind`: a document.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try c.decode(UUID.self, forKey: .id),
                  fileName: try c.decode(String.self, forKey: .fileName),
                  mime: try c.decode(String.self, forKey: .mime),
                  fileExtension: try c.decode(String.self, forKey: .fileExtension),
                  capturedAt: try c.decode(Date.self, forKey: .capturedAt),
                  kind: try c.decodeIfPresent(Kind.self, forKey: .kind) ?? .document)
    }
}
