import SwiftUI

@main
struct GripApp: App {
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
    /// The Sunday summary behind Meer's row and the Weekoverzicht.
    @State private var weekly: WeeklyStore
    /// The voice log (Meer, or the home screen quick action), owned here —
    /// above the lock gate and sign-in — so a relock or a 401 keeps its text.
    @State private var voice: VoiceLogSession
    /// "Gesprek voorbereiden" and its Live Activity, owned here for the same
    /// reason: the Phone app taking the screen, or a relock, keeps the ticks.
    @State private var call: CallSession
    /// `AppServices.now`: Overzicht's clock.
    private let now: @Sendable () -> Date
    private let camera: any CameraAccess

    init() {
        #if DEBUG
        // `-fixtures <name>`: the same stores on the synthetic dataset, no
        // server (Grip/Fixtures). Compiled out of Release.
        if let launch = FixtureLaunch.current {
            self.init(services: FixtureEnvironment.services(for: launch))
            return
        }
        #endif
        self.init(services: .live())
    }

    private init(services s: AppServices) {
        let auth = AuthModel(client: s.client, store: s.store, defaults: s.defaults, widgetSnapshotDir: s.snapshotDir,
                             pendingSignOut: s.pendingSignOut, now: s.now)
        // A missing answer reads "offline" only when the phone has no network
        // path; otherwise it is verder not answering ("De server reageert niet.").
        auth.networkIsUp = { [uploads = s.uploads] in !uploads.isOffline }
        #if DEBUG
        if let state = FixtureLaunch.current?.signIn { auth.fixtureSeed(state) }
        #endif
        _auth = State(initialValue: auth)
        _lock = State(initialValue: s.lock)
        _uploads = State(initialValue: s.uploads)
        let push = PushRegistrar(client: s.client, auth: auth, permission: s.permission,
                                 defaults: s.defaults, registerRemote: s.registerRemote)
        #if DEBUG
        if FixtureEnvironment.opensDeveloper {
            push.seedFixtureRegistration(environment: "development", tokenTail: FixtureEnvironment.developerTokenTail,
                                         at: FixtureEnvironment.developerRegisteredAt)
        }
        #endif
        _push = State(initialValue: push)
        // Every store holding case content shares auth's ONE sign-out epoch
        // (`SessionEpoch`): signing out, or a 401 anywhere, clears all three,
        // and a refresh still in flight writes nothing back.
        let inbox = InboxStore(client: s.client, snapshotDir: s.snapshotDir, setBadge: s.setBadge,
                               onUnauthorized: { auth.sessionRejected() }, now: s.now, epoch: auth.epoch,
                               cache: InboxCache(dir: s.inboxDir))
        now = s.now
        camera = s.camera
        _inbox = State(initialValue: inbox)
        _money = State(initialValue: MoneyStore(client: s.client, onUnauthorized: { auth.sessionRejected() },
                                                epoch: auth.epoch, now: s.now))
        _dossier = State(initialValue: DossierModel(store: DossierStore(dir: s.dossierDir, now: s.now),
                                                    client: s.client,
                                                    onUnauthorized: { auth.sessionRejected() },
                                                    epoch: auth.epoch, now: s.now))
        _timeline = State(initialValue: TimelineStore(client: s.client, cache: TimelineCache(dir: s.timelineDir),
                                                      onUnauthorized: { auth.sessionRejected() },
                                                      epoch: auth.epoch, now: s.now))
        _weekly = State(initialValue: WeeklyStore(client: s.client, cache: WeeklyCache(dir: s.weeklyDir),
                                                  onUnauthorized: { auth.sessionRejected() },
                                                  epoch: auth.epoch, now: s.now))
        let client = s.client
        let clock = s.now
        // The last active call sheet's ticks, for a call recording imported
        // within the hour (Added 2026-11-03). Shared by the two sessions.
        let recent = RecentCallSheet()
        let voice = VoiceLogSession(factory: VoiceLogFactory {
            VoiceLogModel(client: client, recorder: s.makeRecorder(), transcriber: s.transcriber,
                          dir: VoiceLogModel.liveDirectory, recentCall: { recent.prefill(now: clock()) },
                          onUnauthorized: { auth.sessionRejected() })
        }, groupDir: s.snapshotDir)
        _voice = State(initialValue: voice)
        _call = State(initialValue: CallSession(
            client: client, cache: CallCache(dir: s.callCacheDir), activities: s.makeCallActivities(),
            observer: s.makeCallObserver(), epoch: auth.epoch, now: { clock() },
            // The call itself is the Phone app's: verder only hands it the number.
            dial: { UIApplication.shared.open($0) },
            openVoice: { voice.open(prefill: $0) },
            recent: recent,
            onUnauthorized: { auth.sessionRejected() }))
        // Before any delegate callback, so a background launch for a question
        // answer or a silent refresh finds them (see `AppDelegate.Services`).
        AppDelegate.services = .init(client: s.client, inbox: inbox)
    }

    private var root: some View {
        RootView(auth: auth, lock: lock, uploads: uploads, push: push, links: appDelegate.links, inbox: inbox,
                 money: money, dossier: dossier, timeline: timeline, weekly: weekly, voice: voice, call: call,
                 now: now, camera: camera)
            .onAppear { appDelegate.attach(push) }
    }

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            // `-widget-host <scene>`: the widget faces on a drawn home screen,
            // lock screen or StandBy, for the captures (FixtureWidgetHost).
            if let scene = WidgetHostScene.current {
                WidgetHostView(scene: scene)
            } else if let scene = ShareHostScene.current {
                // `-share-host <scene>`: the share extension's screen in a
                // sheet, on a real ShareModel (FixtureShareHost).
                ShareHostView(scene: scene)
            } else {
                root
            }
            #else
            root
            #endif
        }
        .backgroundTask(.urlSession(BackgroundUploader.identifier)) { [uploader = uploads.uploader] in
            await uploader.finishBackgroundEvents()
        }
    }
}
