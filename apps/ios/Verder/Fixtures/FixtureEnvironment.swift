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
///   queue lives in a temporary folder, so the real App Group never holds
///   synthetic data.
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
        guard let root = FixtureServer.bundledRoot, FixtureServer(name: launch.fixture, root: root) != nil else {
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

        return AppServices(client: client, store: store, lock: lock, uploads: uploads, defaults: defaults,
                           permission: FixturePermission(), registerRemote: {},
                           snapshotDir: nil, setBadge: { _ in })
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

struct FixturePermission: NotificationPermission {
    func status() async -> PushPermission { .allowed }
    func request() async -> Bool { true }
}

/// `-route geld|weekly|voice`: the screens with no deep link. Geld is the
/// real screen on the fixture's money store (Task 19); until Tasks 25 and 26
/// build theirs, weekly and voice are the ComingSoon placeholder.
struct FixtureScreen: View {
    let screen: FixtureLaunch.Screen
    let money: MoneyStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            if screen == .geld {
                NavigationStack { GeldScreen(store: money) }
            } else {
                ComingSoon(title: title)
            }
        }
            .overlay(alignment: .topTrailing) {
                Button("Sluiten") { dismiss() }
                    .font(.display(14, relativeTo: .callout, weight: .regular))
                    .foregroundStyle(Color.signal)
                    .padding(16)
            }
    }

    private var title: String {
        switch screen {
        case .geld: "Geld"
        case .weekly: "Weekoverzicht"
        case .voice: "Gesprek vastleggen"
        }
    }
}
#endif
