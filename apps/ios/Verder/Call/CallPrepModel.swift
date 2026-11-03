import Foundation
import Observation

/// One party's call sheet: the talking points, what Martin ticked, and how
/// fresh the points are. The phone's copy is shown first (offline included,
/// with its age), then replaced by the server's answer — ticks survive the
/// refresh, because the point ids are stable.
@MainActor
@Observable
final class CallPrepModel {
    enum Screen: Equatable {
        case loading
        case points
        case offlineNothingCached
        case notFound
        case failed
    }

    let partyId: String
    /// From the entry point at first (the Dossier row, the proposal's sender),
    /// then the server's.
    private(set) var partyName: String?
    private(set) var dto: TalkingPointsDTO?
    private(set) var checklist: CallChecklist
    private(set) var savedAt: Date?
    private(set) var offline = false
    private(set) var notFound = false
    private(set) var lastError: APIError?
    private(set) var isLoading = false
    /// The AI line's sources, unfolded by a tap on it.
    var showsSummarySources = false

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let cache: CallCache
    @ObservationIgnored private let now: @MainActor () -> Date
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void
    /// Called after every tick, so the session can update the Live Activity.
    @ObservationIgnored var onChecklistChanged: @MainActor () -> Void = {}

    init(partyId: String, name: String?, client: APIClient, cache: CallCache,
         now: @escaping @MainActor () -> Date = { Date() },
         onUnauthorized: @escaping @MainActor () -> Void = {}) {
        self.partyId = partyId
        self.partyName = name
        self.client = client
        self.cache = cache
        self.now = now
        self.onUnauthorized = onUnauthorized
        checklist = CallChecklist(TalkingPointsDTO(party: .init(id: partyId, name: name ?? ""), tell: [], ask: [], summary: nil))
    }

    static func path(_ partyId: String) -> String? {
        UUID(uuidString: partyId).map { "/api/mobile/v1/parties/\($0.uuidString.lowercased())/talking-points" }
    }

    var screen: Screen {
        if dto != nil { return .points }
        if notFound { return .notFound }
        if offline { return .offlineNothingCached }
        if lastError != nil, !isLoading { return .failed }
        return .loading
    }

    /// "offline · bijgewerkt 09:41" — the age of what is shown.
    var freshness: String? {
        dto == nil ? nil : DossierCopy.freshness(syncedAt: savedAt, offline: offline, now: now())
    }

    var dialURL: URL? { CallCopy.dialURL(dto?.party.phone) }
    var phone: String? { dto?.party.phone }

    func toggle(_ id: String) {
        checklist.toggle(id)
        onChecklistChanged()
    }

    /// The phone's copy first, then the server.
    func load() async {
        if dto == nil, let entry = cache.load(partyId) { show(entry.points, at: entry.savedAt) }
        guard let path = Self.path(partyId) else { notFound = true; return }
        isLoading = true
        defer { isLoading = false }
        do {
            let fresh: TalkingPointsDTO = try await client.getJSON(path)
            let at = now()
            show(fresh, at: at)
            offline = false
            lastError = nil
            notFound = false
            try? cache.save(.init(savedAt: at, points: fresh), for: partyId)
        } catch {
            if APIError.isCancellation(error) { return }
            let api = error as? APIError ?? .transport(String(describing: error))
            switch api {
            case .unauthorized: onUnauthorized()
            case .transport: offline = true
            case .rejected(404): notFound = dto == nil
            default: lastError = api
            }
        }
    }

    private func show(_ points: TalkingPointsDTO, at: Date) {
        dto = points
        savedAt = at
        partyName = points.party.name
        checklist.replace(with: points)
        onChecklistChanged()
    }
}
