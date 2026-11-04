import SwiftUI
import UIKit
import Observation

/// A task from Voor jou or the dossier (Figma "detail · final", Taak): what it
/// is, by when, the status as a segmented control, and what it is linked to.
///
/// THE CONTROL OFFERS ONLY `validNext`, the server's answer from the same edge
/// matrix `tasks.setStatus` enforces; the phone never offers an override, and
/// the route refuses an `overrideReason` outright. A segment not on that list
/// is drawn but cannot be chosen ("open" never comes back once left), and a
/// status not on it is never sent. A FINAL step (gedaan, laten vallen) asks
/// first: neither can be undone on the server.
@MainActor
@Observable
final class TaskModel {
    enum Copy {
        static let gone = "Deze taak bestaat niet (meer)."
        static let refused = "Die stap kan niet (meer). De taak is bijgewerkt."
        static let offline = "Je bent offline. De status wijzigen kan weer zodra je verbinding hebt."
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

    /// The segmented control's one-word names (the final frames).
    static func segmentLabel(_ status: String) -> String {
        switch status {
        case "in-progress": "bezig"
        case "waiting": "wacht"
        case "done": "gedaan"
        default: label(status)
        }
    }

    /// The four segments, in the order the frames draw them. "Laten vallen"
    /// lives in the ⋯ menu.
    static let segments = ["open", "in-progress", "waiting", "done"]

    struct Choice: Identifiable, Equatable {
        let status: String
        let label: String
        var id: String { status }
    }

    private(set) var task: TaskDTO?
    private(set) var isBusy = false
    private(set) var message: String?
    private(set) var loadError: String?
    /// The status whose save never reached the server: the "NIET OPGESLAGEN"
    /// card and its "Opnieuw: zet op …" button.
    private(set) var failedStatus: String?
    /// When the copy on screen was loaded (the offline readout).
    private(set) var loadedAt: Date?
    /// A final step (gedaan, laten vallen) Martin confirmed, HELD on the
    /// phone for its undo window before it is posted — the list's own rule
    /// (`InboxDecisions`): "Ongedaan maken" inside the window means nothing
    /// was ever recorded, so the server's "final" stays true.
    private(set) var held: String?
    /// Haptic triggers (brief §2.5).
    private(set) var successes = 0
    private(set) var errors = 0

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let sleep: @Sendable (TimeInterval) async throws -> Void
    @ObservationIgnored private var holdTimer: Task<Void, Never>?
    @ObservationIgnored private let onCommitted: @MainActor () async -> Void

    init(client: APIClient, onUnauthorized: @escaping @MainActor () -> Void = {},
         now: @escaping @Sendable () -> Date = { Date() },
         sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) },
         onCommitted: @escaping @MainActor () async -> Void = {}) {
        self.client = client
        self.onUnauthorized = onUnauthorized
        self.now = now
        self.sleep = sleep
        self.onCommitted = onCommitted
    }

    /// The status the screen draws: the held step while it is held.
    var shownStatus: String? { held ?? task?.status }

    /// Holds a confirmed final step for `window` seconds, then posts it.
    func hold(_ status: String, window: TimeInterval) {
        guard let t = task, !isBusy, t.validNext.contains(status), Self.isFinal(status) else { return }
        holdTimer?.cancel()
        held = status
        failedStatus = nil
        message = nil
        let sleep = sleep
        holdTimer = Task { [weak self] in
            do { try await sleep(window) } catch { return }
            await self?.commitHeld()
        }
    }

    /// "Ongedaan maken": nothing was posted, so nothing is recorded.
    func undoHeld() {
        holdTimer?.cancel()
        holdTimer = nil
        held = nil
    }

    /// Posts the held step now (the window ran out, or the screen is leaving).
    func commitHeld() async {
        guard let status = held else { return }
        holdTimer?.cancel()
        holdTimer = nil
        held = nil
        if await setStatus(status) { await onCommitted() }
    }

    /// "Taak gedaan" in the undo row.
    var heldText: String? {
        switch held {
        case "done": "Taak gedaan"
        case "dropped": "Taak laten vallen"
        default: nil
        }
    }

    /// There is no single-task route: the list carries each task's effective
    /// status and `validNext`, which is everything this screen needs.
    func load(id: String) async {
        do {
            let all: [TaskDTO] = try await client.getJSON("/api/mobile/v1/tasks")
            task = all.first { $0.id == id }
            loadError = task == nil ? Copy.gone : nil
            loadedAt = now()
        } catch {
            loadError = handle(error)
        }
    }

    var choices: [Choice] {
        (task?.validNext ?? []).map { Choice(status: $0, label: Self.label($0)) }
    }

    /// Waits on Martin by the one definition (`WAITING_TASK_STATUSES`).
    var waitsOnMartin: Bool { shownStatus == "open" || shownStatus == "in-progress" }

    /// A segment may be chosen when the server offers it; the current one is
    /// drawn selected.
    /// While a step is held, the status it left is a choice too: picking it
    /// (or any other) takes the held step back first.
    func segmentEnabled(_ status: String) -> Bool {
        if held != nil, status == task?.status { return true }
        return task?.validNext.contains(status) == true
    }

    /// Gedaan and laten vallen are final in `TASK_EDGES`: they ask first.
    static func isFinal(_ status: String) -> Bool { status == "done" || status == "dropped" }

    /// The badge: amber only while it waits on Martin.
    var badge: (text: String, tone: DetailBadge.Tone)? {
        switch shownStatus {
        case "open", "in-progress": ("Wacht op jou", .waiting)
        case "waiting": ("Wacht op ander", .neutral)
        case "done": ("Gedaan", .okay)
        case "dropped": ("Laten vallen", .neutral)
        default: nil
        }
    }

    /// "bezig" beside the badge of a task Martin is working on.
    var badgeNote: String? { shownStatus == "in-progress" ? "bezig" : nil }

    /// The one line under the control: what the current status means.
    func explanation(offline: Bool) -> String {
        if offline, task.map({ !$0.validNext.isEmpty }) == true { return Copy.offline }
        // Inside the undo window another status really can still be chosen.
        if held == "done" { return "Gedaan. Vergist? Kies een andere status." }
        if held == "dropped" { return "Laten vallen. Vergist? Kies een andere status." }
        switch task?.status {
        case "open": return "Open: dit wacht op jou. Wacht: je wacht op iemand anders; de taak staat dan niet in Voor jou."
        case "in-progress": return "Bezig: je bent ermee bezig; het blijft in Voor jou staan."
        case "waiting": return "Je wacht op een reactie. Deze taak staat nu niet in Voor jou."
        case "done": return "Gedaan. Deze taak staat niet meer in Voor jou."
        case "dropped": return "Laten vallen. Deze taak staat niet meer in Voor jou."
        default: return ""
        }
    }

    /// "Gedaan is niet opgeslagen: je telefoon kreeg geen antwoord van Grip.
    /// De status staat nog op open."
    var failureText: String? {
        guard let failedStatus, let t = task else { return nil }
        return "\(DetailText.capitalised(Self.segmentLabel(failedStatus))) is niet opgeslagen: je telefoon kreeg geen antwoord van Grip. De status staat nog op \(Self.segmentLabel(t.status))."
    }

    /// "Opnieuw: zet op gedaan".
    var retryLabel: String? { failedStatus.map { "Opnieuw: zet op \(Self.segmentLabel($0))" } }

    /// The confirmation a final step asks.
    static func confirmTitle(_ status: String) -> String {
        status == "done" ? "Taak op gedaan zetten?" : "Taak laten vallen?"
    }

    static let confirmText = "Je kunt het nog even ongedaan maken; daarna kan het niet meer terug: de taak verlaat Voor jou, en Grip legt de stap vast."

    func setStatus(_ status: String) async -> Bool {
        guard let t = task, !isBusy, t.validNext.contains(status) else { return false }
        isBusy = true
        defer { isBusy = false }
        message = nil
        do {
            let r: TaskStatusResponse = try await client.postJSON("/api/mobile/v1/tasks/\(t.id)/status",
                                                                  TaskStatusRequest(status: status))
            task = TaskDTO(id: t.id, title: t.title, details: t.details, dueAt: t.dueAt,
                           status: r.status, assigneeName: t.assigneeName, validNext: r.validNext, links: t.links)
            failedStatus = nil
            successes += 1
            return true
        } catch APIError.rejected(400) {
            await load(id: t.id)
            message = Copy.refused
            failedStatus = nil
            errors += 1
            return false
        } catch APIError.unauthorized {
            message = handle(APIError.unauthorized)
            return false
        } catch APIError.rejected(404) {
            message = Copy.gone
            errors += 1
            return false
        } catch {
            // Nothing reached the ledger: the step is simply not taken, and
            // the card offers it again by name.
            failedStatus = status
            errors += 1
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
    var now: @Sendable () -> Date = { Date() }

    @State private var model: TaskModel?
    @State private var confirming: String?
    @State private var fixtureApplied = false
    @Environment(\.networkOffline) private var offline
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.voorJouNext) private var next
    @Environment(\.scenePhase) private var scenePhase

    private var ax: Bool { typeSize.isAccessibilitySize }

    var body: some View {
        DetailScaffold(navTitle: "Taak") {
            if let model, let task = model.task {
                content(model, task)
            } else if let error = model?.loadError {
                DetailPara(error).padding(.top, 24)
            } else {
                ProposalSkeleton()
            }
        } dock: {
            if let model, let text = model.heldText {
                DetailDock {
                    DetailUndoRow(text: text) { model.undoHeld() }
                    if next != nil { NextInVoorJouButton(id: id) }
                }
            } else if let model, model.task.map({ TaskModel.isFinal($0.status) }) == true, next != nil {
                DetailDock { NextInVoorJouButton(id: id) }
            }
        } menu: {
            if model?.segmentEnabled("dropped") == true, !offline {
                Button("Laten vallen…", systemImage: "xmark.circle") { confirming = "dropped" }
            }
            if let t = model?.task {
                Button("Kopieer tekst", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = [t.title, t.details].compactMap { $0 }.joined(separator: "\n\n")
                }
            }
        }
        .task {
            if model == nil {
                let refresh = next?.refresh
                let m = TaskModel(client: client, onUnauthorized: onUnauthorized, now: now,
                                  onCommitted: { await refresh?() })
                model = m
                await m.load(id: id)
                await applyFixture(m)
            }
        }
        .sensoryFeedback(.success, trigger: model?.successes ?? 0)
        .sensoryFeedback(.error, trigger: model?.errors ?? 0)
        // Leaving posts what is held: a step is never lost to a gone screen.
        .onDisappear { if let model { Task { await model.commitHeld() } } }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active, let model { Task { await model.commitHeld() } }
        }
        .confirmationDialog(confirming.map(TaskModel.confirmTitle) ?? "", isPresented: Binding(
            get: { confirming != nil }, set: { if !$0 { confirming = nil } }
        ), titleVisibility: .visible) {
            if let status = confirming {
                Button(status == "done" ? "Zet op gedaan" : "Laten vallen", role: status == "dropped" ? .destructive : nil) {
                    Task { await choose(status, confirmed: true) }
                }
            }
            Button("Annuleren", role: .cancel) { confirming = nil }
        } message: {
            Text(TaskModel.confirmText)
        }
    }

    private func choose(_ status: String, confirmed: Bool = false) async {
        guard let model else { return }
        // Another choice inside the undo window takes the held step back.
        if model.held != nil {
            model.undoHeld()
            if status == model.task?.status { return }
        }
        if TaskModel.isFinal(status) && !confirmed { confirming = status; return }
        confirming = nil
        if TaskModel.isFinal(status) {
            model.hold(status, window: ax ? InboxDecisions.accessibilityWindow : InboxDecisions.window)
            return
        }
        if await model.setStatus(status) { await next?.refresh() }
    }

    @ViewBuilder
    private func content(_ model: TaskModel, _ task: TaskDTO) -> some View {
        DetailHeader(eyebrow: ["Taak", "uit je dossier"], title: task.title,
                     offlineStamp: offline ? model.loadedAt.map { DetailText.offlineStamp(loadedAt: $0, now: now()) } : nil,
                     badges: model.badge.map { [($0.text, $0.tone)] } ?? [],
                     note: model.badgeNote)
        if let failure = model.failureText {
            DetailNotice(label: "Niet opgeslagen", text: failure).padding(.top, 24)
        }
        if let message = model.message {
            DetailPara(message, size: 15).padding(.top, 16)
        }
        VStack(alignment: .leading, spacing: 12) {
            DetailLabel("Status").padding(.horizontal, 16).id(DetailSpace.middle)
            if ax { statusList(model, task) } else { statusSegments(model, task) }
            DetailPara(model.explanation(offline: offline), color: .inkMute, size: 15).padding(.horizontal, 16)
            if let retry = model.retryLabel, let status = model.failedStatus {
                AuthButton(title: retry, enabled: !model.isBusy && !offline) {
                    Task { await choose(status, confirmed: true) }
                }
                .padding(.top, 8)
            }
        }
        .padding(.top, 24)
        if let due = task.dueAt {
            DetailCard("Uiterlijk op") {
                VStack(alignment: .leading, spacing: 4) {
                    Text(DetailText.longDateTime(due))
                        .font(.mono(18, relativeTo: .title3))
                        .foregroundStyle(Color.inkBright)
                        .fixedSize(horizontal: false, vertical: true)
                    if !TaskModel.isFinal(model.shownStatus ?? task.status) {
                        DetailPara(DetailText.relativeDue(due, now: now()), color: .inkMute, size: 15)
                    }
                }
            }
            .padding(.top, 24)
        }
        if let who = task.assigneeName {
            DetailCard("Bij") { DetailPara(who) }.padding(.top, 16)
        }
        if let details = task.details, !details.isEmpty {
            DetailCard("Toelichting") { DetailPara(details) }.padding(.top, 16)
        }
        if let links = task.links, !links.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                DetailSectionLabel(text: "Gekoppeld", count: links.count).padding(.bottom, 2)
                ForEach(links) { link in
                    DetailRow(title: link.title, meta: link.meta, dot: .signal,
                              route: link.type == "document" ? .document(id: link.id, title: link.title) : nil)
                }
            }
            .padding(.top, 32)
        }
    }

    /// "open · bezig · wacht · gedaan": the current one framed, the ones the
    /// server does not offer dimmed and inert.
    private func statusSegments(_ model: TaskModel, _ task: TaskDTO) -> some View {
        HStack(spacing: 4) {
            ForEach(TaskModel.segments, id: \.self) { status in
                let current = model.shownStatus == status
                let enabled = model.segmentEnabled(status) && !offline && !model.isBusy
                Button { Task { await choose(status) } } label: {
                    Text(TaskModel.segmentLabel(status))
                        .font(.display(17, relativeTo: .body, weight: current ? .semibold : .regular))
                        .foregroundStyle(current ? Color.inkBright : Color.inkMute)
                        .lineLimit(1)
                        .minimumScaleFactor(0.9)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background {
                            if current {
                                RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.plate)
                                    .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous)
                                        .strokeBorder(Color.steelDim.opacity(0.7), lineWidth: 1.5))
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(AuthPressStyle())
                .disabled(!enabled || current)
                // Every unselected segment in the same ink (the frames): a
                // step the server does not offer simply does nothing, and
                // says so to VoiceOver; only offline dims the control.
                .opacity(offline && !current ? 0.55 : 1)
                .accessibilityHint(model.segmentEnabled(status) || current ? "" : "Deze stap kan niet (meer).")
                .accessibilityLabel(TaskModel.label(status))
                .accessibilityAddTraits(current ? .isSelected : [])
            }
        }
        .padding(4)
        .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.panel))
        .overlay(RoundedRectangle(cornerRadius: Radius.panel).strokeBorder(Color.edge, lineWidth: 1))
    }

    /// At the accessibility sizes the four words do not fit beside each
    /// other: one row each, a check at the current one.
    private func statusList(_ model: TaskModel, _ task: TaskDTO) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(TaskModel.segments, id: \.self) { status in
                let current = model.shownStatus == status
                Button { Task { await choose(status) } } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 16) {
                        Image(systemName: "checkmark")
                            .font(.system(size: 22, weight: .regular))
                            .foregroundStyle(Color.signal)
                            .opacity(current ? 1 : 0)
                            .accessibilityHidden(true)
                        Text(TaskModel.segmentLabel(status))
                            .wholeWords(TaskModel.segmentLabel(status),
                                        font: .display(17, relativeTo: .body, weight: current ? .semibold : .regular))
                            .foregroundStyle(current ? Color.inkBright : Color.inkMute)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(AuthPressStyle())
                .disabled(!model.segmentEnabled(status) || offline || model.isBusy || current)
                .opacity(offline && !current ? 0.55 : 1)
                .accessibilityHint(model.segmentEnabled(status) || current ? "" : "Deze stap kan niet (meer).")
                .accessibilityLabel(TaskModel.label(status))
                .accessibilityAddTraits(current ? .isSelected : [])
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
    }

    private func applyFixture(_ model: TaskModel) async {
        #if DEBUG
        guard let launch = FixtureLaunch.current, !fixtureApplied else { return }
        fixtureApplied = true
        if launch.detail == .fout { _ = await model.setStatus("done") }
        // Just set to gedaan: the undo row up, its window frozen open.
        if launch.detail == .gedaan { model.hold("done", window: 3600) }
        #endif
    }
}
