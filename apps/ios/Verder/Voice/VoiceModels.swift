import Foundation

/// One row of `GET /api/mobile/v1/parties?recent=1` — the picker's data,
/// hand-shaped by the route (no email, no note).
struct PartyDTO: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let kind: String
    let name: String
    let organization: String?
    /// Newest log entry this party took part in; nil when never.
    let lastContactAt: Date?
    /// What the party is to Martin ("verhuurder", "incasso"), shown in the
    /// picker when the server serves it. NOT SERVED YET: `parties.kind` is
    /// only person/organization and roles live per debt, so the route has no
    /// such field; the phone never guesses one (FEATURES "De rol van de partij").
    var role: String? = nil

    init(id: String, kind: String, name: String, organization: String?, lastContactAt: Date?, role: String? = nil) {
        self.id = id
        self.kind = kind
        self.name = name
        self.organization = organization
        self.lastContactAt = lastContactAt
        self.role = role
    }
}

/// `POST /api/mobile/v1/entries/voice`'s answer.
struct VoiceEntryAnswer: Codable, Equatable, Sendable {
    let suggestionId: String
    let audioDocumentId: String?
    /// The same clientId was seen before: nothing new was stored.
    let duplicate: Bool
}

/// The channels the voice route accepts that a SPOKEN note can be about
/// (the route also takes `email` and `letter`, which nobody dictates). Labels
/// follow `apps/web/src/lib/entry-labels.ts`.
enum VoiceChannel: String, CaseIterable, Identifiable, Sendable {
    case call, meeting, voicemail, whatsapp, other

    var id: String { rawValue }

    var label: String {
        switch self {
        case .call: "Telefoon"
        // The frames' word: a meeting a voice note is about is a visit.
        case .meeting: "Bezoek"
        case .voicemail: "Voicemail"
        case .whatsapp: "WhatsApp"
        case .other: "Anders"
        }
    }
}

extension VoiceChannel {
    /// The two the segmented row shows; the rest sit behind "Anders…".
    static let primary: [VoiceChannel] = [.call, .meeting]
    static let more: [VoiceChannel] = [.voicemail, .whatsapp, .other]
}

/// What the recogniser has so far while Martin talks: `settled` will not
/// change, `volatile` still may (drawn in signal, the frame "opname").
struct LiveText: Equatable, Sendable {
    var settled: String
    var volatile: String

    static let empty = LiveText(settled: "", volatile: "")
    var isEmpty: Bool { settled.isEmpty && volatile.isEmpty }
    var whole: String { [settled, volatile].filter { !$0.isEmpty }.joined(separator: " ") }
}

/// How far the one-time Dutch model download is. Bytes only when the system
/// reports them as bytes; otherwise the fraction alone.
struct InstallProgress: Equatable, Sendable {
    var fraction: Double
    var completedBytes: Int64? = nil
    var totalBytes: Int64? = nil
}

/// What one "Verstuur als voorstel" sends: the route's multipart fields, and
/// the recording only when Martin kept it.
struct VoiceDraft: Equatable, Sendable {
    static let path = "/api/mobile/v1/entries/voice"
    /// The route's own bound (`TRANSCRIPT_MAX`), checked before sending.
    static let transcriptMax = 20_000
    /// `MAX_UPLOAD_BYTES` on the server.
    static let audioMaxBytes = 50 * 1024 * 1024

    let clientId: UUID
    let occurredAt: Date
    let partyId: String
    let channel: VoiceChannel
    let transcript: String
    let audio: Data?

    var fields: [(String, String)] {
        [("clientId", clientId.uuidString.lowercased()),
         ("occurredAt", occurredAt.formatted(Date.ISO8601FormatStyle())),
         ("partyId", partyId),
         ("channel", channel.rawValue),
         ("transcript", transcript)]
    }

    /// "Gesprek 2026-11-01.m4a", on Amsterdam's calendar.
    var audioFileName: String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
        let c = cal.dateComponents([.year, .month, .day], from: occurredAt)
        return String(format: "Gesprek %04d-%02d-%02d.m4a", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    func request(_ client: APIClient, boundary: String = Multipart.makeBoundary()) -> URLRequest {
        let body = multipartBody(boundary: boundary, fields: fields,
                                 file: audio.map { (name: "audio", fileName: audioFileName, mime: "audio/mp4", data: $0) })
        var req = client.request(Self.path, method: "POST", body: body, contentType: Multipart.contentType(boundary: boundary))
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        return req
    }
}
