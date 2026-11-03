import SwiftUI

/// The Dossier tab: the case in Martin's pocket. Search at the top; with no
/// query, where the case waits, the open tasks, then every document newest
/// first. It renders from the phone's own copy at once (offline included,
/// with the age said), and syncs in the foreground after unlock.
///
/// LOCK-GATED (RootView): nothing here exists while the app is locked.
/// Read-only: no document is changed from the phone, and purge is never
/// offered. Amber only on the open tasks, which wait on Martin.
struct DossierTab: View {
    let model: DossierModel
    let inbox: InboxStore
    /// The case map behind the Tijdlijn row.
    let timeline: TimelineStore
    let lock: AppLock
    let client: APIClient
    @Binding var path: [DossierRoute]
    let onUnauthorized: @MainActor () -> Void
    /// The Tijdlijn's empty state: "Open Voor jou".
    var openVoorJou: () -> Void = {}
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                Color.void.ignoresSafeArea()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        header
                        searchField
                        if model.isSearching {
                            localResults
                            serverResults
                        } else {
                            headlineCard
                            timelineRow
                            tasksCard
                            documentsCard
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 24)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollDismissesKeyboard(.immediately)
                .refreshable { await refresh() }
            }
            .navigationDestination(for: DossierRoute.self) { route in
                switch route {
                case .document(let id, let title):
                    DocumentViewer(id: id, title: title ?? model.doc(id)?.title ?? DossierCopy.title,
                                   store: model.store, client: client, onUnauthorized: onUnauthorized)
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
        .preferredColorScheme(.dark)
        .task {
            await model.loadCached()
            if inbox.summary == nil { await inbox.refresh() }
            await refresh()
            // The Tijdlijn row names the map's own counts.
            if timeline.map == nil { await timeline.load() }
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

    // MARK: - Top

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            // "12 DOCUMENTEN · BIJGEWERKT 14:02" above the title (the frame).
            if let line = DossierCopy.eyebrow(docCount: model.loaded ? model.docs.count : nil,
                                              freshness: model.freshness) {
                Text(ax ? HomeSummary.sentence(line) : line.uppercased())
                    .font(.mono(12, relativeTo: .caption))
                    .tracking(ax ? 0 : 1)
                    .foregroundStyle(Color.inkLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(DossierCopy.title)
                .font(.display(28, relativeTo: .title))
                .foregroundStyle(Color.inkBright)
                .accessibilityAddTraits(.isHeader)
            if let message = model.message {
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

    private var searchField: some View {
        HStack(spacing: 8) {
            // A small glyph at every size (capped): at AX5 a body-sized
            // magnifier took a fifth of the field from the prompt.
            Image(systemName: "magnifyingglass")
                .font(.system(size: 17))
                .dynamicTypeSize(...DynamicTypeSize.xxLarge)
                .foregroundStyle(Color.inkLabel)
                .accessibilityHidden(true)
            // At the accessibility sizes the field grows downward and the
            // prompt is drawn by hand, wrapped (a TextField truncates its own
            // prompt to one line). A return typed in the wrapping field is
            // not a line: `DossierCopy.searchLine` drops it.
            ZStack(alignment: .topLeading) {
                if ax && model.query.isEmpty {
                    // Sizes the field too, so a two-line prompt has its room.
                    Text(DossierCopy.searchPrompt)
                        .font(.display(17, relativeTo: .body))
                        .foregroundStyle(Color.inkLabel)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityHidden(true)
                }
                TextField(ax ? "" : DossierCopy.searchPrompt,
                          text: Binding(get: { model.query }, set: { model.query = DossierCopy.searchLine($0) }),
                          axis: ax ? .vertical : .horizontal)
                    .lineLimit(ax ? 1...4 : 1...1)
                    .accessibilityLabel(DossierCopy.searchPrompt)
                    .font(.display(17, relativeTo: .body))
                    .foregroundStyle(Color.inkBright)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
            }
            if !model.query.isEmpty {
                Button { model.query = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Color.inkLabel)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Wis zoekopdracht")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, ax ? 8 : 0)
        .frame(minHeight: 44)
        .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.chip, style: .continuous).strokeBorder(Color.edgeStrong))
    }

    // MARK: - No query

    @ViewBuilder private var headlineCard: some View {
        if let h = inbox.summary?.headline {
            // The way into the Tijdlijn at what waits: the NU sheet comes up.
            Button { path.append(.timelineNow) } label: {
                TimelineHeadlineCard(title: h.stopTitle, note: h.note,
                                     meta: [h.trackTitle, TimelineHeadlineCard.opens].compactMap { $0 })
            }
            .buttonStyle(.plain)
            .accessibilityHint(HomeSummary.headlineHint)
        } else {
            DossierCard(label: DossierCopy.headlineLabel) { headlineFallback }
        }
    }

    @ViewBuilder private var headlineFallback: some View {
        Group {
            if inbox.summary != nil {
                muted(DossierCopy.noHeadline)
            } else if model.offline {
                muted(DossierCopy.offline)
            } else {
                SkeletonLines(count: 2)
            }
        }
    }

    /// The way into the Tijdlijn, right under the headline it explains.
    private var timelineRow: some View {
        Button { path.append(.timeline) } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(TimelineCopy.rowTitle)
                        .font(.display(17, relativeTo: .body, weight: .medium))
                        .foregroundStyle(Color.inkBright)
                    // The map's own count once it is on the phone.
                    let line = timeline.map.map { TimelineCopy.stats($0).joined(separator: " · ") } ?? TimelineCopy.rowLine
                    Text(typeSize.isAccessibilitySize ? HomeSummary.sentence(line) : line.uppercased())
                        .font(.mono(12, relativeTo: .caption))
                        .tracking(0)
                        .foregroundStyle(Color.inkLabel)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.inkFaint)
                    .accessibilityHidden(true)
            }
            .padding(16)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .glassPanel()
            .contentShape(Rectangle())
            .accessibilityElement(children: .combine)
        }
        .buttonStyle(.plain)
    }

    private var ax: Bool { typeSize.isAccessibilitySize }

    /// OPEN TAKEN as the frame draws it: a grey section header OUTSIDE the
    /// card with the count at its end, the first two tasks (hollow amber
    /// ring, amber "voor jou" lead, the due date relative to now), then
    /// "Alles bekijken (N)", which opens Voor jou.
    @ViewBuilder private var tasksCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(ax ? HomeSummary.sentence(DossierCopy.tasksLabel.lowercased()) : DossierCopy.tasksLabel)
                    .tracking(ax ? 0 : 1)
                Spacer(minLength: 8)
                if let n = model.tasks?.count { Text("\(n)").monospacedDigit() }
            }
            .font(.mono(12, relativeTo: .caption, weight: .medium))
            .foregroundStyle(Color.inkLabel)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 12) {
                if let tasks = model.tasks {
                    if tasks.isEmpty {
                        muted(DossierCopy.noTasks)
                    } else {
                        let shown = tasks.prefix(DossierCopy.tasksShown)
                        ForEach(Array(shown.enumerated()), id: \.element.id) { i, task in
                            if i > 0 { Hairline() }
                            Button { path.append(.task(task.id)) } label: { taskRow(task) }
                                .buttonStyle(.plain)
                        }
                        Hairline()
                        Button(action: openVoorJou) { seeAllRow(tasks.count) }
                            .buttonStyle(.plain)
                    }
                } else if model.offline {
                    muted(DossierCopy.tasksOffline)
                } else {
                    SkeletonLines(count: 3)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassPanel()
        }
    }

    private func taskRow(_ t: TaskDTO) -> some View {
        let line = DossierCopy.taskLine(dueAt: t.dueAt, now: model.now())
        return HStack(alignment: .center, spacing: 12) {
            Circle().strokeBorder(Color.attn, lineWidth: 2).frame(width: 9, height: 9)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(t.title)
                    .font(.display(17, relativeTo: .body))
                    .foregroundStyle(Color.inkBright)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Text(Self.leadThenRest(line.lead, line.rest, ax: ax))
                    .font(.mono(12, relativeTo: .caption))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            chevron
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func seeAllRow(_ n: Int) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(DossierCopy.seeAllTasks(n))
                    .font(.display(17, relativeTo: .body, weight: .medium))
                    .foregroundStyle(Color.signal)
                Text(ax ? HomeSummary.sentence(DossierCopy.seeAllTasksLine) : DossierCopy.seeAllTasksLine.uppercased())
                    .font(.mono(12, relativeTo: .caption))
                    .tracking(ax ? 0 : 1)
                    .foregroundStyle(Color.inkLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            chevron
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Color.inkFaint)
            .accessibilityHidden(true)
    }

    /// "VOOR JOU" in amber, " · MORGEN 17:00" in the label colour; sentence
    /// case at the accessibility sizes.
    static func leadThenRest(_ lead: String, _ rest: String?, ax: Bool) -> AttributedString {
        func cased(_ s: String) -> String { ax ? s : s.uppercased() }
        var a = AttributedString(cased(ax ? HomeSummary.sentence(lead) : lead))
        a.foregroundColor = Color.attn
        guard let rest else { return a }
        var b = AttributedString(" · " + cased(rest))
        b.foregroundColor = Color.inkLabel
        return a + b
    }

    @ViewBuilder private var documentsCard: some View {
        DossierCard(label: DossierCopy.documentsLabel, count: model.loaded ? model.docs.count : nil) {
            if !model.loaded || (model.docs.isEmpty && model.isSyncing && model.syncedAt == nil) {
                SkeletonLines(count: 5)
            } else if model.docs.isEmpty {
                muted(DossierCopy.noDocuments)
            } else {
                documentRows(model.docs)
            }
        }
    }

    private func documentRows(_ docs: [IndexedDoc], query: String = "") -> some View {
        ForEach(Array(docs.enumerated()), id: \.element.id) { i, d in
            if i > 0 { Hairline() }
            Button { path.append(.document(id: d.id, title: d.doc.title)) } label: {
                DossierRow(title: d.doc.title, line: DossierCopy.rowLine(d.doc),
                           snippet: query.isEmpty ? nil : DossierSearch.snippet(d, query: query))
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Searching

    @ViewBuilder private var localResults: some View {
        let hits = model.results
        DossierCard(label: DossierCopy.documentsLabel, count: hits.count) {
            if hits.isEmpty {
                muted(DossierCopy.noLocalHits)
            } else {
                documentRows(hits, query: model.query)
            }
        }
    }

    @ViewBuilder private var serverResults: some View {
        switch model.server {
        case .idle:
            VStack(alignment: .leading, spacing: 8) {
                Button { Task { await model.searchServer() } } label: {
                    Label(DossierCopy.searchServer, systemImage: "network")
                        .font(.display(17, relativeTo: .body))
                        .foregroundStyle(model.offline ? Color.inkLabel : Color.signal)
                        .frame(minHeight: 44)
                }
                .buttonStyle(.plain)
                .disabled(model.offline)
                if model.offline { muted(DossierCopy.serverNeedsNetwork) }
            }
        case .loading:
            DossierCard(label: DossierCopy.serverLabel) { SkeletonLines(count: 3) }
        case .failed(let message):
            DossierCard(label: DossierCopy.serverLabel) {
                muted(message)
                Button(DossierCopy.retry) { Task { await model.searchServer() } }
                    .font(.display(17, relativeTo: .body))
                    .foregroundStyle(Color.signal)
                    .frame(minHeight: 44)
            }
        case .done(_, let hits):
            DossierCard(label: DossierCopy.serverLabel, count: hits.count) {
                if hits.isEmpty {
                    muted(DossierCopy.noServerHits)
                } else {
                    ForEach(Array(hits.enumerated()), id: \.element.id) { i, hit in
                        if i > 0 { Hairline() }
                        serverRow(hit)
                    }
                }
            }
        }
    }

    @ViewBuilder private func serverRow(_ hit: SearchHit) -> some View {
        let row = DossierRow(title: hit.title, line: serverLine(hit), marked: hit.snippet.map(SearchSnippet.segments))
        switch hit.link.map(DeepLink.parse) {
        case .document(let id)?:
            Button { path.append(.document(id: id.uuidString.lowercased(), title: hit.title)) } label: { row }
                .buttonStyle(.plain)
        case .task(let id)?:
            Button { path.append(.task(id.uuidString.lowercased())) } label: { row }
                .buttonStyle(.plain)
        default:
            row
        }
    }

    private func serverLine(_ hit: SearchHit) -> String {
        let kind = switch hit.entityType {
        case "document": "document"
        case "task": "taak"
        case "entry": "logboek"
        default: hit.entityType
        }
        let day = hit.occurredAt.flatMap(parseISODate).map(DossierCopy.day)
        return [kind, day].compactMap { $0 }.joined(separator: " · ")
    }

    private func muted(_ text: String) -> some View {
        Text(text)
            .font(.display(15, relativeTo: .subheadline))
            .foregroundStyle(Color.inkMute)
            .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - Pieces

/// The tab's one card: a mono label (with a count when there is one), then
/// the content, on the glass panel.
struct DossierCard<Content: View>: View {
    let label: String
    var count: Int? = nil
    var amber = false
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text(label)
                if let count { Text("\(count)").monospacedDigit() }
            }
            .font(.mono(12, relativeTo: .caption, weight: .medium))
            .foregroundStyle(amber ? Color.attn : Color.inkLabel)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
    }
}

/// The tab's one row: a title (two lines, then tail truncation), a mono
/// readout line, and — for a search hit — a line of the text around the match.
struct DossierRow: View {
    let title: String
    let line: String
    var snippet: String? = nil
    var marked: [SearchSnippet.Segment]? = nil
    /// A task waiting on Martin: the amber dot, always with the words in `line`.
    var amber = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if amber {
                Circle().fill(Color.attn).frame(width: 8, height: 8).padding(.top, 8)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.display(17, relativeTo: .body))
                    .foregroundStyle(Color.inkBright)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(line)
                    .font(.mono(12, relativeTo: .caption))
                    .foregroundStyle(Color.inkLabel)
                if let snippet {
                    Text(snippet)
                        .font(.display(15, relativeTo: .subheadline))
                        .foregroundStyle(Color.inkMute)
                        .lineLimit(2)
                } else if let marked, !marked.isEmpty {
                    Text(Self.attributed(marked))
                        .font(.display(15, relativeTo: .subheadline))
                        .foregroundStyle(Color.inkMute)
                        .lineLimit(3)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    static func attributed(_ parts: [SearchSnippet.Segment]) -> AttributedString {
        parts.reduce(into: AttributedString()) { out, part in
            var piece = AttributedString(part.text)
            if part.marked { piece.foregroundColor = .inkBright }
            out += piece
        }
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
