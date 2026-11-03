import SwiftUI

/// Meer: a settings screen (Figma "meer · final"). Every row opens a screen
/// of its own on the Meer stack (`MoreRoute`), except Gesprek vastleggen,
/// which is RootView's sheet. What the rows are and what they say is
/// `MoreMenu`; this view only draws it. Lock-gated like every tab but Scan
/// and Overzicht.
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
    /// The case's clock (`AppServices.now`): "bijgewerkt 14:02".
    var now: @Sendable () -> Date = { Date() }

    @State private var account: AccountModel
    @State private var prefs: NotificationPrefsModel
    @State private var weekly: WeeklyStore
    @State private var scrolled = false
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(auth: AuthModel, center: UploadCenter, push: PushRegistrar, money: MoneyStore, dossier: DossierModel,
         path: Binding<[MoreRoute]>, openVoice: @escaping () -> Void, forgetVoice: @escaping () -> Void,
         liveWaiting: Int?, openVoorJou: @escaping () -> Void, now: @escaping @Sendable () -> Date = { Date() }) {
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
        self.now = now
        let rejected: @MainActor () -> Void = { auth.sessionRejected() }
        self._account = State(initialValue: AccountModel(client: auth.client, onUnauthorized: rejected, now: now))
        self._prefs = State(initialValue: NotificationPrefsModel(client: auth.client, onUnauthorized: rejected))
        self._weekly = State(initialValue: WeeklyStore(client: auth.client, onUnauthorized: rejected))
    }

    private var about: AboutInfo { AboutInfo(info: Bundle.main.infoDictionary ?? [:], server: auth.client.base) }

    /// What the rows are read from (`MoreMenu.State`).
    private var state: MoreMenu.State {
        var s = MoreMenu.State()
        s.account = account.account
        if case .unavailable = account.display { s.accountFailed = true }
        s.offline = center.isOffline
        s.stand = account.fetchedAt
        s.geld = money.glance?.meer
        switch weekly.state {
        case .loading: s.weekly = .loading
        case .notYet: s.weekly = .notYet
        case .failed: s.weekly = .failed
        case .loaded(let screen): s.weekly = screen.meer
        }
        s.permission = push.permission
        s.kinds = prefs.count.map { .init(on: $0.on, of: $0.of) }
        s.version = about.version
        s.build = about.build
        s.now = now()
        return s
    }

    var body: some View {
        NavigationStack(path: $path) {
            page.toolbar(.hidden, for: .navigationBar)
                .navigationTitle("Meer")
                .navigationDestination(for: MoreRoute.self) { route in
                    switch route {
                    case .weekly:
                        WeeklyView(client: auth.client, onUnauthorized: { auth.sessionRejected() },
                                   liveWaiting: liveWaiting, openVoorJou: openVoorJou)
                    case .money:
                        GeldScreen(store: money)
                    case .account:
                        AccountScreen(auth: auth, account: account, center: center, now: now, signOut: signOut)
                    case .notifications:
                        NotificationsScreen(push: push, prefs: prefs, offline: center.isOffline,
                                            stand: account.fetchedAt, now: now)
                    case .widgets:
                        WidgetGuideScreen()
                    case .about:
                        AboutScreen(server: auth.client.base, about: about,
                                    connection: AboutInfo.connection(offline: center.isOffline,
                                                                     accountLoaded: account.account != nil,
                                                                     lastError: failure),
                                    openDeveloper: { path.append(.developer) })
                    case .developer:
                        DeveloperScreen(center: center, push: push, now: now)
                    }
                }
        }
        .task { await account.refresh() }
        .task { await push.refresh() }
        .task { await prefs.refresh() }
        .task { await weekly.refresh() }
        .task { if money.glance == nil { await money.refresh() } }
        // A passkey added from the offer changes the count Account shows.
        .onChange(of: auth.passkeyMessage) { _, _ in Task { await account.refresh() } }
        // Back online: the stand is refreshed in place (crossfade, Figma
        // "Meer / offline" Interactie).
        .onChange(of: center.isOffline) { _, offline in
            if !offline { Task { await account.refresh(); await prefs.refresh() } }
        }
    }

    private var failure: APIError? {
        if case .failed(let e) = account.state { return e }
        return nil
    }

    private func signOut() async {
        forgetVoice()
        account.forget()
        path = []
        await auth.signOut()
        await dossier.wipe()
    }

    private var ax: Bool { typeSize.isAccessibilitySize }

    private var page: some View {
        let rows = MoreMenu.rows(state, ax: ax)
        return ZStack(alignment: .top) {
            Color.void.ignoresSafeArea()
            ScrollViewReader { proxy in
                ScrollView {
                    MoreColumn(top: 4) {
                        MoreText.title("Meer").padding(.bottom, 4)
                        if auth.passkeyOfferPending { passkeyOffer }
                        ForEach(Array(MoreMenu.sections.enumerated()), id: \.offset) { _, section in
                            MoreGroup(label: section.label) {
                                MoreCard {
                                    ForEach(Array(section.items.enumerated()), id: \.element) { i, item in
                                        if i > 0 { MoreDivider() }
                                        if let row = rows[item] { button(row) }
                                    }
                                }
                            }
                        }
                        Color.clear.frame(height: 1).id(MorePageAnchor.end)
                    }
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: center.isOffline)
                }
                .onScrollGeometryChange(for: Bool.self) { $0.contentOffset.y + $0.contentInsets.top > 44 } action: {
                    scrolled = $1
                }
                #if DEBUG
                .task { await MorePageAnchor.applyFixtureScroll(proxy) }
                #endif
            }
            if scrolled { ScrolledBar(title: "Meer").transition(.opacity) }
        }
        .animation(.easeInOut(duration: 0.15), value: scrolled)
        .preferredColorScheme(.dark)
    }

    @ViewBuilder private func button(_ row: MoreMenu.Row) -> some View {
        let label = MoreRowView(symbol: row.symbol, title: row.title, lines: row.lines,
                                chevron: row.chevron ? .push : .none) {
            MoreValue(value: row.value, caption: row.valueCaption)
        } accessory: { EmptyView() }
        Group {
            if let route = MoreMenu.route(row.item) {
                Button { path.append(route) } label: { label }
            } else {
                Button(action: openVoice) { label }
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
    }

    private var passkeyOffer: some View {
        MoreCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Toegangssleutel toevoegen?")
                    .font(MoreType.rowTitle)
                    .foregroundStyle(Color.inkBright)
                MoreText.body("Dan log je voortaan in met Face ID, zonder wachtwoord.")
                MoreButton(title: AccountCopy.addPasskey, weight: .primary, enabled: !auth.isBusy) {
                    Task { await auth.addPasskey() }
                }
                MoreButton(title: "Niet nu", weight: .plain, enabled: !auth.isBusy) {
                    auth.dismissPasskeyOffer()
                }
            }
            .padding(16)
        }
    }
}

/// The bar over a scrolled root screen (Figma "Meer / AX5 · onderaan"):
/// void at 96 % over the content, a hairline under it, the title centred.
struct ScrolledBar: View {
    let title: String

    var body: some View {
        VStack(spacing: 0) {
            Text(title)
                .font(MoreType.navTitle)
                .foregroundStyle(Color.inkBright)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                // As the system's inline bar title: it does not grow past xxxLarge.
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .frame(maxWidth: .infinity, minHeight: 44)
                .accessibilityHidden(true)
            Rectangle().fill(Color.hairline).frame(height: 1)
        }
        .background(Color.void.opacity(0.96).ignoresSafeArea(edges: .top))
    }
}

/// Scroll anchors a capture can open a Meer screen on (`-fixtures-scroll`).
enum MorePageAnchor {
    static let end = "more.end"
    static let middle = "more.middle"

    #if DEBUG
    @MainActor static func applyFixtureScroll(_ proxy: ScrollViewProxy) async {
        guard let target = FixtureLaunch.current?.scroll else { return }
        try? await Task.sleep(for: .seconds(1.5))
        switch target {
        case .end: proxy.scrollTo(end, anchor: .bottom)
        case .middle: proxy.scrollTo(middle, anchor: .top)
        default: break
        }
    }
    #endif
}
