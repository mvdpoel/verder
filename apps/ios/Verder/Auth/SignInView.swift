import SwiftUI

/// Sign-in (Figma "auth · final", Sign-in row): the toegangssleutel FIRST —
/// one tap and Face ID — and the password as a second step behind a link.
/// Every screen says what signing in buys ("Deze iPhone blijft 30 dagen
/// ingelogd."). A failure is one notice at the top naming its kind, its time
/// and its cause (`SignInNotice`, which also decides the buttons); a cancelled
/// sheet is one calm line, never a notice.
///
/// The same screen answers a session the SERVER ended: the title reads "Log
/// opnieuw in" and the notice "UITGELOGD · <day> <time>".
///
/// No amber here: an error is not something waiting on Martin in the dossier.
struct SignInView: View {
    let auth: AuthModel
    /// The phone's own network path (`UploadCenter.isOffline`): an offline
    /// password attempt is sent once more when it comes back.
    var offline = false
    /// Fields filled in at first appearance (a fixture capture of "Wachtwoord
    /// klopt niet"); nil in the app.
    var prefill: (email: String, password: String)?
    /// Step two with the e-mail field focused (a capture of the keyboard frame).
    var startOnPassword = false

    @State private var email = ""
    @State private var password = ""
    @State private var step: SignInMethod = .passkey
    @State private var viewport: CGFloat = 0
    @FocusState private var focus: Field?
    @Environment(\.dynamicTypeSize) private var typeSize
    /// At the accessibility sizes the buttons scroll with the page (frame
    /// "Geen toegangssleutel gevonden · AX5"): pinned, they would fill the screen.
    private var ax: Bool { typeSize.isAccessibilitySize }

    private enum Field { case email, password }

    enum Copy {
        static let title = "Inloggen"
        static let expiredTitle = "Log opnieuw in"
        static let subtitle = "Je dossier, veilig op deze iPhone."
        static let passkey = "Inloggen met toegangssleutel"
        static let password = "Inloggen met wachtwoord"
        static let retry = "Probeer opnieuw"
        static let retryPasskey = "Probeer toegangssleutel opnieuw"
        static let waitingFaceID = "Wacht op Face\u{00A0}ID…"
        static let busy = "Bezig…"
        static let faceIDConfirms = "Face\u{00A0}ID bevestigt dat jij het bent."
        static let cancelled = "Je tikte op Annuleer · er is niets veranderd."
        static let thirtyDays = "Deze iPhone blijft 30 dagen ingelogd."
        static let emailLabel = "E-mailadres"
        static let passwordLabel = "Wachtwoord"
        static let emailPrompt = "jij@mail.nl"
        static let passwordPrompt = "Je wachtwoord"
    }

    /// The notice the screen draws; an expiry is drawn too, it is the reason
    /// the screen is up.
    private var notice: SignInNotice? { auth.notice }
    private var expired: Bool { auth.sessionExpired }
    private var showsFields: Bool { notice.map { $0.showsFields } ?? (step == .password) }
    /// The keyboard is up on step two: the header and footer give it room.
    private var typing: Bool { showsFields && focus != nil && notice == nil }

    private var primary: SignInNotice.Action {
        if let notice, notice.cause != .sessionExpired { return notice.primary }
        return step == .password ? .password : .passkey
    }

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header
                    if let notice {
                        AuthNoticeCard(label: notice.label, title: notice.title, text: notice.body, detail: notice.detail)
                            .padding(.top, 24)
                    }
                    if showsFields {
                        fields.padding(.top, notice == nil ? 32 : 24)
                        if typing {
                            AuthButton(title: Copy.passkey, weight: .ghost) { toPasskey() }
                                .padding(.top, 16)
                        }
                        Spacer(minLength: 24)
                    } else if !ax {
                        Spacer(minLength: 32)
                        centre.frame(maxWidth: .infinity)
                        Spacer(minLength: 32)
                    }
                    if ax { actions.padding(.horizontal, -16).padding(.top, 8) }
                }
                .padding(.horizontal, 16)
                .padding(.top, typing ? 16 : 14)
                .frame(minHeight: viewport, alignment: .top)
                .lineHeight(.multiple(factor: AuthType.lineFactor))
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollBounceBehavior(.basedOnSize)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewport = $0 }
            .safeAreaInset(edge: .bottom, spacing: 0) { if !ax { actions } }
        }
        .authTypeCap()
        .preferredColorScheme(.dark)
        .sensoryFeedback(.error, trigger: auth.notice) { _, new in
            new != nil && new?.cause != .sessionExpired
        }
        .onChange(of: offline) { _, isOffline in
            if !isOffline && auth.networkReturned() { submit() }
        }
        .onAppear {
            if let prefill { email = prefill.email; password = prefill.password }
            if startOnPassword { step = .password; focus = .email }
            if auth.notice?.showsFields == true { step = .password }
        }
        .onChange(of: auth.notice) { _, new in
            if new?.showsFields == true { step = .password }
        }
    }

    // MARK: Header and centre

    @ViewBuilder private var header: some View {
        if !typing {
            AuthEyebrow().padding(.bottom, 16)
        }
        AuthTitle(expired ? Copy.expiredTitle : Copy.title)
        if !expired && !typing {
            Text(Copy.subtitle)
                .font(AuthType.callout)
                .foregroundStyle(Color.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4)
        }
    }

    @ViewBuilder private var centre: some View {
        if auth.isBusy && auth.lastMethod == .passkey {
            FaceIDTile()
        } else {
            VerderRings()
        }
    }

    // MARK: Fields

    private var fields: some View {
        VStack(alignment: .leading, spacing: 20) {
            field(Copy.emailLabel, focused: focus == .email) {
                TextField("", text: $email, prompt: Text(Copy.emailPrompt).foregroundStyle(Color.inkMute))
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .focused($focus, equals: .email)
                    .onSubmit { focus = .password }
            }
            field(Copy.passwordLabel, focused: focus == .password) {
                SecureField("", text: $password, prompt: Text(Copy.passwordPrompt).foregroundStyle(Color.inkMute))
                    .textContentType(.password)
                    .submitLabel(.go)
                    .focused($focus, equals: .password)
                    .onSubmit(submit)
            }
        }
    }

    private func field<Content: View>(_ label: String, focused: Bool, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label.uppercased())
                .font(AuthType.label)
                .tracking(AuthType.labelTracking)
                .foregroundStyle(Color.inkLabel)
                .accessibilityHidden(true)
            content()
                .font(.display(17, relativeTo: .body))
                .foregroundStyle(Color.inkBright)
                .tint(Color.signal)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .frame(minHeight: 48)
                .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
                .overlay(RoundedRectangle(cornerRadius: Radius.chip)
                    .strokeBorder(focused ? Color.signal : Color.edgeStrong, lineWidth: 1))
                .accessibilityLabel(label)
        }
    }

    // MARK: Actions

    private var actions: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let now = auth.now()
            VStack(spacing: 0) {
                AuthButton(title: primaryTitle, enabled: primaryEnabled(now: now), busy: auth.isBusy,
                           action: pressPrimary)
                if let caption = caption(now: now) {
                    AuthCaption(caption, emphasised: caption == Copy.cancelled)
                        .padding(.top, 16)
                        .accessibilityAddTraits(.updatesFrequently)
                }
                if !typing, let ghost {
                    AuthButton(title: ghostTitle(ghost), weight: .ghost, busy: auth.isBusy) { press(ghost) }
                        .padding(.top, 12)
                }
                if !typing {
                    AuthCaption(Copy.thirtyDays).padding(.top, ghost == nil ? 8 : 4)
                }
            }
            .lineHeight(.multiple(factor: AuthType.lineFactor))
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, typing ? 8 : 16)
            .background(Color.void)
        }
    }

    private var primaryTitle: String {
        switch primary {
        case .passkey: auth.isBusy && auth.lastMethod == .passkey ? Copy.waitingFaceID : Copy.passkey
        case .password: auth.isBusy && auth.lastMethod == .password ? Copy.busy : Copy.password
        case .retry: auth.isBusy ? Copy.busy : Copy.retry
        }
    }

    private func primaryEnabled(now: Date) -> Bool {
        notice?.primaryEnabled(now: now) ?? true
    }

    private func caption(now: Date) -> String? {
        if let notice, notice.cause != .sessionExpired, let line = notice.caption(now: now) { return line }
        if auth.passkeyCancelled { return Copy.cancelled }
        if primary == .passkey { return Copy.faceIDConfirms }
        return nil
    }

    private var ghost: SignInNotice.Ghost? {
        if let notice, notice.cause != .sessionExpired { return notice.ghost }
        return step == .password ? .toPasskey : .toPassword
    }

    private func ghostTitle(_ ghost: SignInNotice.Ghost) -> String {
        switch ghost {
        case .toPassword: Copy.password
        case .toPasskey: Copy.passkey
        case .retryPasskey: Copy.retryPasskey
        }
    }

    private func press(_ ghost: SignInNotice.Ghost) {
        switch ghost {
        case .toPassword:
            auth.clearNotice()
            step = .password
        case .toPasskey: toPasskey()
        case .retryPasskey: signInWithPasskey()
        }
    }

    private func pressPrimary() {
        switch primary {
        case .passkey: signInWithPasskey()
        case .password:
            if showsFields || canSubmit {
                submit()
            } else {
                // "Inloggen met wachtwoord" from a screen without fields opens them.
                auth.clearNotice()
                step = .password
                focus = .email
            }
        case .retry:
            if auth.lastMethod == .password { submit() } else { signInWithPasskey() }
        }
    }

    private func toPasskey() {
        auth.clearNotice()
        focus = nil
        step = .passkey
    }

    private func signInWithPasskey() {
        focus = nil
        Task { await auth.signInWithPasskey() }
    }

    private var canSubmit: Bool {
        !email.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
    }

    private func submit() {
        guard !auth.isBusy else { return }
        guard canSubmit else {
            focus = email.trimmingCharacters(in: .whitespaces).isEmpty ? .email : .password
            return
        }
        let address = email.trimmingCharacters(in: .whitespaces)
        Task { await auth.signInWithPassword(email: address, password: password) }
    }
}
