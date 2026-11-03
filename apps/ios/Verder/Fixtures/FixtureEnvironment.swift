#if DEBUG
import Foundation
import Synchronization
import SwiftUI

/// The app's services for a `-fixtures` launch: the REAL stores (`AuthModel`,
/// `InboxStore`, `PushRegistrar`, `UploadCenter`, `AppLock`) on a client whose
/// URLSession answers from `FixtureServer`. Only the edges are swapped:
///
/// - the session lives in memory, never the Keychain — a fixture run must not
///   overwrite (or read) the real session;
/// - Face ID answers yes at once (unlocked), or, with `-fixtures-locked`,
///   declines the automatic prompt so the counts-only glance stays up and a
///   tap on "Toon details" then unlocks;
/// - notifications read as allowed and nothing registers with APNs, so no
///   pre-prompt covers a screenshot and no fixture token reaches anything;
/// - the widget snapshot and the icon badge are left alone, and the upload
///   queue and the pocket dossier live in temporary folders, so the real App
///   Group and Application Support never hold synthetic data.
@MainActor
enum FixtureEnvironment {
    nonisolated static let cookie = SessionCookie(name: SessionCookie.names[0], value: "fixture-session", expires: nil)
    static let defaultsSuite = "pro.vanderpoel.verder.fixtures"

    /// The host Over verder shows in a fixture run: the frames'
    /// "verder.example", not the fixture's `<name>.fixtures.verder.invalid`.
    nonisolated static let displayServer: URL? =
        FixtureLaunch.current == nil ? nil : URL(string: "https://verder.example")

    /// `-route meer:developer`: Ontwikkelaar as the frame draws it — a phone
    /// registered for development pushes on 31 okt, a last scan, and an
    /// upload test answered at 14:02. Synthetic; nothing registers with APNs
    /// and nothing is sent.
    static var opensDeveloper: Bool {
        guard case .meer(let path)? = FixtureLaunch.current?.route else { return false }
        return path.last == .developer
    }
    nonisolated static let developerTokenTail = "a41f"
    nonisolated static let developerRegisteredAt = amsterdam("09:12").addingTimeInterval(-86_400)
    nonisolated static let developerScan = "Brief Gemeente Westerlaan 30 okt.pdf"

    /// The synthetic case's "today": Sun 1 nov 2026, 09:41 in Amsterdam —
    /// the reference frames' status bar. It runs on from launch, so a retry a
    /// minute later reads a minute later.
    nonisolated static let today = Date(timeIntervalSince1970: 1_793_522_460) // 2026-11-01T08:41:00Z
    nonisolated static let launchedAt = Date()
    nonisolated static let clock: @Sendable () -> Date = { today.addingTimeInterval(Date().timeIntervalSince(launchedAt)) }

    /// The clock of a fixture with a `keptAt` (`offline-cached`): it reads
    /// `keptAt` while the first, good answers are given — so the kept stand is
    /// stamped the evening before — and the case's today once a repeat has
    /// failed, so the stand on screen reads "gisteren 22:14".
    nonisolated static func clock(keptAt: Date?, today fixtureToday: Date? = nil) -> @Sendable () -> Date {
        let today = fixtureToday ?? today
        guard let keptAt else { return { today.addingTimeInterval(Date().timeIntervalSince(launchedAt)) } }
        return {
            let elapsed = Date().timeIntervalSince(launchedAt)
            return (FixtureProtocol.hasFailedRepeat ? today : keptAt).addingTimeInterval(elapsed)
        }
    }

    /// The fixture session: the app's own configuration (no cookies, no
    /// cache, no redirects) with `FixtureProtocol` in front.
    nonisolated static func sessionConfiguration(_ base: URLSessionConfiguration = APIClient.sessionConfiguration())
        -> URLSessionConfiguration {
        base.protocolClasses = [FixtureProtocol.self]
        return base
    }

    nonisolated static func client(fixture: String, store: any SessionStore = InMemorySessionStore(cookie)) -> APIClient {
        APIClient(base: FixtureProtocol.base(for: fixture),
                  session: APIClient.makeSession(configuration: sessionConfiguration()), store: store)
    }

    static func services(for launch: FixtureLaunch) -> AppServices {
        guard let root = FixtureServer.bundledRoot, let server = FixtureServer(name: launch.fixture, root: root) else {
            let known = FixtureServer.bundledRoot.map(FixtureServer.names(in:)) ?? []
            fatalError("fixtures: no fixture named \(launch.fixture); known: \(known.joined(separator: ", "))")
        }
        let store = InMemorySessionStore(cookie)
        let client = client(fixture: launch.fixture, store: store)

        let lock = AppLock(authenticator: FixtureOwner(declinesFirst: launch.locked,
                                                       holdsFirst: launch.locked && launch.faceID == .asking))
        if !launch.locked { lock.didSignIn() }

        let defaults = UserDefaults(suiteName: defaultsSuite) ?? .standard
        defaults.removePersistentDomain(forName: defaultsSuite)
        defaults.set(true, forKey: PushRegistrar.askedKey)

        let dir = URL.temporaryDirectory.appending(path: "verder-fixture-uploads", directoryHint: .isDirectory)
        try? FileManager.default.removeItem(at: dir)
        if launch.scans { seedUploads(sentToday: 2, pending: 1, in: dir) }
        if let preset = launch.queue { seedQueue(preset, in: dir) }
        if opensDeveloper && launch.queue == nil && !launch.scans { seedDeveloperScan(in: dir) }
        let queue = UploadQueue(dir: dir)
        // Not a background session: those refuse custom protocols, and a scan
        // taken in a fixture run must reach the fixture server, not the network.
        let uploader = BackgroundUploader(queue: queue, client: client,
                                          configuration: sessionConfiguration(.ephemeral))
        let uploads = UploadCenter(queue: queue, uploader: uploader, client: client,
                                   now: launch.queue.map(queueClock) ?? clock)
        if launch.queue == .offline || server.manifest.behavior == .offline { uploads.setOffline(true) }
        if opensDeveloper { uploads.seedFixtureResend(duplicate: true, at: amsterdam("14:02")) }
        // `offlineAfter`: the network goes once the first answers are in, as
        // NWPathMonitor would report it (Meer's kept stand).
        if let after = server.manifest.offlineAfter {
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(after))
                uploads.setOffline(true)
            }
        }

        // A fresh, temporary dossier per launch: synthetic documents never
        // land in the real Application Support folder, and every capture
        // starts from an empty phone.
        let dossierDir = URL.temporaryDirectory.appending(path: "verder-fixture-dossier", directoryHint: .isDirectory)
        try? FileManager.default.removeItem(at: dossierDir)
        let timelineDir = URL.temporaryDirectory.appending(path: "verder-fixture-timeline", directoryHint: .isDirectory)
        try? FileManager.default.removeItem(at: timelineDir)
        let weeklyDir = URL.temporaryDirectory.appending(path: "verder-fixture-weekly", directoryHint: .isDirectory)
        try? FileManager.default.removeItem(at: weeklyDir)

        var services = AppServices(client: client, store: store, lock: lock, uploads: uploads, defaults: defaults,
                           permission: FixturePermission(state: launch.push ?? .allowed), registerRemote: {},
                           snapshotDir: nil, setBadge: { _ in }, dossierDir: dossierDir,
                           timelineDir: timelineDir,
                           // No microphone and no speech model: a "recording"
                           // is synthetic bytes, and its transcript is the
                           // voice fixture's (synthetic-data doc).
                           makeRecorder: { FixtureRecorder() },
                           transcriber: FixtureTranscriber(text: server.manifest.transcript ?? FixtureTranscriber.fallback),
                           now: clock(keptAt: server.manifest.keptAt, today: server.manifest.today))
        services.weeklyDir = weeklyDir
        services.camera = FixtureCamera(state: launch.camera ?? .authorized)
        return services
    }

    /// The afternoon a queue preset happens in, on the case's day (1 nov):
    /// the frames' scans are at 11:05 and 14:32, so "nog 8 min" needs 14:34.
    nonisolated static func queueClock(_ preset: FixtureLaunch.QueuePreset) -> @Sendable () -> Date {
        let start = amsterdam(queueNow(preset))
        return { start.addingTimeInterval(Date().timeIntervalSince(launchedAt)) }
    }

    nonisolated static func queueNow(_ preset: FixtureLaunch.QueuePreset) -> String {
        switch preset {
        case .first, .done: "14:50"
        case .underway, .failedRecent: "14:34"
        case .offline: "14:55"
        case .failed, .signin: "14:50"
        case .signinRecent: "14:38"
        }
    }

    /// "HH:mm" on Sun 1 nov 2026 in Amsterdam (CET, UTC+1).
    nonisolated static func amsterdam(_ hhmm: String) -> Date {
        let p = hhmm.split(separator: ":").compactMap { Int($0) }
        // 1 nov 2026 00:00 CET = 31 oct 23:00 UTC.
        let midnight = Date(timeIntervalSince1970: 1_793_487_600)
        return midnight.addingTimeInterval(TimeInterval(p[0] * 3600 + p[1] * 60))
    }

    /// The queue a "scan · final" frame draws. Synthetic only: every id is
    /// fresh, every file is a stub, and the pending ones are not due for a
    /// day, so a capture never sends anything.
    private static func seedQueue(_ preset: FixtureLaunch.QueuePreset, in dir: URL) {
        struct Index: Encodable { let items: [UploadItem]; let signInRequired: Bool; let everEnqueued: Bool }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let later = Date().addingTimeInterval(86_400)
        func sent(_ at: String, pages: Int, sentAt: String? = nil) -> UploadItem {
            UploadItem(id: UUID(), fileName: "Scan fixture \(at)", capturedAt: amsterdam(at), source: "phone-scan",
                       state: .sent, attempts: 0, nextAttemptAt: nil, sentAt: amsterdam(sentAt ?? at),
                       pages: pages, documentId: UUID().uuidString.lowercased())
        }
        func waiting(_ at: String, pages: Int, bytes: Int, state: UploadItem.State = .pending,
                     failure: UploadItem.Failure? = nil) -> UploadItem {
            UploadItem(id: UUID(), fileName: "Scan fixture \(at)", capturedAt: amsterdam(at), source: "phone-scan",
                       state: state, attempts: state == .failed ? 5 : 1, nextAttemptAt: state == .failed ? nil : later,
                       sentAt: nil, pages: pages, byteCount: bytes, failure: failure)
        }
        let nine = ["09:05", "09:30", "10:02", "10:40", "11:15", "11:48", "11:58"].map { sent($0, pages: 1) }
            + [sent("12:02", pages: 1), sent("13:10", pages: 3, sentAt: "13:11")]
        var signIn = false
        let items: [UploadItem]
        switch preset {
        case .first:
            items = []
        case .underway:
            items = [sent("12:02", pages: 1), sent("13:10", pages: 3, sentAt: "13:11"),
                     waiting("14:32", pages: 2, bytes: 1_400_000)]
        case .done:
            items = [sent("12:02", pages: 1), sent("13:10", pages: 3, sentAt: "13:11"),
                     sent("14:32", pages: 2, sentAt: "14:33")]
        case .offline:
            items = nine + [waiting("14:32", pages: 2, bytes: 1_400_000), waiting("14:36", pages: 1, bytes: 600_000),
                            waiting("14:41", pages: 3, bytes: 2_100_000)]
        case .failed, .failedRecent:
            items = nine + [waiting("11:05", pages: 1, bytes: 500_000, state: .failed, failure: .noAnswer),
                            waiting("14:32", pages: 2, bytes: 1_400_000)]
        case .signin, .signinRecent:
            signIn = true
            items = nine + [waiting("14:32", pages: 2, bytes: 1_400_000), waiting("14:36", pages: 1, bytes: 600_000)]
        }
        for item in items where item.state != .sent {
            try? Data("%PDF-1.4 fixture".utf8).write(to: dir.appending(path: "\(item.id.uuidString).pdf"))
        }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try? encoder.encode(Index(items: items, signInRequired: signIn, everEnqueued: preset != .first))
            .write(to: dir.appending(path: "queue.json"))
    }

    /// Ontwikkelaar's "Laatste scan": one sent letter, the data doc's
    /// Brief Gemeente Westerlaan of 30 okt.
    private static func seedDeveloperScan(in dir: URL) {
        struct Index: Encodable { let items: [UploadItem]; let signInRequired = false }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let at = amsterdam("13:55").addingTimeInterval(-86_400)
        let item = UploadItem(id: UUID(), fileName: developerScan, capturedAt: at, source: "phone-scan",
                              state: .sent, attempts: 0, nextAttemptAt: nil, sentAt: at, pages: 2,
                              documentId: UUID().uuidString.lowercased())
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try? encoder.encode(Index(items: [item])).write(to: dir.appending(path: "queue.json"))
    }

    /// `-fixtures-scans`: the data doc's "2 verstuurd · 1 in de wachtrij",
    /// written in `UploadQueue`'s
    /// own file format, before the queue opens it. Sent items were sent now
    /// (the queue counts "today" on the real clock); pending ones are not due
    /// for an hour, so nothing is sent during a capture.
    private static func seedUploads(sentToday: Int, pending: Int, in dir: URL) {
        struct Index: Encodable { let items: [UploadItem]; let signInRequired = false }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let now = Date()
        var items: [UploadItem] = []
        for n in 0..<(sentToday + pending) {
            let sent = n < sentToday
            let id = UUID()
            items.append(UploadItem(id: id, fileName: "Scan fixture \(n + 1)", capturedAt: now, source: "phone-scan",
                                    state: sent ? .sent : .pending, attempts: sent ? 0 : 1,
                                    nextAttemptAt: sent ? nil : now.addingTimeInterval(3600),
                                    sentAt: sent ? now : nil))
            if !sent { try? Data("%PDF-1.4 fixture".utf8).write(to: dir.appending(path: "\(id.uuidString).pdf")) }
        }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try? encoder.encode(Index(items: items)).write(to: dir.appending(path: "queue.json"))
    }
}

/// Face ID for a fixture run. Unlocked runs never ask (the lock opens at
/// launch); a locked run declines the FIRST ask — the automatic one on open —
/// and allows every later one, so the glance can be captured and still opened.
///
/// With `-fixtures-faceid asking` the first ask is HELD instead (it never
/// answers), so the "Face ID vraagt" state stays on screen for a capture.
final class FixtureOwner: DeviceOwnerAuthenticator {
    private let declines: Mutex<Bool>
    private let holds: Mutex<Bool>

    init(declinesFirst: Bool, holdsFirst: Bool = false) {
        declines = Mutex(declinesFirst)
        holds = Mutex(holdsFirst)
    }

    func authenticate(reason: String) async throws(DeviceOwnerAuthError) {
        let hold = holds.withLock { value in
            defer { value = false }
            return value
        }
        if hold {
            // A prompt nobody answers: suspend until the task is cancelled.
            while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
            throw .cancelled
        }
        let decline = declines.withLock { value in
            defer { value = false }
            return value
        }
        if decline { throw .cancelled }
    }
}

/// The voice log's microphone in a fixture run: synthetic bytes, never the
/// microphone, so a capture needs no permission and records nothing real.
final class FixtureRecorder: VoiceRecording {
    func requestPermission() async -> Bool { true }
    func start(to url: URL) throws { try Data("fixture-recording".utf8).write(to: url) }
    func stop() -> TimeInterval { 4 }
    func cancel() {}
}

/// Speech "recognised" from the voice fixture's manifest transcript.
struct FixtureTranscriber: Transcribing {
    static let fallback = "Gebeld met Woonstichting Lindehof."
    let text: String
    func availability() async -> SpeechAvailability { .ready }
    func install() async throws(TranscriptionError) {}
    func transcribe(_ audio: URL) async throws(TranscriptionError) -> String { text }
}

/// The camera permission a capture asks for (`-fixtures-camera`). "Ga
/// verder" on the pre-prompt allows it, as a tap on iOS's alert would.
final class FixtureCamera: CameraAccess {
    private let state: Mutex<CameraAuthorization>
    init(state: CameraAuthorization) { self.state = Mutex(state) }
    func status() -> CameraAuthorization { state.withLock { $0 } }
    func request() async -> Bool {
        state.withLock { $0 = .authorized }
        return true
    }
}

struct FixturePermission: NotificationPermission {
    var state: PushPermission = .allowed
    func status() async -> PushPermission { state }
    func request() async -> Bool { true }
}

/// `-route voice`: the real voice log (Task 25), already recorded and
/// transcribed so the capture shows the editor. `-route weekly` and
/// `-route geld` are LINKS (`DeepLink.weekly`, `DeepLink.money`) and open the
/// real screens on Meer, the path a tap takes.
struct FixtureScreen: View {
    let screen: FixtureLaunch.Screen
    let money: MoneyStore
    let voice: VoiceLogFactory
    @State private var voiceModel: VoiceLogModel?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            switch screen {
            case .voice:
                if let voiceModel {
                    VoiceLogView(model: voiceModel, close: { dismiss() })
                } else {
                    Color.void.ignoresSafeArea().task {
                        let model = voice.make()
                        voiceModel = model
                        await model.prepare()
                        await model.startRecording()
                        await model.stopRecording()
                    }
                }
            }
        }
    }
}
#endif
