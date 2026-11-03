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
}

/// What a finished call hands the voice quick-log (`CallSession.logCall`):
/// the ticked points as "Besproken: …", the party it was with, and when the
/// call started as CallKit reported it. Nothing in it is sent until Martin
/// presses "Verstuur als voorstel", and then only as a suggestion.
struct VoicePrefill: Equatable, Sendable {
    let partyId: String
    let text: String
    let occurredAt: Date?
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
        case .meeting: "Gesprek"
        case .voicemail: "Voicemail"
        case .whatsapp: "WhatsApp"
        case .other: "Anders"
        }
    }
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
    /// The kept recording's type and extension: the app's own recorder makes
    /// `.m4a`, an imported call keeps what it arrived as (`RecordingImport`).
    var audioMime = "audio/mp4"
    var audioExtension = "m4a"

    var fields: [(String, String)] {
        [("clientId", clientId.uuidString.lowercased()),
         ("occurredAt", occurredAt.formatted(Date.ISO8601FormatStyle())),
         ("partyId", partyId),
         ("channel", channel.rawValue),
         ("transcript", transcript)]
    }

    /// "Gesprek 2026-11-01.m4a" (or `.wav`, `.caf`, …), on Amsterdam's calendar.
    var audioFileName: String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
        let c = cal.dateComponents([.year, .month, .day], from: occurredAt)
        return String(format: "Gesprek %04d-%02d-%02d.", c.year ?? 0, c.month ?? 0, c.day ?? 0) + audioExtension
    }

    func request(_ client: APIClient, boundary: String = Multipart.makeBoundary()) -> URLRequest {
        let body = multipartBody(boundary: boundary, fields: fields,
                                 file: audio.map { (name: "audio", fileName: audioFileName, mime: audioMime, data: $0) })
        var req = client.request(Self.path, method: "POST", body: body, contentType: Multipart.contentType(boundary: boundary))
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        return req
    }
}

/// A call recording handed to the voice log (Added 2026-11-03, Martin: "it
/// would be perfect if i can also record phone calls and transcribe them").
///
/// verder cannot record the call: iOS gives no third-party app a phone call's
/// audio, and `CXCallObserver` only says THAT a call started or ended. The
/// iPhone's built-in call recording is NOT available in the Netherlands
/// (Martin, 2026-11-03: support.apple.com/nl-nl/guide/iphone/iph57c6590e9/ios,
/// ben.nl/blog/telefoongesprek-opnemen-iphone,
/// simyo.nl/blog/telefoongesprek-opnemen-iphone), so a recording is made
/// ELSEWHERE — a call-recording app, a second device on the speaker. It comes
/// IN: shared from any app — a call-recording app, Voice Memos, Files, AirDrop
/// (an audio `IncomingDrop`) — or picked with "Opname kiezen". The main path
/// stays the talking points plus dictating after the call.
struct RecordingImport: Equatable, Sendable {
    /// Where the bytes are: the drop's `.bin`, or the picked file.
    let file: URL
    let fileName: String
    let mime: String
    /// When it reached verder; the call's time when no call sheet knows better.
    let capturedAt: Date?
    /// The App Group drop it came from, deleted after sending or cancelling.
    let drop: UUID?
    let groupDir: URL?

    static func drop(_ d: IncomingDrop, groupDir: URL) -> RecordingImport {
        RecordingImport(file: IncomingDrop.binURL(d.id, in: IncomingDrop.directory(groupDir: groupDir)),
                        fileName: d.fileName, mime: d.mime, capturedAt: d.capturedAt, drop: d.id, groupDir: groupDir)
    }

    /// The types the voice route stores a kept recording under, by extension,
    /// for when what came with the file is not an `audio/*` type.
    static let mimeByExtension = ["m4a": "audio/mp4", "aac": "audio/aac", "wav": "audio/wav", "caf": "audio/x-caf",
                                  "mp3": "audio/mpeg", "aif": "audio/aiff", "aiff": "audio/aiff"]

    /// The extension verder's copy is stored (and kept) under: `AVAudioFile`
    /// needs a real one to read the file, never the drop's `.bin`.
    var fileExtension: String {
        let own = IncomingDrop.fileExtension(fileName: fileName, mime: mime)
        return own == "bin" ? "m4a" : own
    }

    /// Always an `audio/*` type: the voice route refuses anything else.
    var audioMime: String {
        if mime.lowercased().hasPrefix("audio/") { return mime }
        return Self.mimeByExtension[fileExtension] ?? "audio/mp4"
    }
}
