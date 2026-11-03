import Foundation
import Observation

/// The phone's copy of the newest summary it read, so the Weekoverzicht shows
/// with no network — WITH its stand ("stand van zo 1 nov 19:02"), never as if
/// it were live. Same rules as `TimelineCache`: Application Support (never the
/// App Group), `[.atomic, .completeFileProtection]`, excluded from backups,
/// wiped when the session ends. A read that fails is simply nothing kept.
struct WeeklyCache: Sendable {
    struct Entry: Codable, Equatable, Sendable {
        let savedAt: Date
        let summary: WeeklyDTO
    }

    let dir: URL

    static var live: WeeklyCache {
        WeeklyCache(dir: URL.applicationSupportDirectory.appending(path: "weekly", directoryHint: .isDirectory))
    }

    var url: URL { dir.appending(path: "weekly.json") }

    func load() -> Entry? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? APIClient.jsonDecoder.decode(Entry.self, from: data)
    }

    func save(_ entry: Entry) throws {
        var folder = dir
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? folder.setResourceValues(values)
        try APIClient.jsonEncoder.encode(entry).write(to: url, options: TimelineCache.writeOptions)
    }

    func wipe() { try? FileManager.default.removeItem(at: dir) }
}

/// The Weekoverzicht's data: `GET /api/mobile/v1/weekly`, read when the screen
/// (or Meer, for its row) opens, on a pull, and once a minute while the screen
/// is up — so a screen opened offline becomes current by itself.
///
/// A 404 is not a failure: the route answers it before the first Sunday, and
/// the screen says when the first one comes. A cancelled read changes nothing.
///
/// A FAILED READ KEEPS THE WEEK IT EXPECTED, OR SAYS IT IS MISSING: the phone
/// knows which summary it should hold (the newest Sunday 18:00 on its clock).
/// When the summary on hand, or the kept copy, is that week, it stays up as
/// `.kept` with its stand; when it is an older one, the screen says the new
/// week is not fetched yet and offers the older one as "bewaard".
@MainActor
@Observable
final class WeeklyStore {
    static let path = "/api/mobile/v1/weekly"

    struct Kept: Equatable, Sendable {
        let screen: WeeklyScreen
        let savedAt: Date
    }

    enum State: Equatable {
        case loading
        case notYet
        case loaded(WeeklyScreen)
        /// The expected week, from before a read failed.
        case kept(Kept, cause: APIError)
        /// The expected week is not on the phone; `older` is what is.
        case missing(cause: APIError, older: Kept?)
    }

    private(set) var state: State = .loading
    /// Bumped when a retry Martin asked for fails: the view's `.error` haptic.
    private(set) var failedRetries = 0

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let cache: WeeklyCache?
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var lastGood: Kept?
    /// One read at a time: Meer (its row) and the screen both refresh when
    /// a link opens the screen straight away, and a second request racing the
    /// first would answer the same question twice.
    @ObservationIgnored private var inFlight: Task<Void, Never>?

    init(client: APIClient, cache: WeeklyCache? = nil, onUnauthorized: @escaping @MainActor () -> Void = {},
         epoch: SessionEpoch? = nil, now: @escaping @Sendable () -> Date = { Date() }) {
        self.client = client
        self.cache = cache
        self.onUnauthorized = onUnauthorized
        self.now = now
        epoch?.whenEnded { [weak self] in self?.forget() }
    }

    /// The screen shown as `.loaded`/`.kept`, whichever is up.
    var screen: WeeklyScreen? {
        switch state {
        case .loaded(let s): s
        case .kept(let k, _): k.screen
        default: nil
        }
    }

    func refresh() async {
        if let inFlight { return await inFlight.value }
        let task = Task { await read() }
        inFlight = task
        await task.value
        inFlight = nil
    }

    private func read() async {
        let result = await Self.fetch(client)
        switch result {
        case .success(let dto):
            let at = now()
            let screen = WeeklyScreen(dto)
            lastGood = Kept(screen: screen, savedAt: at)
            state = .loaded(screen)
            try? cache?.save(.init(savedAt: at, summary: dto))
        case .failure(.rejected(404)):
            state = .notYet
        case .failure(let error):
            if APIError.isCancellation(error) { return }
            if error == .unauthorized { onUnauthorized() }
            fail(error)
        }
    }

    /// "Opnieuw proberen": a refresh that plays `.error` when it fails again.
    func retry() async {
        await refresh()
        switch state {
        case .kept, .missing: failedRetries += 1
        default: break
        }
    }

    /// "Bekijk week 43 (bewaard)": the older summary, with its stand.
    func showOlder() {
        guard case .missing(let cause, let older?) = state else { return }
        state = .kept(older, cause: cause)
    }

    private func fail(_ error: APIError) {
        if case .notYet = state { return }
        let expected = WeeklyFormat.weekKey(WeeklyFormat.lastClose(atOrBefore: now()))
        let kept = lastGood ?? cache?.load().map { Kept(screen: WeeklyScreen($0.summary), savedAt: $0.savedAt) }
        if error != .unauthorized, let kept, kept.screen.week >= expected {
            state = .kept(kept, cause: error)
        } else {
            state = .missing(cause: error, older: error == .unauthorized ? nil : kept)
        }
    }

    private func forget() {
        state = .loading
        lastGood = nil
        cache?.wipe()
    }

    nonisolated private static func fetch(_ client: APIClient) async -> Result<WeeklyDTO, APIError> {
        do {
            let dto: WeeklyDTO = try await client.getJSON(path)
            return .success(dto)
        } catch let error as APIError {
            return .failure(error)
        } catch {
            return .failure(APIError.isCancellation(error) ? .cancelled : .transport(String(describing: error)))
        }
    }
}
