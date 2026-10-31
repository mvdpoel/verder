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

    /// Until Task 11's tabs: the mark, the one-time passkey offer after a
    /// password sign-in, and the two account actions the passkey check on the
    /// phone needs (add one even when the web already has one; sign out to
    /// sign back in with it).
    private var placeholder: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            VStack(spacing: 26) {
                Spacer()
                Text("verder")
                    .font(.display(34, relativeTo: .largeTitle, weight: .ultraLight))
                    .foregroundStyle(Color.inkBright)
                Spacer()
                if auth.passkeyOfferPending {
                    passkeyOffer
                }
                if let message = auth.passkeyMessage {
                    Text(message)
                        .font(.display(14, relativeTo: .callout, weight: .light))
                        .foregroundStyle(Color.ink)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                VStack(spacing: 12) {
                    if !auth.passkeyOfferPending {
                        AuthButton(title: "Passkey toevoegen", weight: .secondary, enabled: !auth.isBusy) {
                            Task { await auth.addPasskey() }
                        }
                    }
                    AuthButton(title: "Uitloggen", weight: .secondary, enabled: !auth.isBusy) {
                        Task { await auth.signOut() }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 26)
        }
        .preferredColorScheme(.dark)
    }

    private var passkeyOffer: some View {
        VStack(alignment: .leading, spacing: 13) {
            Text("Passkey toevoegen?")
                .font(.display(20, relativeTo: .title3, weight: .light))
                .foregroundStyle(Color.inkBright)
            Text("Dan log je voortaan in met Face ID, zonder wachtwoord.")
                .font(.display(14, relativeTo: .callout, weight: .light))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
            AuthButton(title: "Passkey toevoegen", enabled: !auth.isBusy) {
                Task { await auth.addPasskey() }
            }
            AuthButton(title: "Niet nu", weight: .secondary, enabled: !auth.isBusy) {
                auth.dismissPasskeyOffer()
            }
        }
        .padding(26)
        .glassPanel()
    }
}
