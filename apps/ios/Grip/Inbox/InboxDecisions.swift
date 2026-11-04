import Foundation
import Observation

/// What a decision taken FROM THE LIST posts, once its undo window is over:
/// the same routes, with the same bodies, as the detail screens — so a swipe
/// is recorded exactly like a tap on "Klopt zo" (verdict, empty edit diff,
/// ledger events). NOTHING HERE SENDS: a proposal is sent only from
/// `ProposalScreen`, behind a fresh Face ID, and has no list action at all.
enum DecisionBody: Encodable, Sendable, Equatable {
    /// `{ edits: {} }`: approved exactly as proposed.
    case approve
    /// `{}`: rejected without a reason.
    case reject
    case status(String)
    /// `{}`: "Door verder gedaan"'s undo.
    case empty
    /// `{ revision, option }`: a question answered with an option that
    /// changes nothing ("Nee", "Weet ik niet").
    case answer(revision: Int, option: Int)

    func encode(to encoder: Encoder) throws {
        switch self {
        case .approve: try ApproveSuggestionRequest(edits: [:]).encode(to: encoder)
        case .reject: try RejectRequest(reason: nil).encode(to: encoder)
        case .status(let s): try TaskStatusRequest(status: s).encode(to: encoder)
        case .empty: try EmptyBody().encode(to: encoder)
        case .answer(let revision, let option): try AnswerOptionRequest(revision: revision, option: option).encode(to: encoder)
        }
    }
}

/// One decision Martin took from the list.
struct ListDecision: Identifiable, Equatable, Sendable {
    enum Action: Equatable, Sendable {
        case approve
        case reject
        case task(String)
        /// Undo one thing verder did ("Door verder gedaan").
        case undoVerder
        /// A question's option that changes nothing, by its index, at the
        /// revision the screen showed; `label` is the option's own words.
        case answer(option: Int, revision: Int, label: String)
    }

    let id: UUID
    /// The row it hides while held (`VoorJouList.key`, or `verder:<changeId>`).
    let key: String
    let title: String
    let action: Action
    /// The suggestion, task or change id the route names.
    let target: String
    /// "Logboek · Lindehof": the toast's subject at the accessibility sizes
    /// (`VoorJouList.toastSubject`); nil falls back to the short title.
    var short: String? = nil

    var path: String {
        switch action {
        case .approve: "/api/mobile/v1/suggestions/\(target)/approve"
        case .reject: "/api/mobile/v1/suggestions/\(target)/reject"
        case .task: "/api/mobile/v1/tasks/\(target)/status"
        case .undoVerder: DoneByVerderModel.undoPath(target)
        case .answer: "/api/mobile/v1/proposals/\(target)/answer"
        }
    }

    var body: DecisionBody {
        switch action {
        case .approve: .approve
        case .reject: .reject
        case .task(let s): .status(s)
        case .undoVerder: .empty
        case .answer(let option, let revision, _): .answer(revision: revision, option: option)
        }
    }

    static func key(verder changeId: String) -> String { "verder:\(changeId)" }

    /// The toast's first word: what happened.
    var verb: String {
        switch action {
        case .approve: "Goedgekeurd"
        case .reject: "Niet relevant"
        case .task("done"): "Gedaan"
        case .task("in-progress"): "Op bezig gezet"
        case .task("waiting"): "Wacht op een ander"
        case .task("dropped"): "Laten vallen"
        case .task("open"): "Weer open"
        case .task(let s): "Status: \(s)"
        case .undoVerder: "Terug in Kan wachten"
        case .answer(_, _, let label): "Beantwoord: \(label)"
        }
    }

    /// "goedgekeurd" in "Ook 1 goedgekeurd".
    var participle: String {
        switch action {
        case .approve: "goedgekeurd"
        case .reject: "niet relevant"
        case .task("done"): "gedaan"
        case .task("dropped"): "laten vallen"
        case .task: "gewijzigd"
        case .undoVerder: "teruggezet"
        case .answer: "beantwoord"
        }
    }

    /// The failure's subject, and how it is taken back.
    var noun: String {
        switch action {
        case .approve: "Je goedkeuring"
        case .reject: "Je afwijzing"
        case .task: "Je statuswijziging"
        case .undoVerder: "Je ongedaan maken"
        case .answer: "Je antwoord"
        }
    }

    var withdrawLabel: String {
        switch action {
        case .approve: "Goedkeuring intrekken"
        case .reject: "Afwijzing intrekken"
        case .task: "Wijziging intrekken"
        case .undoVerder: "Intrekken"
        case .answer: "Antwoord intrekken"
        }
    }

    /// An approval or a task step is a success; a rejection is not a failure
    /// either, but it is no success to celebrate (brief §2.5: `.impact(.soft)`).
    var isRejection: Bool {
        switch action {
        case .reject, .task("dropped"): true
        default: false
        }
    }
}

/// Decisions taken from the list, HELD on the phone for their undo window
/// (5 s, 8 s at the accessibility sizes) and only then posted.
///
/// Holding the POST is what keeps the ledger clean: "Ongedaan maken" inside
/// the window means nothing was ever recorded, so there is no reverse route
/// to call and nothing to explain. A new decision inside the window joins the
/// same toast and restarts it; when it ends, every held decision is posted.
/// Leaving the app posts at once (`flush`): a decision is never lost to a
/// suspended timer.
///
/// A post that fails puts its row BACK where it was, with the cause
/// ("niet opgeslagen") and two ways on: try again, or take it back. A 409
/// means it was decided elsewhere: nothing to keep, the list refreshes.
@MainActor
@Observable
final class InboxDecisions {
    struct Failure: Equatable, Sendable {
        let decision: ListDecision
        let message: String
    }

    static let window: TimeInterval = 5
    static let accessibilityWindow: TimeInterval = 8

    /// In their undo window, newest last.
    private(set) var held: [ListDecision] = []
    /// Being posted, or posted and waiting for the refresh that drops them.
    private(set) var posting: [ListDecision] = []
    /// Failed posts, by row key.
    private(set) var failures: [String: Failure] = [:]
    /// When the held decisions are posted.
    private(set) var deadline: Date?
    /// The toast's whole length, for its progress bar.
    private(set) var windowLength: TimeInterval = InboxDecisions.window
    /// A capture's frozen countdown (`-fixtures-voorjou`): never posts.
    private(set) var frozenRemaining: TimeInterval?

    // Haptic triggers (brief §2.5), counted so every moment fires once.
    private(set) var successes = 0
    private(set) var softs = 0
    private(set) var errors = 0
    private(set) var undos = 0

    /// 5 s, or 8 s at the accessibility sizes (the view says which).
    var accessibilitySize = false

    @ObservationIgnored private let post: @Sendable (String, DecisionBody) async throws -> Void
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let sleep: @Sendable (TimeInterval) async throws -> Void
    @ObservationIgnored private let onPosted: @MainActor () async -> Void
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void
    @ObservationIgnored private var timer: Task<Void, Never>?

    init(post: @escaping @Sendable (String, DecisionBody) async throws -> Void,
         now: @escaping @Sendable () -> Date = Date.init,
         sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) },
         onPosted: @escaping @MainActor () async -> Void = {},
         onUnauthorized: @escaping @MainActor () -> Void = {}) {
        self.post = post
        self.now = now
        self.sleep = sleep
        self.onPosted = onPosted
        self.onUnauthorized = onUnauthorized
    }

    convenience init(client: APIClient, now: @escaping @Sendable () -> Date = Date.init,
                     onPosted: @escaping @MainActor () async -> Void = {},
                     onUnauthorized: @escaping @MainActor () -> Void = {}) {
        self.init(post: { path, body in
            let _: Ignored = try await client.postJSON(path, body)
        }, now: now, onPosted: onPosted, onUnauthorized: onUnauthorized)
    }

    /// Rows the list does not draw: held, or posted and not yet refreshed away.
    var hiddenKeys: Set<String> { Set((held + posting).map(\.key)) }
    var hiddenCount: Int { (held + posting).count { !$0.key.hasPrefix("verder:") } }

    /// Seconds left in the window, rounded up ("nog 4 s").
    func remaining(at date: Date? = nil) -> Int {
        if let frozenRemaining { return Int(frozenRemaining.rounded(.up)) }
        guard let deadline else { return 0 }
        return max(0, Int(deadline.timeIntervalSince(date ?? now()).rounded(.up)))
    }

    /// 1 → 0 over the window, for the toast's bar.
    func progress(at date: Date? = nil) -> Double {
        if let frozenRemaining { return frozenRemaining / windowLength }
        guard let deadline else { return 0 }
        return min(1, max(0, deadline.timeIntervalSince(date ?? now()) / windowLength))
    }

    /// Takes a decision and (re)starts the window over everything held.
    func decide(_ decision: ListDecision) {
        failures[decision.key] = nil
        held.removeAll { $0.key == decision.key }
        held.append(decision)
        restart()
    }

    func decide(_ decisions: [ListDecision]) {
        for d in decisions {
            failures[d.key] = nil
            held.removeAll { $0.key == d.key }
            held.append(d)
        }
        restart()
    }

    /// "Ongedaan maken" on the toast: the newest held decision, never posted.
    func undoLast() {
        guard let last = held.last else { return }
        undo(last.id)
    }

    func undo(_ id: UUID) {
        guard held.contains(where: { $0.id == id }) else { return }
        held.removeAll { $0.id == id }
        undos += 1
        if held.isEmpty { stop() }
    }

    /// Posts everything held now (the window ran out, or the app is leaving).
    func flush() async {
        guard !held.isEmpty, frozenRemaining == nil else { return }
        stop()
        let batch = held
        held = []
        posting += batch
        var anyPosted = false
        for d in batch {
            do {
                try await post(d.path, d.body)
                anyPosted = true
                if d.isRejection { softs += 1 } else { successes += 1 }
            } catch APIError.rejected(409) {
                // Decided elsewhere already: that verdict stands.
                anyPosted = true
            } catch APIError.unauthorized {
                failures[d.key] = Failure(decision: d, message: "Log opnieuw in om het op te slaan.")
                onUnauthorized()
            } catch {
                failures[d.key] = Failure(decision: d, message: Self.failureMessage(d, error))
                errors += 1
            }
        }
        if anyPosted { await onPosted() }
        let ids = Set(batch.map(\.id))
        posting.removeAll { ids.contains($0.id) }
    }

    /// "Opnieuw proberen" in a failed row: straight away, no second window.
    func retry(_ key: String) async {
        guard let f = failures[key] else { return }
        failures[key] = nil
        held.append(f.decision)
        await flush()
    }

    /// "Goedkeuring intrekken": nothing was saved, so nothing is posted.
    func withdraw(_ key: String) {
        failures[key] = nil
    }

    static func failureMessage(_ d: ListDecision, _ error: any Error) -> String {
        switch error as? APIError {
        case .transport?:
            "\(d.noun) is nog niet opgeslagen: er is geen verbinding. Probeer het opnieuw zodra je verbinding hebt."
        case .rejected?:
            "\(d.noun) is niet opgeslagen: verder weigerde dit. Open het om het na te kijken."
        default:
            "\(d.noun) is nog niet opgeslagen: de server van verder heeft een storing. Probeer het opnieuw zodra verder weer werkt."
        }
    }

    private func restart() {
        stop()
        windowLength = accessibilitySize ? Self.accessibilityWindow : Self.window
        guard frozenRemaining == nil else { return }
        deadline = now().addingTimeInterval(windowLength)
        let length = windowLength
        let sleep = sleep
        timer = Task { [weak self] in
            do { try await sleep(length) } catch { return }
            await self?.flush()
        }
    }

    private func stop() {
        timer?.cancel()
        timer = nil
        deadline = nil
    }

    #if DEBUG
    /// A capture's state: decisions held with the countdown frozen at
    /// `remaining`, or failed with the server's storing message.
    func fixtureHold(_ decisions: [ListDecision], remaining: TimeInterval) {
        windowLength = accessibilitySize ? Self.accessibilityWindow : Self.window
        frozenRemaining = remaining
        held = decisions
    }

    func fixtureFail(_ d: ListDecision) {
        failures[d.key] = Failure(decision: d, message: Self.failureMessage(d, APIError.server(503)))
    }
    #endif
}

/// The toast's words, decided outside the view.
enum DecisionToast {
    struct Content: Equatable {
        let title: String
        let body: String
        /// "Bekijk beide" / "Bekijk alle 3"; nil for one decision.
        let reviewAll: String?
        let undoGlyph: Bool
    }

    /// `short`: the accessibility sizes, where the subject is wrapped whole
    /// rather than cut, so it is named by kind and party ("Logboek ·
    /// Lindehof", the frame's two lines) or, naming no party, without its
    /// "over …" tail (`VoorJouList.shortTitle`), to keep the card from
    /// filling the screen.
    static func content(_ held: [ListDecision], short: Bool = false) -> Content? {
        guard let last = held.last else { return nil }
        let lastTitle = short ? (last.short ?? VoorJouList.shortTitle(last.title)) : last.title
        if held.count == 1 {
            return Content(title: last.verb, body: lastTitle, reviewAll: nil, undoGlyph: last.action == .undoVerder)
        }
        var counts: [(String, Int)] = []
        for d in held.dropLast() {
            if let i = counts.firstIndex(where: { $0.0 == d.participle }) { counts[i].1 += 1 }
            else { counts.append((d.participle, 1)) }
        }
        let also = VoorJouList.listing(counts.map { "\($0.1) \($0.0)" })
        return Content(title: "\(held.count) beslissingen",
                       body: "Laatste: \(last.verb) — \(lastTitle). Ook \(also).",
                       reviewAll: held.count == 2 ? "Bekijk beide" : "Bekijk alle \(held.count)",
                       undoGlyph: false)
    }

    /// "nog 4 s".
    static func countdown(_ seconds: Int) -> String { "nog \(seconds) s" }
}
