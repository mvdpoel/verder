import SwiftUI

/// The web's /login on the phone: the passkey first (one tap and Face ID),
/// the password second as the fallback.
///
/// No amber here: an error is not something waiting on Martin in the dossier.
struct SignInView: View {
    let auth: AuthModel

    @State private var email = ""
    @State private var password = ""
    @FocusState private var focus: Field?

    private enum Field { case email, password }

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 26) {
                    mark
                    VStack(alignment: .leading, spacing: 18) {
                        Text("Inloggen")
                            .font(.display(26, relativeTo: .title, weight: .ultraLight))
                            .foregroundStyle(Color.inkBright)

                        AuthButton(title: "Inloggen met passkey", enabled: !auth.isBusy) {
                            Task { await auth.signInWithPasskey() }
                        }

                        Text("of met je wachtwoord")
                            .font(.mono(11, relativeTo: .caption))
                            .foregroundStyle(Color.inkLabel)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 4)

                        field("E-mail") {
                            TextField("", text: $email)
                                .textContentType(.username)
                                .keyboardType(.emailAddress)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .submitLabel(.next)
                                .focused($focus, equals: .email)
                                .onSubmit { focus = .password }
                        }
                        field("Wachtwoord") {
                            SecureField("", text: $password)
                                .textContentType(.password)
                                .submitLabel(.go)
                                .focused($focus, equals: .password)
                                .onSubmit(submit)
                        }

                        if let message = auth.errorMessage {
                            Text(message)
                                .font(.display(14, relativeTo: .callout, weight: .light))
                                .foregroundStyle(Color.ink)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityAddTraits(.isStaticText)
                        }

                        AuthButton(title: auth.isBusy ? "Bezig…" : "Inloggen met wachtwoord",
                                   weight: .secondary, enabled: canSubmit, action: submit)
                    }
                    .padding(26)
                    .glassPanel()
                }
                .padding(.horizontal, 16)
                .padding(.top, 72)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .preferredColorScheme(.dark)
    }

    private var canSubmit: Bool {
        !auth.isBusy && !email.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
    }

    private func submit() {
        guard canSubmit else { return }
        let address = email.trimmingCharacters(in: .whitespaces)
        Task { await auth.signInWithPassword(email: address, password: password) }
    }

    /// The rail's mark from the web's login page.
    private var mark: some View {
        VStack(spacing: 13) {
            Canvas { ctx, size in
                let s = size.width / 26
                func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * s, y: y * s) }
                ctx.stroke(Path(ellipseIn: CGRect(x: 2 * s, y: 2 * s, width: 22 * s, height: 22 * s)),
                           with: .color(.signal), lineWidth: 1)
                var axis = Path(); axis.move(to: p(13, 3.2)); axis.addLine(to: p(13, 22.8))
                ctx.stroke(axis, with: .color(.signal.opacity(0.45)), lineWidth: 1)
                var curve = Path(); curve.move(to: p(5.4, 8.4))
                curve.addCurve(to: p(20.6, 8.4), control1: p(10, 13), control2: p(16, 13))
                ctx.stroke(curve, with: .color(.signal), lineWidth: 1.2)
            }
            .frame(width: 34, height: 34)
            .accessibilityHidden(true)
            Text("VERDER")
                .font(.display(15, relativeTo: .headline))
                .tracking(15 * 0.44)
                .foregroundStyle(Color.inkSoft)
        }
    }

    private func field<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.mono(11, relativeTo: .caption))
                .foregroundStyle(Color.inkLabel)
            content()
                .font(.display(16, relativeTo: .body))
                .foregroundStyle(Color.ink)
                .tint(Color.signal)
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
                .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
                .accessibilityLabel(label)
        }
    }
}
