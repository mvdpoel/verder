import SwiftUI

/// The next step of a password sign-in when the account (or this phone) has no
/// toegangssleutel yet (Figma "Sign-in / Toegangssleutel toevoegen"): name
/// what it buys, one button, and say where it lives later. Shown at most once
/// per install (`AuthModel.offerPasskeyIfNone`), and after a sign-in that
/// found this phone's toegangssleutel gone from the account.
///
/// iOS answering 1006 — the Mac's toegangssleutel already synced here through
/// iCloud Keychain — is not a failure: the screen says it works already
/// ("… staat al op je telefoon") and asks nothing more.
struct PasskeyOfferView: View {
    let auth: AuthModel
    /// "Ga naar Overzicht" / "Sla over" / a toegangssleutel added: back to the app.
    let done: () -> Void

    @State private var viewport: CGFloat = 0

    enum Copy {
        static let title = "Voortaan met Face\u{00A0}ID inloggen?"
        static let body = "Zet een toegangssleutel op deze iPhone. Daarna is inloggen één tik."
        static let add = "Zet toegangssleutel aan"
        static let skip = "Sla over"
        static let later = "Later kan het in Meer → Account."
        static let worksTitle = "Je toegangssleutel werkt al"
        static let worksBody = "Hij staat al op deze iPhone, via iCloud-sleutelhanger."
        static let toOverview = "Ga naar Overzicht"
        static let noSecondFaceID = "Face\u{00A0}ID wordt nu niet nog een keer gevraagd."
    }

    private var works: Bool { auth.passkeyOffer == .alreadyOnDevice }

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    AuthEyebrow().padding(.bottom, 16)
                    AuthTitle(works ? Copy.worksTitle : Copy.title)
                    Text(works ? Copy.worksBody : Copy.body)
                        .font(AuthType.callout)
                        .foregroundStyle(Color.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 4)
                    Spacer(minLength: 32)
                    Group {
                        if auth.isBusy { FaceIDTile() } else { VerderRings(confirmed: works) }
                    }
                    .frame(maxWidth: .infinity)
                    Spacer(minLength: 32)
                }
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .frame(minHeight: viewport, alignment: .top)
                .lineHeight(.multiple(factor: AuthType.lineFactor))
            }
            .scrollBounceBehavior(.basedOnSize)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewport = $0 }
            .safeAreaInset(edge: .bottom, spacing: 0) { actions }
        }
        .authTypeCap()
        .preferredColorScheme(.dark)
        .sensoryFeedback(.success, trigger: auth.passkeyAddedCount)
        // Added: the offer has done its job.
        .onChange(of: auth.passkeyAddedCount) { _, _ in done() }
    }

    private var actions: some View {
        VStack(spacing: 0) {
            if works {
                AuthButton(title: Copy.toOverview, action: done)
                AuthCaption(Copy.noSecondFaceID).padding(.top, 16)
            } else {
                AuthButton(title: auth.isBusy ? SignInView.Copy.waitingFaceID : Copy.add, busy: auth.isBusy) {
                    Task { await auth.addPasskey() }
                }
                if let message = auth.passkeyMessage {
                    AuthCaption(message, emphasised: true).padding(.top, 16)
                } else {
                    AuthCaption(SignInView.Copy.faceIDConfirms).padding(.top, 16)
                }
                AuthButton(title: Copy.skip, weight: .ghost, busy: auth.isBusy, action: done)
                    .padding(.top, 12)
                AuthCaption(Copy.later).padding(.top, 4)
            }
        }
        .lineHeight(.multiple(factor: AuthType.lineFactor))
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 16)
        .background(Color.void)
    }
}
