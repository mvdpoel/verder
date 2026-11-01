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
    let lock: AppLock
    let client: APIClient
    @Binding var path: [DossierRoute]
    let onUnauthorized: @MainActor () -> Void
    @Environment(\.scenePhase) private var scenePhase

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
                }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .preferredColorScheme(.dark)
        .task {
            await model.loadCached()
            if inbox.summary == nil { await inbox.refresh() }
            await refresh()
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
            Text(DossierCopy.title)
                .font(.display(28, relativeTo: .title))
                .foregroundStyle(Color.inkBright)
                .accessibilityAddTraits(.isHeader)
            if let line = model.freshness {
                Text(line)
                    .font(.mono(12, relativeTo: .caption))
                    .foregroundStyle(Color.inkLabel)
            }
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
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Color.inkLabel)
                .accessibilityHidden(true)
            TextField(DossierCopy.searchPrompt, text: Binding(get: { model.query }, set: { model.query = $0 }))
                .font(.display(17, relativeTo: .body))
                .foregroundStyle(Color.inkBright)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
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
        .frame(minHeight: 44)
        .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.chip, style: .continuous).strokeBorder(Color.edgeStrong))
    }

    // MARK: - No query

    @ViewBuilder private var headlineCard: some View {
        DossierCard(label: DossierCopy.headlineLabel) {
            if let h = inbox.summary?.headline {
                VStack(alignment: .leading, spacing: 4) {
                    Text(h.stopTitle)
                        .font(.display(17, relativeTo: .headline, weight: .medium))
                        .foregroundStyle(Color.inkBright)
                        .fixedSize(horizontal: false, vertical: true)
                    let line = [h.trackTitle, h.happenedAt.map(HomeSummary.day)].compactMap { $0 }
                    if !line.isEmpty {
                        Text(line.joined(separator: " · "))
                            .font(.mono(12, relativeTo: .caption))
                            .foregroundStyle(Color.inkLabel)
                    }
                    if let note = h.note, !note.isEmpty {
                        Text(note)
                            .font(.display(15, relativeTo: .subheadline))
                            .foregroundStyle(Color.ink)
                            .lineLimit(4)
                    }
                }
            } else if inbox.summary != nil {
                muted(DossierCopy.noHeadline)
            } else if model.offline {
                muted(DossierCopy.offline)
            } else {
                SkeletonLines(count: 2)
            }
        }
    }

    @ViewBuilder private var tasksCard: some View {
        DossierCard(label: DossierCopy.tasksLabel, count: model.tasks?.count, amber: !(model.tasks ?? []).isEmpty) {
            if let tasks = model.tasks {
                if tasks.isEmpty {
                    muted(DossierCopy.noTasks)
                } else {
                    ForEach(Array(tasks.enumerated()), id: \.element.id) { i, task in
                        if i > 0 { Hairline() }
                        Button { path.append(.task(task.id)) } label: {
                            DossierRow(title: task.title, line: taskLine(task), amber: true)
                        }
                        .buttonStyle(.plain)
                    }
                }
            } else if model.offline {
                muted(DossierCopy.tasksOffline)
            } else {
                SkeletonLines(count: 3)
            }
        }
    }

    private func taskLine(_ t: TaskDTO) -> String {
        (["wacht op jou", TaskModel.label(t.status)] + [t.dueAt.map { "uiterlijk \(HomeSummary.day($0))" }])
            .compactMap { $0 }.joined(separator: " · ")
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

private struct Hairline: View {
    var body: some View { Rectangle().fill(Color.hairline).frame(height: 1) }
}

/// The loading state in the shape of rows, never a spinner (brief §2.1).
private struct SkeletonLines: View {
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
