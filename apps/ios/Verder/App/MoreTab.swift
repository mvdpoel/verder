import SwiftUI

/// Meer: the account actions (passkey, sign out) that lived on the
/// pre-tab placeholder, one developer action for the end-to-end check, and
/// the promise of the rest. Lock-gated like every tab but Scan.
struct MoreTab: View {
    let auth: AuthModel
    let center: UploadCenter

    @State private var confirmResend = false

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    Text("Meer")
                        .font(.display(26, relativeTo: .title, weight: .ultraLight))
                        .foregroundStyle(Color.inkBright)

                    if auth.passkeyOfferPending { passkeyOffer }

                    account
                    developer

                    Text("Instellingen en de rest komen binnenkort.")
                        .font(.display(14, relativeTo: .callout, weight: .light))
                        .foregroundStyle(Color.inkMute)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 26)
            }
        }
        .preferredColorScheme(.dark)
    }

    private func label(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.mono(11, relativeTo: .caption2, weight: .medium))
            .foregroundStyle(Color.inkLabel)
    }

    private var account: some View {
        VStack(alignment: .leading, spacing: 12) {
            label("Account")
            if let message = auth.passkeyMessage {
                Text(message)
                    .font(.display(14, relativeTo: .callout, weight: .light))
                    .foregroundStyle(Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
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

    /// Plan Task 12 step 3: send the newest sent scan AGAIN with its own
    /// clientId; the server must answer `duplicate: true` and store nothing.
    /// Behind a confirmation, because it is a real upload to the real dossier.
    private var developer: some View {
        VStack(alignment: .leading, spacing: 12) {
            label("Ontwikkelaar")
            if let item = center.lastSent {
                Text(item.fileName)
                    .font(.mono(11, relativeTo: .caption2))
                    .foregroundStyle(Color.inkDim)
            }
            AuthButton(title: "Opnieuw versturen (zelfde clientId)", weight: .secondary,
                       enabled: center.lastSent != nil && !center.isResending) {
                confirmResend = true
            }
            if let result = center.resendResult {
                Text(result)
                    .font(.mono(11, relativeTo: .caption2))
                    .foregroundStyle(Color.ink)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .confirmationDialog("Laatste scan opnieuw versturen met dezelfde clientId?",
                            isPresented: $confirmResend, titleVisibility: .visible) {
            Button("Opnieuw versturen") { Task { await center.resendLastSent() } }
            Button("Annuleren", role: .cancel) {}
        } message: {
            Text("verder hoort te antwoorden met duplicate: true, zonder een nieuw document.")
        }
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

/// Voor jou and Dossier until their slices land.
struct ComingSoon: View {
    let title: String

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 13) {
                Text(title)
                    .font(.display(26, relativeTo: .title, weight: .ultraLight))
                    .foregroundStyle(Color.inkBright)
                Text("komt binnenkort")
                    .font(.mono(12, relativeTo: .caption))
                    .foregroundStyle(Color.inkDim)
                Spacer()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 26)
        }
        .preferredColorScheme(.dark)
    }
}
