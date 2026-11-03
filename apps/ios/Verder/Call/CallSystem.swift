import ActivityKit
import CallKit
import Foundation

// MARK: - The Live Activity

/// Starts, updates and ends the call's Live Activity. A protocol so the
/// session's rules are tested without ActivityKit (`CallPrepTests`).
@MainActor
protocol CallActivityControlling: AnyObject {
    var isRunning: Bool { get }
    /// False when Live Activities are off for verder (Settings) or iOS refused.
    func start(_ state: CallActivityAttributes.ContentState) -> Bool
    func update(_ state: CallActivityAttributes.ContentState)
    func end()
}

/// ActivityKit's side. One call at a time: a start ends whatever an earlier
/// launch left running (a call activity outlives a killed app by hours).
@MainActor
final class LiveCallActivities: CallActivityControlling {
    /// The running activity's id. `Activity` is not Sendable, so the instance
    /// itself never leaves a nonisolated helper; the id is looked up there.
    private var activityId: String?

    var isRunning: Bool { activityId != nil }

    func start(_ state: CallActivityAttributes.ContentState) -> Bool {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return false }
        do {
            // No push token: only the app updates it, while it runs. No stale
            // date: a call has no deadline, and it ends when the call does.
            let activity = try Activity.request(attributes: CallActivityAttributes(),
                                                content: ActivityContent(state: state, staleDate: nil),
                                                pushType: nil)
            let id = activity.id
            activityId = id
            // One call at a time: whatever an earlier launch left running goes.
            Task { await Self.end(except: id) }
            return true
        } catch {
            activityId = nil
            return false
        }
    }

    func update(_ state: CallActivityAttributes.ContentState) {
        guard let id = activityId else { return }
        Task { await Self.update(id: id, state: state) }
    }

    func end() {
        activityId = nil
        Task { await Self.end(except: nil) }
    }

    nonisolated private static func update(id: String, state: CallActivityAttributes.ContentState) async {
        for running in Activity<CallActivityAttributes>.activities where running.id == id {
            await running.update(ActivityContent(state: state, staleDate: nil))
        }
    }

    /// Every call activity this app has, including one an earlier process left.
    nonisolated private static func end(except keep: String?) async {
        for running in Activity<CallActivityAttributes>.activities where running.id != keep {
            await running.end(nil, dismissalPolicy: .immediate)
        }
    }
}

// MARK: - The phone call itself

/// What `CXCallObserver` says about a call: THAT it started (dialling,
/// ringing or connected) or ended — never who is on it or what is said
/// (CallKit gives an app no more than this, and no audio at all).
enum CallEvent: Equatable, Sendable {
    case started(UUID)
    case ended(UUID)
}

@MainActor
protocol CallObserving: AnyObject {
    func observe(_ handler: @escaping @MainActor (CallEvent) -> Void)
}

/// `CXCallObserver`, delivering on the main queue.
@MainActor
final class LiveCallObserver: NSObject, CallObserving, CXCallObserverDelegate {
    private let observer = CXCallObserver()
    private var handler: (@MainActor (CallEvent) -> Void)?

    func observe(_ handler: @escaping @MainActor (CallEvent) -> Void) {
        self.handler = handler
        // nil = the main queue, so the callback below runs on the main actor.
        observer.setDelegate(self, queue: nil)
    }

    nonisolated func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
        let event: CallEvent = call.hasEnded ? .ended(call.uuid) : .started(call.uuid)
        MainActor.assumeIsolated { handler?(event) }
    }
}

// MARK: - The phone's copy

/// The last talking points fetched per party, so the sheet still works at a
/// counter with no signal — WITH its age, never as if live. Also the party
/// list Dossier's "Bellen" card shows.
///
/// WHERE: `Application Support/calls`, never the App Group (no extension
/// reads it). Written `[.atomic, .completeFileProtection]` and excluded from
/// backups (it is rebuilt from the server, and a backup would carry the case
/// into iCloud); wiped when the session ends.
struct CallCache: Sendable {
    typealias Writer = @Sendable (Data, URL, Data.WritingOptions) throws -> Void
    typealias Reader = @Sendable (URL) throws -> Data

    static let writeOptions: Data.WritingOptions = [.atomic, .completeFileProtection]
    static let defaultWriter: Writer = { try $0.write(to: $1, options: $2) }
    static let defaultReader: Reader = { try Data(contentsOf: $0) }

    struct Entry: Codable, Equatable, Sendable {
        let savedAt: Date
        let points: TalkingPointsDTO
    }

    let dir: URL
    var write: Writer = Self.defaultWriter
    var read: Reader = Self.defaultReader

    static var live: CallCache {
        CallCache(dir: URL.applicationSupportDirectory.appending(path: "calls", directoryHint: .isDirectory))
    }

    /// A party id is a UUID; anything else never names a file.
    private func url(_ partyId: String) -> URL? {
        UUID(uuidString: partyId).map { dir.appending(path: "\($0.uuidString.lowercased()).json") }
    }

    private var partiesURL: URL { dir.appending(path: "parties.json") }

    func load(_ partyId: String) -> Entry? {
        guard let url = url(partyId), let data = try? read(url) else { return nil }
        return try? APIClient.jsonDecoder.decode(Entry.self, from: data)
    }

    func save(_ entry: Entry, for partyId: String) throws {
        guard let url = url(partyId) else { return }
        try prepare()
        try write(try APIClient.jsonEncoder.encode(entry), url, Self.writeOptions)
    }

    func loadParties() -> [PartyDTO]? {
        guard let data = try? read(partiesURL) else { return nil }
        return try? APIClient.jsonDecoder.decode([PartyDTO].self, from: data)
    }

    func saveParties(_ parties: [PartyDTO]) throws {
        try prepare()
        try write(try APIClient.jsonEncoder.encode(parties), partiesURL, Self.writeOptions)
    }

    func wipe() {
        try? FileManager.default.removeItem(at: dir)
    }

    private func prepare() throws {
        var folder = dir
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? folder.setResourceValues(values)
    }
}
