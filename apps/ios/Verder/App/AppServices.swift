import UIKit

/// What `VerderApp` builds its stores on: the client, where the session lives,
/// the lock, the upload queue, the pocket dossier's folder, and the edges to the system (notification
/// permission, APNs registration, the widget snapshot, the icon badge).
///
/// `live()` is the only one a Release build has. A DEBUG `-fixtures` launch
/// builds the same stores on `FixtureEnvironment.services(for:)` instead, so
/// screenshots exercise the real stores and views on synthetic data.
@MainActor
struct AppServices {
    let client: APIClient
    let store: any SessionStore
    let lock: AppLock
    let uploads: UploadCenter
    let defaults: UserDefaults
    let permission: any NotificationPermission
    let registerRemote: @MainActor () -> Void
    let snapshotDir: URL?
    let setBadge: @Sendable (Int) async -> Void
    /// The pocket dossier's folder (`DossierStore`): Application Support,
    /// never the App Group.
    let dossierDir: URL
    /// The Tijdlijn's copy of the case map (`TimelineCache`): Application
    /// Support, never the App Group.
    let timelineDir: URL
    /// The voice log's microphone and on-device transcription (Task 25).
    let makeRecorder: @MainActor () -> any VoiceRecording
    let transcriber: any Transcribing

    static func live() -> AppServices {
        let store = KeychainSessionStore()
        let client = APIClient(session: APIClient.makeSession(), store: store)
        return AppServices(client: client, store: store, lock: AppLock(),
                           // Made at launch, not lazily: a relaunch for
                           // background-upload events must find the background
                           // session (one per identifier per process) already
                           // reconnected to its delegate.
                           uploads: UploadCenter.live(client: client),
                           defaults: .standard,
                           permission: SystemNotificationPermission(),
                           registerRemote: { UIApplication.shared.registerForRemoteNotifications() },
                           snapshotDir: AppGroup.containerURL,
                           setBadge: InboxStore.systemBadge,
                           dossierDir: URL.applicationSupportDirectory.appending(path: "dossier", directoryHint: .isDirectory),
                           timelineDir: TimelineCache.live.dir,
                           makeRecorder: { AudioRecorder() },
                           transcriber: OnDeviceTranscriber())
    }
}
