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
    /// Voor jou's data, the icon badge and the widget snapshot. One per
    /// process, beside the registrar: the silent-push refresh (AppDelegate) and
    /// the tab read the same store.
    @State private var inbox: InboxStore

    init() {
        let store = KeychainSessionStore()
        let client = APIClient(session: APIClient.makeSession(), store: store)
        let auth = AuthModel(client: client, store: store)
        _auth = State(initialValue: auth)
        _uploads = State(initialValue: UploadCenter.live(client: client))
        _push = State(initialValue: PushRegistrar(client: client, auth: auth))
        let inbox = InboxStore(client: client, onUnauthorized: { auth.sessionRejected() })
        _inbox = State(initialValue: inbox)
        // Before any delegate callback, so a background launch for a question
        // answer or a silent refresh finds them (see `AppDelegate.Services`).
        AppDelegate.services = .init(client: client, inbox: inbox)
    }

    var body: some Scene {
        WindowGroup {
            RootView(auth: auth, lock: lock, uploads: uploads, push: push, links: appDelegate.links, inbox: inbox)
                .onAppear { appDelegate.attach(push) }
        }
        .backgroundTask(.urlSession(BackgroundUploader.identifier)) { [uploader = uploads.uploader] in
            await uploader.finishBackgroundEvents()
        }
    }
}
