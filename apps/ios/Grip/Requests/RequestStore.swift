import Foundation
import Observation

/// A question that has not reached Grip yet: written on the phone, posted
/// with its own `clientId` until the server has it. The server dedups on that
/// id, so sending it twice — a lost answer, a relaunch, a reconnect — makes
/// one request, never two.
struct PendingRequest: Codable, Equatable, Identifiable, Sendable {
    let clientId: String
    let text: String
    let about: RequestAbout?
    let parentRequestId: String?
    let createdAt: Date
    var id: String { clientId }

    var post: RequestPost {
        RequestPost(clientId: clientId, text: text,
                    about: about.map { [$0.postKey: $0.id] }, parentRequestId: parentRequestId)
    }
}

/// The phone's copy of the questions it still has to send. It names the case
/// (Martin's own words), so it lives in Application Support with complete
/// file protection, excluded from backup, and is wiped with the session —
/// exactly like `InboxCache`.
struct RequestOutbox: Sendable {
    let dir: URL
    static var live: RequestOutbox {
        RequestOutbox(dir: URL.applicationSupportDirectory.appending(path: "requests", directoryHint: .isDirectory))
    }

    var url: URL { dir.appending(path: "outbox.json") }

    func load() -> [PendingRequest] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? APIClient.jsonDecoder.decode([PendingRequest].self, from: data)) ?? []
    }

    func save(_ items: [PendingRequest]) {
        var folder = dir
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? folder.setResourceValues(values)
        if items.isEmpty { try? FileManager.default.removeItem(at: url); return }
        if let data = try? APIClient.jsonEncoder.encode(items) {
            try? data.write(to: url, options: [.atomic, .completeFileProtection])
        }
    }

    func wipe() { try? FileManager.default.removeItem(at: dir) }
}

/// What the compose sheet opens with.
struct RequestDraft: Equatable, Sendable, Identifiable {
    var id = UUID()
    var text = ""
    var about: RequestAbout?
    /// "Vraag door": the answer this follows up, and its thread's name.
    var parent: (id: String, title: String)?
    /// "Vraag aanpassen": the failed question this one replaces, put away
    /// once the new words are on their way.
    var replaces: String?

    static func == (a: RequestDraft, b: RequestDraft) -> Bool {
        a.id == b.id && a.text == b.text && a.about == b.about && a.parent?.id == b.parent?.id
    }
}

/// The undo toast after "Laat maar" or the last ticked step.
struct RequestToast: Equatable, Identifiable, Sendable {
    enum Undo: Equatable, Sendable {
        case undismiss(String)
        case untick(id: String, index: Int)
    }
    let id = UUID()
    let text: String
    let undo: Undo
}

/// Vraag Grip's data on the phone: the question threads (`GET /requests`),
/// the questions still waiting to be sent, the compose sheet's draft and the
/// undo toast. Made ONCE, in `GripApp`.
///
/// What waits on Martin is NOT counted here: a question that waits on him is
/// an item of the one inbox (`loadWaiting`), so the badge, the widget and Voor
/// jou's headline agree. Every change here asks the inbox to refresh.
@MainActor
@Observable
final class RequestStore {
    static let path = "/api/mobile/v1/requests"
    static let toastSeconds: TimeInterval = 5

    private(set) var threads: [RequestListItem]?
    private(set) var pending: [PendingRequest] = []
    private(set) var lastError: APIError?
    /// The compose sheet, when open.
    var draft: RequestDraft?
    private(set) var toast: RequestToast?
    /// Counted for the haptics: a send, a refusal.
    private(set) var sends = 0
    private(set) var failures = 0

    @ObservationIgnored let client: APIClient
    @ObservationIgnored private let outbox: RequestOutbox?
    @ObservationIgnored private let onChanged: @MainActor () async -> Void
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void
    @ObservationIgnored let now: @Sendable () -> Date
    @ObservationIgnored private let epoch: SessionEpoch
    @ObservationIgnored private var flushing = false
    @ObservationIgnored private var toastTask: Task<Void, Never>?
    /// Whether the phone has a network path (`UploadCenter.isOffline`).
    @ObservationIgnored var isOffline: @MainActor () -> Bool = { false }

    init(client: APIClient, outbox: RequestOutbox? = .live, epoch: SessionEpoch = SessionEpoch(),
         now: @escaping @Sendable () -> Date = Date.init,
         onChanged: @escaping @MainActor () async -> Void = {},
         onUnauthorized: @escaping @MainActor () -> Void = {}) {
        self.client = client
        self.outbox = outbox
        self.epoch = epoch
        self.now = now
        self.onChanged = onChanged
        self.onUnauthorized = onUnauthorized
        pending = outbox?.load() ?? []
        epoch.whenEnded { [weak self] in self?.sessionEnded() }
    }

    // MARK: - Lists

    /// Open questions under JOUW VRAAG: queued, being researched, being
    /// rewritten. Those that wait on Martin are Nu's (the inbox's).
    var open: [RequestListItem] {
        (threads ?? []).filter { [.queued, .working, .updating].contains($0.phase) }
            .sorted { $0.createdAt > $1.createdAt }
    }

    /// Eerdere vragen, newest first.
    var earlier: [RequestListItem] { (threads ?? []).filter { $0.phase == .done }.sorted { $0.at > $1.at } }

    func thread(_ id: String) -> RequestListItem? {
        threads?.first { $0.id.lowercased() == id.lowercased() }
    }

    func refresh() async {
        let started = epoch.current
        do {
            let dto: RequestListDTO = try await client.getJSON(Self.path)
            guard epoch.isCurrent(started) else { return }
            threads = dto.requests
            lastError = nil
        } catch {
            guard epoch.isCurrent(started), !APIError.isCancellation(error) else { return }
            let e = (error as? APIError) ?? .transport(String(describing: error))
            lastError = e
            if e == .unauthorized { onUnauthorized() }
        }
        if !pending.isEmpty { await flush() }
    }

    // MARK: - Compose

    func compose(about: RequestAbout? = nil, text: String = "") {
        draft = RequestDraft(text: text, about: about)
    }

    func followUp(_ d: RequestDetail) {
        draft = RequestDraft(text: "", about: nil, parent: (d.id, d.title))
    }

    enum SendOutcome: Equatable { case sent(String), queued, refused(APIError) }

    /// Sends what the sheet holds. The question is written to the outbox
    /// FIRST, so a crash between tap and answer still sends it; offline it
    /// stays there and Voor jou shows it as "Wacht op netwerk".
    @discardableResult
    func send(_ d: RequestDraft) async -> SendOutcome {
        let text = d.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .refused(.rejected(400)) }
        let item = PendingRequest(clientId: UUID().uuidString.lowercased(), text: text, about: d.about,
                                  parentRequestId: d.parent?.id, createdAt: now())
        pending.append(item)
        outbox?.save(pending)
        draft = nil
        sends += 1
        if let old = d.replaces {
            let _: RequestIgnored? = try? await client.postJSON("\(Self.path)/\(old)/dismiss", [String: String]())
        }
        if isOffline() { return .queued }
        let outcome = await post(item)
        await refresh()
        await onChanged()
        return outcome
    }

    /// Posts every question still on the phone, oldest first. Idempotent on
    /// the server: a question already received answers `duplicate: true`.
    func flush() async {
        guard !flushing, !isOffline() else { return }
        flushing = true
        defer { flushing = false }
        var any = false
        for item in pending {
            if case .sent = await post(item) { any = true } else { break }
        }
        if any {
            await refresh()
            await onChanged()
        }
    }

    private func post(_ item: PendingRequest) async -> SendOutcome {
        let started = epoch.current
        do {
            let r: RequestCreated = try await client.postJSON(Self.path, item.post)
            guard epoch.isCurrent(started) else { return .refused(.unauthorized) }
            drop(item.clientId)
            return .sent(r.id)
        } catch {
            let e = (error as? APIError) ?? .transport(String(describing: error))
            switch e {
            case .transport, .server, .rateLimited:
                return .queued
            case .unauthorized:
                onUnauthorized()
                return .refused(e)
            case .rejected:
                // The server refused these words for good (an item that no
                // longer exists): keeping them would retry forever.
                failures += 1
                drop(item.clientId)
                return .refused(e)
            }
        }
    }

    private func drop(_ clientId: String) {
        pending.removeAll { $0.clientId == clientId }
        outbox?.save(pending)
    }

    // MARK: - Acting on a question

    func markOpened(_ id: String) async {
        let _: RequestIgnored? = try? await client.postJSON("\(Self.path)/\(id)/opened", [String: String]())
        await onChanged()
    }

    func cancel(_ id: String) async -> Bool {
        do {
            let _: RequestIgnored = try await client.postJSON("\(Self.path)/\(id)/cancel", [String: String]())
            await refresh()
            await onChanged()
            return true
        } catch {
            failures += 1
            return false
        }
    }

    /// "Opnieuw proberen" / "Vraag opnieuw stellen": the same question, asked
    /// again. Online only: the answer names the NEW request to open.
    func retry(_ id: String) async -> String? {
        do {
            let r: RequestCreated = try await client.postJSON("\(Self.path)/\(id)/retry",
                                                              RequestRetryPost(clientId: UUID().uuidString.lowercased()))
            sends += 1
            await refresh()
            await onChanged()
            return r.id
        } catch {
            failures += 1
            return nil
        }
    }

    /// "Laat maar": the question leaves Voor jou; the toast offers the undo.
    func dismiss(_ id: String, carriesProposal: Bool) async {
        do {
            let _: RequestIgnored = try await client.postJSON("\(Self.path)/\(id)/dismiss", [String: String]())
            show(RequestToast(text: carriesProposal ? RequestText.putAwayReleasedToast : RequestText.putAwayToast,
                              undo: .undismiss(id)))
            await refresh()
            await onChanged()
        } catch {
            failures += 1
        }
    }

    /// Ticks (or unticks) a step. The LAST tick says the question is done.
    func step(_ id: String, index: Int, done: Bool, lastOpen: Bool) async -> Bool {
        do {
            let _: RequestIgnored = try await client.postJSON("\(Self.path)/\(id)/steps", RequestStepPost(index: index, done: done))
            if done && lastOpen { show(RequestToast(text: RequestText.allDoneToast, undo: .untick(id: id, index: index))) }
            await refresh()
            await onChanged()
            return true
        } catch {
            failures += 1
            return false
        }
    }

    func undo(_ toast: RequestToast) async {
        hideToast()
        switch toast.undo {
        case .undismiss(let id):
            let _: RequestIgnored? = try? await client.postJSON("\(Self.path)/\(id)/undismiss", [String: String]())
        case .untick(let id, let index):
            let _: RequestIgnored? = try? await client.postJSON("\(Self.path)/\(id)/steps", RequestStepPost(index: index, done: false))
        }
        await refresh()
        await onChanged()
    }

    func show(_ t: RequestToast, seconds: TimeInterval = RequestStore.toastSeconds) {
        toast = t
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            self?.hideToast()
        }
    }

    func hideToast() {
        toastTask?.cancel()
        toast = nil
    }

    func attachable() async -> [RequestAbout] {
        (try? await client.getJSON("\(Self.path)/attachable") as AttachableDTO)?.items ?? []
    }

    private func sessionEnded() {
        threads = nil
        pending = []
        draft = nil
        toast = nil
        outbox?.wipe()
    }

    #if DEBUG
    /// `-fixtures-vraag netwerk`: a question written offline, on the phone.
    func fixtureSeed(_ items: [PendingRequest]) {
        pending = items
    }

    /// A toast frozen for a capture.
    func fixtureToast(_ t: RequestToast) {
        toast = t
    }
    #endif
}
