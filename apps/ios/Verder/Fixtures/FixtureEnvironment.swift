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

        let lock = AppLock(authenticator: FixtureOwner(declinesFirst: launch.locked))
        if !launch.locked { lock.didSignIn() }

        let defaults = UserDefaults(suiteName: defaultsSuite) ?? .standard
        defaults.removePersistentDomain(forName: defaultsSuite)
        defaults.set(true, forKey: PushRegistrar.askedKey)

        let dir = URL.temporaryDirectory.appending(path: "verder-fixture-uploads", directoryHint: .isDirectory)
        try? FileManager.default.removeItem(at: dir)
        let queue = UploadQueue(dir: dir)
        // Not a background session: those refuse custom protocols, and a scan
        // taken in a fixture run must reach the fixture server, not the network.
        let uploader = BackgroundUploader(queue: queue, client: client,
                                          configuration: sessionConfiguration(.ephemeral))
        let uploads = UploadCenter(queue: queue, uploader: uploader, client: client)

        // A fresh, temporary dossier per launch: synthetic documents never
        // land in the real Application Support folder, and every capture
        // starts from an empty phone.
        let dossierDir = URL.temporaryDirectory.appending(path: "verder-fixture-dossier", directoryHint: .isDirectory)
        try? FileManager.default.removeItem(at: dossierDir)
        let timelineDir = URL.temporaryDirectory.appending(path: "verder-fixture-timeline", directoryHint: .isDirectory)
        try? FileManager.default.removeItem(at: timelineDir)

        return AppServices(client: client, store: store, lock: lock, uploads: uploads, defaults: defaults,
                           permission: FixturePermission(), registerRemote: {},
                           snapshotDir: nil, setBadge: { _ in }, dossierDir: dossierDir,
                           timelineDir: timelineDir,
                           // No microphone and no speech model: a "recording"
                           // is synthetic bytes, and its transcript is the
                           // voice fixture's (synthetic-data doc).
                           makeRecorder: { FixtureRecorder() },
                           transcriber: FixtureTranscriber(text: server.manifest.transcript ?? FixtureTranscriber.fallback))
    }
}

/// Face ID for a fixture run. Unlocked runs never ask (the lock opens at
/// launch); a locked run declines the FIRST ask — the automatic one on open —
/// and allows every later one, so the glance can be captured and still opened.
final class FixtureOwner: DeviceOwnerAuthenticator {
    private let declines: Mutex<Bool>

    init(declinesFirst: Bool) { declines = Mutex(declinesFirst) }

    func authenticate(reason: String) async throws(DeviceOwnerAuthError) {
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

struct FixturePermission: NotificationPermission {
    func status() async -> PushPermission { .allowed }
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
