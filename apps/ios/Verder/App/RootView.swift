import SwiftUI

/// The tab bar behind sign-in: Scan opens first; Voor jou, Dossier and Meer.
///
/// The app lock is judged here, once for the whole app. The Scan tab goes in
/// UN-gated (the camera opens before Face ID); every other tab gets
/// `.lockGated(by: lock)` — see `AppLock` for the rule.
struct RootView: View {
    let auth: AuthModel
    let lock: AppLock
    let uploads: UploadCenter
    let push: PushRegistrar
    let links: DeepLinkInbox
    @Environment(\.scenePhase) private var scenePhase

    enum TabID: Hashable { case scan, voorJou, dossier, meer }
    @State private var tab: TabID = .scan

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
            default: break
            }
        }
        .onChange(of: auth.isSignedIn) { _, signedIn in
            if signedIn { lock.didSignIn() }
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
            if let target = links.take().tab { tab = target }
        }
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

    private var tabs: some View {
        TabView(selection: $tab) {
            Tab("Scan", systemImage: "doc.viewfinder", value: TabID.scan) {
                // NOT gated: plan Task 7 step 3.
                ScanTab(center: uploads, auth: auth)
            }
            Tab("Voor jou", systemImage: "tray", value: TabID.voorJou) {
                ComingSoon(title: "Voor jou").lockGated(by: lock)
            }
            Tab("Dossier", systemImage: "folder", value: TabID.dossier) {
                ComingSoon(title: "Dossier").lockGated(by: lock)
            }
            Tab("Meer", systemImage: "ellipsis", value: TabID.meer) {
                MoreTab(auth: auth, center: uploads, push: push).lockGated(by: lock)
            }
        }
        .tint(Color.signal)
        .preferredColorScheme(.dark)
    }
}
