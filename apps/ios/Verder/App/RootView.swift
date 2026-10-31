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
                MoreTab(auth: auth, center: uploads).lockGated(by: lock)
            }
        }
        .tint(Color.signal)
        .preferredColorScheme(.dark)
    }
}
