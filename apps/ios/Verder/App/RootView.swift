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
    let timeline: TimelineStore
    let weekly: WeeklyStore
    let voice: VoiceLogSession
    /// Overzicht's clock (`AppServices.now`).
    var now: @Sendable () -> Date = { Date() }
    var camera: any CameraAccess = LiveCameraAccess()
    @Environment(\.scenePhase) private var scenePhase
    /// A `verder://scan` (quick action, control, Action button) waiting for
    /// Scan to open its camera. ScanTab clears it once it has.
    @State private var cameraRequested = false
    /// Scan's page-into-the-queue flight, drawn above the TabView.
    @State private var scanHandoff = ScanHandoff()
    /// The item a link points at while the app is locked: its KIND only, for
    /// the lock's placeholder and the sheet's amber line (`LockedTarget`).
    @State private var lockedTarget: LockedTarget?
    /// Martin's own system sheets (Face ID, a permission alert) make the scene
    /// inactive too; the privacy cover leaves those alone.
    private var prompts: SystemPrompts { SystemPrompts.shared }

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
    /// `-route voice` (Verder/Fixtures), and whether the launch's
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
            if auth.isSignedIn, auth.passkeyOffer != nil {
                // The next step of a password sign-in (Figma "Sign-in /
                // Toegangssleutel toevoegen"); Overzicht after it.
                PasskeyOfferView(auth: auth) {
                    auth.dismissPasskeyOffer()
                    tab = .home
                }
            } else if auth.isSignedIn {
                tabs
            } else {
                // A first sign-in, and a session the server ended ("Log opnieuw in").
                signIn
            }
        }
        // The app-switcher snapshot shows the mark, never the dossier
        // (FEATURES 3.17). Not over the app's own system sheets: Face ID would
        // otherwise flash the cover behind its own prompt at every unlock.
        .overlay {
            if coversContent { PrivacyCover().transition(.identity) }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: lock.sceneDidEnterBackground()
            case .active:
                lock.sceneDidBecomeActive()
                if auth.isSignedIn { Task { await uploads.start() } }
                if auth.signOutPending { Task { await auth.retryPendingSignOut() } }
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
            if !locked { lockedTarget = nil }
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
            // Where it lands is `DeepLink.destination` (tested); this only applies it.
            let link = links.take()
            guard let to = link.destination else { return }
            lockedTarget = lock.isLocked ? LockedTarget(link) : nil
            if let target = to.tab { tab = target }
            switch to.stack {
            case .inbox(let path)?: inboxPath = path
            case .dossier(let path)?: dossierPath = path
            case .meer(let path)?: meerPath = path
            case nil: break
            }
            if to.opensVoice { voice.open() }
            if to.opensCamera { cameraRequested = true }
        }
        // The widget's `widgetURL` (Task 23). verder registers NO URL scheme,
        // so only its own widget reaches this; the strict parse still applies.
        .onOpenURL { url in links.deliver(DeepLink.parse(url.absoluteString)) }
        // An offline sign-out is revoked at the next launch, the next time the
        // app comes to the front, and the moment the network returns.
        .task { if auth.signOutPending { await auth.retryPendingSignOut() } }
        .onChange(of: uploads.isOffline) { _, offline in
            if !offline && auth.signOutPending { Task { await auth.retryPendingSignOut() } }
        }
        // The notification pre-prompt (Figma "Pre-prompt / Meldingen", brief
        // R25): one screen, one "Ga verder", no close; iOS's alert follows.
        // Never stacked on the toegangssleutel offer, and never over the lock.
        .fullScreenCover(isPresented: Binding(
            get: { push.prePromptPending && auth.isSignedIn && auth.passkeyOffer == nil && !lock.isLocked },
            set: { _ in }
        )) {
            NotificationPrePrompt {
                Task { await SystemPrompts.around { await push.acceptPrePrompt() } }
            }
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
    @ViewBuilder private var signIn: some View {
        #if DEBUG
        SignInView(auth: auth, offline: uploads.isOffline,
                   prefill: FixtureLaunch.current?.signIn?.prefill,
                   startOnPassword: FixtureLaunch.current?.signIn == .keyboard)
        #else
        SignInView(auth: auth, offline: uploads.isOffline)
        #endif
    }

    private var coversContent: Bool {
        #if DEBUG
        if FixtureLaunch.current?.cover == true { return true }
        #endif
        return scenePhase != .active && prompts.open == 0
    }

    /// The sheet after a cancelled (or impossible) Face ID. Not on Scan: the
    /// shutter is never covered; not over the voice sheet, which shows its own lock.
    private var unlockSheet: Binding<AppLock.UnlockSheet?> {
        Binding(get: { tab == .scan || voice.isPresented || !auth.isSignedIn ? nil : lock.unlockSheet },
                set: { if $0 == nil { lock.dismissUnlockSheet() } })
    }

    /// The frames dim the screen behind the unlock sheet and the voice log's
    /// sheets to about a quarter (auth final: Face ID geannuleerd, Geen
    /// toegangscode, Microfoon geweigerd), far past the system's own light
    /// dim — the counts behind a lock sheet must not read as the thing to do.
    /// Drawn on the presenting view, so it lies under the sheet, never on it.
    private var dimsBehindSheet: Bool {
        (lock.isUnlocking && tab != .scan) || unlockSheet.wrappedValue != nil || voice.isPresented
    }

    private func promptOnOpen() {
        guard auth.isSignedIn, lock.isLocked, tab != .scan else { return }
        Task { await lock.autoPromptIfNeeded() }
    }

    private var tabs: some View {
        TabView(selection: $tab) {
            Tab("Overzicht", systemImage: "square.grid.2x2", value: TabID.home) {
                // NOT gated: `.glance`, counts only while locked.
                HomeTab(store: inbox, money: money, uploads: uploads, lock: lock, now: now,
                        openInbox: { route in
                            inboxPath = route.map { [$0] } ?? []
                            tab = .voorJou
                        },
                        openScan: { tab = .scan },
                        // The Tijdlijn is pushed on Overzicht's own stack,
                        // lock-gated there; what sits behind a stop opens
                        // on Dossier, where documents and tasks live.
                        timeline: timeline,
                        openDossier: { route in
                            dossierPath = [route]
                            tab = .dossier
                        },
                        openVoorJou: {
                            inboxPath = []
                            tab = .voorJou
                        },
                        dossier: dossier)
            }
            Tab("Voor jou", systemImage: "tray", value: TabID.voorJou) {
                VoorJouTab(store: inbox, dossier: dossier.store, client: auth.client, gate: ApprovalGate(), path: $inboxPath,
                           onUnauthorized: { auth.sessionRejected() }, now: now)
                    .lockGated(by: lock)
                    .environment(\.lockedTarget, lockedTarget?.tab == .voorJou ? lockedTarget : nil)
                    .environment(\.networkOffline, uploads.isOffline)
            }
            Tab("Scan", image: ScanGlyph.tabAsset, value: TabID.scan) {
                // NOT gated: plan Task 7 step 3.
                ScanTab(center: uploads, auth: auth, camera: camera, cameraRequested: $cameraRequested,
                        locked: lock.isLocked,
                        openDocument: { id in
                            dossierPath = [.document(id: id, title: nil)]
                            tab = .dossier
                        },
                        handoff: scanHandoff)
            }
            Tab("Dossier", systemImage: "folder", value: TabID.dossier) {
                DossierTab(model: dossier, inbox: inbox, timeline: timeline, lock: lock, client: auth.client,
                           path: $dossierPath,
                           onUnauthorized: { auth.sessionRejected() },
                           openVoorJou: {
                               inboxPath = []
                               tab = .voorJou
                           })
                    .lockGated(by: lock)
                    .environment(\.lockedTarget, lockedTarget?.tab == .dossier ? lockedTarget : nil)
            }
            Tab("Meer", systemImage: "ellipsis", value: TabID.meer) {
                MoreTab(auth: auth, center: uploads, push: push, money: money, dossier: dossier, path: $meerPath,
                        openVoice: { voice.open() }, forgetVoice: { voice.close() },
                        weekly: weekly, inbox: inbox,
                        openVoorJou: {
                            inboxPath = []
                            tab = .voorJou
                        },
                        openDossier: {
                            dossierPath = []
                            tab = .dossier
                        },
                        openDoneByVerder: {
                            inboxPath = [.doneByVerder]
                            tab = .voorJou
                        }, now: now).lockGated(by: lock)
            }
        }
        .tint(Color.signal)
        .background {
            Color.clear.sheet(item: unlockSheet) { sheet in
                UnlockSheetView(sheet: sheet, lock: lock, target: lockedTarget,
                                overview: {
                                    lock.dismissUnlockSheet()
                                    tab = .home
                                },
                                scan: {
                                    lock.dismissUnlockSheet()
                                    tab = .scan
                                    cameraRequested = true
                                })
            }
        }
        // Above the tab bar: the handoff dims it too (frame "Scan · overdracht").
        .overlay { ScanHandoffOverlay(handoff: scanHandoff) }
        .overlay {
            if dimsBehindSheet { UnlockScrim().transition(.opacity) }
        }
        .animation(.easeInOut(duration: 0.2), value: dimsBehindSheet)
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
        // `-fixtures-mic`: the voice log opens as the quick action opens it,
        // on its pre-prompt or its "microfoon uit" sheet.
        if launch.mic != nil { voice.open() }
        // `-fixtures-push-preprompt`: the moment after a sign-in, when it asks.
        if launch.pushPrePrompt { Task { await push.requestPermissionIfNeeded() } }
        switch launch.route {
        case .link(let link)?: links.deliver(link)
        case .screen(let screen)?: fixtureScreen = screen
        case .meer(let path)?:
            tab = .meer
            meerPath = path
        case nil: break
        }
    }
    #endif
}
