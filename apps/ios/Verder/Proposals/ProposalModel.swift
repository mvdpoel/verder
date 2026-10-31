import Foundation
import Observation

/// One proposal on the phone: read it, edit the draft, approve, reject, or
/// answer a question (spec §6.4.2–3, §7.2; Plan 2 Task 19).
///
/// NOTHING HERE SENDS MAIL. Approve moves the proposal to `approved`; the
/// worker's send job claims it. What this class guarantees is the phone's half
/// of "Martin approved the FINAL text":
/// - `approve()` sends exactly the draft on screen and the revision it was
///   loaded at, snapshotted BEFORE Face ID, so the sheet approves that text
///   and an edit made while it is up cannot ride along;
/// - Face ID is asked on EVERY send (`ApprovalGate`), and a no sends nothing;
/// - a 409 is never retried: the newer version is loaded and shown, and Martin
///   approves again if he still wants to.
@MainActor
@Observable
final class ProposalModel {
    enum Copy {
        static let newerVersion = "Er is intussen een nieuwere versie. Bekijk hem en verstuur opnieuw."
        static let refused = "verder weigerde dit: een ontvanger of bijlage hoort niet (meer) bij dit voorstel."
        static let notPending = "Dit voorstel is al afgehandeld."
        static let offline = "Geen verbinding met verder. Probeer het opnieuw."
        static let failed = "Dat lukte niet. Probeer het over een moment opnieuw."
        static let unavailableAttachment = "Een bijlage is niet meer beschikbaar. Haal hem weg voordat je verstuurt."
        static let sending = "Wordt verstuurd…"
        static let sent = "Verstuurd."
        static let approved = "Goedgekeurd — wordt zo verstuurd."
        static let senderUnconfirmed = "lijkt van Verder — afzender niet bevestigd"
    }

    enum ApproveOutcome: Equatable {
        case approved
        /// Face ID was cancelled or failed: nothing was sent.
        case cancelled
        /// 409: someone (the worker, another device) moved the proposal on.
        case newerVersion
        /// 400: the server refused a recipient or attachment.
        case refused
        /// Nothing to approve, or the draft cannot be sent as it stands.
        case notReady
        case failed
    }

    private(set) var detail: ProposalDetail?
    /// The editable reply. Nil for a question or before loading.
    private(set) var draft: ReplyDraft?
    private(set) var isBusy = false
    private(set) var message: String?
    private(set) var loadError: String?
    private(set) var taskCreated = false

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let gate: ApprovalGate
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void
    @ObservationIgnored private var id: String?

    init(client: APIClient, gate: ApprovalGate, onUnauthorized: @escaping @MainActor () -> Void = {}) {
        self.client = client
        self.gate = gate
        self.onUnauthorized = onUnauthorized
    }

    private var base: String { "/api/mobile/v1/proposals/\(id ?? "")" }

    // MARK: - Loading

    func load(id: String) async {
        self.id = id.lowercased()
        await reload()
    }

    /// Replaces what is on screen with the server's current version, edits
    /// included: after a reload the screen shows what approve would now act on.
    private func reload() async {
        do {
            let d: ProposalDetail = try await client.getJSON(base)
            apply(d)
            loadError = nil
        } catch {
            loadError = handle(error)
        }
    }

    private func apply(_ d: ProposalDetail) {
        detail = d
        taskCreated = d.createdTaskId != nil
        if let r = d.payload?.reply {
            draft = ReplyDraft(to: r.to, cc: r.cc, subject: r.subject, body: r.body,
                               attachmentDocumentIds: r.attachmentDocumentIds,
                               entrySummary: d.entrySummary ?? d.payload?.entrySummary ?? "")
        } else {
            draft = nil
        }
    }

    // MARK: - What the screen shows

    var status: String? { detail?.status }
    var revision: Int? { detail?.revision }
    var isPending: Bool { detail?.status == "pending" }
    var isSending: Bool { detail?.status == "approved" || detail?.status == "sending" }

    var dueText: String? {
        guard let due = detail?.dueAt, let dm = ProposalFormat.dayMonth(due) else { return nil }
        return "Uiterlijk \(dm)"
    }

    var missing: [String] { detail?.missing ?? [] }
    var showsMissing: Bool { !missing.isEmpty }

    var senderNote: String? { detail?.senderUnconfirmed == true ? Copy.senderUnconfirmed : nil }

    var proposedTaskTitle: String? { detail?.proposedTask?.title }

    var questionPrompt: String? { detail?.payload?.question?.prompt }
    var optionButtons: [ProposalDetail.Option] { detail?.options ?? [] }

    /// The draft's attachments in order, each with what the server knows of it.
    /// An id the server could not resolve is shown unavailable, never hidden.
    var attachmentRows: [ProposalDetail.Attachment] {
        guard let draft else { return [] }
        let known = Dictionary((detail?.attachments ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let offered = Dictionary((detail?.attachable ?? []).map { ($0.id, $0.title) }, uniquingKeysWith: { a, _ in a })
        return draft.attachmentDocumentIds.map { id in
            known[id] ?? ProposalDetail.Attachment(id: id, title: offered[id] ?? id, sizeBytes: 0,
                                                   unavailable: offered[id] == nil)
        }
    }

    /// What the picker may add: ONLY what the server offered (`attachable`);
    /// approve refuses anything else.
    var attachableNotAttached: [ProposalDetail.Attachable] {
        let attached = Set(draft?.attachmentDocumentIds ?? [])
        return (detail?.attachable ?? []).filter { !attached.contains($0.id) }
    }

    var canSend: Bool {
        guard isPending, let draft, !isBusy else { return false }
        return !draft.to.isEmpty
            && !draft.subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !draft.entrySummary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !attachmentRows.contains(where: \.unavailable)
    }

    /// The line under the draft once Martin has decided.
    var statusLine: String? {
        switch detail?.status {
        case "approved": Copy.approved
        case "sending": Copy.sending
        case "sent": Copy.sent
        case "failed": "Versturen mislukt\(detail?.error.map { ": \($0)" } ?? ".")"
        case "rejected": "Afgewezen."
        case "superseded": "Vervangen door een nieuwer voorstel."
        default: nil
        }
    }

    // MARK: - Editing

    func edit(body: String? = nil, subject: String? = nil, removing attachmentId: String? = nil) {
        guard var d = draft, isPending else { return }
        if let body { d.body = body }
        if let subject { d.subject = subject }
        if let attachmentId { d.attachmentDocumentIds.removeAll { $0 == attachmentId } }
        draft = d
    }

    func attach(_ documentId: String) {
        guard var d = draft, isPending,
              attachableNotAttached.contains(where: { $0.id == documentId }) else { return }
        d.attachmentDocumentIds.append(documentId)
        draft = d
    }

    func setRecipients(to: [String], cc: [String]) {
        guard var d = draft, isPending else { return }
        d.to = to
        d.cc = cc
        draft = d
    }

    func setEntrySummary(_ summary: String) {
        guard var d = draft, isPending else { return }
        d.entrySummary = summary
        draft = d
    }

    // MARK: - Deciding

    func approve() async -> ApproveOutcome {
        guard canSend, let detail, let snapshot = draft else {
            if draft != nil, attachmentRows.contains(where: \.unavailable) { message = Copy.unavailableAttachment }
            return .notReady
        }
        let revision = detail.revision
        isBusy = true
        defer { isBusy = false }
        message = nil
        guard await gate.confirmSend(to: snapshot.to) else { return .cancelled }
        do {
            let _: Ignored = try await client.postJSON("\(base)/approve",
                                                      ApproveRequest(revision: revision, payload: snapshot))
            await reload()
            return .approved
        } catch APIError.rejected(409) {
            await reload()
            message = isPending ? Copy.newerVersion : Copy.notPending
            return .newerVersion
        } catch APIError.rejected(400) {
            message = Copy.refused
            return .refused
        } catch {
            message = handle(error)
            return .failed
        }
    }

    func reject(reason: String?) async -> Bool {
        guard isPending else { return false }
        isBusy = true
        defer { isBusy = false }
        let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines)
        return await decide("\(base)/reject", RejectRequest(reason: trimmed?.isEmpty == false ? trimmed : nil))
    }

    /// Answers a question with one of the server's options. A question never
    /// leaves the house, so it is not behind the send gate; the app lock
    /// already covers it.
    func answer(option index: Int) async -> Bool {
        guard isPending, let revision, optionButtons.contains(where: { $0.index == index }) else { return false }
        isBusy = true
        defer { isBusy = false }
        return await decide("\(base)/answer", AnswerOptionRequest(revision: revision, option: index))
    }

    func answer(freeText: String) async -> Bool {
        let text = freeText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isPending, let revision, !text.isEmpty else { return false }
        isBusy = true
        defer { isBusy = false }
        return await decide("\(base)/answer", AnswerTextRequest(revision: revision, freeText: text))
    }

    private func decide<B: Encodable & Sendable>(_ path: String, _ body: B) async -> Bool {
        message = nil
        do {
            let _: Ignored = try await client.postJSON(path, body)
            await reload()
            return true
        } catch APIError.rejected(409) {
            await reload()
            message = isPending ? Copy.newerVersion : Copy.notPending
            return false
        } catch APIError.rejected(400) {
            message = Copy.refused
            return false
        } catch {
            message = handle(error)
            return false
        }
    }

    /// Creates the proposed task — on Martin's tap and nowhere else. The server
    /// makes a second tap a no-op; the phone does not even send it.
    func createTask() async {
        guard detail?.proposedTask != nil, !taskCreated, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let _: Ignored = try await client.postJSON("\(base)/task", EmptyBody())
            taskCreated = true
        } catch {
            message = handle(error)
        }
    }

    /// After approve: reload until the worker has settled the send (`sent` or
    /// `failed`), at most `limit` times. Stops when the view goes away.
    func followSend(every interval: Duration = .seconds(5), limit: Int = 120) async {
        var left = limit
        while isSending, left > 0, !Task.isCancelled {
            left -= 1
            try? await Task.sleep(for: interval)
            if Task.isCancelled { return }
            await reload()
        }
    }

    private func handle(_ error: any Error) -> String {
        switch error as? APIError {
        case .unauthorized?:
            onUnauthorized()
            return "Log opnieuw in."
        case .transport?: return Copy.offline
        case .rejected(404)?: return "Dit voorstel bestaat niet (meer)."
        default: return Copy.failed
        }
    }
}
