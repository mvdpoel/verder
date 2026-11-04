import SwiftUI

/// Where a Voor jou row leads. Held as RootView's path (not the tab's), so a
/// deep link that lands on the lock screen survives the lock.
enum InboxRoute: Hashable, Sendable {
    /// A reply, follow-up or question: all three open Plan 2's `ProposalScreen`.
    case proposal(String)
    case suggestion(String)
    case task(String)
    /// A document, read-only: the one an undo of "Door verder gedaan" is
    /// putting back into Kan wachten, before its suggestion has an id.
    case document(id: String, title: String)
    /// "Door verder gedaan" on a screen of its own, open: where Overzicht's
    /// card and the daily digest lead.
    case doneByVerder

    /// Nil for the map's current stop and for a kind this build does not know:
    /// those are shown, not opened.
    init?(_ item: WaitingItem) {
        switch item.kind {
        case .proposal, .question: self = .proposal(item.id)
        case .suggestion: self = .suggestion(item.id)
        case .task: self = .task(item.id)
        case .stop, .other: return nil
        }
    }
}

/// The Voor jou tab: one list of everything waiting on Martin, in the
/// server's order, split into Nu and Kan wachten (Figma "voorjou · final").
/// Read from the app's one `InboxStore`, so the list, the badge and the
/// widget cannot disagree.
///
/// Routine decisions happen ON THE LIST — a swipe or a menu approves an
/// unchanged suggestion, finishes a task or calls something not relevant —
/// and are HELD for their undo window (`InboxDecisions`) before they post.
/// Never here: a send (only `ProposalScreen`, behind a fresh Face ID), a
/// bulk send, or an approval of anything the server did not call approvable.
struct VoorJouTab: View {
    let store: InboxStore
    /// Where a document's bytes are kept; a restored row opens its document.
    let dossier: DossierStore
    let client: APIClient
    let gate: ApprovalGate
    @Binding var path: [InboxRoute]
    let onUnauthorized: @MainActor () -> Void
    let now: @Sendable () -> Date

    @State private var done: DoneByVerderModel
    @State private var decisions: InboxDecisions
    @State private var showAll = false
    @State private var doneOpen = false
    @State private var selecting = false
    @State private var selected: Set<String> = []
    @State private var confirming = false
    @State private var reviewing = false
    @State private var scrolled = false
    @State private var verderUndos = 0
    @State private var fixtureApplied = false
    @Namespace private var zoom
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// "Gesprek voorbereiden" on a row about a party (Call/).
    @Environment(CallSession.self) private var call: CallSession?

    init(store: InboxStore, dossier: DossierStore, client: APIClient, gate: ApprovalGate, path: Binding<[InboxRoute]>,
         onUnauthorized: @escaping @MainActor () -> Void, now: @escaping @Sendable () -> Date = { Date() }) {
        self.store = store
        self.dossier = dossier
        self.client = client
        self.gate = gate
        self._path = path
        self.onUnauthorized = onUnauthorized
        self.now = now
        // An undo moves a document back into the inbox, and a refusal means
        // the row is stale: either way the one store refreshes.
        self._done = State(initialValue: DoneByVerderModel(
            client: client, onChanged: { await store.refresh() }, onUnauthorized: onUnauthorized))
        self._decisions = State(initialValue: InboxDecisions(
            client: client, now: now, onPosted: { await store.refresh() }, onUnauthorized: onUnauthorized))
    }

    private var ax: Bool { typeSize.isAccessibilitySize }

    var body: some View {
        NavigationStack(path: $path) {
            root
                .navigationDestination(for: InboxRoute.self) { route in
                    // A row zooms open from itself; with Reduce Motion the
                    // system's own crossfade-like push (brief §2.6).
                    if reduceMotion {
                        destination(route)
                    } else {
                        destination(route).navigationTransition(.zoom(sourceID: route, in: zoom))
                    }
                }
                .toolbar(.hidden, for: .navigationBar)
                .toolbar(selecting ? .hidden : .automatic, for: .tabBar)
        }
        .preferredColorScheme(.dark)
        .task { await store.refresh() }
        // Back from a screen: what was decided there has moved on the list.
        .onChange(of: path) { _, now in
            if now.isEmpty { Task { await store.refresh() } }
        }
        // Leaving the app posts what is held: a decision is never lost to a
        // suspended timer.
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { Task { await decisions.flush() } }
        }
        .onChange(of: typeSize, initial: true) { _, size in decisions.accessibilitySize = size.isAccessibilitySize }
        .sensoryFeedback(.success, trigger: decisions.successes)
        .sensoryFeedback(.impact(flexibility: .soft), trigger: decisions.softs)
        .sensoryFeedback(.error, trigger: decisions.errors)
        .sensoryFeedback(.impact(weight: .light), trigger: verderUndos)
        .sensoryFeedback(.error, trigger: store.failures)
    }

    /// "Volgende in Voor jou": the store's list in the server's order, minus
    /// the item on screen. Opening it REPLACES that screen on the stack.
    private var nextUp: VoorJouNext {
        VoorJouNext(pick: { id in VoorJouNextPick.pick(items: store.inbox?.items ?? [], excluding: id) },
                    refresh: { await store.refresh() },
                    open: { route in path = [route] },
                    hand: { id, action, title in
                        let d = Self.handBack(id: id, action: action, title: title, items: store.inbox?.items ?? [])
                        #if DEBUG
                        // A capture shoots the toast: its countdown frozen.
                        if FixtureLaunch.current?.detail != nil {
                            decisions.fixtureHold([d], remaining: decisions.accessibilitySize ? 8 : 4)
                            path = []
                            return
                        }
                        #endif
                        decisions.decide(d)
                        path = []
                    },
                    push: { route in path.append(route) })
    }

    /// The decision a detail screen hands back to the list: keyed by the
    /// list's own row (so the row hides while it is held), named as the
    /// row names it. A row the list has not loaded falls back to the kind
    /// the action implies.
    static func handBack(id: String, action: ListDecision.Action, title: String,
                         items: [WaitingItem]) -> ListDecision {
        let item = items.first { $0.id.lowercased() == id.lowercased() }
        let fallbackKind: String = switch action {
        case .answer: "question"
        case .task: "task"
        default: "suggestion"
        }
        return ListDecision(id: UUID(), key: item.map(VoorJouList.key) ?? "\(fallbackKind):\(id)",
                            title: item?.title ?? title, action: action, target: id,
                            short: item.flatMap(VoorJouList.toastSubject))
    }

    @ViewBuilder private func destination(_ route: InboxRoute) -> some View {
        switch route {
        case .proposal(let id):
            ProposalScreen(id: id, client: client, gate: gate, onUnauthorized: onUnauthorized, now: now)
                .environment(\.voorJouNext, nextUp)
        case .suggestion(let id):
            SuggestionDetailView(id: id, client: client, onUnauthorized: onUnauthorized, now: now)
                .environment(\.voorJouNext, nextUp)
        case .task(let id):
            TaskScreen(id: id, client: client, onUnauthorized: onUnauthorized, now: now)
                .environment(\.voorJouNext, nextUp)
        case .doneByVerder:
            DoneByVerderScreen(store: store, model: done)
        case .document(let id, let title):
            DocumentViewer(id: id, title: title, store: dossier, client: client, onUnauthorized: onUnauthorized)
        }
    }

    @ViewBuilder private var root: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            if let inbox = store.inbox {
                list(inbox)
            } else if let error = store.lastError, error != .unauthorized {
                VoorJouFailurePage(eyebrow: VoorJouList.eyebrow(now()), error: error,
                                   readout: VoorJouList.lastAttempt(error, attemptedAt: store.attemptedAt, now: now()),
                                   retry: { Task { await store.refresh() } })
            } else {
                VoorJouLoadingPage(eyebrow: VoorJouList.eyebrow(now()))
            }
        }
    }

    // MARK: - The list

    private func list(_ inbox: InboxDTO) -> some View {
        let clock = now()
        let restoring = VoorJouList.restoring(inbox, keys: decisions.hiddenKeys)
        let sections = VoorJouList.sections(inbox, hiding: decisions.hiddenKeys, expanded: showAll, restoring: restoring)
        let count = VoorJouList.count(inbox, hidden: decisions.hiddenCount, restored: restoring.count)
        let notice = VoorJouList.notice(store.lastError, hasList: true)
        let readOnly = notice == .offline
        let freshness = VoorJouList.freshness(now: clock, fetchedAt: store.fetchedAt, error: store.lastError)
        let selectable = sections.flatMap(\.rows).filter(\.selectable)
        let canSelect = VoorJouList.canSelect(selectable: selectable.count, readOnly: readOnly,
                                              holding: !decisions.held.isEmpty)
        let doneActions = inbox.doneByVerder.filter { !decisions.hiddenKeys.contains(ListDecision.key(verder: $0.changeId)) }

        return ScrollViewReader { proxy in
            List {
                if !ax && !selecting {
                    VoorJouHeader(eyebrow: VoorJouList.eyebrow(clock), count: count, empty: sections.isEmpty,
                                  freshness: freshness, canSelect: canSelect, select: startSelecting)
                        .voorJouRow()
                        .id("top")
                }
                if let notice {
                    VoorJouNoticeCard(notice: notice, retry: { Task { await store.refresh() } })
                        .padding(.bottom, 12)
                        .voorJouRow()
                }
                if sections.isEmpty {
                    VoorJouEmptyState(body: VoorJouList.emptyBody(lastClearedAt: inbox.lastClearedAt, now: clock),
                                      readout: VoorJouList.emptyReadout(freshness))
                        .voorJouRow()
                }
                ForEach(sections) { section in
                    Section {
                        // At the accessibility sizes the section's name is an
                        // ordinary row, not a pinned header: two lines of AX5
                        // pinned over the rows leave them a sliver and read as
                        // the next row's title cut off beneath it.
                        if ax {
                            VoorJouSectionHeader(section: section, trailing: sectionTrailing(section, readOnly: readOnly))
                                .listRowBackground(Color.void)
                                .listRowSeparator(.hidden)
                        }
                        if selecting && section.kind == .nu {
                            Text(VoorJouCopy.nuNote)
                                .font(.display(15, relativeTo: .subheadline))
                                .foregroundStyle(Color.inkMute)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.bottom, 8)
                                .voorJouRow()
                        }
                        ForEach(section.rows) { row in
                            rowCell(row, readOnly: readOnly, now: clock)
                            if let failure = decisions.failures[row.id] {
                                VoorJouNotSavedNotice(failure: failure, ax: ax,
                                                      retry: { Task { await decisions.retry(row.id) } },
                                                      withdraw: { decisions.withdraw(row.id) })
                                    .voorJouRow()
                            }
                        }
                        if section.truncated {
                            VoorJouShowAllRow(shown: section.rows.count, total: section.total, ax: ax) { showAll = true }
                                .voorJouRow()
                                .id("more")
                        } else if section.kind == .nu, sections.count == 1, count == 1 {
                            Text(VoorJouCopy.onlyOne)
                                .font(.display(15, relativeTo: .subheadline))
                                .foregroundStyle(Color.inkMute)
                                .padding(.leading, ax ? 0 : VoorJouMetrics.gutter)
                                .padding(.vertical, 14)
                                .voorJouRow()
                        }
                        Color.clear.frame(height: 28).voorJouRow()
                    } header: {
                        if !ax {
                            VoorJouSectionHeader(section: section, trailing: sectionTrailing(section, readOnly: readOnly))
                        }
                    }
                }
                if !inbox.doneByVerder.isEmpty {
                    DoneByVerderListSection(actions: doneActions,
                                            total: VoorJouList.doneCount(inbox, restored: restoring.count),
                                            open: $doneOpen, summary: sections.isEmpty, ax: ax,
                                            undo: { action in
                                                verderUndos += 1
                                                decisions.decide(ListDecision(
                                                    id: UUID(), key: ListDecision.key(verder: action.changeId),
                                                    title: action.documentTitle ?? action.after.title ?? "Document",
                                                    action: .undoVerder, target: action.changeId))
                                            })
                }
                Color.clear.frame(height: 24).voorJouRow()
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 0)
            .listSectionSpacing(0)
            .animation(reduceMotion ? .easeInOut(duration: 0.2) : .easeInOut(duration: 0.25), value: decisions.hiddenKeys)
            .refreshable { await store.refresh() }
            .onScrollGeometryChange(for: Bool.self) { $0.contentOffset.y + $0.contentInsets.top > VoorJouMetrics.compactAfter } action: { _, past in
                scrolled = past
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                if selecting {
                    VoorJouSelectionBar(count: selected.count, all: selectable.count,
                                        cancel: stopSelecting,
                                        selectAll: { selected = Set(selectable.map(\.id)) })
                } else if ax || scrolled {
                    VoorJouCompactHeader(count: count, canSelect: ax && canSelect, select: startSelecting)
                        .transition(.opacity)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if selecting {
                    let chosen = selectable.filter { selected.contains($0.id) }
                    VoorJouSelectionToolbar(count: chosen.count,
                                            canApprove: !chosen.isEmpty && chosen.allSatisfy(\.approvable),
                                            reject: { decideAll(chosen, .reject) },
                                            approve: { confirming = true })
                } else if let content = DecisionToast.content(decisions.held, short: ax) {
                    DecisionToastView(content: content, decisions: decisions, ax: ax,
                                      undo: { decisions.undoLast() }, review: { reviewing = true })
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: scrolled)
            .alert(VoorJouList.confirmTitle(selectedApprovable(selectable).count), isPresented: $confirming) {
                Button("Annuleren", role: .cancel) {}
                Button(VoorJouList.approveMany(selectedApprovable(selectable).count)) {
                    decideAll(selectedApprovable(selectable), .approve)
                }
            } message: {
                Text(VoorJouList.confirmMessage(selectedApprovable(selectable).map(\.item.title),
                                                window: ax ? InboxDecisions.accessibilityWindow : InboxDecisions.window))
            }
            .sheet(isPresented: $reviewing) {
                DecisionReviewSheet(decisions: decisions)
                    .presentationDetents([.medium, .large])
            }
            #if DEBUG
            .task(id: inbox.count) { applyFixtureState(inbox, proxy: proxy) }
            #endif
        }
    }

    private func sectionTrailing(_ section: VoorJouList.Section, readOnly: Bool) -> String? {
        guard section.kind == .kanWachten else { return nil }
        if selecting { return VoorJouList.suggestionsCount(section.rows.count { $0.selectable }) }
        if readOnly { return VoorJouCopy.readOnly }
        return section.truncated ? "\(section.rows.count) getoond" : nil
    }

    private func selectedApprovable(_ selectable: [VoorJouList.Row]) -> [VoorJouList.Row] {
        selectable.filter { selected.contains($0.id) && $0.approvable }
    }

    // MARK: - One row

    @ViewBuilder
    private func rowCell(_ row: VoorJouList.Row, readOnly: Bool, now: Date) -> some View {
        let isSelected = selected.contains(row.id)
        let view = VoorJouRowView(row: row, now: now, ax: ax, selecting: selecting, selected: isSelected,
                                  failed: decisions.failures[row.id] != nil)
        Group {
            if selecting && row.selectable {
                Button { toggle(row) } label: { view }
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
            } else if selecting {
                view
            } else if let route = row.route {
                Button { path.append(route) } label: { view }
                    .matchedTransitionSource(id: route, in: zoom)
            } else {
                view
            }
        }
        .buttonStyle(.plain)
        .voorJouRow()
        // A restored row has no server id yet: nothing to decide on it.
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if !selecting && !readOnly && !row.restored { leadingAction(row) }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if !selecting && !readOnly && !row.restored { trailingAction(row) }
        }
        .contextMenu { if !selecting && !row.restored { menu(row, readOnly: readOnly) } }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(VoorJouList.accessibilityLabel(row.item, now: now))
        .accessibilityActions {
            if !selecting && !readOnly && !row.restored { accessibilityActions(row) }
            if !selecting, let open = prepareCall(row) { Button(CallCopy.title, action: open) }
        }
        .id(row.id)
    }

    @ViewBuilder private func leadingAction(_ row: VoorJouList.Row) -> some View {
        if row.approvable {
            Button { decide(row, .approve) } label: { Label("Goedkeuren", systemImage: "checkmark") }
                .tint(Color.signal)
        } else if row.canDone {
            Button { decide(row, .task("done")) } label: { Label("Gedaan", systemImage: "checkmark") }
                .tint(Color.okay)
        }
    }

    @ViewBuilder private func trailingAction(_ row: VoorJouList.Row) -> some View {
        if row.item.kind == .suggestion {
            Button { decide(row, .reject) } label: { Label("Niet relevant", systemImage: "xmark.circle") }
                .tint(Color.steelDim)
        } else if row.taskNext.contains("dropped") {
            Button { decide(row, .task("dropped")) } label: { Label("Niet relevant", systemImage: "xmark.circle") }
                .tint(Color.steelDim)
        }
    }

    @ViewBuilder private func menu(_ row: VoorJouList.Row, readOnly: Bool) -> some View {
        if let route = row.route {
            Button(VoorJouCopy.view, systemImage: "eye") { path.append(route) }
        }
        if let open = prepareCall(row) {
            Button(CallCopy.title, systemImage: "phone", action: open)
        }
        switch row.item.kind {
        case .proposal, .question:
            Divider()
            Text(VoorJouCopy.sendOnlyInProposal)
        case .suggestion where readOnly, .task where readOnly:
            Divider()
            Text(VoorJouCopy.offlineMenu)
        case .suggestion:
            Divider()
            if row.approvable {
                Button("Keur goed", systemImage: "checkmark") { decide(row, .approve) }
            }
            Divider()
            Button("Markeer als niet relevant", systemImage: "xmark.circle") { decide(row, .reject) }
        case .task:
            Divider()
            ForEach(VoorJouMenu.taskSteps(row.taskNext).filter { $0.status != "dropped" }, id: \.status) { step in
                Button(step.label, systemImage: step.symbol) { decide(row, .task(step.status)) }
            }
            if row.taskNext.contains("dropped") {
                Divider()
                Button("Markeer als niet relevant", systemImage: "xmark.circle") { decide(row, .task("dropped")) }
            }
        default:
            EmptyView()
        }
    }

    @ViewBuilder private func accessibilityActions(_ row: VoorJouList.Row) -> some View {
        if row.approvable { Button("Keur goed") { decide(row, .approve) } }
        if row.item.kind == .suggestion { Button("Markeer als niet relevant") { decide(row, .reject) } }
        ForEach(VoorJouMenu.taskSteps(row.taskNext), id: \.status) { step in
            Button(step.label) { decide(row, .task(step.status)) }
        }
    }

    /// A row about a party (a proposal or question the server names one
    /// for) offers "Gesprek voorbereiden"; a row with no party offers nothing.
    private func prepareCall(_ row: VoorJouList.Row) -> (() -> Void)? {
        guard let partyId = row.item.partyId, let call else { return nil }
        let name = row.item.party ?? row.item.subtitle
        return { Task { await call.open(partyId: partyId, name: name) } }
    }

    private func decide(_ row: VoorJouList.Row, _ action: ListDecision.Action) {
        decisions.decide(Self.decision(row, action))
    }

    private func decideAll(_ rows: [VoorJouList.Row], _ action: ListDecision.Action) {
        decisions.decide(rows.map { Self.decision($0, action) })
        stopSelecting()
    }

    static func decision(_ row: VoorJouList.Row, _ action: ListDecision.Action) -> ListDecision {
        ListDecision(id: UUID(), key: row.id, title: row.item.title, action: action, target: row.item.id,
                     short: VoorJouList.toastSubject(row.item))
    }

    private func toggle(_ row: VoorJouList.Row) {
        guard row.selectable else { return }
        if selected.contains(row.id) { selected.remove(row.id) } else { selected.insert(row.id) }
    }

    private func startSelecting() {
        selected = []
        selecting = true
    }

    private func stopSelecting() {
        selecting = false
        selected = []
    }

    #if DEBUG
    /// `-fixtures-voorjou`: a state only a gesture reaches, set up on the
    /// list as it loaded. Nothing here posts: a held decision is frozen.
    private func applyFixtureState(_ inbox: InboxDTO, proxy: ScrollViewProxy) {
        guard !fixtureApplied, let states = FixtureLaunch.current?.voorJou, !states.isEmpty else { return }
        fixtureApplied = true
        let rows = VoorJouList.rows(inbox)
        let suggestions = rows.filter { $0.item.kind == .suggestion }
        let task = rows.first { $0.item.kind == .task }
        func decision(_ row: VoorJouList.Row, _ action: ListDecision.Action) -> ListDecision {
            Self.decision(row, action)
        }
        for state in states {
            switch state {
            case .toast:
                if let s = suggestions.first { decisions.fixtureHold([decision(s, .approve)], remaining: ax ? 8 : 4) }
            case .twee:
                if let s = suggestions.first, let t = task {
                    decisions.fixtureHold([decision(s, .approve), decision(t, .task("done"))], remaining: 2)
                }
            case .nietOpgeslagen:
                if let s = suggestions.first { decisions.fixtureFail(decision(s, .approve)) }
            case .selecteren, .bevestigen:
                selecting = true
                selected = Set(suggestions.prefix(3).map(\.id))
                if state == .bevestigen { confirming = true }
            case .gedaan:
                doneOpen = true
            case .ongedaan:
                doneOpen = true
                if let a = inbox.doneByVerder.first(where: { $0.undoable && !$0.undone }) {
                    decisions.fixtureHold([ListDecision(id: UUID(), key: ListDecision.key(verder: a.changeId),
                                                        title: a.documentTitle ?? "Document",
                                                        action: .undoVerder, target: a.changeId)],
                                          remaining: 4)
                }
            case .scroll(let raw):
                // "<key>@<y>": the row's point y (0 top, 1 bottom) on the
                // same point of the visible list; plain "<key>" is its top.
                var target = raw
                var anchor = UnitPoint.top
                if let at = raw.lastIndex(of: "@"), let y = Double(raw[raw.index(after: at)...]) {
                    target = String(raw[..<at])
                    anchor = UnitPoint(x: 0, y: y)
                }
                Task {
                    try? await Task.sleep(for: .milliseconds(400))
                    proxy.scrollTo(target, anchor: anchor)
                }
            }
        }
    }
    #endif

    static func message(_ error: APIError) -> String {
        switch error {
        case .unauthorized: "Log opnieuw in."
        case .transport: ProposalModel.Copy.offline
        default: ProposalModel.Copy.failed
        }
    }
}

/// A task's menu steps, in the frame's order, for the statuses the server allows.
enum VoorJouMenu {
    struct Step: Equatable {
        let status: String
        let label: String
        let symbol: String
    }

    static let order: [Step] = [
        Step(status: "done", label: "Markeer als gedaan", symbol: "checkmark.circle"),
        Step(status: "in-progress", label: "Zet op bezig", symbol: "clock"),
        Step(status: "waiting", label: "Zet op wacht op een ander", symbol: "person.badge.clock"),
        Step(status: "open", label: "Zet weer open", symbol: "arrow.uturn.backward"),
        Step(status: "dropped", label: "Markeer als niet relevant", symbol: "xmark.circle"),
    ]

    /// Only `validNext`: the phone never offers a step the matrix forbids.
    static func taskSteps(_ validNext: [String]) -> [Step] {
        order.filter { validNext.contains($0.status) }
    }
}
