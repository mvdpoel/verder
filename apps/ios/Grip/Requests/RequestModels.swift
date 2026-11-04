import Foundation

/// Vraag Grip on the phone: field for field what
/// `apps/web/src/lib/mobile-requests.ts` serves. Ids stay strings: they are
/// only ever echoed back to the server.
///
/// THE PHONE NEVER DECIDES WHERE A QUESTION STANDS. `phase` comes from the
/// server's one thread rule (`packages/api/src/request-threads.ts`), the same
/// rule the badge counts with; the phone only words it.

/// Where a thread stands, as the server says. An unknown phase decodes as
/// `.other` rather than failing the whole list.
enum RequestPhase: Codable, Hashable, Sendable {
    /// Waiting for the runner.
    case queued
    /// Grip is researching.
    case working
    /// A follow-up is rewriting the proposal ("voorstel wordt bijgewerkt").
    case updating
    /// Waits on Martin: Nu, amber, counted.
    case todo
    /// Finished: Eerdere vragen.
    case done
    case other(String)

    init(rawValue: String) {
        switch rawValue {
        case "queued": self = .queued
        case "working": self = .working
        case "updating": self = .updating
        case "todo": self = .todo
        case "done": self = .done
        default: self = .other(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .queued: "queued"
        case .working: "working"
        case .updating: "updating"
        case .todo: "todo"
        case .done: "done"
        case .other(let s): s
        }
    }

    init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// One thread on `GET /requests`, by its head.
struct RequestListItem: Codable, Identifiable, Equatable, Sendable {
    struct ProposalRef: Codable, Equatable, Sendable {
        let id: String
        let status: String
        let priority: String
    }

    /// The head: the request the answer screen opens.
    let id: String
    let rootId: String
    let text: String
    /// The thread's name: the answer's title, else Martin's own words.
    let title: String
    let status: String
    let phase: RequestPhase
    /// todo: failed · unread · steps · proposal.
    let todoReason: String?
    /// done: afgerond · beantwoord · weggelegd · gestopt.
    let doneReason: String?
    /// todo: the row's meta ("Nieuw antwoord · 1 voorstel").
    let meta: String?
    let parentRequestId: String?
    let createdAt: Date
    let answeredAt: Date?
    let openedAt: Date?
    let dismissedAt: Date?
    /// The moment the row shows.
    let at: Date
    let unread: Bool
    let stepsTotal: Int
    let stepsDone: Int
    let proposal: ProposalRef?
    let followUps: Int
}

struct RequestListDTO: Codable, Equatable, Sendable {
    let requests: [RequestListItem]
}

/// What a request is about (`about` on create, the picker's rows).
struct RequestAbout: Codable, Hashable, Sendable, Identifiable {
    /// mail · document · party · stop · task.
    let type: String
    let id: String
    let label: String
    var meta: [String] = []
    var at: Date? = nil

    /// The `about` body the create route takes: exactly one key.
    var postKey: String {
        switch type {
        case "mail": "rawEmailId"
        case "document": "documentId"
        case "party": "partyId"
        case "stop": "stopId"
        default: "taskId"
        }
    }

    private enum K: String, CodingKey { case type, id, label, meta, at }
    init(type: String, id: String, label: String, meta: [String] = [], at: Date? = nil) {
        self.type = type; self.id = id; self.label = label; self.meta = meta; self.at = at
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        type = try c.decode(String.self, forKey: .type)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decode(String.self, forKey: .label)
        meta = try c.decodeIfPresent([String].self, forKey: .meta) ?? []
        at = try c.decodeIfPresent(Date.self, forKey: .at)
    }
}

struct AttachableDTO: Codable, Equatable, Sendable {
    let items: [RequestAbout]
}

/// `GET /requests/<id>`.
struct RequestDetail: Codable, Identifiable, Equatable, Sendable {
    struct Source: Codable, Equatable, Sendable, Identifiable {
        struct Transaction: Codable, Equatable, Sendable {
            let amountCents: Int
            let bookedAt: Date
            let counterparty: String?
            let accountIban: String?
            let description: String?
            let mandate: Bool
        }
        struct Gmail: Codable, Equatable, Sendable {
            let from: String
            let to: String
            let subject: String
            let date: String
            let body: String
        }

        let type: String
        let id: String
        let why: String
        let label: String
        let meta: [String]
        let at: Date?
        let inDossier: Bool
        var transaction: Transaction? = nil
        var gmail: Gmail? = nil
    }

    struct Step: Codable, Equatable, Sendable, Identifiable {
        let index: Int
        let text: String
        let doneAt: Date?
        var id: Int { index }
    }

    struct ProposalCard: Codable, Equatable, Sendable {
        let id: String
        let status: String
        let kind: String
        let priority: String
        let title: String?
        let to: [String]
        let subject: String?
        let attachmentCount: Int
        let sentAt: Date?
    }

    struct Progress: Codable, Equatable, Sendable {
        struct Step: Codable, Equatable, Sendable {
            let label: String
            /// done · current · failed.
            let state: String
        }
        let calls: Int
        let documents: Int
        let mails: Int
        let liveMail: Int
        let line: String?
        let steps: [Step]
    }

    struct Earlier: Codable, Equatable, Sendable, Identifiable {
        let id: String
        let text: String
        let status: String
        let createdAt: Date
        let title: String
        let headline: String?
        let answer: String?
        let proposal: ProposalCard?
    }

    struct FollowUp: Codable, Equatable, Sendable {
        let id: String
        let text: String
        let status: String
        let createdAt: Date
    }

    let id: String
    let rootId: String
    let clientId: String
    let text: String
    let status: String
    let title: String
    let headline: String?
    let phase: RequestPhase?
    let todoReason: String?
    let doneReason: String?
    let parentRequestId: String?
    let createdAt: Date
    let claimedAt: Date?
    let answeredAt: Date?
    let openedAt: Date?
    let dismissedAt: Date?
    let updatedAt: Date
    let unread: Bool
    let progressLine: String?
    let failure: String?
    let failureDetail: String?
    let about: RequestAbout?
    let answer: String?
    let sources: [Source]
    let martinSteps: [String]
    let steps: [Step]
    let proposal: ProposalCard?
    let proposalUpdating: Bool
    let progress: Progress?
    let thread: [Earlier]
    let followUps: [FollowUp]
}

/// `POST /requests` and `POST /requests/<id>/retry`.
struct RequestCreated: Codable, Equatable, Sendable {
    let id: String
    let status: String
    let duplicate: Bool
}

/// The body of `POST /requests`. `about` carries exactly one key.
struct RequestPost: Encodable, Equatable, Sendable {
    let clientId: String
    let text: String
    let about: [String: String]?
    let parentRequestId: String?
}

struct RequestStepPost: Encodable, Sendable {
    let index: Int
    let done: Bool
}

struct RequestRetryPost: Encodable, Sendable {
    let clientId: String
}

/// A route whose answer the phone does not read.
struct RequestIgnored: Decodable, Sendable {}
