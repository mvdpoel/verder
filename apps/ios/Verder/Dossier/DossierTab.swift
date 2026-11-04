import SwiftUI

/// The Dossier tab: the case in Martin's pocket ("dossier · final",
/// 2026-11-03). The age of the copy and the title, the search field, where
/// the case waits (with the way into the Tijdlijn beside its label), the
/// open tasks, then every document newest first under the soort chips.
/// Scrolled down, the title collapses into the bar and — at the regular
/// sizes — the search field, the chips and the documents' label stay pinned
/// above the rows. Searching, the bar is the search field and "Annuleer".
///
/// It renders from the phone's own copy at once (offline included, with the
/// age said), and syncs in the foreground after unlock; a first sync shows
/// its progress and the list fills as documents arrive.
///
/// LOCK-GATED (RootView): nothing here exists while the app is locked.
/// Read-only: no document is changed from the phone, and purge is never
/// offered. Amber only on what waits on Martin — the open stop and the open
/// tasks, always with the words "wacht op jou".
struct DossierTab: View {
    let model: DossierModel
    let inbox: InboxStore
    /// The case map behind the Tijdlijn row.
    let timeline: TimelineStore
    let lock: AppLock
    let client: APIClient
    @Binding var path: [DossierRoute]
    let onUnauthorized: @MainActor () -> Void
    /// The Tijdlijn's empty state and "Toon alle": Voor jou.
    var openVoorJou: () -> Void = {}
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var typeSize
    @FocusState private var fieldFocused: Bool
    /// Where the title ends and the documents' label starts, in the scroll
    /// view's visible frame: what collapses the title and pins the bar.
    @State private var titleBottom: CGFloat = 100
    @State private var labelTop: CGFloat = 10_000
    @State private var pinnedTop: CGFloat = 0
    /// The bar's bottom and the list's places, on screen: what tucks a row
    /// exactly under the pinned bar (a soort chosen, a capture's offset).
    @State private var barBottom: CGFloat = 0
    @State private var placeTops: [String: CGFloat] = [:]
    @State private var scrollOffset: CGFloat = 0
    @State private var position = ScrollPosition(edge: .top)
    /// The screen's height: at a compact height (the iPhone SE's 667 pt)
    /// the sections sit 24 apart instead of 32 (the final frames' rule).
    @State private var screenHeight: CGFloat = 874
    /// The search bar asks for the keyboard when it opens from a tap.
    @State private var focusOnOpen = false
    /// A refresh pulled by hand shows the system's own spinner; the header's
    /// is for a sync the app started.
    @State private var pulled = false

    private var ax: Bool { typeSize.isAccessibilitySize }
    private var now: Date { model.now() }
    private var sectionGap: CGFloat { DossierSpacing.sectionGap(screenHeight: screenHeight) }
    /// One open task instead of two on a short screen or at the
    /// accessibility sizes (the SE and AX5 frames).
    private var compactHeight: Bool { ax || DossierSpacing.isCompact(screenHeight: screenHeight) }
    /// The status bar's own height: a phone without a notch (the SE) puts
    /// the content straight under it, where the frames keep 8 pt free.
    @State private var safeTop: CGFloat = 62
    private var underStatusBar: CGFloat { DossierSpacing.underStatusBar(safeTop: safeTop) }

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                Color.void.ignoresSafeArea()
                if model.searchActive || model.isSearching {
                    searchScreen
                } else {
                    mainScreen
                }
            }
            .navigationTitle(DossierCopy.title)
            .navigationDestination(for: DossierRoute.self) { route in
                switch route {
                case .document(let id, let title):
                    DocumentViewer(id: id, title: title ?? model.doc(id)?.title ?? DossierCopy.title,
                                   store: model.store, client: client, dossier: model, onUnauthorized: onUnauthorized)
                case .counter(let id):
                    DocumentViewer(id: id, title: model.doc(id)?.title ?? DossierCopy.title, store: model.store,
                                   client: client, dossier: model, opensCounter: true, onUnauthorized: onUnauthorized)
                case .task(let id):
                    TaskScreen(id: id, client: client, onUnauthorized: onUnauthorized)
                case .timeline, .timelineNow:
                    TimelineScreen(store: timeline, open: { path.append($0) }, openVoorJou: openVoorJou,
                                   raiseCurrent: route == .timelineNow,
                                   heldDocument: { model.doc($0) },
                                   prepareDocuments: { await model.prepareForTimeline(isLocked: lock.isLocked, isActive: true) })
                }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .tint(Color.signalLink)
        .preferredColorScheme(.dark)
        .onAppear {
            // The screen's own height: what "compact" means is a fact about
            // the phone, not about how much room this tab was given.
            if let screen = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen {
                screenHeight = screen.bounds.height
            }
        }
        .task {
            await model.loadCached()
            #if DEBUG
            applyFixtureState()
            #endif
            if inbox.summary == nil { await inbox.refresh() }
            await refresh()
            // The Tijdlijn row names the map's own counts.
            if timeline.map == nil { await timeline.load() }
            #if DEBUG
            // `-fixtures-dossier refresh`: a second sync, as the next return to
            // the foreground would start (the kept copy over a later delta).
            let states = FixtureLaunch.current?.dossier ?? []
            if states.contains(.refresh) || states.contains(where: { if case .open = $0 { true } else { false } }) {
                // Wait for the first sync to finish, whoever started it (this
                // task or the scene turning active).
                while model.syncedAt == nil || model.isSyncing { try? await Task.sleep(for: .milliseconds(200)) }
                try? await Task.sleep(for: .milliseconds(300))
            }
            for case .open(let id) in states { path = [.document(id: id, title: nil)] }
            if states.contains(.refresh) {
                try? await Task.sleep(for: .milliseconds(300))
                await model.refresh(isLocked: lock.isLocked, isActive: true)
            }
            #endif
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await refresh() } }
        }
        // A launch while locked could not read the phone's copy; read it now.
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataDidBecomeAvailableNotification)) { _ in
            Task {
                await model.loadCached()
                await refresh()
            }
        }
    }

    private func refresh() async {
        await model.refresh(isLocked: lock.isLocked, isActive: scenePhase == .active)
    }

    // MARK: - The tab without a query

    private var mainScreen: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header
                        .padding(.top, underStatusBar - 2)
                        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .scrollView).maxY } action: { titleBottom = $0 }
                    searchButton.padding(.top, 14)
                    if let card = model.firstSyncCard {
                        syncCard(card).padding(.top, 24)
                    } else {
                        headlineSection.padding(.top, ax ? 24 : (compactHeight ? 16 : 22))
                        tasksSection.padding(.top, sectionGap)
                    }
                    documentsHeader(pinned: false)
                        // Pinned, the bar draws it; never both at once.
                        .opacity(isPinned ? 0 : 1)
                        .padding(.top, sectionGap)
                        .id(DossierAnchor.documents)
                        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .scrollView).minY } action: { labelTop = $0 }
                        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: {
                            placeTops[DossierPlace.header] = $0
                        }
                    Color.clear.frame(height: 0)
                        .id(DossierAnchor.list)
                        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { placeTops[DossierPlace.list] = $0 }
                        .padding(.top, 8)
                    documentsBody
                    // A short filtered list can still scroll up under the bar.
                    if model.kind != nil { Color.clear.frame(height: 480) }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
                .frame(maxWidth: .infinity, alignment: .leading)
                // Saira's own line height is ~1.57 em; the ramp sets 17 on 23.
                .lineHeight(.multiple(factor: HomeType.sairaLineFactor))
            }
            .scrollDismissesKeyboard(.immediately)
            .scrollPosition($position)
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { _, y in
                scrollOffset = y
            }
            .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.top } action: { safeTop = $0 }
            .refreshable {
                pulled = true
                await refresh()
                pulled = false
            }
            .overlay(alignment: .top) { compactBar }
            // A soort chosen in the pinned bar starts its list at the top,
            // right under the bar — never with its first row hidden behind it.
            .onChange(of: model.kind) { _, _ in
                guard isPinned else { return }
                Task {
                    try? await Task.sleep(for: .milliseconds(50))
                    tuck(DossierPlace.list)
                }
            }
            #if DEBUG
            .task(id: model.loaded) { await fixtureScroll(proxy) }
            #endif
        }
    }

    /// Scrolls so the place `key` (the list's top, or a row) starts exactly
    /// at the pinned bar's bottom edge.
    private func tuck(_ key: String) {
        guard let top = placeTops[key], barBottom > 0 else { return }
        // The place starts at the bar's lip (`PanelLip`), the card's edge.
        let edge = barBottom - PanelLip.height + (key == DossierPlace.list ? 0 : 1)
        position.scrollTo(y: max(0, scrollOffset + top - edge))
    }

    /// The bar that takes over once the page scrolls: the title alone after
    /// the big title has gone, then — once the documents reach it — the
    /// search field, the chips and the documents' label too, pinned.
    private var isPinned: Bool {
        // At the accessibility sizes nothing pins: the field, its hint and
        // every chip would fill most of the screen (the AX5 frames).
        !ax && model.loaded && model.firstSyncCard == nil && !model.docs.isEmpty && labelTop <= pinnedTop
    }

    @ViewBuilder private var compactBar: some View {
        let pinned = isPinned
        if pinned || titleBottom <= 0 {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(DossierCopy.title)
                        .font(.display(17, relativeTo: .headline, weight: .medium))
                        // An inline bar title: it stays small at every size
                        // (the AX5 frame), the big title above says it large.
                        .dynamicTypeSize(...DynamicTypeSize.xLarge)
                        .foregroundStyle(Color.inkBright)
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 44)
                        .accessibilityAddTraits(.isHeader)
                    if pinned {
                        searchButton
                        chips.padding(.top, 8)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, underStatusBar - 8)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { pinnedTop = $0 + (pinned ? 0 : 140) }
                if pinned {
                    Hairline().padding(.top, 4)
                    documentsLabel.padding(.horizontal, 16).padding(.top, 22).padding(.bottom, 7)
                    // The list card's own top edge: the rows tuck under it
                    // rather than reading as sliced off at the bar.
                    PanelLip().padding(.horizontal, 16)
                }
            }
            .background(Color.void.ignoresSafeArea(edges: .top))
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { barBottom = $0 }
            .transition(.opacity)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            if !pulled, model.isSyncing, model.syncedAt != nil, (model.progress?.due ?? 0) > 0 {
                ProgressView().tint(Color.inkLabel).frame(maxWidth: .infinity).padding(.top, 15).padding(.bottom, 18)
            }
            if let line = model.eyebrow {
                Text(ax ? line : line.uppercased())
                    .font(.mono(12, relativeTo: .caption)).monoCap()
                    .tracking(ax ? 0 : 1)
                    .foregroundStyle(Color.inkLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(DossierCopy.title)
                .font(.display(28, relativeTo: .largeTitle))
                .foregroundStyle(Color.inkBright)
                .accessibilityAddTraits(.isHeader)
            // "Geen verbinding" is the eyebrow's "offline ·" already.
            if let message = model.message, !model.offline {
                Text(message)
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let line = model.notHeldLine {
                Text(line)
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// The field as a button: a tap opens the search bar with the keyboard.
    /// At the accessibility sizes the prompt is short and what it searches is
    /// said under it, so neither is cut off.
    private var searchButton: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                focusOnOpen = true
                model.searchActive = true
            } label: {
                HStack(spacing: 10) {
                    magnifier
                    Text(ax ? DossierSearchCopy.axPrompt : DossierCopy.searchPrompt)
                        .font(.display(15, relativeTo: .body))
                        .foregroundStyle(Color.inkLabel)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .padding(.vertical, ax ? 4 : 0)
                .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.chip, style: .continuous).strokeBorder(Color.edgeStrong))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(DossierCopy.searchPrompt)
            .accessibilityAddTraits(.isSearchField)
            if ax {
                Text(DossierSearchCopy.axHint)
                    .font(.mono(12, relativeTo: .caption)).monoCap()
                    .foregroundStyle(Color.inkLabel)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityHidden(true)
            }
        }
    }

    private var magnifier: some View {
        // A small glyph at every size (capped): at AX5 a body-sized
        // magnifier took a fifth of the field from the prompt.
        Image(systemName: "magnifyingglass")
            .font(.system(size: 17))
            .dynamicTypeSize(...DynamicTypeSize.xxLarge)
            .foregroundStyle(Color.inkLabel)
            .accessibilityHidden(true)
    }

    // MARK: Waar het nu op wacht

    @ViewBuilder private var headlineSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            labelRow(sectionLabel(DossierCopy.headlineLabel)) {
                // The way into the Tijdlijn (Martin, 2026-11-03: "I'm also
                // missing the timeline from the web app"), as a link beside
                // the label it explains rather than a card of its own, so the
                // documents keep their place on the first screen (the frames).
                // At the accessibility sizes it would take a line of its own,
                // and the headline card below opens the Tijdlijn already.
                if !ax || inbox.summary?.headline == nil {
                    link(TimelineCopy.rowTitle) { path.append(.timeline) }
                        .accessibilityHint(TimelineCopy.rowLine)
                }
            }
            if let h = inbox.summary?.headline {
                // The way into the Tijdlijn at what waits: the NU sheet comes up.
                Button { path.append(.timelineNow) } label: { headlineCard(h) }
                    .buttonStyle(.plain)
                    .accessibilityHint(HomeSummary.headlineHint)
            } else {
                VStack(alignment: .leading) {
                    if inbox.summary != nil {
                        muted(DossierCopy.noHeadline)
                    } else if model.offline {
                        muted(DossierCopy.offline)
                    } else {
                        SkeletonLines(count: 2)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassPanel()
            }
        }
    }

    private func headlineCard(_ h: DashboardSummaryDTO.Headline) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                readout(DossierLine.headline(happenedAt: h.happenedAt, now: now), amber: true)
                Spacer(minLength: 0)
                chevron
            }
            Text(h.stopTitle)
                .font(.display(17, relativeTo: .headline, weight: .medium))
                .foregroundStyle(Color.inkBright)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The glow is the card's, around its edge; the words stay crisp.
        .background { RoundedRectangle(cornerRadius: Radius.panel).fill(Color.void).glow(Glow.attn) }
        .overlay(RoundedRectangle(cornerRadius: Radius.panel).strokeBorder(Color.attn, lineWidth: 1))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    // MARK: Open taken

    @ViewBuilder private var tasksSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            labelRow(sectionLabel(DossierCopy.tasksLabel, count: model.tasks?.count)) {
                if let n = model.tasks?.count, n > DossierCopy.tasksShown(compact: compactHeight) {
                    link(DossierCopy.seeAllTasks(n), action: openVoorJou)
                }
            }
            VStack(alignment: .leading, spacing: 0) {
                if let tasks = model.tasks {
                    if tasks.isEmpty {
                        muted(DossierCopy.noTasks).padding(16)
                    } else {
                        let shown = DossierCopy.byDue(tasks).prefix(DossierCopy.tasksShown(compact: compactHeight))
                        ForEach(Array(shown.enumerated()), id: \.element.id) { i, task in
                            if i > 0 { Hairline().padding(.horizontal, 16) }
                            Button { path.append(.task(task.id)) } label: { taskRow(task) }
                                .buttonStyle(.plain)
                        }
                    }
                } else if model.offline {
                    muted(DossierCopy.tasksOffline).padding(16)
                } else {
                    SkeletonLines(count: 3).padding(16)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassPanel()
        }
    }

    private func taskRow(_ t: TaskDTO) -> some View {
        HStack(alignment: .center, spacing: 0) {
            amberDot.padding(.trailing, 12)
            VStack(alignment: .leading, spacing: 4) {
                Text(t.title)
                    .font(.display(17, relativeTo: .body))
                    .foregroundStyle(Color.inkBright)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                readout(DossierLine.task(dueAt: t.dueAt, now: now), amber: true)
            }
            Spacer(minLength: DossierSpacing.toChevron)
            chevron
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var amberDot: some View {
        Circle().fill(Color.attn).frame(width: 8, height: 8).glow(Glow.attn)
            .frame(width: 18, height: 18)
            .background(RoundedRectangle(cornerRadius: 4).fill(Color.attn.opacity(0.12)))
            .accessibilityHidden(true)
    }

    // MARK: Documenten

    /// "DOCUMENTEN · 12 · NIEUWSTE EERST" and the chips; pinned in the bar
    /// once it reaches the top.
    @ViewBuilder private func documentsHeader(pinned: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            documentsLabel
            if model.firstSyncCard == nil, !model.docs.isEmpty { chips }
        }
    }

    @ViewBuilder private var documentsLabel: some View {
        let filtered = model.kind != nil
        let label: String = {
            if model.firstSyncCard != nil { return DossierProgressCopy.documentsLabel(held: model.docs.count, total: model.progress?.total) }
            if filtered { return "documenten · \(model.shownDocs.count) van \(model.documentCount)" }
            return model.loaded ? "documenten · \(model.documentCount)" : "documenten"
        }()
        let trailing: some View = Group {
            if filtered {
                link(DossierSearchCopy.clearFilter) { model.kind = nil }
            } else if model.firstSyncCard == nil, !model.docs.isEmpty {
                Text(ax ? DossierSearchCopy.newestFirst : DossierSearchCopy.newestFirst.uppercased())
                    .font(.mono(12, relativeTo: .caption)).monoCap().tracking(ax ? 0 : 1)
                    .foregroundStyle(Color.inkLabel)
            }
        }
        labelRow(sectionLabel(label)) { trailing }
    }

    /// A section label with something at its trailing end ("Toon alle 6",
    /// "Wis filter"): the trailing part keeps its 44 pt hit area without
    /// making the row taller than its label. At the accessibility sizes it
    /// goes under the label, which needs the whole width.
    @ViewBuilder private func labelRow(_ label: some View, @ViewBuilder trailing: () -> some View) -> some View {
        if ax {
            VStack(alignment: .leading, spacing: 4) {
                label
                trailing()
            }
        } else {
            label
                .padding(.trailing, 120)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .trailing) { trailing() }
        }
    }

    private func link(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .font(.display(15, relativeTo: .subheadline))
            .foregroundStyle(Color.signalLink)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .buttonStyle(.plain)
    }

    private var chips: some View {
        KindChips(kinds: model.kinds, total: model.documentCount, selected: model.kind, ax: ax) { model.kind = $0 }
    }

    @ViewBuilder private var documentsBody: some View {
        if let card = model.firstSyncCard {
            // Every listed document in its own place, newest first; a place
            // whose file is still on its way is a skeleton.
            let rows = model.firstSyncRows
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
                    if i > 0 { Hairline().padding(.horizontal, 16) }
                    switch row {
                    case .held(let d): documentRow(d)
                    case .arriving: SkeletonRow()
                    }
                }
                if rows.isEmpty { SkeletonRow() }
            }
            .glassPanel()
            .accessibilityHint(card.headline)
        } else if !model.loaded || (model.docs.isEmpty && model.isSyncing && model.syncedAt == nil) {
            SkeletonLines(count: 5).padding(16).frame(maxWidth: .infinity, alignment: .leading).glassPanel()
        } else if model.docs.isEmpty {
            muted(DossierCopy.noDocuments).padding(16).frame(maxWidth: .infinity, alignment: .leading).glassPanel()
        } else {
            VStack(alignment: .leading, spacing: 0) { documentRows(model.shownDocs, filtered: model.kind != nil) }
                .glassPanel()
            if model.kind != nil {
                muted(DossierSearchCopy.filterApplies).padding(.top, 24)
            }
        }
    }

    private func documentRows(_ docs: [IndexedDoc], filtered: Bool = false, query: String = "") -> some View {
        ForEach(Array(docs.enumerated()), id: \.element.id) { i, d in
            if i > 0 { Hairline().padding(.horizontal, 16) }
            documentRow(d, filtered: filtered, query: query)
                .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: {
                    placeTops[DossierPlace.row(i)] = $0
                }
        }
    }

    private func documentRow(_ d: IndexedDoc, filtered: Bool = false, query: String = "") -> some View {
        Group {
            let row = DossierDocRow(symbol: DossierKinds.symbol(d.doc.docType),
                                    title: DossierSearchCopy.marked(d.doc.title, query: query),
                                    parts: DossierLine.row(d, filtered: filtered, inSearch: !query.isEmpty, now: now),
                                    snippet: query.isEmpty ? nil : DossierSearch.snippet(d, query: query)
                                        .map { DossierSearchCopy.marked($0, query: query) })
            Button { path.append(.document(id: d.id, title: d.doc.title)) } label: { row }
                .buttonStyle(.plain)
                .contextMenu {
                    Button(DocumentViewerModel.Copy.counter, systemImage: "sun.max") { path.append(.counter(id: d.id)) }
                    ShareLink(item: SharedDocument(store: model.store, id: d.id, title: d.doc.title),
                              preview: SharePreview(d.doc.title)) {
                        Label("Deel…", systemImage: "square.and.arrow.up")
                    }
                    Button("Open", systemImage: "doc") { path.append(.document(id: d.id, title: d.doc.title)) }
                } preview: {
                    row.frame(width: 370).background(Color.plate)
                }
                .accessibilityAction(named: DocumentViewerModel.Copy.counter) { path.append(.counter(id: d.id)) }
        }
    }

    // MARK: Eerste synchronisatie

    private func syncCard(_ card: DossierProgressCopy.Card) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(ax ? HomeSummary.sentence(card.label) : card.label.uppercased())
                .font(.mono(12, relativeTo: .caption)).monoCap().tracking(ax ? 0 : 1)
                .foregroundStyle(Color.inkLabel)
                .fixedSize(horizontal: false, vertical: true)
            Text(card.headline)
                .font(.display(28, relativeTo: .title))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
            if let f = card.fraction {
                GeometryReader { g in
                    // The part that is in, and nothing for the rest (the frames).
                    Capsule().fill(card.interrupted ? Color.inkLabel : Color.signal).frame(width: g.size.width * f)
                }
                .frame(height: 3)
                .frame(maxWidth: .infinity)
                .accessibilityHidden(true)
            }
            Text(ax ? card.meta : card.meta.uppercased())
                .font(.mono(12, relativeTo: .caption)).monoCap().tracking(ax ? 0 : 1)
                .foregroundStyle(Color.inkLabel)
                .fixedSize(horizontal: false, vertical: true)
            Text(card.body)
                .font(.display(15, relativeTo: .subheadline))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
            if card.interrupted {
                AuthButton(title: DossierProgressCopy.resume, weight: .outline, enabled: !model.isSyncing) {
                    Task { await refresh() }
                }
                .padding(.top, 6)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
        .accessibilityElement(children: .contain)
    }

    // MARK: - Searching

    private var searchScreen: some View {
        VStack(spacing: 0) {
            searchBar
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        localResults
                        serverResults
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 16)
                    .padding(.bottom, 32)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .lineHeight(.multiple(factor: HomeType.sairaLineFactor))
                }
                .scrollDismissesKeyboard(.immediately)
                #if DEBUG
                .task(id: model.server) { await fixtureScroll(proxy) }
                #endif
            }
        }
    }

    private var searchBar: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                HStack(spacing: 10) {
                    magnifier
                    TextField(ax ? DossierSearchCopy.axPrompt : DossierCopy.searchPrompt,
                              text: Binding(get: { model.query }, set: { model.query = DossierCopy.searchLine($0) }),
                              axis: ax ? .vertical : .horizontal)
                        .lineLimit(ax ? 1...4 : 1...1)
                        .focused($fieldFocused)
                        .accessibilityLabel(DossierCopy.searchPrompt)
                        .font(.display(15, relativeTo: .body))
                        .foregroundStyle(Color.inkBright)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                    if !model.query.isEmpty {
                        Button { model.query = "" } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(Color.inkLabel)
                                .frame(width: 32, height: 44)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(DossierSearchCopy.clear)
                    }
                }
                .padding(.leading, 14)
                .padding(.trailing, model.query.isEmpty ? 14 : 4)
                .padding(.vertical, ax ? 6 : 0)
                .frame(minHeight: 44)
                .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.chip, style: .continuous).strokeBorder(Color.signal))
                Button(DossierSearchCopy.cancel) {
                    fieldFocused = false
                    model.cancelSearch()
                }
                .font(.display(15, relativeTo: .body))
                .foregroundStyle(Color.signalLink)
                .frame(minHeight: 44)
                .buttonStyle(.plain)
                .fixedSize()
            }
            if model.offline, let line = model.freshness {
                Label {
                    Text(ax ? line : line.uppercased())
                        .font(.mono(12, relativeTo: .caption)).monoCap().tracking(ax ? 0 : 1)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "wifi.slash").font(.system(size: 12))
                }
                .foregroundStyle(Color.inkLabel)
            }
            if !model.docs.isEmpty { chips }
        }
        .padding(.horizontal, 16)
        .padding(.top, 0)
        .padding(.bottom, 12)
        .overlay(alignment: .bottom) { Hairline() }
        .task {
            if focusOnOpen {
                focusOnOpen = false
                fieldFocused = true
            }
        }
    }

    private var queryWords: String { model.query }

    @ViewBuilder private var localResults: some View {
        let hits = model.results
        if hits.isEmpty {
            if case .done = model.server, model.serverGroups.isEmpty {
                nothingAnywhere
            } else {
                nothingHere
            }
        } else {
            VStack(alignment: .leading, spacing: 12) {
                sectionLabel(DossierSearchCopy.localLabel, count: hits.count)
                VStack(alignment: .leading, spacing: 0) { documentRows(hits, filtered: false, query: model.query) }
                    .glassPanel()
            }
        }
    }

    /// No local hit; the server not asked yet, or with something of its own.
    private var nothingHere: some View {
        VStack(alignment: .leading, spacing: 8) {
            emptyGlyph
            Text(DossierSearchCopy.nothingHere)
                .font(.display(17, relativeTo: .headline, weight: .medium))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
            let why = model.server == .idle && !model.offline ? DossierSearchCopy.serverWhy : nil
            if let body = [DossierSearchCopy.titleOnly(model.titleOnlyCount), why].compactMap({ $0 }).joined(separator: " ")
                .nilIfEmpty {
                muted(body)
            }
        }
        .padding(.bottom, 24)
    }

    /// Nothing on the phone and nothing on the server: one state, the query named.
    private var nothingAnywhere: some View {
        VStack(alignment: .leading, spacing: 8) {
            emptyGlyph
            Text(DossierSearchCopy.nothingAnywhere(model.query))
                .font(.display(17, relativeTo: .headline, weight: .medium))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
            muted(DossierSearchCopy.nothingAnywhereBody(shorter: DossierSearchCopy.shorterTerm(model.query, in: model.docs)))
            AuthButton(title: DossierSearchCopy.clear, weight: .outline) {
                model.query = ""
                model.kind = nil
            }
            .padding(.top, 16)
        }
    }

    private var emptyGlyph: some View {
        Image(systemName: "magnifyingglass").font(.system(size: 24, weight: .light))
            .foregroundStyle(Color.inkLabel)
            .padding(.bottom, 8)
            .accessibilityHidden(true)
    }

    @ViewBuilder private var serverResults: some View {
        let localHits = !model.results.isEmpty
        switch model.server {
        case .idle, .loading:
            VStack(alignment: .leading, spacing: 12) {
                if localHits {
                    VStack(alignment: .leading, spacing: 6) {
                        sectionLabel(DossierSearchCopy.serverLabel)
                        if model.offline { offlineReason } else { muted(DossierSearchCopy.serverWhy) }
                    }
                } else if model.offline {
                    offlineReason
                }
                serverButton(DossierSearchCopy.serverButton)
            }
            .padding(.top, localHits ? 32 : 0)
        case .failed(let message):
            serverFailure(message)
        case .timedOut:
            serverFailure(DossierSearchCopy.timedOut)
        case .done:
            let groups = model.serverGroups
            if !groups.isEmpty {
                VStack(alignment: .leading, spacing: 24) {
                    HStack(alignment: .firstTextBaseline) {
                        sectionLabel(DossierSearchCopy.serverLabel, count: groups.reduce(0) { $0 + $1.hits.count })
                        Spacer(minLength: 8)
                        Text(ax ? DossierSearchCopy.new : DossierSearchCopy.new.uppercased())
                            .font(.mono(12, relativeTo: .caption)).monoCap().tracking(ax ? 0 : 1)
                            .foregroundStyle(Color.inkLabel)
                    }
                    .id(DossierAnchor.server)
                    ForEach(groups) { group in
                        VStack(alignment: .leading, spacing: 12) {
                            sectionLabel(group.label, count: group.hits.count)
                            VStack(alignment: .leading, spacing: 0) {
                                ForEach(Array(group.hits.enumerated()), id: \.element.id) { i, hit in
                                    if i > 0 { Hairline().padding(.horizontal, 16) }
                                    serverRow(hit)
                                }
                            }
                            .glassPanel()
                        }
                    }
                }
                .padding(.top, localHits ? 32 : 0)
            } else if localHits {
                muted(DossierSearchCopy.alsoNothingThere).padding(.top, 32)
            }
        }
    }

    private var offlineReason: some View {
        Label {
            Text(DossierSearchCopy.serverOffline)
                .font(.display(15, relativeTo: .subheadline))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "wifi.slash").font(.system(size: 12)).foregroundStyle(Color.inkLabel)
        }
    }

    /// "Zoek op de server": explicit, never automatic. Underway, the button
    /// itself says so (brief §2.1: progress in the button within 100 ms).
    @ViewBuilder private func serverButton(_ title: String) -> some View {
        if case .loading = model.server {
            HStack(spacing: 12) {
                ProgressView().tint(Color.inkLabel)
                Text(DossierSearchCopy.serverBusy)
                    .font(.display(17, relativeTo: .body, weight: .medium))
                    .foregroundStyle(Color.inkLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
            .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong))
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.updatesFrequently)
        } else {
            AuthButton(title: title, weight: model.offline ? .secondary : .outline, enabled: !model.offline) {
                fieldFocused = false
                Task { await model.searchServer() }
            }
        }
    }

    private func serverFailure(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            DossierNotice(label: DossierSearchCopy.unreachableLabel, text: text)
            serverButton(DossierSearchCopy.serverRetry)
        }
        .padding(.top, model.results.isEmpty ? 8 : 32)
    }

    @ViewBuilder private func serverRow(_ hit: SearchHit) -> some View {
        let waits = ServerHits.waitsOnMartin(hit)
        let opens: DossierRoute? = switch hit.link.map(DeepLink.parse) {
        case .document(let id)?: .document(id: id.uuidString.lowercased(), title: hit.title)
        case .task(let id)?: .task(id.uuidString.lowercased())
        default: nil
        }
        let row = HStack(alignment: .center, spacing: 0) {
            Group {
                if waits { amberDot } else {
                    Image(systemName: ServerHits.symbol(hit)).font(.system(size: 15)).foregroundStyle(Color.inkLabel)
                        .frame(width: 18).accessibilityHidden(true)
                }
            }
            .padding(.trailing, 14)
            VStack(alignment: .leading, spacing: 4) {
                Text(DossierDocRow.attributed(DossierSearchCopy.marked(hit.title, query: model.query), size: 17))
                    .foregroundStyle(Color.inkBright)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                readout(ServerHits.detail(hit, now: now), amber: waits)
            }
            Spacer(minLength: opens != nil ? DossierSpacing.toChevron : 0)
            if opens != nil { chevron }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(minHeight: ax ? 44 : DossierSpacing.rowMinHeight)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        if let opens {
            Button { path.append(opens) } label: { row }.buttonStyle(.plain)
        } else {
            row
        }
    }

    // MARK: - Pieces

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Color.inkFaint)
            .accessibilityHidden(true)
    }

    /// A mono section label, "OPEN TAKEN · 6"; sentence case at the
    /// accessibility sizes, the count never cut.
    private func sectionLabel(_ text: String, count: Int? = nil) -> some View {
        let full = [text, count.map(String.init)].compactMap { $0 }.joined(separator: " · ")
        return Text(ax ? HomeSummary.sentence(full.lowercased()) : HomeSummary.metaLine([full.uppercased()]))
            .font(.mono(12, relativeTo: .caption, weight: .medium)).monoCap()
            .tracking(ax ? 0 : 1)
            .foregroundStyle(Color.inkLabel)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    /// A readout ("WACHT OP JOU · TE LAAT · 30 OKT"); at the accessibility
    /// sizes one part per line (brief §2.7).
    @ViewBuilder private func readout(_ parts: [String], amber: Bool = false) -> some View {
        let color = amber ? Color.attn : Color.inkLabel
        if ax {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(parts.enumerated()), id: \.offset) { _, p in Text(p) }
            }
            .font(.mono(12, relativeTo: .caption)).monoCap()
            .foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
        } else {
            Text(DossierLine.joined(parts))
                .font(.mono(12, relativeTo: .caption)).monoCap()
                .tracking(1)
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func muted(_ text: String) -> some View {
        Text(text)
            .font(.display(15, relativeTo: .subheadline))
            .foregroundStyle(Color.inkMute)
            .fixedSize(horizontal: false, vertical: true)
    }

    #if DEBUG
    /// `-fixtures-dossier`: the states a gesture reaches (a chip tapped, a
    /// query typed, "Zoek op de server" tapped).
    private func applyFixtureState() {
        guard let states = FixtureLaunch.current?.dossier, !states.isEmpty else { return }
        for state in states {
            switch state {
            case .filter(let label): model.kind = DossierKinds.key(label)
            case .zoek(let q):
                model.searchActive = true
                model.query = q
            default: break
            }
        }
        if states.contains(.server) { Task { await model.searchServer() } }
    }

    private func fixtureScroll(_ proxy: ScrollViewProxy) async {
        guard model.loaded, let states = FixtureLaunch.current?.dossier else { return }
        for case .scroll(let target) in states {
            try? await Task.sleep(for: .milliseconds(400))
            switch target {
            case "documenten":
                // The list's top tucked under the pinned bar.
                proxy.scrollTo(DossierAnchor.documents, anchor: .top)
                try? await Task.sleep(for: .milliseconds(500))
                tuck(DossierPlace.list)
            case _ where target.hasPrefix("rij:"):
                // `scroll:rij:<n>`: the n-th row (1 = the newest) first under the bar.
                guard let n = Int(target.dropFirst(4)), n >= 1 else { return }
                proxy.scrollTo(DossierAnchor.documents, anchor: .top)
                try? await Task.sleep(for: .milliseconds(500))
                tuck(DossierPlace.row(n - 1))
                try? await Task.sleep(for: .milliseconds(400))
                tuck(DossierPlace.row(n - 1))
            case "chips":
                // The documents' label and chips a little below the middle,
                // the open task's end above them (frame "AX5 · verder gescrold").
                proxy.scrollTo(DossierAnchor.documents, anchor: .center)
                try? await Task.sleep(for: .milliseconds(500))
                if let top = placeTops[DossierPlace.header] {
                    position.scrollTo(y: max(0, scrollOffset + top - screenHeight * 0.53))
                }
            case "server":
                guard case .done = model.server else { return }
                proxy.scrollTo(DossierAnchor.server, anchor: UnitPoint(x: 0, y: 0.2))
            default: break
            }
        }
    }
    #endif
}

enum DossierAnchor: Hashable { case documents, list, server }

/// The places `DossierTab.tuck` can bring to the pinned bar's edge.
enum DossierPlace {
    static let list = "list"
    static let header = "header"
    static func row(_ i: Int) -> String { "row:\(i)" }
}

/// The Dossier's measured spacing ("dossier · final").
enum DossierSpacing {
    /// A one-line document row: title and readout at 12/12, held at 68.
    static let rowMinHeight: CGFloat = 68
    /// Between a row's text and its chevron.
    static let toChevron: CGFloat = 18
    /// Between sections: 32 at a regular height, 24 at a compact one (the
    /// iPhone SE's 667 pt and less).
    static func sectionGap(screenHeight: CGFloat) -> CGFloat { isCompact(screenHeight: screenHeight) ? 24 : 32 }
    static func isCompact(screenHeight: CGFloat) -> Bool { screenHeight <= 667 }
    /// Room between the status bar and the content: a notched phone's safe
    /// area already leaves it; one without (the SE's 20 pt bar) gets 8.
    static func underStatusBar(safeTop: CGFloat) -> CGFloat { safeTop < 40 ? 8 : 0 }
}

/// The top edge of the list card, drawn under the pinned bar so the rows
/// scrolling up go in under a card's edge instead of being cut by the bar.
struct PanelLip: View {
    static let height: CGFloat = 4

    var body: some View {
        let shape = UnevenRoundedRectangle(topLeadingRadius: Radius.panel, topTrailingRadius: Radius.panel)
        shape.fill(Color.glassA)
            .overlay(shape.stroke(Color.edge, lineWidth: 1).padding(.bottom, -2).clipped())
            .overlay(alignment: .top) {
                Rectangle().fill(Color.edgeLit).frame(height: 1).padding(.horizontal, Radius.panel)
            }
            .frame(height: Self.height)
            .accessibilityHidden(true)
    }
}

extension View {
    /// Mono readouts stop growing at AX3: the frames set them 28 at AX5
    /// (spec "Type at AX5: 58 / 53 / 49 / 28"), where the titles keep growing.
    func monoCap() -> some View { dynamicTypeSize(...DynamicTypeSize.accessibility3) }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

// MARK: - Rows and chips

/// One document: the soort's glyph, the title (the query's words bold), the
/// mono readout, and for a search hit the text around the match.
struct DossierDocRow: View {
    let symbol: String
    let title: [SearchSnippet.Segment]
    let parts: [String]
    var snippet: [SearchSnippet.Segment]? = nil
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let ax = typeSize.isAccessibilitySize
        // A search hit's glyph and chevron stand at its title's first line
        // (the text under it can run three lines); a plain row centres them.
        let lead = snippet?.isEmpty == false
        HStack(alignment: lead ? .firstTextBaseline : .center, spacing: 0) {
            Image(systemName: symbol)
                .font(.system(size: 15))
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .foregroundStyle(Color.inkLabel)
                .frame(width: 18)
                .padding(.trailing, 14)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(Self.attributed(title, size: 17))
                    .foregroundStyle(Color.inkBright)
                    .lineLimit(ax ? nil : 2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                if ax {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(parts.enumerated()), id: \.offset) { _, p in Text(p) }
                    }
                    .font(.mono(12, relativeTo: .caption)).monoCap()
                    .foregroundStyle(Color.inkLabel)
                    .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text(DossierLine.joined(parts))
                        .font(.mono(12, relativeTo: .caption)).monoCap().tracking(1)
                        .foregroundStyle(Color.inkLabel)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let snippet, !snippet.isEmpty {
                    Text(Self.attributed(snippet, size: 15, relativeTo: .subheadline))
                        .foregroundStyle(Color.inkMute)
                        .lineLimit(ax ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 8)
                }
            }
            Spacer(minLength: DossierSpacing.toChevron)
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.inkFaint)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        // One-line rows keep 68 by intent (the frames' row model); two-line
        // rows hug their text at 12/12.
        .frame(minHeight: ax ? 44 : DossierSpacing.rowMinHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// The marked words semibold and bright, the rest as the line's own.
    static func attributed(_ parts: [SearchSnippet.Segment], size: CGFloat,
                           relativeTo style: Font.TextStyle = .body) -> AttributedString {
        parts.reduce(into: AttributedString()) { out, part in
            var piece = AttributedString(part.text)
            piece.font = .display(size, relativeTo: style, weight: part.marked ? .semibold : .regular)
            if part.marked { piece.foregroundColor = .inkBright }
            out += piece
        }
    }
}

/// The soort chips: "ALLES 12 · BRIEF 4 · MEER SOORTEN"; at the
/// accessibility sizes every soort, wrapping onto the next line. Each chip's
/// hit area is 44 pt high.
struct KindChips: View {
    let kinds: [DossierKind]
    let total: Int
    let selected: String?
    let ax: Bool
    let choose: (String?) -> Void

    var body: some View {
        if ax {
            FlowLayout(spacing: 8, lineSpacing: 8) {
                chip(DossierSearchCopy.all, total, on: selected == nil) { choose(nil) }
                ForEach(kinds) { k in chip(k.label, k.count, on: selected == k.key) { choose(k.key) } }
            }
        } else {
            let split = DossierKinds.visible(kinds, selected: selected)
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    chip(DossierSearchCopy.all, total, on: selected == nil) { choose(nil) }
                    ForEach(split.shown) { k in chip(k.label, k.count, on: selected == k.key) { choose(k.key) } }
                    if !split.more.isEmpty {
                        Menu {
                            ForEach(split.more) { k in
                                Button("\(HomeSummary.sentence(k.label)) · \(k.count)") { choose(k.key) }
                            }
                        } label: {
                            HStack(spacing: 6) {
                                Text(DossierSearchCopy.moreKinds.uppercased())
                                Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))
                            }
                            .modifier(ChipLook(on: false, ax: false))
                        }
                        .accessibilityLabel("Meer soorten")
                    }
                }
            }
            .scrollIndicators(.hidden)
            .scrollClipDisabled()
        }
    }

    private func chip(_ label: String, _ count: Int, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(ax ? "\(HomeSummary.sentence(label)) \(count)" : "\(label.uppercased()) \(count)")
                .monospacedDigit()
                .modifier(ChipLook(on: on, ax: ax))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(HomeSummary.sentence(label)), \(count)")
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

private struct ChipLook: ViewModifier {
    let on: Bool
    let ax: Bool

    func body(content: Content) -> some View {
        content
            .font(.mono(12, relativeTo: .caption, weight: .medium)).monoCap()
            .tracking(ax ? 0 : 1)
            .foregroundStyle(on ? Color.onSignal : Color.inkBright)
            .padding(.horizontal, 10)
            .padding(.vertical, ax ? 4 : 5)
            .background(on ? Color.signal : Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
            .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(on ? Color.clear : Color.edgeStrong))
            // The 44 pt hit area around a chip drawn smaller (brief §2.2).
            .frame(minHeight: 44)
            .contentShape(Rectangle())
    }
}

struct Hairline: View {
    var body: some View { Rectangle().fill(Color.hairline).frame(height: 1) }
}

/// The loading state in the shape of rows, never a spinner (brief §2.1).
struct SkeletonLines: View {
    let count: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(0..<count, id: \.self) { i in
                VStack(alignment: .leading, spacing: 4) {
                    RoundedRectangle(cornerRadius: Radius.chip).fill(Color.edge)
                        .frame(width: i % 2 == 0 ? 220 : 180, height: 16)
                    RoundedRectangle(cornerRadius: Radius.chip).fill(Color.hairline)
                        .frame(width: 140, height: 12)
                }
            }
        }
        .accessibilityLabel("Laden")
    }
}

/// A document still on its way during a first sync: a row's shape.
struct SkeletonRow: View {
    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            Circle().fill(Color.edge).frame(width: 6, height: 6).frame(width: 18)
            VStack(alignment: .leading, spacing: 8) {
                RoundedRectangle(cornerRadius: Radius.chip).fill(Color.edge).frame(height: 12)
                    .frame(maxWidth: 220)
                RoundedRectangle(cornerRadius: Radius.chip).fill(Color.hairline).frame(width: 110, height: 9)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(minHeight: DossierSpacing.rowMinHeight)
        .accessibilityLabel("Laden")
    }
}
