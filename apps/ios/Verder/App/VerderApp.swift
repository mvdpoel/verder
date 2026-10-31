import SwiftUI

@main
struct VerderApp: App {
    @State private var auth: AuthModel = {
        let store = KeychainSessionStore()
        return AuthModel(client: APIClient(session: APIClient.makeSession(), store: store), store: store)
    }()
    @State private var lock = AppLock()

    var body: some Scene {
        WindowGroup {
            RootView(auth: auth, lock: lock)
        }
    }
}
