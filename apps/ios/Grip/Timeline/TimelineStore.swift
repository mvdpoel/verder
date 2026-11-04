import Foundation
import Observation

/// The phone's copy of the case map, so the Tijdlijn shows at a counter with
/// no network — WITH its age, never as if it were live.
///
/// WHERE: `Application Support/timeline`, never the App Group (no extension
/// reads it). One file per view (`case-map.json`, `case-map-verborgen.json`),
/// written `[.atomic, .completeFileProtection]` and excluded from backups: it
/// is rebuilt from the server, and a backup would carry the case into iCloud.
/// A read that fails (the phone is locked) is simply nothing cached.
struct TimelineCache: Sendable {
    typealias Writer = @Sendable (Data, URL, Data.WritingOptions) throws -> Void
    typealias Reader = @Sendable (URL) throws -> Data

    static let writeOptions: Data.WritingOptions = [.atomic, .completeFileProtection]
    static let defaultWriter: Writer = { try $0.write(to: $1, options: $2) }
    static let defaultReader: Reader = { try Data(contentsOf: $0) }

    struct Entry: Codable, Equatable, Sendable {
        let savedAt: Date
        let map: CaseMapDTO
    }

    let dir: URL
    var write: Writer = Self.defaultWriter
    var read: Reader = Self.defaultReader

    static var live: TimelineCache {
        TimelineCache(dir: URL.applicationSupportDirectory.appending(path: "timeline", directoryHint: .isDirectory))
    }

    func url(hidingDebts: Bool) -> URL {
        dir.appending(path: hidingDebts ? "case-map-verborgen.json" : "case-map.json")
    }

    func load(hidingDebts: Bool) -> Entry? {
        guard let data = try? read(url(hidingDebts: hidingDebts)) else { return nil }
        return try? APIClient.jsonDecoder.decode(Entry.self, from: data)
    }

    func save(_ entry: Entry, hidingDebts: Bool) throws {
        var folder = dir
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? folder.setResourceValues(values)
        try write(try APIClient.jsonEncoder.encode(entry), url(hidingDebts: hidingDebts), Self.writeOptions)
    }

    func wipe() {
        try? FileManager.default.removeItem(at: dir)
    }
}

/// The Tijdlijn's data: `GET /api/mobile/v1/case-map`, read when the screen
/// opens and on a pull. The phone's copy is shown first (offline included, with
/// its age), then replaced by the server's answer.
///
/// SESSION: shares auth's one `SessionEpoch`. An answer that arrives after the
/// session ended is dropped (its 401 included), and the ending forgets the map
/// AND the copy on disk — the copy names the case.
@MainActor
@Observable
final class TimelineStore {
    static let basePath = "/api/mobile/v1/case-map"

    /// The web's own switch: `?schuldeisers=verborgen` filters the map's input
    /// on the server, so bands and lanes are rebuilt, never post-filtered.
    static func path(hidingDebts: Bool) -> String {
        hidingDebts ? basePath + "?schuldeisers=verborgen" : basePath
    }

    /// What the screen shows, decided here so the view only draws it.
    enum Screen: Equatable {
        /// Nothing known yet and a request out: the skeleton.
        case loading
        case map(CaseMapDTO)
        /// The server answered with a map that has no stops.
        case empty
        case offlineNothingCached
        case failed(APIError)
    }

    private(set) var map: CaseMapDTO?
    /// When `map` was fetched; for a cached map, the time it was cached.
    private(set) var savedAt: Date?
    private(set) var offline = false
    private(set) var lastError: APIError?
    private(set) var isLoading = false
    private(set) var hideDebts = false
    /// When the last request failed (the header's "niet geladen · 14:05").
    private(set) var failedAt: Date?
    /// Counts failures after a retry, so the screen plays `.error` on the second.
    private(set) var failedRetries = 0
    /// The full map as this phone last saw it, while the filter is on: how many
    /// open stops the filter took off is said, never hidden.
    private(set) var unfiltered: CaseMapDTO?

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let cache: TimelineCache
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void
    @ObservationIgnored private let epoch: SessionEpoch
    /// The case's clock (`AppServices.now`): what "te laat" and "van 09:20" read.
    @ObservationIgnored let now: @Sendable () -> Date

    init(client: APIClient, cache: TimelineCache, onUnauthorized: @escaping @MainActor () -> Void = {},
         epoch: SessionEpoch = SessionEpoch(), now: @escaping @Sendable () -> Date = { Date() }) {
        self.client = client
        self.cache = cache
        self.onUnauthorized = onUnauthorized
        self.epoch = epoch
        self.now = now
        epoch.whenEnded { [weak self] in self?.forget() }
    }

    /// A failed screen stays up while its retry runs: the button shows the
    /// progress, the page does not fall back to a skeleton.
    var screen: Screen {
        if let map { return map.stops.isEmpty ? .empty : .map(map) }
        if offline { return .offlineNothingCached }
        if let lastError { return .failed(lastError) }
        return .loading
    }

    /// What the header says under the title — decided here, drawn as is.
    enum HeaderLine: Equatable {
        /// "4 sporen · 14 haltes · nieuwste 30 okt" (one fact per part).
        case stats([String])
        /// "1 spoor verborgen" and, when known, "daarin wacht 1 op jou".
        case hidden(String, String?)
        /// "offline · tijdlijn van 09:20".
        case offline(String)
        /// "niet geladen · 14:05".
        case failed(String)
        case none
    }

    var headerLine: HeaderLine {
        let now = now()
        if let map {
            if offline { return .offline(TimelineCopy.kept("offline", savedAt: savedAt, now: now)) }
            if lastError != nil { return .failed(TimelineCopy.kept("niet bijgewerkt", savedAt: savedAt, now: now)) }
            if map.debtEpisodesHidden {
                let open = TimelineCopy.hiddenOpen(full: unfiltered, shown: map) ?? 0
                return .hidden(TimelineCopy.hiddenCount(map.hiddenDebtTrackCount),
                               open > 0 ? TimelineCopy.hiddenOpenLine(open) : nil)
            }
            return .stats(TimelineCopy.stats(map))
        }
        if lastError != nil { return .failed(TimelineCopy.notLoaded(at: failedAt, now: now)) }
        if offline { return .offline("offline") }
        return .none
    }

    /// "offline · bijgewerkt 14:02" — the age of what is shown.
    var freshness: String? {
        map == nil ? nil : DossierCopy.freshness(syncedAt: savedAt, offline: offline, now: now())
    }

    /// The hidden open stops, when the full map is known: "Toon alle sporen"
    /// scrolls to the first of them.
    var hiddenOpenStopIds: [String] {
        guard let map, map.debtEpisodesHidden, let full = unfiltered else { return [] }
        let shown = Set(map.stops.map(\.id))
        return full.stops.filter { $0.state == "open" && !shown.contains($0.id) }.sorted { $0.row < $1.row }.map(\.id)
    }

    /// The phone's copy first, then the server.
    func load() async {
        showCached()
        await refresh()
    }

    func setHideDebts(_ hide: Bool) async {
        guard hide != hideDebts else { return }
        // The full map, kept while the filter is on (memory, or the phone's copy).
        if hide { unfiltered = (map?.debtEpisodesHidden == false ? map : nil) ?? cache.load(hidingDebts: false)?.map }
        hideDebts = hide
        map = nil
        savedAt = nil
        lastError = nil
        showCached()
        await refresh()
    }

    func refresh() async {
        let started = epoch.current
        let hide = hideDebts
        let retrying = lastError != nil
        isLoading = true
        let result = await Self.fetch(client, path: Self.path(hidingDebts: hide))
        guard epoch.isCurrent(started) else { return }
        isLoading = false
        // The switch moved while this was in flight: its answer is for the other view.
        guard hide == hideDebts else { return }
        switch result {
        case .success(let dto):
            let at = now()
            map = dto
            savedAt = at
            offline = false
            lastError = nil
            failedAt = nil
            if !dto.debtEpisodesHidden { unfiltered = nil }
            try? cache.save(.init(savedAt: at, map: dto), hidingDebts: hide)
        case .failure(let error):
            if APIError.isCancellation(error) { return }
            if error == .unauthorized { onUnauthorized(); return }
            failedAt = now()
            if case .transport = error {
                offline = true
                lastError = nil
            } else {
                offline = false
                lastError = error
                if retrying { failedRetries += 1 }
            }
        }
    }

    private func showCached() {
        guard map == nil, let entry = cache.load(hidingDebts: hideDebts) else { return }
        map = entry.map
        savedAt = entry.savedAt
    }

    private func forget() {
        map = nil
        savedAt = nil
        offline = false
        lastError = nil
        isLoading = false
        failedAt = nil
        unfiltered = nil
        cache.wipe()
    }

    nonisolated private static func fetch(_ client: APIClient, path: String) async -> Result<CaseMapDTO, APIError> {
        do {
            let dto: CaseMapDTO = try await client.getJSON(path)
            return .success(dto)
        } catch let error as APIError {
            return .failure(error)
        } catch {
            return .failure(APIError.isCancellation(error) ? .cancelled : .transport(String(describing: error)))
        }
    }
}
