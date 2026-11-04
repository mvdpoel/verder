import Foundation
import Observation
import UIKit

/// Where a Dossier row leads.
enum DossierRoute: Hashable, Sendable {
    /// The full-screen viewer. `title` is nil when a push opened it before
    /// the row was known; the viewer then looks it up.
    case document(id: String, title: String?)
    /// The viewer with "Toon aan de balie" already up: a row's long-press menu.
    case counter(id: String)
    case task(String)
    /// The Tijdlijn: the case as a metro map (`TimelineScreen`).
    case timeline
    /// The Tijdlijn with the NU sheet raised: the headline card's tap.
    case timelineNow
}

/// The words and choices of the Dossier tab, decided outside the view.
enum DossierCopy {
    static let title = "Dossier"
    static let headlineLabel = "WAAR HET NU OP WACHT"
    static let tasksLabel = "OPEN TAKEN"
    static let documentsLabel = "DOCUMENTEN"
    static let serverLabel = "OP DE SERVER"
    static let searchPrompt = "Zoek in titel en tekst"
    static let searchServer = "Zoek op de server"
    static let serverNeedsNetwork = "Zoeken op de server kan niet offline."
    static let noLocalHits = "Niets gevonden op je telefoon."
    static let noServerHits = "Ook op de server niets gevonden."
    static let noDocuments = "Nog geen documenten op je telefoon. Ze komen binnen zodra Grip bereikbaar is."
    static let noTasks = "Geen open taken."
    static let tasksOffline = "Taken zijn offline niet te zien."
    static let noHeadline = "Geen open halte op de kaart."
    static let offline = "Geen verbinding — je ziet wat je telefoon al had."
    static let serverError = "Grip is even niet bereikbaar. Je ziet wat je telefoon al had."
    static let badDownload = "Een document kwam niet goed binnen. Trek omlaag om het opnieuw te proberen."

    /// The documents the server lists that the phone could not take in; nil
    /// when there are none. Grip retries them itself on every sync, so the
    /// line asks Martin to do nothing.
    static func notHeldLine(_ count: Int) -> String? {
        switch count {
        case ..<1: return nil
        case 1: return "1 document staat nog niet op je telefoon. Grip probeert het bij elke update opnieuw."
        default: return "\(count) documenten staan nog niet op je telefoon. Grip probeert het bij elke update opnieuw."
        }
    }
    static let retry = "Opnieuw proberen"

    /// The search field's text as one line: at the accessibility sizes the
    /// field wraps (a vertical TextField), where Return would type a newline.
    static func searchLine(_ typed: String) -> String {
        typed.contains(where: \.isNewline)
            ? typed.split(whereSeparator: \.isNewline).joined(separator: " ")
            : typed
    }

    /// The docmeta vocabulary in Dutch; a soort Martin typed himself stays as typed.
    static func docTypeLabel(_ docType: String?) -> String? {
        guard let t = docType?.trimmingCharacters(in: .whitespaces), !t.isEmpty else { return nil }
        switch t.lowercased() {
        case "letter": return "brief"
        case "payslip": return "loonstrook"
        case "contract": return "contract"
        case "invoice": return "factuur"
        case "bank-statement": return "bankafschrift"
        case "id-document": return "id-bewijs"
        case "other": return "overig"
        default: return t
        }
    }

    static func statusLabel(_ status: String) -> String {
        status == "filed" ? "opgeborgen" : "in de inbox"
    }

    private static var amsterdam: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
        return cal
    }

    /// "26 okt 2026", on Amsterdam's calendar.
    static func day(_ date: Date) -> String {
        "\(MoneyFormat.day(date)) \(amsterdam.component(.year, from: date))"
    }

    /// "offline · bijgewerkt 14:02" — the age of what is shown, in Amsterdam
    /// time; with the day when it was not today. Nil when there is nothing to
    /// say (online and never synced: the skeleton says it).
    static func freshness(syncedAt: Date?, offline: Bool, now: Date = Date()) -> String? {
        let prefix = offline ? "offline · " : ""
        guard let at = syncedAt else { return offline ? "\(prefix)nog niet bijgewerkt" : nil }
        let cal = amsterdam
        let c = cal.dateComponents([.hour, .minute], from: at)
        let time = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
        let when = cal.isDate(at, inSameDayAs: now) ? time : "\(MoneyFormat.day(at)) \(time)"
        return "\(prefix)bijgewerkt \(when)"
    }

    /// The eyebrow above the title: "bijgewerkt 14:02", "offline ·
    /// bijgewerkt 14:02", "bijwerken… · 2 van 3 nieuw" while a later sync
    /// takes documents in, and "nog niet bijgewerkt" before the first sync
    /// finished (the first-sync card says the rest). Nil while the phone's
    /// copy is not read yet.
    static func eyebrow(loaded: Bool, syncedAt: Date?, freshness: String?, updating: DossierStore.Progress?) -> String? {
        guard loaded else { return freshness }
        if syncedAt == nil { return "nog niet bijgewerkt" }
        if let updating, updating.due > 0 { return DossierProgressCopy.updating(done: updating.done, due: updating.due) }
        return freshness
    }

    /// How many open tasks the tab lists before "Toon alle": two, one at a
    /// compact height (the iPhone SE frame), so the documents still start
    /// on the first screen.
    static func tasksShown(compact: Bool) -> Int { compact ? 1 : 2 }
    static func seeAllTasks(_ n: Int) -> String { "Toon alle \(n)" }

    /// The open tasks as the tab lists them: the most pressing first — the
    /// earliest due (overdue ones lead), then those without a date, in the
    /// server's order.
    static func byDue(_ tasks: [TaskDTO]) -> [TaskDTO] {
        tasks.enumerated().sorted { a, b in
            switch (a.element.dueAt, b.element.dueAt) {
            case let (x?, y?): x != y ? x < y : a.offset < b.offset
            case (_?, nil): true
            case (nil, _?): false
            case (nil, nil): a.offset < b.offset
            }
        }.map(\.element)
    }

    /// Waiting on Martin by the one definition (`WAITING_TASK_STATUSES` in
    /// waiting.ts), in the server's order.
    static func openTasks(_ tasks: [TaskDTO]) -> [TaskDTO] {
        tasks.filter { $0.status == "open" || $0.status == "in-progress" }
    }

    /// `?q=` with everything but unreserved characters escaped — `+` above
    /// all, which URLSearchParams would read back as a space.
    static func searchPath(_ q: String) -> String {
        // ASCII only: `.alphanumerics` holds every Unicode letter, which
        // would leave "á" unescaped.
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        let encoded = q.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
        return "/api/mobile/v1/search?q=\(encoded)"
    }
}

/// What the Dossier tab shows: the phone's own copy of the dossier (read from
/// disk first, so it renders at once and offline), the open tasks, and the
/// server's search when Martin asks for it.
@MainActor
@Observable
final class DossierModel {
    enum ServerSearch: Equatable {
        case idle
        case loading(String)
        case done(query: String, hits: [SearchHit])
        case failed(String)
        /// No answer within `serverTimeout`: "Je zoekterm staat nog klaar."
        case timedOut
    }

    private(set) var docs: [IndexedDoc] = []
    /// False until the disk copy has been read: the tab shows a skeleton.
    private(set) var loaded = false
    private(set) var syncedAt: Date?
    /// Documents the server lists that the phone does not hold (see
    /// `DossierStore.State.notHeld`).
    private(set) var notHeldCount = 0
    /// The documents behind `notHeldCount`: the viewer offers "Haal nu op".
    private(set) var notHeldDocs: [DossierDoc] = []
    private(set) var isSyncing = false
    /// The running sync's progress; kept after a FIRST sync that stopped
    /// half-way, so its card can say how far it got ("onderbroken").
    private(set) var progress: DossierStore.Progress?
    /// When the running sync started, and what the phone held then: the
    /// first-sync card's estimate is this run's rate, not the dossier's.
    @ObservationIgnored private var runStartedAt: Date?
    @ObservationIgnored private var bytesAtStart = 0
    /// Bumped by every reload: the viewer looks again (a link opened before
    /// the first sync finds out afterwards that its document is not held).
    private(set) var revision = 0
    /// The soort the list is narrowed to (`DossierKinds.key`); nil for all.
    /// It narrows the search too ("Het filter geldt ook als je zoekt.").
    var kind: String?
    /// The search bar is up (the field tapped, or a query typed): the tab's
    /// header gives way to it, and "Annuleer" leaves it.
    var searchActive = false
    /// The last sync had no network: actions that need the server say so.
    private(set) var offline = false
    /// The last sync's failure, in Dutch; nil after a good one.
    private(set) var message: String?
    /// Nil until fetched (and while offline).
    private(set) var tasks: [TaskDTO]?
    private(set) var server: ServerSearch = .idle
    var query = "" {
        didSet {
            switch server {
            case .loading(let q) where q != query, .done(let q, _) where q != query: server = .idle
            default: break
            }
        }
    }

    @ObservationIgnored let store: DossierStore
    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void
    @ObservationIgnored private let isProtectedDataAvailable: @MainActor () -> Bool
    @ObservationIgnored private let epoch: SessionEpoch
    /// The case's clock (`AppServices.now`): "bijgewerkt" and every due date.
    @ObservationIgnored let now: @Sendable () -> Date
    /// The server search's limit ("binnen 10 seconden geen antwoord"). The
    /// app's network layer sets no timeout of its own (URLSession's 60 s).
    @ObservationIgnored let serverTimeout: Duration

    init(store: DossierStore, client: APIClient, onUnauthorized: @escaping @MainActor () -> Void = {},
         isProtectedDataAvailable: @escaping @MainActor () -> Bool = { UIApplication.shared.isProtectedDataAvailable },
         epoch: SessionEpoch = SessionEpoch(), now: @escaping @Sendable () -> Date = { Date() },
         serverTimeout: Duration = .seconds(10)) {
        self.now = now
        self.serverTimeout = serverTimeout
        self.store = store
        self.epoch = epoch
        self.client = client
        self.onUnauthorized = onUnauthorized
        self.isProtectedDataAvailable = isProtectedDataAvailable
        epoch.whenEnded { [weak self] in
            guard let self else { return }
            self.forgetInMemory()
            let store = self.store
            Task { await store.wipe() }
        }
    }

    var results: [IndexedDoc] { DossierSearch.search(query, in: DossierKinds.filter(docs, kind: kind)) }
    var isSearching: Bool { !DossierSearch.words(query).isEmpty }
    var freshness: String? { DossierCopy.freshness(syncedAt: syncedAt, offline: offline, now: now()) }
    var notHeldLine: String? { DossierCopy.notHeldLine(notHeldCount) }

    /// The soort chips, counted on the phone's copy.
    var kinds: [DossierKind] { DossierKinds.counts(docs) }
    /// What the Documenten label and the "Alles" chip count
    /// (`DossierProgressCopy.documentCount`).
    var documentCount: Int {
        DossierProgressCopy.documentCount(held: docs.count, syncing: isSyncing, total: progress?.total)
    }
    /// A first sync's list: every held document and a place for each one on
    /// its way, newest first (`DossierProgressCopy.rows`).
    var firstSyncRows: [DossierProgressCopy.Row] {
        DossierProgressCopy.rows(held: docs, waiting: progress?.waiting ?? [])
    }
    /// The list as the chips narrow it.
    var shownDocs: [IndexedDoc] { DossierKinds.filter(docs, kind: kind) }
    /// The list as drawn after the first sync (`DossierProgressCopy.listRows`).
    var listRows: [DossierProgressCopy.Row] {
        DossierProgressCopy.listRows(shown: shownDocs, waiting: progress?.waiting ?? [],
                                     syncing: isSyncing && syncedAt != nil, filtered: kind != nil)
    }
    /// Held documents with no recognised text: found by their title only.
    var titleOnlyCount: Int { docs.filter { !$0.doc.hasText }.count }

    /// The eyebrow above the title (`DossierCopy.eyebrow`).
    var eyebrow: String? {
        DossierCopy.eyebrow(loaded: loaded, syncedAt: syncedAt, freshness: freshness,
                            updating: isSyncing && syncedAt != nil ? progress : nil)
    }

    /// The first sync's card, while it runs and after it stopped half-way;
    /// nil once a sync has finished (or before one started).
    var firstSyncCard: DossierProgressCopy.Card? {
        guard loaded, syncedAt == nil, let progress, isSyncing || progress.done < progress.due || progress.more else {
            return nil
        }
        let held = docs.reduce(0) { $0 + $1.doc.sizeBytes }
        let bytesLeft = progress.totalBytes.map { max(0, $0 - held) } ?? 0
        let eta = runStartedAt.flatMap {
            DossierProgressCopy.eta(bytesThisRun: held - bytesAtStart, elapsed: now().timeIntervalSince($0), bytesLeft: bytesLeft)
        }
        return DossierProgressCopy.card(held: docs.count, heldBytes: held, total: progress.total,
                                        totalBytes: progress.totalBytes, interrupted: !isSyncing,
                                        offline: offline, eta: eta)
    }

    /// The server's hits that are new to the phone, grouped by kind.
    var serverGroups: [ServerHitGroup] {
        guard case .done(_, let hits) = server else { return [] }
        return ServerHits.groups(ServerHits.fresh(hits, held: Set(docs.map(\.id))))
    }

    /// "Annuleer": the query, the server's answer and the bar go.
    func cancelSearch() {
        query = ""
        searchActive = false
        server = .idle
    }

    func doc(_ id: String) -> DossierDoc? { docs.first { $0.id == id }?.doc }
    /// The record the server listed for a document the phone could not take in.
    func notHeldDoc(_ id: String) -> DossierDoc? { notHeldDocs.first { $0.id == id } }

    /// "Haal nu op": takes one document in and keeps it (`DossierStore.take`).
    /// True when it is on the phone afterwards.
    func takeIn(_ doc: DossierDoc) async -> Bool {
        let started = epoch.current
        do {
            let held = try await store.take(doc, client: client)
            guard epoch.isCurrent(started) else { return false }
            await reload()
            return held
        } catch {
            guard epoch.isCurrent(started), !Self.isInterruption(error) else { return false }
            _ = handle(error)
            return false
        }
    }

    /// What the Tijdlijn needs before it can describe a document behind a
    /// stop (its soort, and whether it opens offline): the phone's copy read,
    /// and synced once if it never was. ONE spelling for every path the
    /// Tijdlijn is opened from — pushed from Overzicht before Dossier was ever
    /// opened, `doc(_:)` would otherwise answer nil and the row lose its soort.
    func prepareForTimeline(isLocked: Bool, isActive: Bool) async {
        await loadCached()
        if syncedAt == nil { await refresh(isLocked: isLocked, isActive: isActive) }
    }

    /// The disk copy, before any network. While the phone's copy cannot be
    /// read yet (a launch while locked), `loaded` stays false — the skeleton,
    /// never "no documents" — and the next call tries again.
    func loadCached() async {
        guard !loaded else { return }
        await reload()
    }

    /// Syncs the dossier and fetches the open tasks — only when
    /// `DossierSyncPolicy` allows it (unlocked, in the foreground).
    func refresh(isLocked: Bool, isActive: Bool) async {
        guard DossierSyncPolicy.maySync(isLocked: isLocked, isActive: isActive), !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }
        async let synced: Void = sync()
        async let fetched: Void = fetchTasks()
        _ = await (synced, fetched)
    }

    /// Asks the server for the query as typed now. The answer is shown only
    /// while that same query is still in the field: typing on resets the
    /// search (the `query` didSet), and a reply for an older query is dropped.
    func searchServer() async {
        let started = epoch.current
        let sent = query
        let q = sent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, !offline else { return }
        server = .loading(sent)
        let next: ServerSearch
        do {
            let results = try await Self.withTimeout(serverTimeout) { [client] () async throws -> SearchResults in
                try await client.getJSON(DossierCopy.searchPath(String(q.prefix(500))))
            }
            next = .done(query: sent, hits: results.hits)
        } catch is TimedOut {
            next = .timedOut
        } catch {
            guard !Self.isInterruption(error) else {
                if server == .loading(sent) { server = .idle }
                return
            }
            guard epoch.isCurrent(started) else { return }
            next = .failed(handle(error))
        }
        guard epoch.isCurrent(started), server == .loading(sent), query == sent else { return }
        server = next
    }

    struct TimedOut: Error {}

    /// The operation's answer, or `TimedOut` once `limit` passes first; the
    /// loser is cancelled.
    nonisolated static func withTimeout<T: Sendable>(_ limit: Duration,
                                                     _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(for: limit)
                throw TimedOut()
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw TimedOut() }
            return first
        }
    }

    /// Forgets the phone's copy and everything the tab shows about it. The
    /// session's end (`SessionEpoch`) does this by itself; Meer's sign-out
    /// also awaits it, so the files are gone before the sheet closes.
    func wipe() async {
        forgetInMemory()
        await store.wipe()
    }

    /// The query and the server's hits go too: "huur" over a list of hits is
    /// case content as much as the documents are.
    private func forgetInMemory() {
        docs = []
        syncedAt = nil
        notHeldCount = 0
        notHeldDocs = []
        progress = nil
        kind = nil
        searchActive = false
        tasks = nil
        query = ""
        server = .idle
        message = nil
        offline = false
    }

    /// Every write after an await is checked against the epoch it started
    /// in: a sync that outlives its session leaves the wiped tab wiped.
    private func sync() async {
        let started = epoch.current
        runStartedAt = now()
        bytesAtStart = docs.reduce(0) { $0 + $1.doc.sizeBytes }
        let sink: DossierStore.ProgressSink = { [weak self] p in await self?.didProgress(p, started: started) }
        do {
            try await store.sync(client: client, progress: sink)
            guard epoch.isCurrent(started) else { return }
            offline = false
            message = nil
            progress = nil
        } catch DossierStore.SyncError.unavailable {
            // Not a failure: the copy is still locked away; tried again on unlock.
        } catch where Self.isInterruption(error) || !isProtectedDataAvailable() {
            // Not a failure either, and above all not "offline": the tab was
            // left (SwiftUI cancelled its `.task`), or the phone locked and
            // the `.complete` files refused the write. What was applied is
            // kept; the next foreground refresh after unlock carries on.
        } catch DossierStore.SyncError.wiped {
            // Wiped while this sync waited: nothing to report.
        } catch {
            guard epoch.isCurrent(started) else { return }
            // `handle` can end the epoch itself (a 401 rejects the session,
            // whose ender wipes the tab): look again before writing.
            let text = handle(error)
            guard epoch.isCurrent(started) else { return }
            message = text
        }
        guard epoch.isCurrent(started) else { return }
        await reload()
    }

    /// Each settled document shows at once: a first sync's list fills while
    /// it runs, rather than all at the end.
    private func didProgress(_ p: DossierStore.Progress, started: Int) async {
        guard epoch.isCurrent(started) else { return }
        let grew = p.done != progress?.done
        progress = p
        if grew { await reload() }
    }

    private func fetchTasks() async {
        let started = epoch.current
        do {
            let all: [TaskDTO] = try await client.getJSON("/api/mobile/v1/tasks")
            guard epoch.isCurrent(started) else { return }
            tasks = DossierCopy.openTasks(all)
        } catch {
            // The sync reports the failure; a task list that cannot load just stays as it was.
        }
    }

    private func reload() async {
        let started = epoch.current
        guard await store.load() else { return }
        let docs = await store.indexed()
        let syncedAt = await store.lastSyncedAt
        let notHeld = await store.notHeld()
        guard epoch.isCurrent(started) else { return }
        self.docs = docs
        self.syncedAt = syncedAt
        self.notHeldCount = notHeld.count
        self.notHeldDocs = notHeld
        loaded = true
        revision += 1
    }

    /// The caller stopped waiting — never a fact about the network or disk.
    private static func isInterruption(_ error: any Error) -> Bool {
        Task.isCancelled || APIError.isCancellation(error)
    }

    private func handle(_ error: any Error) -> String {
        switch error as? APIError {
        case .unauthorized?:
            onUnauthorized()
            return "Log opnieuw in."
        case .transport?:
            offline = true
            return DossierCopy.offline
        case nil where error is DossierStore.SyncError:
            return DossierCopy.badDownload
        default:
            return DossierCopy.serverError
        }
    }
}
