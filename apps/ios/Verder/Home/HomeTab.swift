import SwiftUI

/// The tab the app opens on: the current state of the case at a glance, in
/// the board's order (brief §3, Mercury's now → soon → later): what waits on
/// Martin and the map's headline (both now), the leefgeld week, then tasks ·
/// scans · Door verder gedaan. Read-only: every action lives one tap further, on the
/// screen that owns it. Every word and number comes from `HomeSummary` and
/// `LeefgeldGlance` (tested); this file only lays them out (Figma
/// "overzicht · final").
///
/// OPEN WHILE LOCKED (`AppLock.Area.glance`, Martin 2026-11-01): it shows
/// counts and amounts only until `lock.revealsCaseContent`; the preview rows
/// and the map headline are not even built while locked. Every tap lands on
/// a gated screen, which asks for Face ID there.
///
/// It asks the server again every minute while it is on screen — the error
/// copy promises "verder probeert het elke minuut opnieuw" — and a failed
/// refresh keeps the board it had, with its age in the eyebrow.
struct HomeTab: View {
    let store: InboxStore
    let money: MoneyStore
    let uploads: UploadCenter
    let lock: AppLock
    /// The case's clock (`AppServices.now`).
    var now: @Sendable () -> Date = { Date() }
    /// Opens Voor jou, optionally straight onto one item.
    let openInbox: (InboxRoute?) -> Void
    let openScan: () -> Void
    /// The case map: the headline card pushes the Tijdlijn on THIS tab's
    /// stack (Figma "Tijdlijn / vanaf Overzicht"), with the NU sheet raised.
    var timeline: TimelineStore? = nil
    /// A document or task behind a stop: shown on Dossier, where they live.
    var openDossier: (DossierRoute) -> Void = { _ in }
    var openVoorJou: () -> Void = {}

    @State private var showGeld = false
    @State private var showTimeline = false
    /// The account Geld lands on when it opens (the card that was tapped).
    @State private var geldFocus: String?
    @State private var compactHeight = false
    @State private var failedRetries = 0
    @State private var failedUnlocks = 0
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var ax: Bool { typeSize.isAccessibilitySize }
    /// Soft hyphens only at the accessibility sizes, where a compound cannot
    /// fit a line; at the ordinary sizes a word moves to the next line whole.
    private func hy(_ s: String) -> String { ax ? HomeSummary.hyphenated(s) : s }

    var body: some View {
        NavigationStack {
            page
                // Never drawn (the bar is hidden); it names this screen in the
                // back button's long-press history menu on Geld. iOS 26 draws
                // the back button itself as a glass chevron, without the title.
                .navigationTitle("Overzicht")
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(isPresented: $showGeld) {
                    GeldScreen(store: money, focusAccount: geldFocus).lockGated(by: lock)
                }
                .navigationDestination(isPresented: $showTimeline) {
                    if let timeline {
                        TimelineScreen(store: timeline, open: openDossier, openVoorJou: openVoorJou,
                                       raiseCurrent: true)
                            .lockGated(by: lock)
                    }
                }
                #if DEBUG
                .task {
                    // `-fixtures-geld`: Geld pushed from here, as a card tap does.
                    if FixtureLaunch.current?.geld != nil { showGeld = true }
                    // `-fixtures-timeline overzicht`: the headline card's tap.
                    if FixtureLaunch.current?.timeline.contains(.overzicht) == true {
                        try? await Task.sleep(for: .seconds(0.8))
                        showTimeline = true
                    }
                }
                #endif
        }
    }

    private var page: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        header
                        board
                        Color.clear.frame(height: 1).id(Self.endID)
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // Saira's own line height is ~1.57 em; the ramp sets
                    // body 17 on 23 (Figma), a multiple of the point size.
                    // Mono meta keeps its natural 17 (`.lineHeight(.normal)`).
                    .lineHeight(.multiple(factor: HomeType.sairaLineFactor))
                    .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.3, dampingFraction: 0.9),
                               value: animationKey)
                }
                .refreshable { await refreshAll() }
                #if DEBUG
                .task {
                    guard let target = FixtureLaunch.current?.scroll else { return }
                    try? await Task.sleep(for: .seconds(1.5))
                    if target == .end {
                        proxy.scrollTo(Self.endID, anchor: .bottom)
                    } else if target == .waiting {
                        // The end of Wacht op jou, clear of the tab bar.
                        proxy.scrollTo(Self.waitingEndID, anchor: UnitPoint(x: 0.5, y: 0.8))
                    } else {
                        proxy.scrollTo(target.rawValue, anchor: .top)
                    }
                }
                #endif
            }
        }
        .onGeometryChange(for: Bool.self) { $0.size.height < 700 } action: { compactHeight = $0 }
        .preferredColorScheme(.dark)
        .sensoryFeedback(.error, trigger: failedRetries)
        .sensoryFeedback(.error, trigger: failedUnlocks)
        .task {
            await refreshAll()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(HomeSummary.pollInterval))
                if Task.isCancelled { break }
                await refreshAll()
            }
        }
    }

    private static let endID = "overzicht-end"
    private static let waitingEndID = "waiting"

    /// What changes a card's height, so the change springs (Reduce Motion: a crossfade).
    private var animationKey: [Int] {
        [store.inbox?.count ?? -1, store.inbox == nil ? 0 : 1, store.lastError == nil ? 0 : 1,
         money.glance == nil ? 0 : 1, lock.revealsCaseContent ? 1 : 0]
    }

    private func refreshAll() async {
        async let inbox: Void = store.refresh()
        async let cash: Void = money.refresh()
        _ = await (inbox, cash)
    }

    // MARK: - Header

    private var header: some View {
        let eyebrow = HomeSummary.eyebrow(now: now(), fetchedAt: store.inbox == nil ? nil : store.fetchedAt,
                                          error: store.lastError)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                if eyebrow.offline {
                    Image(systemName: "wifi.slash")
                        .font(.system(size: 13, weight: .regular))
                        .accessibilityHidden(true)
                }
                Text(eyebrow.text)
                    .textCase(.uppercase)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(HomeType.mono)
            .lineHeight(.normal)
            .foregroundStyle(Color.inkLabel)
            .dynamicTypeSize(...DynamicTypeSize.accessibility3)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(eyebrow.accessibilityLabel)
            Text(HomeSummary.title)
                .font(HomeType.title)
                .foregroundStyle(Color.inkBright)
                .accessibilityAddTraits(.isHeader)
        }
    }

    // MARK: - The board

    @ViewBuilder private var board: some View {
        let notice = HomeSummary.errorNotice(store.lastError, attemptedAt: store.attemptedAt)
        if let inbox = store.inbox {
            if let notice, store.lastError != nil, !isOffline {
                strip(notice)
            }
            waitingCard(inbox)
            // "Waar het nu op wacht" is NOW too, so it sits right under what
            // waits (the "Overzicht · naar de tijdlijn" frames).
            headlineCard
            leefgeldCard.id("leefgeld")
            restCard(inbox).id("rest")
        } else if let notice {
            errorCard(notice)
            card { scansRow }
        } else {
            WaitingSkeleton()
            LeefgeldSkeleton()
        }
    }

    private var isOffline: Bool {
        if case .transport = store.lastError { return true }
        return false
    }

    // MARK: Wacht op jou

    private func waitingCard(_ inbox: InboxDTO) -> some View {
        let amber = HomeSummary.cardAmber(.waiting, inbox: inbox)
        let limit = HomeSummary.previewLimit(accessibilitySize: ax, compactHeight: compactHeight)
        let rows = HomeSummary.preview(inbox, revealed: lock.revealsCaseContent, limit: limit)
        return card {
            Button { openInbox(nil) } label: {
                cardHeader(HomeSummary.waitingLabel, amber: amber, chevron: true)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(HomeSummary.waitingLabel)
            if inbox.count == 0 {
                calm(inbox)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(inbox.count)")
                        .font(HomeType.hero)
                        .lineHeight(.multiple(factor: 56.0 / 48.0))
                        .foregroundStyle(Color.attn)
                        .contentTransition(.numericText())
                        .dynamicTypeSize(...DynamicTypeSize.accessibility4)
                    Text(hy(HomeSummary.countCaption(inbox.count)))
                        .font(HomeType.body)
                        .foregroundStyle(Color.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    if let hint = HomeSummary.manyHint(inbox.count, shown: lock.revealsCaseContent ? limit : 0),
                       lock.revealsCaseContent {
                        Text(hy(hint))
                            .font(HomeType.body)
                            .foregroundStyle(Color.inkMute)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(HomeSummary.waitingLine(inbox.count))
                if lock.revealsCaseContent {
                    Rectangle().fill(Color.edge).frame(height: 1)
                    ForEach(rows) { previewRow($0) }
                    if inbox.count > rows.count {
                        Button { openInbox(nil) } label: {
                            linkRow(HomeSummary.seeAll(inbox.count))
                        }
                        .buttonStyle(.plain)
                    }
                    Color.clear.frame(height: 0).id(Self.waitingEndID)
                } else {
                    lockedReveal
                }
            }
        }
    }

    private func calm(_ inbox: InboxDTO) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 40, weight: .thin))
                .foregroundStyle(Color.okay)
                .accessibilityHidden(true)
            Text(HomeSummary.nothingWaiting)
                .font(HomeType.title)
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
            Text(hy(HomeSummary.calmBody))
                .font(HomeType.body)
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
            if let cleared = HomeSummary.clearedLine(inbox.lastClearedAt, now: now()) {
                meta(cleared)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var lockedReveal: some View {
        let prompt = HomeSummary.lockedPrompt(asking: lock.isUnlocking, cancelled: lock.lastAttemptCancelled)
        let text = Text(hy(prompt.text))
            .font(HomeType.body)
            .foregroundStyle(prompt.textFirst ? Color.ink : Color.inkSoft)
            .fixedSize(horizontal: false, vertical: true)
        return VStack(alignment: .leading, spacing: 12) {
            if prompt.textFirst { text }
            if let button = prompt.button {
                Button {
                    Task {
                        await lock.unlock()
                        if lock.isLocked { failedUnlocks += 1 }
                    }
                } label: {
                    HStack(spacing: 8) {
                        if prompt.glyph {
                            Image(systemName: "faceid")
                                .font(.system(size: 20, weight: .regular))
                                .foregroundStyle(Color.signal)
                                .accessibilityHidden(true)
                        }
                        Text(button)
                            .font(HomeType.bodyStrong)
                            .foregroundStyle(Color.inkBright)
                    }
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .padding(.horizontal, 12)
                    .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
                    .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(lock.isUnlocking)
            }
            if !prompt.textFirst { text }
        }
    }

    private func previewRow(_ item: WaitingItem) -> some View {
        let route = InboxRoute(item)
        return Button { openInbox(route) } label: {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(hy(item.title))
                        .font(HomeType.bodyStrong)
                        .foregroundStyle(Color.inkBright)
                        .lineLimit(ax ? nil : 2)
                        .truncationMode(.tail)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    previewMeta(item)
                }
                Spacer(minLength: 0)
                chevron
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(HomeSummary.rowAccessibilityLabel(item, now: now()))
        .accessibilityAddTraits(.isButton)
        .contextMenu {
            Button { openInbox(route) } label: { Label("Bekijken", systemImage: "eye") }
        }
    }

    // MARK: Leefgeld

    /// Amounts only, so it shows while locked. No amber: nothing about money
    /// waits on Martin. Without a weekly amount there is no leefgeld card;
    /// unlocked, the per-account lines take its place (`MoneyGlance.summary`).
    @ViewBuilder private var leefgeldCard: some View {
        if let glance = money.glance {
            if let lg = glance.leefgeldGlance {
                Button { openGeld(glance.leefgeldAccountID) } label: {
                    card { LeefgeldGlanceView(glance: lg, ax: ax, revealed: lock.revealsCaseContent) }
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(lg.accessibilityLabel(revealed: lock.revealsCaseContent))
                .accessibilityAddTraits(.isButton)
                .accessibilityHint("Opent Geld")
            }
            // No weekly amount: no leefgeld card. The accounts lead the rest
            // card instead (`restCard`), Figma "Money glance / no-budget".
        } else if money.lastError == nil {
            LeefgeldSkeleton()
        }
        // A failed money fetch with nothing kept hides the card rather than
        // adding a second error to Overzicht; Geld itself says why.
    }

    /// Geld, landing on that account's card.
    private func openGeld(_ account: String?) {
        geldFocus = account
        showGeld = true
    }

    // MARK: Tasks · scans · Door verder gedaan

    private func restCard(_ inbox: InboxDTO) -> some View {
        card {
            // Without a weekly amount the accounts lead this card: no
            // amounts, no total, unlocked only (the tail names an account).
            ForEach(money.glance?.accountRows(revealed: lock.revealsCaseContent) ?? []) { a in
                restRow(HomeSummary.Row(title: a.title, amberSuffix: nil, meta: a.meta)) { openGeld(a.id) }
            }
            if let tasks = store.summary?.tasks {
                restRow(HomeSummary.tasksRow(tasks, inbox: inbox, now: now())) { openInbox(nil) }
            }
            scansRow
            let done = HomeSummary.doneRow(inbox)
            if let route = HomeSummary.doneOpens(inbox) {
                restRow(done) { openInbox(route) }
            } else {
                restRow(done, action: nil)
            }
        }
    }

    private var scansRow: some View {
        restRow(HomeSummary.scansRow(uploads.summary, offline: isOffline), action: openScan)
    }

    private func restRow(_ row: HomeSummary.Row, action: (() -> Void)?) -> some View {
        let content = HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                rowTitle(row)
                meta(row.meta)
            }
            Spacer(minLength: 0)
            if action != nil { chevron }
        }
        .overlay(alignment: .topLeading) {
            if row.dot && !ax {
                Circle().fill(Color.attn).frame(width: 8, height: 8)
                    .offset(x: -12, y: 8)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
        return Group {
            if let action {
                Button(action: action) { content }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(.isButton)
            } else {
                content
            }
        }
    }

    @ViewBuilder private func rowTitle(_ row: HomeSummary.Row) -> some View {
        if ax, let suffix = row.amberSuffix {
            VStack(alignment: .leading, spacing: 0) {
                Text(hy(row.title)).foregroundStyle(Color.inkBright)
                Text(suffix).foregroundStyle(Color.attn)
            }
            .font(HomeType.bodyStrong)
            .fixedSize(horizontal: false, vertical: true)
        } else {
            Text(Self.titleWithSuffix(row, ax: ax))
                .font(HomeType.bodyStrong)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// "6 taken voor jou · 1 te laat", the late part amber.
    private static func titleWithSuffix(_ row: HomeSummary.Row, ax: Bool) -> AttributedString {
        var title = AttributedString(ax ? HomeSummary.hyphenated(row.title) : row.title)
        title.foregroundColor = Color.inkBright
        guard let suffix = row.amberSuffix else { return title }
        var dot = AttributedString(" · ")
        dot.foregroundColor = Color.inkBright
        var late = AttributedString(suffix.replacingOccurrences(of: " ", with: "\u{00A0}"))
        late.foregroundColor = Color.attn
        return title + dot + late
    }

    // MARK: The map headline

    /// A tap opens the Tijdlijn on this tab with the NU sheet up. Locked, the
    /// card says only THAT a next step exists (the stop's title is case
    /// content); its tap asks Face ID first.
    @ViewBuilder private var headlineCard: some View {
        if let h = store.summary?.headline {
            if lock.revealsCaseContent {
                Button { showTimeline = timeline != nil } label: {
                    TimelineHeadlineCard(title: hy(h.stopTitle), note: h.note.map(hy),
                                         meta: [h.trackTitle, TimelineHeadlineCard.opens].compactMap { $0 })
                }
                .buttonStyle(.plain)
                .accessibilityHint(HomeSummary.headlineHint)
            } else {
                Button {
                    Task {
                        await lock.unlock()
                        if lock.isLocked { failedUnlocks += 1 } else { showTimeline = timeline != nil }
                    }
                } label: { TimelineHeadlineCard.locked() }
                    .buttonStyle(.plain)
                    .accessibilityHint(HomeSummary.headlineHint)
            }
        }
    }

    // MARK: Errors

    /// Above a kept board: the board stays, this says it is not fresh.
    private func strip(_ n: HomeSummary.ErrorNotice) -> some View {
        card {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(Color.inkBright)
                    .accessibilityHidden(true)
                Text(n.strip)
                    .font(HomeType.bodyStrong)
                    .foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
            }
            meta(n.readout).padding(.top, -8)
            Button { retry() } label: {
                Text(HomeSummary.retry)
                    .font(HomeType.bodyStrong)
                    .foregroundStyle(Color.signal)
                    .frame(minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.vertical, -8)
        }
    }

    /// No board to keep: what happened, that nothing is lost, and what to do.
    private func errorCard(_ n: HomeSummary.ErrorNotice) -> some View {
        card {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(Color.inkBright)
                .accessibilityHidden(true)
            Text(n.headline)
                .font(HomeType.title)
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(hy(n.body))
                .font(HomeType.body)
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
            meta(n.readout)
            Button { retry() } label: {
                Text(HomeSummary.retry)
                    .font(HomeType.bodyStrong)
                    .foregroundStyle(Color.onSignal)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .padding(.vertical, 2)
                    .background(
                        LinearGradient(colors: [.signalLit, .signal], startPoint: .top, endPoint: .bottom),
                        in: RoundedRectangle(cornerRadius: Radius.chip))
                    .glow(Glow.action)
            }
            .buttonStyle(.plain)
            if let step = n.step {
                Text(hy(step))
                    .font(HomeType.body)
                    .foregroundStyle(Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func retry() {
        Task {
            await refreshAll()
            if store.lastError != nil { failedRetries += 1 }
        }
    }

    // MARK: - Pieces

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) { content() }
            .padding(ax ? 12 : 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassPanel()
            .contentShape(Rectangle())
    }

    private func cardHeader(_ label: String, amber: Bool, chevron showChevron: Bool) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(ax ? label : label.uppercased())
                .font(HomeType.mono)
            .lineHeight(.normal)
                .foregroundStyle(amber ? Color.attn : Color.inkLabel)
                .dynamicTypeSize(...DynamicTypeSize.accessibility3)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            if showChevron && !ax {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.inkFaint)
                    .accessibilityHidden(true)
            }
        }
    }

    /// One mono meta line that wraps only at " · " — or, at the accessibility
    /// sizes, one fact per line in sentence case (Figma it4: no dangling dots).
    @ViewBuilder private func meta(_ parts: [String]) -> some View {
        if !parts.isEmpty {
            Group {
                if ax {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(parts.enumerated()), id: \.offset) { _, p in Text(HomeSummary.sentence(p)) }
                    }
                } else {
                    Text(HomeSummary.metaLine(parts)).textCase(.uppercase)
                }
            }
            .font(HomeType.mono)
            .lineHeight(.normal)
            .foregroundStyle(Color.inkDim)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .dynamicTypeSize(...DynamicTypeSize.accessibility3)
        }
    }

    /// A preview row's meta: on one line when it fits, else kind and age
    /// together over the party (`HomeSummary.previewMeta`). At the
    /// accessibility sizes, one fact per line, as every meta.
    @ViewBuilder private func previewMeta(_ item: WaitingItem) -> some View {
        if ax {
            meta(HomeSummary.meta(item, now: now()))
        } else {
            let m = HomeSummary.previewMeta(item, now: now())
            ViewThatFits(in: .horizontal) {
                Text(m.oneLine).lineLimit(1)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(m.stacked.enumerated()), id: \.offset) { _, line in
                        Text(line).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .textCase(.uppercase)
            .font(HomeType.mono)
            .lineHeight(.normal)
            .foregroundStyle(Color.inkDim)
            .multilineTextAlignment(.leading)
            .dynamicTypeSize(...DynamicTypeSize.accessibility3)
        }
    }

    private func linkRow(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(text)
                .font(HomeType.bodyStrong)
                .foregroundStyle(Color.signal)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if !ax {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.signal)
            }
        }
        .frame(minHeight: 24)
        .contentShape(Rectangle())
    }

    /// Chevrons go at the accessibility sizes: the width is the text's.
    @ViewBuilder private var chevron: some View {
        if !ax {
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.inkFaint)
                .padding(.top, 4)
                .accessibilityHidden(true)
        }
    }
}

/// Overzicht's type ramp (Figma: 48 / 28 / 17 / 13), each tied to the text
/// style it scales with — body 17 → 53 at AX5, title 28 → 58.
enum HomeType {
    /// Regular, as the frames' "10" / "498": a light numeral reads half as heavy.
    static let hero = Font.display(48, relativeTo: .largeTitle, weight: .regular)
    static let title = Font.display(28, relativeTo: .title, weight: .regular)
    static let money = Font.display(28, relativeTo: .title, weight: .regular)
    static let body = Font.display(17, relativeTo: .body)
    static let bodyStrong = Font.display(17, relativeTo: .body, weight: .medium)
    static let mono = Font.mono(13, relativeTo: .footnote)
    /// 23 / 17: the Figma ramp's line height as a multiple of the size.
    static let sairaLineFactor: CGFloat = 23.0 / 17.0
}

// MARK: - Leefgeld card

/// The Leefgeld card's content: header, figure or message. `LeefgeldGlance`
/// decides every word; this lays it out (Figma "money · final").
struct LeefgeldGlanceView: View {
    let glance: LeefgeldGlance
    let ax: Bool
    /// Unlocked: the Ontvangen row may name the account the money came from.
    let revealed: Bool

    private func hy(_ s: String) -> String { ax ? HomeSummary.hyphenated(s) : s }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            switch glance.body {
            case .figure(let f): figure(f)
            case .message(let m): message(m)
            }
        }
    }

    // MARK: Header

    private var header: some View {
        let label = Text(ax ? HomeSummary.leefgeldLabel : HomeSummary.leefgeldLabel.uppercased())
            .foregroundStyle(Color.inkLabel)
        let range = glance.rangeUnbroken.map { r in
            Text(ax ? r : r.uppercased()).foregroundStyle(Color.inkLabel)
                .fixedSize(horizontal: false, vertical: true)
        }
        return Group {
            if ax {
                // Label, chip and range each on their own line: a run that
                // wraps mid-phrase splits "26 okt" across two lines.
                VStack(alignment: .leading, spacing: 4) {
                    label
                    if glance.partial { chip }
                    range
                }
            } else {
                HStack(alignment: .center, spacing: 8) {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .center, spacing: 8) {
                            label
                            Spacer(minLength: 16)
                            if glance.partial { chip }
                            range?.fixedSize()
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            label
                            HStack(alignment: .center, spacing: 8) {
                                if glance.partial { chip }
                                range
                            }
                        }
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Color.inkFaint)
                }
            }
        }
        .font(HomeType.mono)
        .lineHeight(.normal)
        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
    }

    /// "● DEELS", boxed: the week is not wholly on a statement.
    private var chip: some View {
        HStack(alignment: .center, spacing: 4) {
            Circle().fill(Color.inkDim).frame(width: 5, height: 5)
            Text(ax ? HomeSummary.sentence(LeefgeldGlance.partialChip) : LeefgeldGlance.partialChip.uppercased())
                .foregroundStyle(Color.inkLabel)
                .fixedSize()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .overlay(RoundedRectangle(cornerRadius: 2).strokeBorder(Color.edgeStrong, lineWidth: 1))
    }

    // MARK: Figure

    @ViewBuilder private func figure(_ f: LeefgeldGlance.Figure) -> some View {
        let hero = Text(f.hero)
            .font(HomeType.money)
            .foregroundStyle(Color.inkBright)
        let caption = ax ? f.axCaption : f.caption
        // The caption flows after the amount, wrapping under it like a
        // sentence ("↑ € 12,40 meer uitgegeven / dan het weekbedrag").
        (hero + Text(" ") + Text(caption).font(HomeType.body).foregroundStyle(Color.ink))
            .fixedSize(horizontal: false, vertical: true)
            .contentTransition(.numericText())
        if let note = f.note, !ax {
            Text(note)
                .font(HomeType.body)
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        LeefgeldBar(bar: f.bar)
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(f.rows.enumerated()), id: \.offset) { i, r in
                if i > 0 { Rectangle().fill(Color.edge).frame(height: 1) }
                row(r)
            }
        }
    }

    @ViewBuilder private func row(_ r: LeefgeldGlance.Row) -> some View {
        let title = Text(r.label).font(HomeType.bodyStrong).foregroundStyle(Color.inkBright)
        let value = Text(r.value).font(HomeType.bodyStrong).foregroundStyle(Color.inkBright)
        if ax {
            VStack(alignment: .leading, spacing: 4) {
                title.fixedSize(horizontal: false, vertical: true)
                meta(r.meta(revealed: revealed))
                value.fixedSize(horizontal: false, vertical: true)
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    title.fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    value.fixedSize()
                }
                meta(r.meta(revealed: revealed))
            }
        }
    }

    // MARK: Message

    private func message(_ m: LeefgeldGlance.Message) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "doc.text")
                        .font(.system(size: m.display ? 17 : 15, weight: .regular))
                        .foregroundStyle(Color.inkSoft)
                        .accessibilityHidden(true)
                    Text(m.title)
                        .font(m.display ? HomeType.money : HomeType.bodyStrong)
                        .foregroundStyle(Color.inkBright)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let readout = m.meta { meta([readout]) }
            }
            Text(hy(m.text))
                .font(HomeType.body)
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// A mono meta line that wraps only at " · "; at the accessibility sizes
    /// one fact per line, in sentence case.
    @ViewBuilder private func meta(_ parts: [String]) -> some View {
        if !parts.isEmpty {
            Group {
                if ax {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(parts.enumerated()), id: \.offset) { _, p in
                            Text(HomeSummary.sentence(p)).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                } else {
                    Text(HomeSummary.metaLine(parts)).textCase(.uppercase)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .font(HomeType.mono)
            .lineHeight(.normal)
            .foregroundStyle(Color.inkDim)
            .dynamicTypeSize(...DynamicTypeSize.accessibility3)
        }
    }
}

/// The 4 pt week meter: what was spent solid (up to the weekly amount), the
/// overspend or the days no statement covers yet hatched, and an overspent
/// week's weekly amount ticked and labelled "€ 100".
struct LeefgeldBar: View {
    let bar: LeefgeldGlance.Bar

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let label = bar.tickLabel, let tick = bar.tick {
                TickLabelLayout(tick: tick) {
                    Text(label)
                        .font(HomeType.mono)
                        .lineHeight(.normal)
                        .foregroundStyle(Color.inkDim)
                        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
                        .fixedSize()
                }
            }
            GeometryReader { geo in
                let w = geo.size.width
                ZStack(alignment: .leading) {
                    Rectangle().fill(Color.edgeStrong)
                    Rectangle().fill(Color.inkSoft).frame(width: bar.solid * w)
                    if let from = bar.hatchedFrom, from < 1 {
                        Hatch(spacing: 3).stroke(Color.inkDim, lineWidth: 1)
                            .frame(width: (1 - from) * w)
                            .clipped()
                            .offset(x: from * w)
                    }
                }
                .frame(height: 4)
                .frame(maxHeight: .infinity)
                .overlay(alignment: .leading) {
                    if let tick = bar.tick {
                        Rectangle().fill(Color.inkBright).frame(width: 2, height: 12).offset(x: tick * w - 1)
                    }
                }
            }
            .frame(height: bar.tick == nil ? 4 : 12)
        }
        .accessibilityHidden(true)
    }
}

/// Puts the "€ 100" label's right edge 8 pt left of the tick (never past
/// the meter's left end), as the overspend frame sets it.
private struct TickLabelLayout: Layout {
    let tick: Double

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let size = subviews.first?.sizeThatFits(.unspecified) ?? .zero
        return CGSize(width: proposal.width ?? size.width, height: size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let label = subviews.first else { return }
        let size = label.sizeThatFits(.unspecified)
        let x = max(bounds.minX, bounds.minX + bounds.width * tick - 8 - size.width)
        label.place(at: CGPoint(x: x, y: bounds.minY), proposal: ProposedViewSize(size))
    }
}

// MARK: - Skeletons

/// Loading: the shape of what is coming, not a spinner (brief §2.4) — the
/// loaded cards' geometry, so nothing jumps when the data arrives.
private struct WaitingSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            line(96, 10, in: 17)
            line(56, 44, in: 56)
            line(160, 12, in: 23)
            Rectangle().fill(Color.edge).frame(height: 1)
            ForEach(0..<3, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 0) {
                    line(290, 12, in: 23)
                    line(190, 12, in: 23)
                    line(150, 8, in: 17).padding(.top, 4)
                }
            }
            line(110, 12, in: 24)
        }
        .skeletonCard()
    }
}

private struct LeefgeldSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { line(72, 10, in: 17); Spacer(); line(110, 10, in: 17) }
            HStack(spacing: 12) { line(100, 24, in: 34); line(130, 12, in: 34) }
            SkeletonBar(width: nil, height: 4)
            HStack(alignment: .top, spacing: 16) {
                ForEach(0..<2, id: \.self) { _ in
                    VStack(alignment: .leading, spacing: 4) { line(80, 8, in: 17); line(64, 10, in: 23) }
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            line(200, 12, in: 23)
        }
        .skeletonCard()
    }
}

/// A skeleton bar centred in the height of the text line it stands for.
private func line(_ width: CGFloat, _ height: CGFloat, in lineHeight: CGFloat) -> some View {
    SkeletonBar(width: width, height: height).frame(height: lineHeight)
}

private struct SkeletonBar: View {
    let width: CGFloat?
    let height: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: 1)
            .fill(Color.edgeStrong.opacity(0.6))
            .frame(maxWidth: width ?? .infinity, alignment: .leading)
            .frame(width: width, height: height)
    }
}

private extension View {
    func skeletonCard() -> some View {
        padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassPanel()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Laden")
    }
}
