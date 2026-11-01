import Foundation
import Observation
import UIKit

/// Where a Dossier row leads.
enum DossierRoute: Hashable, Sendable {
    /// The full-screen viewer. `title` is nil when a push opened it before
    /// the row was known; the viewer then looks it up.
    case document(id: String, title: String?)
    case task(String)
}

/// The words and choices of the Dossier tab, decided outside the view.
enum DossierCopy {
    static let title = "Dossier"
    static let headlineLabel = "WAAR HET NU OP WACHT"
    static let tasksLabel = "OPEN TAKEN"
    static let documentsLabel = "DOCUMENTEN"
    static let serverLabel = "OP DE SERVER"
    static let searchPrompt = "Zoek in je dossier"
    static let searchServer = "Zoek op de server"
    static let serverNeedsNetwork = "Zoeken op de server kan niet offline."
    static let noLocalHits = "Niets gevonden op je telefoon."
    static let noServerHits = "Ook op de server niets gevonden."
    static let noDocuments = "Nog geen documenten op je telefoon. Ze komen binnen zodra verder bereikbaar is."
    static let noTasks = "Geen open taken."
    static let tasksOffline = "Taken zijn offline niet te zien."
    static let noHeadline = "Geen open halte op de kaart."
    static let offline = "Geen verbinding — je ziet wat je telefoon al had."
    static let serverError = "verder is even niet bereikbaar. Je ziet wat je telefoon al had."
    static let badDownload = "Een document kwam niet goed binnen. Trek omlaag om het opnieuw te proberen."

    /// The documents the server lists that the phone could not take in; nil
    /// when there are none. verder retries them itself on every sync, so the
    /// line asks Martin to do nothing.
    static func notHeldLine(_ count: Int) -> String? {
        switch count {
        case ..<1: return nil
        case 1: return "1 document staat nog niet op je telefoon. verder probeert het bij elke update opnieuw."
        default: return "\(count) documenten staan nog niet op je telefoon. verder probeert het bij elke update opnieuw."
        }
    }
    static let retry = "Opnieuw proberen"

    /// The docmeta vocabulary in Dutch; a soort Martin typed himself stays as typed.
    static func docTypeLabel(_ docType: String?) -> String? {
        guard let t = docType?.trimmingCharacters(in: .whitespaces), !t.isEmpty else { return nil }
        switch t.lowercased() {
        case "letter": return "brief"
        case "payslip": return "loonstrook"
        case "contract": return "contract"
        case "invoice": return "factuur"
        case "bank-statement": return "bankafschrift"
        case "id-document": return "identiteitsbewijs"
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

    /// "26 okt 2026 · loonstrook · opgeborgen".
    static func rowLine(_ doc: DossierDoc) -> String {
        [day(doc.receivedAt), docTypeLabel(doc.docType), statusLabel(doc.status)]
            .compactMap { $0 }.joined(separator: " · ")
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
    }

    private(set) var docs: [IndexedDoc] = []
    /// False until the disk copy has been read: the tab shows a skeleton.
    private(set) var loaded = false
    private(set) var syncedAt: Date?
    /// Documents the server lists that the phone does not hold (see
    /// `DossierStore.State.notHeld`).
    private(set) var notHeldCount = 0
    private(set) var isSyncing = false
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

    init(store: DossierStore, client: APIClient, onUnauthorized: @escaping @MainActor () -> Void = {},
         isProtectedDataAvailable: @escaping @MainActor () -> Bool = { UIApplication.shared.isProtectedDataAvailable }) {
        self.store = store
        self.client = client
        self.onUnauthorized = onUnauthorized
        self.isProtectedDataAvailable = isProtectedDataAvailable
    }

    var results: [IndexedDoc] { DossierSearch.search(query, in: docs) }
    var isSearching: Bool { !DossierSearch.words(query).isEmpty }
    var freshness: String? { DossierCopy.freshness(syncedAt: syncedAt, offline: offline) }
    var notHeldLine: String? { DossierCopy.notHeldLine(notHeldCount) }

    func doc(_ id: String) -> DossierDoc? { docs.first { $0.id == id }?.doc }

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
        let sent = query
        let q = sent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, !offline else { return }
        server = .loading(sent)
        let next: ServerSearch
        do {
            let results: SearchResults = try await client.getJSON(DossierCopy.searchPath(String(q.prefix(500))))
            next = .done(query: sent, hits: results.hits)
        } catch {
            guard !Self.isInterruption(error) else {
                if server == .loading(sent) { server = .idle }
                return
            }
            next = .failed(handle(error))
        }
        guard server == .loading(sent), query == sent else { return }
        server = next
    }

    func wipe() async {
        await store.wipe()
        docs = []
        syncedAt = nil
        notHeldCount = 0
        tasks = nil
    }

    private func sync() async {
        do {
            try await store.sync(client: client)
            offline = false
            message = nil
        } catch DossierStore.SyncError.unavailable {
            // Not a failure: the copy is still locked away; tried again on unlock.
        } catch where Self.isInterruption(error) || !isProtectedDataAvailable() {
            // Not a failure either, and above all not "offline": the tab was
            // left (SwiftUI cancelled its `.task`), or the phone locked and
            // the `.complete` files refused the write. What was applied is
            // kept; the next foreground refresh after unlock carries on.
        } catch {
            message = handle(error)
        }
        await reload()
    }

    private func fetchTasks() async {
        do {
            let all: [TaskDTO] = try await client.getJSON("/api/mobile/v1/tasks")
            tasks = DossierCopy.openTasks(all)
        } catch {
            // The sync reports the failure; a task list that cannot load just stays as it was.
        }
    }

    private func reload() async {
        guard await store.load() else { return }
        docs = await store.indexed()
        syncedAt = await store.lastSyncedAt
        notHeldCount = await store.notHeld().count
        loaded = true
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
