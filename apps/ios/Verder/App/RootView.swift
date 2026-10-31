import SwiftUI

/// Placeholder root on `void`, behind sign-in. Task 11 replaces the placeholder
/// with the tab bar (Scan first).
struct RootView: View {
    let auth: AuthModel

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

    @ViewBuilder private var signedInOrSignIn: some View {
        if auth.isSignedIn {
            placeholder
        } else {
            SignInView(auth: auth)
        }
    }

    private var placeholder: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            Text("verder")
                .font(.display(34, relativeTo: .largeTitle, weight: .ultraLight))
                .foregroundStyle(Color.inkBright)
        }
        .preferredColorScheme(.dark)
    }
}
