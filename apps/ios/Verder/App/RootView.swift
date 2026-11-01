import SwiftUI

/// The tab bar behind sign-in: Overzicht opens first (Martin, 2026-11-01: "the
/// app should open on a dashboard, showing current state"); then Voor jou,
/// Scan, Dossier and Meer.
///
/// The app lock is judged here, once for the whole app. Scan and Overzicht go
/// in UN-gated: the camera opens before Face ID, and Overzicht shows counts
/// only until unlock (Martin, 2026-11-01). Every other tab gets
/// `.lockGated(by: lock)` — see `AppLock` for the rule. So opening the app
/// asks nothing; Face ID comes the moment Martin taps into case content.
struct RootView: View {
    let auth: AuthModel
    let lock: AppLock
    let uploads: UploadCenter
    let push: PushRegistrar
    let links: DeepLinkInbox
    let inbox: InboxStore
    let money: MoneyStore
    let dossier: DossierModel
    let voice: VoiceLogSession
    @Environment(\.scenePhase) private var scenePhase

    enum TabID: Hashable { case home, scan, voorJou, dossier, meer }
    @State private var tab: TabID = .home
    /// The Voor jou stack. Held HERE, not in the tab: a gated tab's content
    /// does not exist while locked, so a deep link that arrives on the lock
    /// screen must wait somewhere that survives it.
    @State private var inboxPath: [InboxRoute] = []
    /// The Dossier stack, held here for the same reason: a document link
    /// that lands on the lock screen opens once the app is unlocked.
    @State private var dossierPath: [DossierRoute] = []
    /// The Meer stack, held here for the same reason: a tap on the Sunday
    /// push opens the Weekoverzicht once the app is unlocked.
    @State private var meerPath: [MoreRoute] = []
    #if DEBUG
    /// `-route geld|voice` (Verder/Fixtures), and whether the launch's
    /// `-tab`/`-route` has been applied — once, not on every re-appearance.
    @State private var fixtureScreen: FixtureLaunch.Screen?
    @State private var fixtureStartApplied = false
    #endif

    var body: some View {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-tokenPreview") {
            TokenPreview().preferredColorScheme(.dark)
        } else {
            signedInOrSignIn
        }
        #else
        signedInOrSignIn
        #endif
    }

    private var signedInOrSignIn: some View {
        Group {
            if auth.isSignedIn {
                tabs
            } else {
                SignInView(auth: auth)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: lock.sceneDidEnterBackground()
            case .active:
                lock.sceneDidBecomeActive()
                if auth.isSignedIn { Task { await uploads.start() } }
                promptOnOpen()
            default: break
            }
        }
        .onChange(of: auth.isSignedIn) { _, signedIn in
            if signedIn { lock.didSignIn() }
            // A 401 swaps the tabs (and the voice sheet) for sign-in; the
            // unsent voice log waits and comes back after (`VoiceLogSession`).
            if signedIn { voice.sessionStarted() } else { voice.sessionEnded() }
        }
        // Push permission is asked after a sign-in or an unlock — moments
        // Martin chose to look at verder — and never on a cold launch, which
        // belongs to the camera (plan 2 Task 7 step 3). Both are idempotent:
        // the pre-prompt is offered once per install.
        .onChange(of: auth.sessionGeneration) { _, _ in
            Task { await push.requestPermissionIfNeeded() }
        }
        .onChange(of: lock.isLocked) { _, locked in
            if !locked && auth.isSignedIn { Task { await push.requestPermissionIfNeeded() } }
        }
        // Every launch with a session refreshes the APNs token (tokens change);
        // this never prompts.
        .task(id: auth.isSignedIn) {
            if auth.isSignedIn { await push.registerIfAllowed() }
        }
        // A tapped notification. The target tabs are lock-gated, so what the
        // link points at shows only after unlock.
        .onChange(of: links.pending, initial: true) { _, _ in
            let link = links.take()
            if let target = link.tab { tab = target }
            switch link {
            case .proposal(let id): inboxPath = [.proposal(id.uuidString.lowercased())]
            case .suggestion(let id): inboxPath = [.suggestion(id.uuidString.lowercased())]
            case .task(let id): inboxPath = [.task(id.uuidString.lowercased())]
            case .inbox: inboxPath = []
            case .document(let id): dossierPath = [.document(id: id.uuidString.lowercased(), title: nil)]
            case .voice: voice.open()
            case .weekly: meerPath = [.weekly]
            case .none: break
            }
        }
        // The widget's `widgetURL` (Task 23). verder registers NO URL scheme,
        // so only its own widget reaches this; the strict parse still applies.
        .onOpenURL { url in links.deliver(DeepLink.parse(url.absoluteString)) }
        // Never stacked on the passkey offer: that one waits in Meer first.
        .alert(PushRegistrar.Copy.prePromptTitle, isPresented: Binding(
            get: { push.prePromptPending && auth.isSignedIn && !auth.passkeyOfferPending },
            set: { _ in }
        )) {
            Button(PushRegistrar.Copy.allow) { Task { await push.acceptPrePrompt() } }
            Button(PushRegistrar.Copy.notNow, role: .cancel) { push.declinePrePrompt() }
        } message: {
            Text(PushRegistrar.Copy.prePrompt)
        }
        // The one-time passkey offer lives in Meer; it only ever appears right
        // after an interactive password sign-in, so Martin is looking.
        .onChange(of: auth.passkeyOfferPending) { _, pending in
            if pending { tab = .meer }
        }
        // Uploads only with a session: without one every send is a 401.
        .task(id: auth.isSignedIn) {
            if auth.isSignedIn { await uploads.start() }
        }
        // A NEW session (the stored one may have been rejected while
        // `isSignedIn` stayed true): clear "log opnieuw in" and send. Here and
        // not in ScanTab, because a first sign-in creates ScanTab with the
        // new value already in place and its onChange would never fire.
        .onChange(of: auth.sessionGeneration) { _, _ in
            Task { await uploads.sessionRenewed() }
        }
    }

    /// Martin, 2026-11-01: "only do Face ID on open and reopen of app, not for
    /// every screen switch". So the app asks ONCE, by itself, the moment it
    /// opens or comes back past the grace period (`LockPolicy`), whichever tab
    /// is showing; after that every tab is open until the next lock. Overzicht
    /// shows its counts behind the sheet meanwhile. The one exception stays the
    /// camera: on Scan nothing prompts, so the shutter is never covered.
    private func promptOnOpen() {
        guard auth.isSignedIn, lock.isLocked, tab != .scan else { return }
        Task { await lock.autoPromptIfNeeded() }
    }

    private var tabs: some View {
        TabView(selection: $tab) {
            Tab("Overzicht", systemImage: "square.grid.2x2", value: TabID.home) {
                // NOT gated: `.glance`, counts only while locked.
                HomeTab(store: inbox, money: money, uploads: uploads, lock: lock,
                        openInbox: { route in
                            inboxPath = route.map { [$0] } ?? []
                            tab = .voorJou
                        },
                        openScan: { tab = .scan })
            }
            Tab("Voor jou", systemImage: "tray", value: TabID.voorJou) {
                VoorJouTab(store: inbox, client: auth.client, gate: ApprovalGate(), path: $inboxPath,
                           onUnauthorized: { auth.sessionRejected() })
                    .lockGated(by: lock)
            }
            Tab("Scan", systemImage: "doc.viewfinder", value: TabID.scan) {
                // NOT gated: plan Task 7 step 3.
                ScanTab(center: uploads, auth: auth)
            }
            Tab("Dossier", systemImage: "folder", value: TabID.dossier) {
                DossierTab(model: dossier, inbox: inbox, lock: lock, client: auth.client, path: $dossierPath,
                           onUnauthorized: { auth.sessionRejected() })
                    .lockGated(by: lock)
            }
            Tab("Meer", systemImage: "ellipsis", value: TabID.meer) {
                MoreTab(auth: auth, center: uploads, push: push, money: money, dossier: dossier, path: $meerPath,
                        openVoice: { voice.open() }, forgetVoice: { voice.close() },
                        liveWaiting: inbox.inbox?.count,
                        openVoorJou: {
                            inboxPath = []
                            tab = .voorJou
                        }).lockGated(by: lock)
            }
        }
        .tint(Color.signal)
        .preferredColorScheme(.dark)
        // Lock-gated: it names parties. From the quick action on a cold
        // launch the lock asks Face ID by itself (`promptOnOpen`).
        // The model lives in `voice`, above this gate: a relock or a 401
        // removes the sheet's content, never the text Martin was told stays.
        .sheet(isPresented: Binding(get: { voice.isPresented }, set: { voice.presentationChanged($0) })) {
            VoiceLogSheet(session: voice).lockGated(by: lock)
        }
        // A cold launch is already `.active` when the tabs appear, so the
        // scene-phase change above never fires for it.
        .onAppear {
            promptOnOpen()
            #if DEBUG
            applyFixtureStart()
            #endif
        }
        #if DEBUG
        .fullScreenCover(item: $fixtureScreen) { FixtureScreen(screen: $0, money: money, voice: voice.factory) }
        #endif
    }

    #if DEBUG
    /// `-tab` selects a tab; `-route proposal:<id>` (and suggestion, task) goes
    /// through `links`, exactly the path a tapped notification takes.
    private func applyFixtureStart() {
        guard !fixtureStartApplied, let launch = FixtureLaunch.current else { return }
        fixtureStartApplied = true
        if let start = launch.tab { tab = start.tabID }
        switch launch.route {
        case .link(let link)?: links.deliver(link)
        case .screen(let screen)?: fixtureScreen = screen
        case nil: break
        }
    }
    #endif
}
