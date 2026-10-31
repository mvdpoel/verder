import SwiftUI
import Observation

/// The proposals in Voor jou: pending ones first, then sends in flight and
/// recent failures (the server's order, `proposals.list`). Plan 3 replaces this
/// with the full ranked inbox; until then it is the whole tab.
///
/// AMBER MARKS PENDING PROPOSALS ONLY — they are what waits on Martin. A send
/// in flight or a failure waits on verder, and reads in ink.
@MainActor
@Observable
final class ProposalListModel {
    private(set) var items: [ProposalSummary] = []
    private(set) var loaded = false
    private(set) var message: String?

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void

    init(client: APIClient, onUnauthorized: @escaping @MainActor () -> Void = {}) {
        self.client = client
        self.onUnauthorized = onUnauthorized
    }

    func refresh() async {
        do {
            let list: ProposalList = try await client.getJSON("/api/mobile/v1/proposals")
            items = list.proposals
            message = nil
        } catch APIError.unauthorized {
            onUnauthorized()
            message = "Log opnieuw in."
        } catch APIError.transport {
            message = ProposalModel.Copy.offline
        } catch {
            message = ProposalModel.Copy.failed
        }
        loaded = true
    }
}

struct ProposalListView: View {
    let client: APIClient
    let gate: ApprovalGate
    @Binding var path: [String]
    let onUnauthorized: @MainActor () -> Void

    @State private var model: ProposalListModel?

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
                }
                .refreshable { await model?.refresh() }
            }
            .navigationDestination(for: String.self) { id in
                ProposalScreen(id: id, client: client, gate: gate, onUnauthorized: onUnauthorized)
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .preferredColorScheme(.dark)
        .task {
            if model == nil { model = ProposalListModel(client: client, onUnauthorized: onUnauthorized) }
            await model?.refresh()
        }
        // Back from a proposal: what was decided there has moved on the list.
        .onChange(of: path) { _, now in
            if now.isEmpty { Task { await model?.refresh() } }
        }
    }

    @ViewBuilder private var content: some View {
        if let message = model?.message {
            Text(message)
                .font(.display(14, relativeTo: .callout, weight: .light))
                .foregroundStyle(Color.ink)
        }
        if let model, model.loaded, model.items.isEmpty, model.message == nil {
            Text("Er wacht niets op je.")
                .font(.display(14, relativeTo: .callout, weight: .light))
                .foregroundStyle(Color.inkMute)
        }
        ForEach(model?.items ?? []) { item in
            Button { path.append(item.id) } label: { row(item) }
                .buttonStyle(.plain)
        }
    }

    private func row(_ item: ProposalSummary) -> some View {
        let waiting = item.status == "pending"
        return HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(waiting ? Color.attn : Color.inkFaint)
                .frame(width: 8, height: 8)
                .glow(waiting ? Glow.attn : Glow.Shadow(color: .clear, radius: 0, y: 0))
                .padding(.top, 7)
            VStack(alignment: .leading, spacing: 5) {
                Text(item.ask ?? "Voorstel")
                    .font(.display(16, relativeTo: .body, weight: .regular))
                    .foregroundStyle(Color.inkBright)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Text(ProposalFormat.kind(item.kind))
                    if let party = item.partyName { Text(party) }
                    if let at = item.triggerAt { Text(ProposalFormat.dateTime(at)) }
                }
                .font(.mono(11, relativeTo: .caption2))
                .foregroundStyle(Color.inkDim)
                Text(ProposalFormat.status(item.status))
                    .font(.mono(11, relativeTo: .caption2, weight: .medium))
                    .foregroundStyle(waiting ? Color.attn : Color.inkMute)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
        .contentShape(Rectangle())
    }
}
