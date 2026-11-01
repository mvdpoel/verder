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
    /// A fresh voice log per opening (Meer, or the home screen quick action).
    private let voice: VoiceLogFactory

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
        let auth = AuthModel(client: s.client, store: s.store, defaults: s.defaults, widgetSnapshotDir: s.snapshotDir)
        _auth = State(initialValue: auth)
        _lock = State(initialValue: s.lock)
        _uploads = State(initialValue: s.uploads)
        _push = State(initialValue: PushRegistrar(client: s.client, auth: auth, permission: s.permission,
                                                  defaults: s.defaults, registerRemote: s.registerRemote))
        let inbox = InboxStore(client: s.client, snapshotDir: s.snapshotDir, setBadge: s.setBadge,
                               onUnauthorized: { auth.sessionRejected() })
        _inbox = State(initialValue: inbox)
        _money = State(initialValue: MoneyStore(client: s.client, onUnauthorized: { auth.sessionRejected() }))
        _dossier = State(initialValue: DossierModel(store: DossierStore(dir: s.dossierDir), client: s.client,
                                                    onUnauthorized: { auth.sessionRejected() }))
        let client = s.client
        voice = VoiceLogFactory {
            VoiceLogModel(client: client, recorder: s.makeRecorder(), transcriber: s.transcriber,
                          dir: VoiceLogModel.liveDirectory, onUnauthorized: { auth.sessionRejected() })
        }
        // Before any delegate callback, so a background launch for a question
        // answer or a silent refresh finds them (see `AppDelegate.Services`).
        AppDelegate.services = .init(client: s.client, inbox: inbox)
    }

    var body: some Scene {
        WindowGroup {
            RootView(auth: auth, lock: lock, uploads: uploads, push: push, links: appDelegate.links, inbox: inbox,
                     money: money, dossier: dossier, voice: voice)
                .onAppear { appDelegate.attach(push) }
        }
        .backgroundTask(.urlSession(BackgroundUploader.identifier)) { [uploader = uploads.uploader] in
            await uploader.finishBackgroundEvents()
        }
    }
}
