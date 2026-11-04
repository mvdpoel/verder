import Foundation
import Observation

/// One question on screen: loaded from `GET /requests/<id>`, polled every
/// five seconds while Grip works on it (the "Wat Grip nu doet" lines are live),
/// and marked opened the first time an answer — or a failure — is shown.
@MainActor
@Observable
final class RequestScreenModel {
    static let pollSeconds: TimeInterval = 5

    private(set) var detail: RequestDetail?
    private(set) var loadError: APIError?
    /// Steps ticked on the phone, before the server confirms (index → when).
    private(set) var ticking: [Int: Date] = [:]
    /// Counted for the light haptic on a tick.
    private(set) var ticks = 0
    /// Each new activity line, for VoiceOver (at most once every 10 s).
    private(set) var announced: String?

    @ObservationIgnored let id: String
    @ObservationIgnored let store: RequestStore
    @ObservationIgnored private var opened = false
    @ObservationIgnored private var lastAnnounce: Date = .distantPast

    init(id: String, store: RequestStore) {
        self.id = id.lowercased()
        self.store = store
    }

    var isLive: Bool { detail?.status == "queued" || detail?.status == "working" }

    func load() async {
        do {
            let d: RequestDetail = try await store.client.getJSON("\(RequestStore.path)/\(id)")
            let before = detail?.progress?.steps.last?.label
            detail = d
            loadError = nil
            ticking = ticking.filter { i, _ in !(d.steps.first { $0.index == i }?.doneAt != nil) }
            if let line = d.progress?.steps.last?.label, line != before, store.now().timeIntervalSince(lastAnnounce) >= 10 {
                announced = line
                lastAnnounce = store.now()
            }
            if !opened, (d.status == "answered" && d.unread) || (d.status == "failed" && d.openedAt == nil) {
                opened = true
                await store.markOpened(d.id)
            }
        } catch {
            if APIError.isCancellation(error) { return }
            loadError = (error as? APIError) ?? .transport(String(describing: error))
        }
    }

    /// Reloads while Grip works; stops by itself once the answer is in.
    func poll() async {
        await load()
        while !Task.isCancelled, isLive {
            try? await Task.sleep(for: .seconds(Self.pollSeconds))
            if Task.isCancelled { break }
            await load()
        }
    }

    /// The step as drawn: the server's tick, or the one the phone just made.
    func doneAt(_ step: RequestDetail.Step) -> Date? { ticking[step.index] ?? step.doneAt }

    func toggle(_ step: RequestDetail.Step) async {
        guard let d = detail else { return }
        let done = doneAt(step) == nil
        let openBefore = d.steps.filter { doneAt($0) == nil }.count
        ticks += 1
        if done { ticking[step.index] = store.now() }
        let ok = await store.step(d.id, index: step.index, done: done, lastOpen: done && openBefore == 1)
        if !ok { ticking[step.index] = nil }
        await load()
    }

    #if DEBUG
    /// A step ticked a moment ago, for a capture.
    func fixtureTick(_ index: Int, at: Date) { ticking[index] = at }
    #endif
}
