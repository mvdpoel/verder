import SwiftUI

/// Meer: a settings screen (plan 3 Task GAP). Every row opens a screen of its
/// own on the Meer stack (`MoreRoute`), except Gesprek vastleggen, which is
/// RootView's sheet. What the rows are and what they say is `MoreMenu`; this
/// view only draws it. Lock-gated like every tab but Scan and Overzicht.
struct MoreTab: View {
    let auth: AuthModel
    let center: UploadCenter
    let push: PushRegistrar
    let money: MoneyStore
    /// Forgotten on sign-out: the phone keeps no dossier for nobody.
    let dossier: DossierModel
    /// The Meer stack (RootView holds it, so a link can open a screen on it).
    @Binding var path: [MoreRoute]
    /// Opens "Gesprek vastleggen" (RootView holds the sheet, which the home
    /// screen quick action opens too).
    let openVoice: () -> Void
    /// Signing out on purpose drops a voice log waiting from an earlier 401
    /// (`VoiceLogSession.close`); only a REJECTED session keeps it.
    let forgetVoice: () -> Void
    /// What waits on Martin now (`InboxStore`), for the Weekoverzicht's next step.
    let liveWaiting: Int?
    /// The Weekoverzicht's one next step.
    let openVoorJou: () -> Void

    @State private var account: AccountModel

    init(auth: AuthModel, center: UploadCenter, push: PushRegistrar, money: MoneyStore, dossier: DossierModel,
         path: Binding<[MoreRoute]>, openVoice: @escaping () -> Void, forgetVoice: @escaping () -> Void,
         liveWaiting: Int?, openVoorJou: @escaping () -> Void) {
        self.auth = auth
        self.center = center
        self.push = push
        self.money = money
        self.dossier = dossier
        self._path = path
        self.openVoice = openVoice
        self.forgetVoice = forgetVoice
        self.liveWaiting = liveWaiting
        self.openVoorJou = openVoorJou
        self._account = State(initialValue: AccountModel(client: auth.client,
                                                         onUnauthorized: { auth.sessionRejected() }))
    }

    var body: some View {
        NavigationStack(path: $path) {
            page.toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: MoreRoute.self) { route in
                    switch route {
                    case .weekly:
                        WeeklyView(client: auth.client, onUnauthorized: { auth.sessionRejected() },
                                   liveWaiting: liveWaiting, openVoorJou: openVoorJou)
                    case .money:
                        GeldScreen(store: money)
                    case .account:
                        AccountScreen(auth: auth, account: account, signOut: signOut)
                    case .notifications:
                        NotificationsScreen(push: push)
                    case .widgets:
                        WidgetGuideScreen()
                    case .about:
                        AboutScreen(server: auth.client.base)
                    case .developer:
                        DeveloperScreen(center: center, push: push)
                    }
                }
        }
        .task { await account.refresh() }
        .task { await push.refresh() }
        // A passkey added from the offer changes the count Account shows.
        .onChange(of: auth.passkeyMessage) { _, _ in Task { await account.refresh() } }
    }

    private func signOut() async {
        forgetVoice()
        account.forget()
        path = []
        await auth.signOut()
        await dossier.wipe()
    }

    private var page: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    MoreText.title("Meer")
                    if auth.passkeyOfferPending { passkeyOffer }
                    ForEach(MoreMenu.sections, id: \.label) { section in
                        VStack(alignment: .leading, spacing: 8) {
                            MoreText.label(section.label)
                            VStack(spacing: 0) {
                                ForEach(Array(section.items.enumerated()), id: \.element) { i, item in
                                    if i > 0 { Rectangle().fill(Color.hairline).frame(height: 1).padding(.leading, 52) }
                                    row(item)
                                }
                            }
                            .glassPanel()
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 26)
            }
        }
        .preferredColorScheme(.dark)
    }

    @ViewBuilder private func row(_ item: MoreMenu.Item) -> some View {
        let label = MoreRow(symbol: MoreMenu.symbol(item), title: MoreMenu.title(item),
                            subtitle: MoreMenu.subtitle(item, email: account.email, permission: push.permission),
                            chevron: MoreMenu.route(item) != nil)
        if let route = MoreMenu.route(item) {
            Button { path.append(route) } label: { label }.buttonStyle(.plain)
        } else {
            Button(action: openVoice) { label }.buttonStyle(.plain)
        }
    }

    private var passkeyOffer: some View {
        VStack(alignment: .leading, spacing: 13) {
            Text("Passkey toevoegen?")
                .font(.display(20, relativeTo: .title3, weight: .regular))
                .foregroundStyle(Color.inkBright)
            MoreText.body("Dan log je voortaan in met Face ID, zonder wachtwoord.")
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

/// One row of the Meer list: symbol, title, the state under it, chevron.
struct MoreRow: View {
    let symbol: String
    let title: String
    let subtitle: String?
    let chevron: Bool

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(Color.inkSoft)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.display(17, relativeTo: .body, weight: .regular))
                    .foregroundStyle(Color.inkBright)
                if let subtitle {
                    Text(subtitle)
                        .font(.display(15, relativeTo: .subheadline, weight: .regular))
                        .foregroundStyle(Color.inkDim)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Image(systemName: chevron ? "chevron.right" : "plus")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.inkFaint)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// The brief's type ramp for the Meer screens, in one place.
enum MoreText {
    static func title(_ text: String) -> some View {
        Text(text)
            .font(.display(28, relativeTo: .title, weight: .regular))
            .foregroundStyle(Color.inkBright)
    }

    static func label(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.mono(12, relativeTo: .caption, weight: .medium))
            .foregroundStyle(Color.inkLabel)
    }

    static func body(_ text: String, color: Color = .ink) -> some View {
        Text(text)
            .font(.display(15, relativeTo: .subheadline, weight: .regular))
            .foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
    }

    static func readout(_ text: String) -> some View {
        Text(text)
            .font(.mono(12, relativeTo: .footnote))
            .foregroundStyle(Color.inkDim)
            .fixedSize(horizontal: false, vertical: true)
    }
}
