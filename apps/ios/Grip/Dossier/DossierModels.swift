import Foundation

/// The phone's side of the pocket dossier routes, field for field what
/// `packages/api/src/routers/dossier-sync.ts` (`DossierDelta`, `DossierText`)
/// and `apps/web/src/lib/mobile-dto.ts` (`toSearchDTO`) serve.

/// One document the phone keeps: what it IS now, never its history. `title`,
/// `docType` and `status` are the EFFECTIVE ones (`effectiveDocument`), so a
/// rename or a filing arrives as an upsert with the new values.
struct DossierDoc: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let title: String
    /// Free text: the English docmeta vocabulary or the Dutch soort Martin typed.
    let docType: String?
    /// "inbox" or "filed"; kept a string so a new value never fails the sync.
    let status: String
    let receivedAt: Date
    /// As stored. The bytes are rendered by the file route's `Content-Type`.
    let mime: String
    let sizeBytes: Int
    let sha256: String
    let hasText: Bool
    /// The ingest path (`documents.source`: "phone-scan", "nas-scan",
    /// "email-attachment", …). Not served by dossier-sync.ts yet; the phone
    /// reads it as optional, and only a phone scan is ever named ("foto-scan").
    var source: String? = nil
}

/// A document the phone must forget: discarded or purged on the web.
struct DossierTombstone: Codable, Equatable, Sendable {
    let id: String
    let reason: String
}

/// `GET /api/mobile/v1/documents/sync?cursor=&limit=`.
struct DossierDelta: Codable, Equatable, Sendable {
    let cursor: Int
    let more: Bool
    let upserts: [DossierDoc]
    let tombstones: [DossierTombstone]
    /// The whole dossier the phone is catching up to — documents and bytes —
    /// so a first sync can say "5 van 12". Not served by dossier-sync.ts yet;
    /// without it the card counts only what has arrived.
    var total: Int? = nil
    var totalBytes: Int? = nil
}

/// One row of `GET /api/mobile/v1/documents/texts?ids=`.
struct DossierText: Codable, Equatable, Sendable {
    let id: String
    let text: String
    let truncated: Bool
}

/// A document with its extracted text, as the on-device search reads it. The
/// folded haystack is computed once here, not on every keystroke.
struct IndexedDoc: Identifiable, Equatable, Sendable {
    let doc: DossierDoc
    let text: String?
    /// Pages of a held PDF, read on the phone (PDFKit); nil when unknown.
    var pages: Int? = nil
    /// Title and text, folded (case, diacritics, width).
    let haystack: String
    let foldedTitle: String

    var id: String { doc.id }

    init(doc: DossierDoc, text: String?, pages: Int? = nil) {
        self.doc = doc
        self.text = text
        self.pages = pages
        let title = DossierSearch.fold(doc.title)
        foldedTitle = title
        haystack = text.map { title + "\n" + DossierSearch.fold($0) } ?? title
    }
}

// MARK: - Server search

/// One hit of `GET /api/mobile/v1/search?q=` ("Zoek op de server").
struct SearchHit: Codable, Equatable, Identifiable, Sendable {
    let entityType: String
    let entityId: String
    let title: String
    /// Plain text with keyword matches marked «…».
    let snippet: String?
    /// A STRING, as the search index stores it (an instant or a plain day);
    /// decoding it as a Date would fail every hit on the first odd value.
    let occurredAt: String?
    let status: String?
    /// `grip://document/<id>` or `grip://task/<id>`; nil for a kind the
    /// phone has no screen for.
    let link: String?
    /// A mail's sender as the frames name it ("Ilse, Noordkust"), a task's
    /// assignee when it waits on someone else, a log entry's channel
    /// ("phone"). Not in `toSearchDTO` yet; each detail line falls back to
    /// the kind and the day without them.
    var from: String? = nil
    var assigneeName: String? = nil
    var channel: String? = nil

    var id: String { "\(entityType):\(entityId)" }
}

struct SearchResults: Codable, Equatable, Sendable {
    let hits: [SearchHit]
    let nextCursor: String?
}
