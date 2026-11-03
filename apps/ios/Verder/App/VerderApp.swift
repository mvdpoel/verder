import SwiftUI

@main
struct VerderApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var auth: AuthModel
    @State private var lock: AppLock
    /// Made at launch, not lazily: a relaunch for background-upload events
    /// must find the background session (one per identifier per process)
    /// already reconnected to its delegate.
    @State private var uploads: UploadCenter
    @State private var push: PushRegistrar
    /// Voor jou's data, the icon badge and the widget snapshot. One per
    /// process, beside the registrar: the silent-push refresh (AppDelegate) and
    /// the tab read the same store.
    @State private var inbox: InboxStore
    /// The money summary behind the Overzicht money card and Geld.
    @State private var money: MoneyStore
    /// The pocket dossier behind the Dossier tab.
    @State private var dossier: DossierModel
    /// The case map behind the Tijdlijn (Dossier, and a tap on Overzicht's headline).
    @State private var timeline: TimelineStore
    /// The voice log (Meer, or the home screen quick action), owned here —
    /// above the lock gate and sign-in — so a relock or a 401 keeps its text.
    @State private var voice: VoiceLogSession
    /// `AppServices.now`: Overzicht's clock.
    private let now: @Sendable () -> Date
    private let camera: any CameraAccess

    init() {
        #if DEBUG
        // `-fixtures <name>`: the same stores on the synthetic dataset, no
        // server (Verder/Fixtures). Compiled out of Release.
        if let launch = FixtureLaunch.current {
            self.init(services: FixtureEnvironment.services(for: launch))
            return
        }
        #endif
        self.init(services: .live())
    }

    private init(services s: AppServices) {
        let auth = AuthModel(client: s.client, store: s.store, defaults: s.defaults, widgetSnapshotDir: s.snapshotDir,
                             pendingSignOut: s.pendingSignOut)
        _auth = State(initialValue: auth)
        _lock = State(initialValue: s.lock)
        _uploads = State(initialValue: s.uploads)
        _push = State(initialValue: PushRegistrar(client: s.client, auth: auth, permission: s.permission,
                                                  defaults: s.defaults, registerRemote: s.registerRemote))
        // Every store holding case content shares auth's ONE sign-out epoch
        // (`SessionEpoch`): signing out, or a 401 anywhere, clears all three,
        // and a refresh still in flight writes nothing back.
        let inbox = InboxStore(client: s.client, snapshotDir: s.snapshotDir, setBadge: s.setBadge,
                               onUnauthorized: { auth.sessionRejected() }, now: s.now, epoch: auth.epoch)
        now = s.now
        camera = s.camera
        _inbox = State(initialValue: inbox)
        _money = State(initialValue: MoneyStore(client: s.client, onUnauthorized: { auth.sessionRejected() },
                                                epoch: auth.epoch, now: s.now))
        _dossier = State(initialValue: DossierModel(store: DossierStore(dir: s.dossierDir), client: s.client,
                                                    onUnauthorized: { auth.sessionRejected() },
                                                    epoch: auth.epoch))
        _timeline = State(initialValue: TimelineStore(client: s.client, cache: TimelineCache(dir: s.timelineDir),
                                                      onUnauthorized: { auth.sessionRejected() },
                                                      epoch: auth.epoch))
        let client = s.client
        _voice = State(initialValue: VoiceLogSession(factory: VoiceLogFactory {
            VoiceLogModel(client: client, recorder: s.makeRecorder(), transcriber: s.transcriber,
                          dir: VoiceLogModel.liveDirectory, onUnauthorized: { auth.sessionRejected() })
        }))
        // Before any delegate callback, so a background launch for a question
        // answer or a silent refresh finds them (see `AppDelegate.Services`).
        AppDelegate.services = .init(client: s.client, inbox: inbox)
    }

    var body: some Scene {
        WindowGroup {
            RootView(auth: auth, lock: lock, uploads: uploads, push: push, links: appDelegate.links, inbox: inbox,
                     money: money, dossier: dossier, timeline: timeline, voice: voice, now: now, camera: camera)
                .onAppear { appDelegate.attach(push) }
        }
        .backgroundTask(.urlSession(BackgroundUploader.identifier)) { [uploader = uploads.uploader] in
            await uploader.finishBackgroundEvents()
        }
    }
}
