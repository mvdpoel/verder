import Foundation

/// The phone's side of the Voor jou read routes, field for field what
/// `apps/web/src/lib/mobile-dto.ts` serves (and `WaitingItem` what
/// `packages/api/src/waiting.ts` builds). Ids stay strings: they are only ever
/// echoed back to the server.
///
/// Proposal detail is NOT here: it is Plan 2's `ProposalDetail`
/// (Proposals/ProposalDTO.swift), read from `GET /proposals/:id`.

// MARK: - Free-form JSON

/// A JSON value the phone carries without a fixed shape — a suggestion's
/// `proposed` differs per kind, and the server publishes it as `unknown`.
enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "not a JSON value") }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    /// The member `key` of an object; nil for anything else.
    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var string: String? {
        if case .string(let s) = self { return s }
        return nil
    }
}

// MARK: - Inbox

/// `WaitingKind` in waiting.ts. A kind this build does not know decodes as
/// `.other` rather than failing the whole list: one new kind on the server
/// must never empty Voor jou and zero the badge on an older phone.
enum WaitingKind: Codable, Hashable, Sendable {
    case proposal, question, suggestion, task, stop
    case other(String)

    init(rawValue: String) {
        switch rawValue {
        case "proposal": self = .proposal
        case "question": self = .question
        case "suggestion": self = .suggestion
        case "task": self = .task
        case "stop": self = .stop
        default: self = .other(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .proposal: "proposal"
        case .question: "question"
        case .suggestion: "suggestion"
        case .task: "task"
        case .stop: "stop"
        case .other(let s): s
        }
    }

    init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// One thing waiting on Martin. The server ranks; the phone never re-ranks.
struct WaitingItem: Codable, Identifiable, Equatable, Sendable {
    let kind: WaitingKind
    let id: String
    let title: String
    let subtitle: String?
    /// 1 = urgent, 2 = a proposal or question, 3 = the rest.
    let priority: Int
    let at: Date
    /// A STRING, not a Date: for a proposal it is the payload's `dueAt`, which
    /// is a plain day ("2026-11-07"); for a task it is an ISO instant. Decoding
    /// it as a Date would fail the whole inbox on the first proposal with a
    /// deadline. `ProposalFormat.dayMonth` reads both.
    let dueAt: String?
    /// A Verder-priority proposal.
    let verder: Bool
    /// A suggestion that can be approved AS PROPOSED (not a registry item,
    /// no required field empty): only then does the list offer "Goedkeuren".
    /// The server does not serve it yet (`toInboxDTO`), and absent means no:
    /// the phone never guesses that something may be approved unseen.
    var approvable: Bool? = nil
    /// A task's next statuses (`validNext`, the same matrix `tasks.setStatus`
    /// enforces): the list offers only these. Absent means none offered.
    var validNext: [String]? = nil
    /// The map stop's open tasks ("halte · 1 taak"); absent, the row says only "halte".
    var taskCount: Int? = nil
    /// The party a SUGGESTION concerns ("Incassobureau Kade & Partners"),
    /// shown in the row's meta in place of what it suggests. Absent (the
    /// server does not send it yet), the row says "Logboek" / "Document".
    var party: String? = nil
    /// A proposal whose send FAILED, and when. The server lists only pending
    /// proposals today (whether a failed send waits on Martin is still his
    /// call, F-38); absent, a proposal row reads as an ordinary one.
    var failedAt: Date? = nil
}

/// One thing verder did on its own (spec §6.6), as `verderActions.list` builds
/// it (packages/api/src/routers/verder-actions.ts): the document's state
/// before and after, and whether — and why not — it can be undone. The phone
/// never decides undoability itself; it shows the server's reason.
struct VerderAction: Codable, Identifiable, Equatable, Sendable {
    struct DocState: Codable, Equatable, Sendable {
        let status: String
        let title: String?
        let docType: String?
    }

    let changeId: String
    let documentId: String
    let documentTitle: String?
    let at: Date
    /// "auto-file" or "auto-name"; kept a string so a new kind never fails the inbox.
    let kind: String
    let before: DocState
    let after: DocState
    /// The title docmeta proposed — information only, auto-file never applies it.
    let proposedTitle: String?
    let undone: Bool
    let undoable: Bool
    /// "al aangepast", "vernietigd" or "naam staat ook op de NAS"; nil when undoable.
    let notUndoableReason: String?

    var id: String { changeId }
}

/// `GET /api/mobile/v1/inbox`. `count` is the list's own length on the server,
/// so the badge and the list cannot disagree.
struct InboxDTO: Codable, Equatable, Sendable {
    let count: Int
    let items: [WaitingItem]
    let doneByVerder: [VerderAction]
    /// When the last item that waited on Martin was dealt with — the calm
    /// card's "jij was klaar · vandaag 08:20". Optional: absent, the card
    /// simply says nothing about when.
    var lastClearedAt: Date? = nil
}

// MARK: - Suggestion

/// `GET /api/mobile/v1/suggestions/:id`.
struct SuggestionDTO: Codable, Equatable, Sendable, Identifiable {
    struct Trigger: Codable, Equatable, Sendable {
        let from: String?
        let subject: String?
        let sentAt: Date?
    }

    /// The EFFECTIVE title, soort and status — never `documents.status`.
    struct Document: Codable, Equatable, Sendable {
        let id: String
        let title: String
        let docType: String?
        let status: String
    }

    let id: String
    let kind: String
    let status: String
    let createdAt: Date
    /// Per kind (log-entry, document-meta, debt, task, registry-item).
    let proposed: JSONValue
    let trigger: Trigger?
    let document: Document?
    let retrievedRefs: [JSONValue]
}

// MARK: - Task

/// One row of `GET /api/mobile/v1/tasks`. `status` is the effective status
/// (ledger seq), and `validNext` the only statuses the phone may offer.
struct TaskDTO: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let title: String
    let details: String?
    let dueAt: Date?
    let status: String
    let assigneeName: String?
    let validNext: [String]
}

// MARK: - Dashboard summary

/// `GET /api/mobile/v1/dashboard/summary`.
struct DashboardSummaryDTO: Codable, Equatable, Sendable {
    /// The stop the map draws as current; nil when no stop is open.
    struct Headline: Codable, Equatable, Sendable {
        let stopTitle: String
        let trackTitle: String?
        let happenedAt: Date?
        let note: String?
    }

    struct Tasks: Codable, Equatable, Sendable {
        let openCount: Int
        let overdueCount: Int
        let waitingOnOthersCount: Int
    }

    let headline: Headline?
    let waitingCount: Int
    let tasks: Tasks
}
