import Foundation

/// The proposal shapes the mobile routes serve, as served by
/// `packages/api/src/routers/proposals.ts` (`list` and `get`). Ids stay
/// strings: they are only ever echoed back to the server.

/// One row of `GET /api/mobile/v1/proposals`.
struct ProposalSummary: Decodable, Equatable, Sendable, Identifiable {
    let id: String
    let kind: String
    let status: String
    let priority: String
    let ask: String?
    let partyName: String?
    let triggerAt: Date?
    let createdAt: Date
}

struct ProposalList: Decodable, Sendable {
    let proposals: [ProposalSummary]
}

/// `GET /api/mobile/v1/proposals/<id>`.
struct ProposalDetail: Decodable, Equatable, Sendable {
    struct Trigger: Decodable, Equatable, Sendable {
        let type: String
        let id: String
        let from: String?
        let subject: String?
        let date: Date?
        let excerpt: String?
    }

    struct ProposedTask: Decodable, Equatable, Sendable {
        let title: String
        let dueAt: String?
    }

    struct Citation: Decodable, Equatable, Sendable {
        let type: String
        let id: String
        let label: String
        let why: String?
    }

    struct Reply: Decodable, Equatable, Sendable {
        let to: [String]
        let cc: [String]
        let subject: String
        let body: String
        let attachmentDocumentIds: [String]
    }

    struct Question: Decodable, Equatable, Sendable {
        let prompt: String
    }

    /// The subset of the stored model payload the screen reads. The question's
    /// options are NOT read from here: `options` below carries them with the
    /// server-rendered target.
    struct Payload: Decodable, Equatable, Sendable {
        let entrySummary: String?
        let reply: Reply?
        let question: Question?
    }

    struct Attachment: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let title: String
        let sizeBytes: Int
        /// Discarded or purged since drafting: the server refuses to send it.
        let unavailable: Bool
    }

    struct Attachable: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let title: String
    }

    struct Option: Decodable, Equatable, Sendable, Identifiable {
        let index: Int
        let action: String
        /// The model's words.
        let label: String
        /// The SERVER's Dutch description of what the option does, built from
        /// the validated ids — the button never shows only the model's label.
        let target: String
        var id: Int { index }
    }

    let id: String
    let kind: String
    let status: String
    let priority: String
    let ask: String?
    let partyName: String?
    let triggerAt: Date?
    let createdAt: Date
    let trigger: Trigger
    let dueAt: String?
    let missing: [String]
    let entrySummary: String?
    let proposedTask: ProposedTask?
    let createdTaskId: String?
    let senderUnconfirmed: Bool
    let reliedOn: [Citation]
    let payload: Payload?
    let revision: Int
    let attachments: [Attachment]
    let attachable: [Attachable]
    let options: [Option]
    let error: String?
}

/// What the phone may change before approving, exactly the `payload` of
/// `POST …/approve` (`approveInput` in proposals.ts). Nothing else is sent.
struct ReplyDraft: Codable, Equatable, Sendable {
    var to: [String]
    var cc: [String]
    var subject: String
    var body: String
    var attachmentDocumentIds: [String]
    var entrySummary: String
}

struct ApproveRequest: Encodable, Sendable {
    let revision: Int
    let payload: ReplyDraft
}

struct RejectRequest: Encodable, Sendable {
    let reason: String?
}

struct AnswerOptionRequest: Encodable, Sendable {
    let revision: Int
    let option: Int
}

struct AnswerTextRequest: Encodable, Sendable {
    let revision: Int
    let freeText: String
}

struct EmptyBody: Encodable, Sendable {}

/// The routes answer more than the phone reads; this reads nothing.
struct Ignored: Decodable, Sendable {}

/// Dutch display helpers shared by the list and the screen.
enum ProposalFormat {
    static let amsterdam = TimeZone(identifier: "Europe/Amsterdam")!

    /// "2026-11-07" or an ISO timestamp → "7-11", on the AMSTERDAM calendar —
    /// the same rule as `dayMonth` in proposals.ts. Nil for anything else.
    static func dayMonth(_ s: String) -> String? {
        let plain = s.split(separator: "-", omittingEmptySubsequences: false)
        if plain.count == 3, plain[0].count == 4, plain[1].count == 2, plain[2].count == 2,
           let m = Int(plain[1]), let d = Int(plain[2]), (1...12).contains(m), (1...31).contains(d) {
            return "\(d)-\(m)"
        }
        guard let date = parseISODate(s) else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = amsterdam
        let c = cal.dateComponents([.day, .month], from: date)
        guard let d = c.day, let m = c.month else { return nil }
        return "\(d)-\(m)"
    }

    /// "30 okt 2026, 10:12" in Amsterdam.
    static func dateTime(_ date: Date) -> String {
        var style = Date.FormatStyle(date: .abbreviated, time: .shortened)
        style.timeZone = amsterdam
        style.locale = Locale(identifier: "nl_NL")
        return date.formatted(style)
    }

    static func kind(_ kind: String) -> String {
        switch kind {
        case "reply": "antwoord"
        case "question": "vraag"
        case "follow-up": "opvolging"
        default: kind
        }
    }

    static func status(_ status: String) -> String {
        switch status {
        case "pending": "wacht op jou"
        case "approved": "goedgekeurd"
        case "sending": "wordt verstuurd"
        case "sent": "verstuurd"
        case "failed": "mislukt"
        case "rejected": "afgewezen"
        case "superseded": "vervangen"
        default: status
        }
    }

    static func bytes(_ n: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
    }
}
