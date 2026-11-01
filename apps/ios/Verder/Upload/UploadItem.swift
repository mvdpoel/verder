import Foundation

/// One capture or shared file waiting to reach verder, or that has.
///
/// `id` IS the upload's `clientId`: the server stores it as
/// `sourceRef = "phone:<clientId>"` and answers a second upload with the same
/// id as a duplicate, so a retry after a lost response can never ingest the
/// letter twice (Review Focus 1). It is therefore minted once, at enqueue (or,
/// for a share, when the extension wrote the drop), and never changes — not on
/// retry, not on a manual "opnieuw".
///
/// Its own file, Foundation only, because the share extension compiles it too
/// (it builds the same upload request); the extension never touches the queue.
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
    /// The file's media type and the extension it is stored under. BOTH
    /// OPTIONAL, and that is load-bearing: `UploadQueue.init` decodes with
    /// `try? … ?? Index()`, so a non-optional field the queue.json written
    /// before the share extension lacks would SILENTLY EMPTY the queue and lose
    /// every pending scan. A missing optional key decodes as nil, and nil means
    /// what every item before this field was: a PDF.
    var mime: String? = nil
    var fileExtension: String? = nil

    enum State: String, Codable, Sendable {
        case pending, sending, sent, failed
    }

    /// The form value: lower-case, as the server spells it in `sourceRef`.
    var clientId: String { id.uuidString.lowercased() }

    var resolvedMime: String { mime ?? "application/pdf" }
    var resolvedExtension: String { fileExtension ?? "pdf" }

    /// Extensions the queue's own files use; a shared `x.body` would otherwise
    /// be stored where the uploader writes its multipart body.
    static let reservedExtensions: Set<String> = ["body", "json", "sent", "partial"]

    /// A file extension safe to put in a path: 1–10 lower-case ASCII letters or
    /// digits, and none of the queue's own. Nil for anything else.
    static func safeExtension(_ raw: String) -> String? {
        let ext = raw.lowercased()
        guard (1...10).contains(ext.count),
              ext.unicodeScalars.allSatisfy({ ("a"..."z").contains($0) || ("0"..."9").contains($0) }),
              !reservedExtensions.contains(ext)
        else { return nil }
        return ext
    }
}
