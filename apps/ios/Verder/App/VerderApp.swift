import SwiftUI

@main
struct VerderApp: App {
    @State private var auth: AuthModel
    @State private var lock = AppLock()
    /// Made at launch, not lazily: a relaunch for background-upload events
    /// must find the background session (one per identifier per process)
    /// already reconnected to its delegate.
    @State private var uploads: UploadCenter

    init() {
        let store = KeychainSessionStore()
        let client = APIClient(session: APIClient.makeSession(), store: store)
        _auth = State(initialValue: AuthModel(client: client, store: store))
        _uploads = State(initialValue: UploadCenter.live(client: client))
    }

    var body: some Scene {
        WindowGroup {
            RootView(auth: auth, lock: lock, uploads: uploads)
        }
        .backgroundTask(.urlSession(BackgroundUploader.identifier)) { [uploader = uploads.uploader] in
            await uploader.finishBackgroundEvents()
        }
    }
}
