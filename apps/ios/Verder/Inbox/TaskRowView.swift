import SwiftUI
import Observation

/// A task from Voor jou: what it is, by when, and the statuses it may move to.
///
/// THE PICKER OFFERS ONLY `validNext`, the server's answer from the same edge
/// matrix `tasks.setStatus` enforces; the phone never offers an override, and
/// the route refuses an `overrideReason` outright. A status not on that list
/// is never sent.
@MainActor
@Observable
final class TaskModel {
    enum Copy {
        static let gone = "Deze taak bestaat niet (meer)."
        static let refused = "Die stap kan niet (meer). De taak is bijgewerkt."
    }

    /// The task's statuses in Dutch, the words `/tasks` uses
    /// (apps/web/src/components/task-list.tsx `TASK_STATUS_LABEL`).
    static func label(_ status: String) -> String {
        switch status {
        case "open": "open"
        case "in-progress": "mee bezig"
        case "waiting": "wacht op iemand"
        case "done": "klaar"
        case "dropped": "laten vallen"
        default: status
        }
    }

    struct Choice: Identifiable, Equatable {
        let status: String
        let label: String
        var id: String { status }
    }

    private(set) var task: TaskDTO?
    private(set) var isBusy = false
    private(set) var message: String?
    private(set) var loadError: String?

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void

    init(client: APIClient, onUnauthorized: @escaping @MainActor () -> Void = {}) {
        self.client = client
        self.onUnauthorized = onUnauthorized
    }

    /// There is no single-task route: the list carries each task's effective
    /// status and `validNext`, which is everything this screen needs.
    func load(id: String) async {
        do {
            let all: [TaskDTO] = try await client.getJSON("/api/mobile/v1/tasks")
            task = all.first { $0.id == id }
            loadError = task == nil ? Copy.gone : nil
        } catch {
            loadError = handle(error)
        }
    }

    var choices: [Choice] {
        (task?.validNext ?? []).map { Choice(status: $0, label: Self.label($0)) }
    }

    /// Waits on Martin by the one definition (`WAITING_TASK_STATUSES`).
    var waitsOnMartin: Bool { task?.status == "open" || task?.status == "in-progress" }

    func setStatus(_ status: String) async -> Bool {
        guard let t = task, !isBusy, t.validNext.contains(status) else { return false }
        isBusy = true
        defer { isBusy = false }
        message = nil
        do {
            let r: TaskStatusResponse = try await client.postJSON("/api/mobile/v1/tasks/\(t.id)/status",
                                                                  TaskStatusRequest(status: status))
            task = TaskDTO(id: t.id, title: t.title, details: t.details, dueAt: t.dueAt,
                           status: r.status, assigneeName: t.assigneeName, validNext: r.validNext)
            return true
        } catch APIError.rejected(400) {
            await load(id: t.id)
            message = Copy.refused
            return false
        } catch {
            message = handle(error)
            return false
        }
    }

    private func handle(_ error: any Error) -> String {
        switch error as? APIError {
        case .unauthorized?:
            onUnauthorized()
            return "Log opnieuw in."
        case .transport?: return ProposalModel.Copy.offline
        case .rejected(404)?: return Copy.gone
        default: return ProposalModel.Copy.failed
        }
    }
}

/// `POST /tasks/:id/status`. Only the status: never a task id (the path names
/// it), never an override reason.
struct TaskStatusRequest: Encodable, Sendable {
    let status: String
}

struct TaskStatusResponse: Decodable, Sendable {
    let taskId: String
    let status: String
    let validNext: [String]
}

struct TaskScreen: View {
    let id: String
    let client: APIClient
    let onUnauthorized: @MainActor () -> Void

    @State private var model: TaskModel?
    @State private var pending: TaskModel.Choice?

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if let model, let task = model.task {
                        content(model, task)
                    } else if let error = model?.loadError {
                        Text(error).font(.display(14, relativeTo: .callout, weight: .light)).foregroundStyle(Color.ink)
                    } else {
                        ProgressView().tint(Color.signal)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 26)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .preferredColorScheme(.dark)
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                let m = TaskModel(client: client, onUnauthorized: onUnauthorized)
                model = m
                await m.load(id: id)
            }
        }
        // A status change is ledgered: one tap shows what it does, a second
        // confirms it.
        .confirmationDialog(pending.map { "Status wordt: \($0.label)" } ?? "", isPresented: Binding(
            get: { pending != nil }, set: { if !$0 { pending = nil } }
        ), titleVisibility: .visible) {
            if let choice = pending {
                Button(choice.label) { Task { _ = await model?.setStatus(choice.status); pending = nil } }
            }
            Button("Annuleren", role: .cancel) { pending = nil }
        }
    }

    @ViewBuilder
    private func content(_ model: TaskModel, _ task: TaskDTO) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.waitsOnMartin {
                Text("WACHT OP JOU")
                    .font(.mono(11, relativeTo: .caption2, weight: .medium))
                    .foregroundStyle(Color.attn)
            }
            Text(task.title)
                .font(.display(22, relativeTo: .title2, weight: .light))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Text("taak · \(TaskModel.label(task.status))")
                if let due = task.dueAt { Text("uiterlijk \(ProposalFormat.dateTime(due))") }
                if let who = task.assigneeName { Text(who) }
            }
            .font(.mono(11, relativeTo: .caption2))
            .foregroundStyle(Color.inkDim)
        }
        if let details = task.details, !details.isEmpty {
            Text(details)
                .font(.display(15, relativeTo: .body, weight: .light))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        if let message = model.message {
            Text(message)
                .font(.display(14, relativeTo: .callout, weight: .light))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        if !model.choices.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("STATUS WIJZIGEN")
                    .font(.mono(11, relativeTo: .caption2, weight: .medium))
                    .foregroundStyle(Color.inkLabel)
                ForEach(model.choices) { choice in
                    AuthButton(title: choice.label, weight: .secondary, enabled: !model.isBusy) { pending = choice }
                }
            }
        }
    }
}
