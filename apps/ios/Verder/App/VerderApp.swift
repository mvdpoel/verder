import SwiftUI

@main
struct VerderApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var auth: AuthModel
    @State private var lock = AppLock()
    /// Made at launch, not lazily: a relaunch for background-upload events
    /// must find the background session (one per identifier per process)
    /// already reconnected to its delegate.
    @State private var uploads: UploadCenter
    @State private var push: PushRegistrar

    init() {
        let store = KeychainSessionStore()
        let client = APIClient(session: APIClient.makeSession(), store: store)
        let auth = AuthModel(client: client, store: store)
        _auth = State(initialValue: auth)
        _uploads = State(initialValue: UploadCenter.live(client: client))
        _push = State(initialValue: PushRegistrar(client: client, auth: auth))
    }

    var body: some Scene {
        WindowGroup {
            RootView(auth: auth, lock: lock, uploads: uploads, push: push, links: appDelegate.links)
                .onAppear { appDelegate.attach(push) }
        }
        .backgroundTask(.urlSession(BackgroundUploader.identifier)) { [uploader = uploads.uploader] in
            await uploader.finishBackgroundEvents()
        }
    }
}
