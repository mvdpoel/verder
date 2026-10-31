import SwiftUI
import Observation

/// One suggestion from Voor jou, per kind as `/queue`'s `SuggestionCard` shows
/// it (apps/web/src/components/suggestion-card.tsx): a log entry, a document's
/// title and soort, a debt, a task. "Klopt zo" approves, "Aanpassen" opens the
/// fields, "Niet relevant" rejects.
///
/// THE PHONE SENDS ONLY WHAT MARTIN CHANGED: the approve body is
/// `{ edits }` holding the fields that differ from the proposal, never the
/// kind and never the whole procedure input. The server picks the procedure by
/// the STORED kind and builds `{ ...proposed, ...edits }` through that
/// procedure's own schema (Plan 3 Task 4), so the web and the phone record the
/// same verdict and the same edit diff.
@MainActor
@Observable
final class SuggestionDetailModel {
    enum Copy {
        static let alreadyDecided = "Deze suggestie is al afgehandeld."
        static let refused = "verder weigerde dit. Controleer de velden."
        static let gone = "Deze suggestie bestaat niet (meer)."
        static let approved = "Vastgelegd."
        static let rejected = "Afgewezen."
    }

    /// One editable value on the card.
    struct Field: Identifiable, Equatable {
        enum Style: Equatable { case line, text, day }
        let key: String
        let label: String
        let style: Style
        /// Must hold text before "Klopt zo" is offered.
        let required: Bool
        /// What an emptied box sends: `null` for an optional field, `""` where
        /// the procedure wants a string.
        let cleared: JSONValue
        let initial: String
        var id: String { key }
    }

    private(set) var suggestion: SuggestionDTO?
    private(set) var fields: [Field] = []
    private(set) var values: [String: String] = [:]
    private(set) var isBusy = false
    private(set) var decided = false
    private(set) var message: String?
    private(set) var loadError: String?

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void

    init(client: APIClient, onUnauthorized: @escaping @MainActor () -> Void = {}) {
        self.client = client
        self.onUnauthorized = onUnauthorized
    }

    private var base: String { "/api/mobile/v1/suggestions/\(suggestion?.id ?? "")" }

    func load(id: String) async {
        do {
            let s: SuggestionDTO = try await client.getJSON("/api/mobile/v1/suggestions/\(id)")
            suggestion = s
            fields = Self.fields(for: s)
            values = Dictionary(uniqueKeysWithValues: fields.map { ($0.key, $0.initial) })
            loadError = nil
        } catch {
            loadError = handle(error)
        }
    }

    /// A suggestion still waiting for a verdict.
    var isOpen: Bool {
        guard let s = suggestion, !decided else { return false }
        return s.status == "pending" || s.status == "needs-manual"
    }

    /// A registry item needs a category and evidence the phone has no form
    /// for: the server answers 409 "open op de website", so it is never tried.
    var opensOnWebsite: Bool { suggestion?.kind == "registry-item" }

    var canApprove: Bool {
        isOpen && !isBusy && !opensOnWebsite && !fields.isEmpty
            && fields.allSatisfy { !$0.required || !(values[$0.key] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
    }

    func value(_ key: String) -> String { values[key] ?? "" }

    func set(_ key: String, _ value: String) {
        guard fields.contains(where: { $0.key == key }) else { return }
        values[key] = value
    }

    /// The fields that differ from the proposal, and only those.
    var edits: [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for f in fields {
            let now = values[f.key] ?? ""
            guard now != f.initial else { continue }
            out[f.key] = now.isEmpty ? f.cleared : .string(now)
        }
        return out
    }

    func approve() async -> Bool {
        guard canApprove else { return false }
        return await decide("\(base)/approve", ApproveSuggestionRequest(edits: edits), done: Copy.approved)
    }

    func reject(reason: String?) async -> Bool {
        guard isOpen, !isBusy else { return false }
        let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines)
        return await decide("\(base)/reject", RejectRequest(reason: trimmed?.isEmpty == false ? trimmed : nil),
                            done: Copy.rejected)
    }

    private func decide<B: Encodable & Sendable>(_ path: String, _ body: B, done: String) async -> Bool {
        isBusy = true
        defer { isBusy = false }
        message = nil
        do {
            let _: Ignored = try await client.postJSON(path, body)
            decided = true
            message = done
            return true
        } catch APIError.rejected(409) {
            decided = true
            message = Copy.alreadyDecided
            return false
        } catch APIError.rejected(400) {
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

    // MARK: - Per kind

    /// The fields `/queue` lets Martin change, per kind.
    static func fields(for s: SuggestionDTO) -> [Field] {
        let p = s.proposed
        func text(_ key: String) -> String { p[key]?.string ?? "" }
        switch s.kind {
        case "log-entry":
            return [
                Field(key: "summary", label: "Samenvatting", style: .line, required: true, cleared: .string(""), initial: text("summary")),
                Field(key: "details", label: "Toelichting", style: .text, required: false, cleared: .string(""), initial: text("details")),
            ]
        case "document-meta":
            return [
                Field(key: "title", label: "Titel", style: .line, required: true, cleared: .string(""),
                      initial: p["title"]?.string ?? s.document?.title ?? ""),
                Field(key: "docType", label: "Soort", style: .line, required: false, cleared: .null, initial: text("docType")),
            ]
        case "debt":
            return [
                Field(key: "creditorName", label: "Schuldeiser", style: .line, required: true, cleared: .string(""),
                      initial: p["creditorName"]?.string ?? p["counterpartyName"]?.string ?? ""),
            ]
        case "task":
            return [
                Field(key: "title", label: "Taak", style: .line, required: true, cleared: .string(""), initial: text("title")),
                Field(key: "details", label: "Toelichting", style: .text, required: false, cleared: .null, initial: text("details")),
                Field(key: "dueAt", label: "Uiterlijk op", style: .day, required: false, cleared: .null,
                      initial: p["dueAt"]?.string.flatMap(SuggestionFormat.day) ?? ""),
            ]
        default:
            return []
        }
    }

    /// "Gevorderd: € 1.234,56", or "onbekend" when the notice names no total
    /// — never € 0,00, which would say the creditor claims nothing.
    var claimedText: String? {
        guard suggestion?.kind == "debt" else { return nil }
        guard case .number(let n)? = suggestion?.proposed["claimedCents"] else { return "Gevorderd: onbekend" }
        return "Gevorderd: \(SuggestionFormat.euro(cents: Int(abs(n))))"
    }

    /// Where the suggestion came from — provenance, as the card's `Source` line.
    var sourceLine: String {
        guard let s = suggestion else { return "" }
        if let t = s.trigger {
            let subject = t.subject.map { " “\($0)”" } ?? ""
            return t.from.map { "E-mail van \($0):\(subject)" } ?? "Uit e-mail\(subject)"
        }
        if let d = s.document { return "Document “\(d.title)”" }
        return SuggestionFormat.kind(s.kind)
    }
}

struct ApproveSuggestionRequest: Encodable, Sendable {
    let edits: [String: JSONValue]
}

enum SuggestionFormat {
    static func kind(_ kind: String) -> String {
        switch kind {
        case "log-entry": "Logboekregel"
        case "document-meta": "Document"
        case "registry-item": "Vaste last"
        case "debt": "Vordering"
        case "task": "Taak"
        default: "Suggestie"
        }
    }

    /// A plain day "2026-11-07" stays as it is; an ISO instant becomes its
    /// Amsterdam calendar day. Anything else is nil.
    static func day(_ s: String) -> String? {
        if s.count == 10, dayFormatter.date(from: s) != nil { return s }
        guard let date = parseISODate(s) else { return nil }
        return dayFormatter.string(from: date)
    }

    static func date(fromDay s: String) -> Date? { dayFormatter.date(from: s) }
    static func day(from date: Date) -> String { dayFormatter.string(from: date) }

    nonisolated(unsafe) private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = ProposalFormat.amsterdam
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// Integer cents to "€ 1.234,56" — no floating point on the way.
    static func euro(cents: Int) -> String {
        let euros = cents / 100, rest = cents % 100
        var digits = String(euros)
        var grouped = ""
        while digits.count > 3 {
            grouped = "." + digits.suffix(3) + grouped
            digits = String(digits.dropLast(3))
        }
        return "€ \(digits)\(grouped),\(rest < 10 ? "0" : "")\(rest)"
    }
}

struct SuggestionDetailView: View {
    let id: String
    let client: APIClient
    let onUnauthorized: @MainActor () -> Void

    @State private var model: SuggestionDetailModel?
    @State private var editing = false
    @State private var rejecting = false
    @State private var rejectReason = ""

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if let model, let s = model.suggestion {
                        content(model, s)
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
            .scrollDismissesKeyboard(.interactively)
        }
        .preferredColorScheme(.dark)
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                let m = SuggestionDetailModel(client: client, onUnauthorized: onUnauthorized)
                model = m
                await m.load(id: id)
            }
        }
        .sheet(isPresented: $rejecting) { rejectSheet }
    }

    @ViewBuilder
    private func content(_ model: SuggestionDetailModel, _ s: SuggestionDTO) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // Cyan, never amber: a suggestion is the machine offering
            // something. The list row already says it waits on Martin.
            Text(SuggestionFormat.kind(s.kind).uppercased())
                .font(.mono(11, relativeTo: .caption2, weight: .medium))
                .foregroundStyle(Color.signal)
            Text(model.sourceLine)
                .font(.mono(11, relativeTo: .caption2))
                .foregroundStyle(Color.inkDim)
                .fixedSize(horizontal: false, vertical: true)
            if let sent = s.trigger?.sentAt {
                Text(ProposalFormat.dateTime(sent))
                    .font(.mono(11, relativeTo: .caption2))
                    .foregroundStyle(Color.inkDim)
            }
        }
        if s.kind == "debt" {
            Text("Dit lijkt op een incassopartij — geen oordeel, wel goed om op de lijst te hebben.")
                .font(.display(14, relativeTo: .callout, weight: .light))
                .foregroundStyle(Color.signal)
                .fixedSize(horizontal: false, vertical: true)
        }
        if model.opensOnWebsite {
            if let name = s.proposed["name"]?.string { para(name) }
            para("Een vaste last leg je vast op de website: daar kies je de categorie.")
            Link("Open op de website", destination: client.base.appending(path: "queue"))
                .font(.mono(14, relativeTo: .body, weight: .medium))
                .foregroundStyle(Color.signalLink)
        }
        ForEach(model.fields) { f in fieldView(model, f) }
        if let claimed = model.claimedText {
            Text(claimed).font(.mono(12, relativeTo: .caption)).foregroundStyle(Color.inkSoft)
        }
        if let message = model.message {
            Text(message)
                .font(.display(14, relativeTo: .callout, weight: .light))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        if model.isOpen {
            VStack(spacing: 10) {
                if !model.opensOnWebsite {
                    AuthButton(title: "Klopt zo", enabled: model.canApprove) {
                        Task { if await model.approve() { editing = false } }
                    }
                    AuthButton(title: editing ? "Klaar met aanpassen" : "Aanpassen", weight: .secondary,
                               enabled: !model.isBusy) { editing.toggle() }
                }
                AuthButton(title: "Niet relevant", weight: .secondary, enabled: !model.isBusy) { rejecting = true }
            }
        } else if model.message == nil && !model.decided {
            Text(SuggestionDetailModel.Copy.alreadyDecided)
                .font(.display(14, relativeTo: .callout, weight: .light))
                .foregroundStyle(Color.inkMute)
        }
    }

    @ViewBuilder
    private func fieldView(_ model: SuggestionDetailModel, _ f: SuggestionDetailModel.Field) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(f.label.uppercased())
                .font(.mono(11, relativeTo: .caption2, weight: .medium))
                .foregroundStyle(Color.signal)
            if editing && model.isOpen {
                switch f.style {
                case .line, .text:
                    TextField(f.label, text: Binding(get: { model.value(f.key) }, set: { model.set(f.key, $0) }),
                              axis: .vertical)
                        .lineLimit(f.style == .text ? 3...8 : 1...3)
                        .font(.display(15, relativeTo: .body))
                        .foregroundStyle(Color.ink)
                        .padding(10)
                        .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
                        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
                case .day:
                    dayEditor(model, f)
                }
            } else {
                let v = model.value(f.key)
                Text(v.isEmpty ? "—" : (f.style == .day ? (ProposalFormat.dayMonth(v) ?? v) : v))
                    .font(.display(15, relativeTo: .body, weight: .light))
                    .foregroundStyle(v.isEmpty ? Color.inkMute : Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func dayEditor(_ model: SuggestionDetailModel, _ f: SuggestionDetailModel.Field) -> some View {
        let v = model.value(f.key)
        if let date = SuggestionFormat.date(fromDay: v) {
            HStack {
                DatePicker(f.label, selection: Binding(get: { date },
                                                       set: { model.set(f.key, SuggestionFormat.day(from: $0)) }),
                           displayedComponents: .date)
                    .labelsHidden()
                    .environment(\.locale, Locale(identifier: "nl_NL"))
                    .environment(\.timeZone, ProposalFormat.amsterdam)
                Spacer()
                Button("Geen datum") { model.set(f.key, "") }
                    .font(.mono(12, relativeTo: .caption, weight: .medium))
                    .foregroundStyle(Color.signalLink)
            }
        } else {
            Button("Datum kiezen") { model.set(f.key, SuggestionFormat.day(from: Date())) }
                .font(.mono(12, relativeTo: .caption, weight: .medium))
                .foregroundStyle(Color.signalLink)
        }
    }

    private var rejectSheet: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 16) {
                Text("Niet relevant")
                    .font(.display(22, relativeTo: .title2, weight: .light))
                    .foregroundStyle(Color.inkBright)
                Text("Waarom? Niet verplicht — verder leert ervan.")
                    .font(.display(14, relativeTo: .callout, weight: .light))
                    .foregroundStyle(Color.inkMute)
                TextField("Reden", text: $rejectReason, axis: .vertical)
                    .font(.display(15, relativeTo: .body))
                    .foregroundStyle(Color.ink)
                    .padding(10)
                    .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
                    .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
                AuthButton(title: "Niet relevant", enabled: model?.isBusy == false) {
                    Task { if await model?.reject(reason: rejectReason) == true { rejecting = false } }
                }
                AuthButton(title: "Annuleren", weight: .secondary) { rejecting = false }
                Spacer()
            }
            .padding(16)
        }
        .preferredColorScheme(.dark)
        .presentationDetents([.medium])
    }

    private func para(_ text: String) -> some View {
        Text(text)
            .font(.display(15, relativeTo: .body, weight: .light))
            .foregroundStyle(Color.ink)
            .fixedSize(horizontal: false, vertical: true)
    }
}
