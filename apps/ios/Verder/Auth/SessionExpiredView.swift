import SwiftUI

/// What the app shows when the SERVER ended the session (a 401 anywhere,
/// `AuthModel.sessionExpired`), rather than the first-launch sign-in: it says
/// what happened, that nothing queued is lost, and offers the toegangssleutel
/// first, the password second, and the camera anyway (Figma "overzicht ·
/// final", uitgelogd). The password leads to the ordinary sign-in screen.
///
/// No amber: an expired session is not something waiting on Martin in the dossier.
struct SessionExpiredView: View {
    let auth: AuthModel
    let uploads: UploadCenter

    @State private var usePassword = false
    @State private var scanning = false
    @Environment(\.dynamicTypeSize) private var typeSize

    enum Copy {
        static let title = "Je sessie is verlopen."
        static let body = "Log opnieuw in met je toegangssleutel en Face\u{00A0}ID. Scans in de wachtrij blijven bewaard en gaan daarna vanzelf mee."
        static let passkey = "Inloggen met toegangssleutel"
        static let password = "Inloggen met wachtwoord"
        static let scan = "Toch een brief scannen"
    }

    var body: some View {
        if usePassword {
            SignInView(auth: auth)
                .overlay(alignment: .topLeading) {
                    Button { usePassword = false } label: {
                        Label("Terug", systemImage: "chevron.left")
                            .font(HomeType.bodyStrong)
                            .foregroundStyle(Color.signal)
                            .frame(minHeight: 44)
                            .padding(.horizontal, 16)
                    }
                    .buttonStyle(.plain)
                }
        } else {
            expired
        }
    }

    private var expired: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Image(systemName: "lock")
                        .font(.system(size: 32, weight: .regular))
                        .foregroundStyle(Color.inkBright)
                        .accessibilityHidden(true)
                    Text(Copy.title)
                        .font(HomeType.title)
                        .foregroundStyle(Color.inkBright)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    Text(typeSize.isAccessibilitySize ? HomeSummary.hyphenated(Copy.body) : Copy.body)
                        .font(HomeType.body)
                        .foregroundStyle(Color.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    if let message = auth.errorMessage {
                        Text(message)
                            .font(HomeType.body)
                            .foregroundStyle(Color.inkMute)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .lineHeight(.multiple(factor: HomeType.sairaLineFactor))
                .padding(.horizontal, 16)
                .padding(.top, 140)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .safeAreaInset(edge: .bottom) { buttons }
        }
        .preferredColorScheme(.dark)
        .sensoryFeedback(.error, trigger: auth.errorMessage) { _, new in new != nil }
        .fullScreenCover(isPresented: $scanning) {
            ScanTab(center: uploads, auth: auth, cameraRequested: .constant(true))
                .overlay(alignment: .topTrailing) {
                    Button("Sluiten") { scanning = false }
                        .font(HomeType.bodyStrong)
                        .foregroundStyle(Color.signal)
                        .frame(minHeight: 44)
                        .padding(.horizontal, 16)
                }
        }
    }

    private var buttons: some View {
        VStack(spacing: 12) {
            Button { Task { await auth.signInWithPasskey() } } label: {
                Text(auth.isBusy ? "Bezig…" : Copy.passkey)
                    .font(HomeType.bodyStrong)
                    .foregroundStyle(Color.onSignal)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(LinearGradient(colors: [.signalLit, .signal], startPoint: .top, endPoint: .bottom),
                                in: RoundedRectangle(cornerRadius: Radius.chip))
                    .glow(Glow.action)
            }
            .disabled(auth.isBusy)
            Button { usePassword = true } label: {
                Text(Copy.password)
                    .font(HomeType.bodyStrong)
                    .foregroundStyle(Color.inkBright)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
                    .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
            }
            Button { scanning = true } label: {
                Text(Copy.scan)
                    .font(HomeType.bodyStrong)
                    .foregroundStyle(Color.signal)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .background(Color.void)
    }
}
