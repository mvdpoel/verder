import SwiftUI

/// Where a Voor jou row leads. Held as RootView's path (not the tab's), so a
/// deep link that lands on the lock screen survives the lock.
enum InboxRoute: Hashable, Sendable {
    /// A reply, follow-up or question: all three open Plan 2's `ProposalScreen`.
    case proposal(String)
    case suggestion(String)
    case task(String)
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

/// What the list draws, decided outside the view so it is testable.
///
/// THE PHONE NEVER RE-RANKS: rows come in exactly the server's order
/// (`waitingOnMartin` in packages/api/src/waiting.ts). AMBER MEANS WAITING ON
/// MARTIN, and everything in the list proper does by that one definition;
/// "Door verder gedaan" is what verder already did, so it is never amber.
enum VoorJouList {
    static let emptyText = "Niets wacht op je."

    struct Row: Identifiable, Equatable {
        let item: WaitingItem
        let route: InboxRoute?
        let amber: Bool
        var id: String { "\(item.kind.rawValue):\(item.id)" }
    }

    struct DoneRow: Identifiable, Equatable {
        let action: VerderAction
        let amber: Bool
        var id: String { action.id }
    }

    static func rows(_ inbox: InboxDTO) -> [Row] {
        inbox.items.map { Row(item: $0, route: InboxRoute($0), amber: true) }
    }

    static func doneRows(_ inbox: InboxDTO) -> [DoneRow] {
        inbox.doneByVerder.map { DoneRow(action: $0, amber: false) }
    }

    static func kindLabel(_ kind: WaitingKind) -> String {
        KindLabel.dutch(kind.rawValue)
    }
}

/// The Voor jou tab: one ranked list of everything waiting on Martin, read
/// from the app's one `InboxStore` (the same fetch feeds the badge and the
/// widget, so the three cannot disagree).
///
/// Never here: an approve from a row, a send outside `ProposalScreen`'s
/// `ApprovalGate`, or an auto-advance to the next item after a decision.
struct VoorJouTab: View {
    let store: InboxStore
    let client: APIClient
    let gate: ApprovalGate
    @Binding var path: [InboxRoute]
    let onUnauthorized: @MainActor () -> Void

    @State private var done: DoneByVerderModel
    @Environment(CallSession.self) private var call: CallSession?

    init(store: InboxStore, client: APIClient, gate: ApprovalGate, path: Binding<[InboxRoute]>,
         onUnauthorized: @escaping @MainActor () -> Void) {
        self.store = store
        self.client = client
        self.gate = gate
        self._path = path
        self.onUnauthorized = onUnauthorized
        // An undo moves a document back into the inbox, and a refusal means
        // the row is stale: either way the one store refreshes.
        self._done = State(initialValue: DoneByVerderModel(
            client: client, onChanged: { await store.refresh() }, onUnauthorized: onUnauthorized))
    }

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                Color.void.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Voor jou")
                            .font(.display(26, relativeTo: .title, weight: .ultraLight))
                            .foregroundStyle(Color.inkBright)
                        content
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 26)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .refreshable { await store.refresh() }
            }
            .navigationDestination(for: InboxRoute.self) { route in
                switch route {
                case .proposal(let id):
                    ProposalScreen(id: id, client: client, gate: gate, onUnauthorized: onUnauthorized)
                case .suggestion(let id):
                    SuggestionDetailView(id: id, client: client, onUnauthorized: onUnauthorized)
                case .task(let id):
                    TaskScreen(id: id, client: client, onUnauthorized: onUnauthorized)
                case .doneByVerder:
                    DoneByVerderScreen(store: store, model: done)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .preferredColorScheme(.dark)
        .task { await store.refresh() }
        // Back from a screen: what was decided there has moved on the list.
        .onChange(of: path) { _, now in
            if now.isEmpty { Task { await store.refresh() } }
        }
    }

    @ViewBuilder private var content: some View {
        if let error = store.lastError {
            Text(Self.message(error))
                .font(.display(14, relativeTo: .callout, weight: .light))
                .foregroundStyle(Color.ink)
        }
        if let inbox = store.inbox {
            let rows = VoorJouList.rows(inbox)
            if rows.isEmpty {
                Text(VoorJouList.emptyText)
                    .font(.display(14, relativeTo: .callout, weight: .light))
                    .foregroundStyle(Color.inkMute)
            }
            ForEach(rows) { row in
                Group {
                    if let route = row.route {
                        Button { path.append(route) } label: { rowView(row) }
                            .buttonStyle(.plain)
                    } else {
                        rowView(row)
                    }
                }
                .modifier(PrepareCallAction(partyId: row.item.partyId, name: row.item.subtitle, call: call))
            }
            if !inbox.doneByVerder.isEmpty {
                DoneByVerderSection(actions: inbox.doneByVerder, model: done)
            }
        } else if store.lastError == nil {
            ProgressView().tint(Color.signal)
        }
    }

    private func rowView(_ row: VoorJouList.Row) -> some View {
        let item = row.item
        return HStack(alignment: .top, spacing: 12) {
            dot(amber: row.amber)
            VStack(alignment: .leading, spacing: 5) {
                Text(item.title)
                    .font(.display(16, relativeTo: .body, weight: .regular))
                    .foregroundStyle(Color.inkBright)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Text(VoorJouList.kindLabel(item.kind))
                    if let subtitle = item.subtitle { Text(subtitle) }
                    if let due = item.dueAt.flatMap(ProposalFormat.dayMonth) { Text("uiterlijk \(due)") }
                }
                .font(.mono(11, relativeTo: .caption2))
                .foregroundStyle(Color.inkDim)
            }
            Spacer(minLength: 0)
            if row.route != nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.inkFaint)
                    .padding(.top, 5)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
        .contentShape(Rectangle())
    }

    private func dot(amber: Bool) -> some View {
        Circle()
            .fill(amber ? Color.attn : Color.inkFaint)
            .frame(width: 8, height: 8)
            .glow(amber ? Glow.attn : Glow.Shadow(color: .clear, radius: 0, y: 0))
            .padding(.top, 7)
    }

    static func message(_ error: APIError) -> String {
        switch error {
        case .unauthorized: "Log opnieuw in."
        case .transport: ProposalModel.Copy.offline
        default: ProposalModel.Copy.failed
        }
    }
}

/// A Voor jou row about a party offers "Gesprek voorbereiden" on a long
/// press (and as a VoiceOver action); a row with no party offers nothing.
private struct PrepareCallAction: ViewModifier {
    let partyId: String?
    let name: String?
    let call: CallSession?

    func body(content: Content) -> some View {
        if let partyId, let call {
            content
                .contextMenu {
                    Button {
                        Task { await call.open(partyId: partyId, name: name) }
                    } label: {
                        Label(CallCopy.title, systemImage: "phone")
                    }
                }
                .accessibilityAction(named: CallCopy.title) {
                    Task { await call.open(partyId: partyId, name: name) }
                }
        } else {
            content
        }
    }
}
