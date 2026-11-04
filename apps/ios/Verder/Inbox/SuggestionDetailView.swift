import SwiftUI
import UIKit
import Observation

/// One suggestion from Voor jou, per kind as `/queue`'s `SuggestionCard` shows
/// it (apps/web/src/components/suggestion-card.tsx): a log entry, a document's
/// title and soort, a debt, a task (Figma "detail · final", Suggestie).
/// A tap on a field edits THAT field; a changed field reads "AANGEPAST", shows
/// what it was, and offers "Zet terug" — the edit diff is visible BEFORE
/// approving (brief §3, the golden rule).
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
        static let offline = "Je bent offline. Goedkeuren of Niet relevant kiezen kan weer zodra je verbinding hebt; aanpassen kan nu al."
        static let debtMeaning = "Goedkeuren legt vast wat zij vorderen; je erkent het bedrag daarmee niet."
        static let collector = "Dit lijkt op een incassopartij — geen oordeel, wel goed om op de lijst te hebben."
        static let tapToEdit = "Tik op een veld om het aan te passen."
        static let unknownAmount = "onbekend — de brief noemt geen totaal"
    }

    /// One editable value on the card.
    struct Field: Identifiable, Equatable {
        enum Style: Equatable {
            case line, text
            /// A plain day ("2026-11-07").
            case day
            /// An instant with its time ("di 3 nov 2026 · 17:00"), sent as ISO 8601.
            case dateTime
            /// Whole cents, typed as "240,00"; empty is UNKNOWN, never € 0,00.
            case money
        }
        let key: String
        let label: String
        let style: Style
        /// Must hold text before "Goedkeuren" is offered.
        let required: Bool
        /// What an emptied box sends: `null` for an optional field, `""` where
        /// the procedure wants a string.
        let cleared: JSONValue
        let initial: String
        var id: String { key }
    }

    /// What an approval made, from the route's answer.
    struct Outcome: Equatable {
        let kind: String
        let entryId: String?
        let taskId: String?
        let debtId: String?
        let at: Date
    }

    private(set) var suggestion: SuggestionDTO?
    private(set) var fields: [Field] = []
    private(set) var values: [String: String] = [:]
    private(set) var isBusy = false
    private(set) var decided = false
    private(set) var message: String?
    private(set) var loadError: String?
    private(set) var outcome: Outcome?
    /// The approval never reached the server: "NIET VASTGELEGD", and the
    /// edits stay on screen.
    private(set) var approveFailed = false
    private(set) var loadedAt: Date?
    /// Haptic triggers (brief §2.5).
    private(set) var successes = 0
    private(set) var softs = 0
    private(set) var errors = 0

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void
    @ObservationIgnored private let now: @Sendable () -> Date

    init(client: APIClient, onUnauthorized: @escaping @MainActor () -> Void = {},
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.client = client
        self.onUnauthorized = onUnauthorized
        self.now = now
    }

    private var base: String { "/api/mobile/v1/suggestions/\(suggestion?.id ?? "")" }

    func load(id: String) async {
        do {
            let s: SuggestionDTO = try await client.getJSON("/api/mobile/v1/suggestions/\(id)")
            suggestion = s
            fields = Self.fields(for: s)
            values = Dictionary(uniqueKeysWithValues: fields.map { ($0.key, $0.initial) })
            loadError = nil
            loadedAt = now()
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
            && fields.allSatisfy { f in
                let v = (values[f.key] ?? "").trimmingCharacters(in: .whitespaces)
                if f.required && v.isEmpty { return false }
                if f.style == .money && !v.isEmpty && SuggestionFormat.cents(from: v) == nil { return false }
                return true
            }
    }

    func value(_ key: String) -> String { values[key] ?? "" }

    func set(_ key: String, _ value: String) {
        guard fields.contains(where: { $0.key == key }) else { return }
        values[key] = value
    }

    /// The proposal's own value back (frame "Zet terug").
    func revert(_ key: String) {
        guard let f = fields.first(where: { $0.key == key }) else { return }
        values[key] = f.initial
    }

    func field(_ key: String) -> Field? { fields.first { $0.key == key } }

    /// Changed against the proposal, by the same rule `edits` sends.
    func isChanged(_ key: String) -> Bool { edits[key] != nil }

    var changedCount: Int { edits.count }

    /// The fields that differ from the proposal, and only those.
    var edits: [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for f in fields {
            let now = values[f.key] ?? ""
            switch f.style {
            case .money:
                let was = SuggestionFormat.cents(from: f.initial)
                let cents = SuggestionFormat.cents(from: now)
                guard cents != was || now.trimmingCharacters(in: .whitespaces).isEmpty != f.initial.isEmpty else { continue }
                if now.trimmingCharacters(in: .whitespaces).isEmpty { out[f.key] = f.cleared }
                else if let cents { out[f.key] = .number(Double(cents)) }
            default:
                guard now != f.initial else { continue }
                out[f.key] = now.isEmpty ? f.cleared : .string(now)
            }
        }
        return out
    }

    /// "Goedkeuren", "Goedkeuren · 2 aangepast", "Opnieuw goedkeuren · 2 aangepast".
    var approveLabel: String {
        let head = approveFailed ? "Opnieuw goedkeuren" : "Goedkeuren"
        return changedCount == 0 ? head : "\(head) · \(changedCount) aangepast"
    }

    func approve() async -> Bool {
        guard canApprove, let s = suggestion else { return false }
        isBusy = true
        defer { isBusy = false }
        message = nil
        do {
            let r: ApproveSuggestionResponse = try await client.postJSON("\(base)/approve", ApproveSuggestionRequest(edits: edits))
            decided = true
            approveFailed = false
            message = Copy.approved
            outcome = Outcome(kind: s.kind, entryId: r.entryId, taskId: r.taskId, debtId: r.debtId, at: now())
            successes += 1
            return true
        } catch {
            approveFailed = failure(error)
            return false
        }
    }

    func reject(reason: String?) async -> Bool {
        guard isOpen, !isBusy else { return false }
        isBusy = true
        defer { isBusy = false }
        message = nil
        let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let _: Ignored = try await client.postJSON("\(base)/reject",
                                                      RejectRequest(reason: trimmed?.isEmpty == false ? trimmed : nil))
            decided = true
            message = Copy.rejected
            softs += 1
            return true
        } catch {
            _ = failure(error)
            return false
        }
    }

    /// Maps a failed decision; true when it never reached the server (the
    /// "NIET VASTGELEGD" card rather than a line).
    private func failure(_ error: any Error) -> Bool {
        errors += 1
        switch error as? APIError {
        case .rejected(409)?:
            decided = true
            message = Copy.alreadyDecided
            return false
        case .rejected(400)?:
            message = Copy.refused
            return false
        case .unauthorized?, .rejected(404)?:
            message = handle(error)
            return false
        default:
            message = nil
            return true
        }
    }

    /// "Je goedkeuring kwam niet aan bij verder. Er staat nog niets in het
    /// logboek; je 2 aanpassingen staan hier nog."
    var failureText: String? {
        guard approveFailed, let s = suggestion else { return nil }
        var t = "Je goedkeuring kwam niet aan bij verder. "
        let what: String = switch s.kind {
        case "log-entry": "Er staat nog niets in het logboek"
        case "task": "Er is nog geen taak aangemaakt"
        case "debt": "De vordering is nog niet vastgelegd"
        default: "Er is nog niets vastgelegd"
        }
        t += what
        switch changedCount {
        case 0: t += "."
        case 1: t += "; je aanpassing staat hier nog."
        default: t += "; je \(changedCount) aanpassingen staan hier nog."
        }
        return t
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

    // MARK: - What the screen says

    /// The suggestion in its own words: the summary, the title, the task, or
    /// "Vordering van <schuldeiser>". Follows the edit on screen.
    var title: String {
        guard let s = suggestion else { return "Suggestie" }
        switch s.kind {
        case "log-entry": return value("summary").nonEmpty ?? "Logboekregel"
        case "document-meta", "task": return value("title").nonEmpty ?? SuggestionFormat.kind(s.kind)
        case "debt": return value("creditorName").nonEmpty.map { "Vordering van \($0)" } ?? "Vordering"
        case "registry-item": return s.proposed["name"]?.string ?? "Vaste last"
        default: return "Suggestie"
        }
    }

    /// "SUGGESTIE · LOGBOEKREGEL".
    var eyebrow: [String] { ["Suggestie", SuggestionFormat.kind(suggestion?.kind ?? "")] }

    /// Where verder found it, as one sentence: "Gevonden door verder in je
    /// spraaknotitie van za 31 okt." Then what a tap does, while it is open;
    /// for a debt, what approving means.
    func provenance() -> String {
        guard let s = suggestion else { return "" }
        var where_: String?
        if let o = s.origin {
            let noun = o.kind == "spraaknotitie" ? "je spraaknotitie" : "de \(o.kind)"
            where_ = noun + (o.from.map { " van \($0)" } ?? "") + (o.at.map { " van \(DetailText.dayName($0))" } ?? "")
        } else if let t = s.trigger {
            let who = ProposalText.displayName(t.from) ?? t.from
            where_ = "de mail" + (who.map { " van \($0)" } ?? "") + (t.sentAt.map { " van \(DetailText.dayName($0))" } ?? "")
        } else if let d = s.document {
            where_ = "het document “\(d.title)”"
        }
        var out = where_.map { "Gevonden door verder in \($0)." } ?? "Gevonden door verder."
        if s.kind == "debt" { out += " " + Copy.debtMeaning }
        else if isOpen && !opensOnWebsite { out += " " + Copy.tapToEdit }
        return out
    }

    /// The collector note, only where the model concluded it.
    var collectorNote: String? {
        guard suggestion?.kind == "debt", case .bool(true)? = suggestion?.proposed["isDebtCollector"] else { return nil }
        return Copy.collector
    }

    /// Read-only facts beside the fields: who sent a document, who collects
    /// for a creditor. The phone cannot change them yet.
    var readOnly: [(label: String, value: String)] {
        guard let s = suggestion else { return [] }
        switch s.kind {
        case "document-meta":
            return (s.document?.partyName ?? s.proposed["partyName"]?.string).map { [("Van wie", $0)] } ?? []
        case "debt":
            let creditor = value("creditorName")
            if let c = s.proposed["collectorName"]?.string ?? s.proposed["counterpartyName"]?.string,
               c != creditor, c != s.proposed["creditorName"]?.string {
                return [("Namens hen", c)]
            }
            return []
        default:
            return []
        }
    }

    /// What a field shows when it is not being edited.
    func display(_ f: Field) -> String {
        let v = value(f.key)
        switch f.style {
        case .money:
            guard let cents = SuggestionFormat.cents(from: v) else { return Copy.unknownAmount }
            return SuggestionFormat.euro(cents: cents)
        case .day: return v.isEmpty ? "—" : (ProposalFormat.dayMonth(v) ?? v)
        case .dateTime: return parseISODate(v).map(DetailText.longDateTime) ?? "—"
        default: return v.isEmpty ? "—" : v
        }
    }

    /// The "was:" line of a changed field: the proposal's own value.
    func was(_ f: Field) -> String {
        switch f.style {
        case .money: return SuggestionFormat.cents(from: f.initial).map(SuggestionFormat.euro) ?? "onbekend"
        case .dateTime: return parseISODate(f.initial).map(DetailText.longDateTime) ?? "geen datum"
        case .day: return f.initial.isEmpty ? "geen datum" : (ProposalFormat.dayMonth(f.initial) ?? f.initial)
        default: return f.initial.isEmpty ? "leeg" : f.initial
        }
    }

    /// "Kopieer tekst": each field as "Label: waarde".
    var copyText: String {
        fields.map { "\($0.label): \(display($0))" }.joined(separator: "\n")
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
            var amount = ""
            if case .number(let n)? = p["claimedCents"] { amount = SuggestionFormat.plainEuro(cents: Int(abs(n))) }
            return [
                Field(key: "claimedCents", label: "Gevorderd", style: .money, required: false, cleared: .null, initial: amount),
                Field(key: "creditorName", label: "Schuldeiser", style: .line, required: true, cleared: .string(""),
                      initial: p["creditorName"]?.string ?? p["counterpartyName"]?.string ?? ""),
            ]
        case "task":
            let due = p["dueAt"]?.string ?? ""
            // An instant keeps its time; a plain day stays a day.
            let timed = due.contains("T") && parseISODate(due) != nil
            return [
                Field(key: "title", label: "Taak", style: .line, required: true, cleared: .string(""), initial: text("title")),
                Field(key: "dueAt", label: "Uiterlijk op", style: timed ? .dateTime : .day, required: false, cleared: .null,
                      initial: timed ? parseISODate(due).map(SuggestionFormat.iso) ?? "" : SuggestionFormat.day(due) ?? ""),
                Field(key: "details", label: "Toelichting", style: .text, required: false, cleared: .null, initial: text("details")),
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

private extension String {
    var nonEmpty: String? {
        let t = trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : self
    }
}

struct ApproveSuggestionRequest: Encodable, Sendable {
    let edits: [String: JSONValue]
}

/// The approve route answers with what it made (`entryId` / `debtId` / `taskId`).
struct ApproveSuggestionResponse: Decodable, Sendable {
    var entryId: String? = nil
    var debtId: String? = nil
    var taskId: String? = nil
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

    /// An instant as the server's own ISO 8601 ("2026-11-03T16:00:00.000Z").
    static func iso(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    nonisolated(unsafe) private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = ProposalFormat.amsterdam
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// Integer cents to "€ 1.234,56" — no floating point on the way.
    static func euro(cents: Int) -> String { "€ \(plainEuro(cents: cents))" }

    /// Integer cents to "1.234,56".
    static func plainEuro(cents: Int) -> String {
        let euros = cents / 100, rest = cents % 100
        var digits = String(euros)
        var grouped = ""
        while digits.count > 3 {
            grouped = "." + digits.suffix(3) + grouped
            digits = String(digits.dropLast(3))
        }
        return "\(digits)\(grouped),\(rest < 10 ? "0" : "")\(rest)"
    }

    /// "240", "240,5", "€ 1.234,56" → whole cents, by string arithmetic only.
    /// Nil for anything that is not an amount (and for an empty box: unknown).
    static func cents(from text: String) -> Int? {
        var s = text.replacingOccurrences(of: "€", with: "").trimmingCharacters(in: .whitespaces)
        s = s.replacingOccurrences(of: ".", with: "").replacingOccurrences(of: " ", with: "")
        guard !s.isEmpty else { return nil }
        let parts = s.split(separator: ",", omittingEmptySubsequences: false)
        guard parts.count <= 2, let whole = parts.first, !whole.isEmpty, whole.allSatisfy(\.isNumber),
              let euros = Int(whole) else { return nil }
        var rest = 0
        if parts.count == 2 {
            let frac = parts[1]
            guard frac.count <= 2, frac.allSatisfy(\.isNumber) else { return nil }
            rest = frac.isEmpty ? 0 : Int(frac.count == 1 ? frac + "0" : frac) ?? 0
        }
        return euros * 100 + rest
    }
}

// MARK: - The screen

struct SuggestionDetailView: View {
    let id: String
    let client: APIClient
    let onUnauthorized: @MainActor () -> Void
    var now: @Sendable () -> Date = { Date() }

    @State private var model: SuggestionDetailModel?
    /// The one field being edited, or nil.
    @State private var editingKey: String?
    @State private var rejecting = false
    @State private var rejectReason = ""
    @State private var fixtureApplied = false
    @FocusState private var focused: String?
    @Environment(\.networkOffline) private var offline
    @Environment(\.voorJouNext) private var next
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        DetailScaffold(navTitle: model?.suggestion.map { SuggestionFormat.kind($0.kind) } ?? "Suggestie",
                       focus: editingKey) {
            if let model, let s = model.suggestion {
                content(model, s)
            } else if let error = model?.loadError {
                DetailPara(error).padding(.top, 24)
            } else {
                ProposalSkeleton()
            }
        } dock: {
            if let model { dock(model) }
        } menu: {
            if model?.isOpen == true {
                Button("Niet relevant, met reden…", systemImage: "nosign") { rejecting = true }
                    .disabled(offline)
            }
            if let model, model.suggestion != nil {
                Button("Kopieer tekst", systemImage: "doc.on.doc") { UIPasteboard.general.string = model.copyText }
            }
        }
        .task {
            if model == nil {
                let m = SuggestionDetailModel(client: client, onUnauthorized: onUnauthorized, now: now)
                model = m
                await m.load(id: id)
                await applyFixture(m)
            }
        }
        .onChange(of: focused) { _, now in if now == nil, editingKey != nil, model?.field(editingKey!)?.style != .dateTime { editingKey = nil } }
        .sensoryFeedback(.success, trigger: model?.successes ?? 0)
        .sensoryFeedback(.impact(flexibility: .soft), trigger: model?.softs ?? 0)
        .sensoryFeedback(.error, trigger: model?.errors ?? 0)
        .sheet(isPresented: $rejecting) { rejectSheet }
    }

    // MARK: Content

    @ViewBuilder
    private func content(_ model: SuggestionDetailModel, _ s: SuggestionDTO) -> some View {
        let outcome = model.outcome
        DetailHeader(eyebrow: model.eyebrow, title: model.title,
                     offlineStamp: offline && model.isOpen ? model.loadedAt.map { DetailText.offlineStamp(loadedAt: $0, now: now()) } : nil,
                     badges: badges(model, outcome),
                     note: badgeNote(model, s, outcome))
        if let outcome {
            outcomeSection(model, outcome)
        } else {
            if let failure = model.failureText {
                DetailNotice(label: "Niet vastgelegd", text: failure).padding(.top, 24)
            } else if model.isOpen {
                DetailPara(model.provenance(), color: .inkMute, size: 15)
                    .padding(.horizontal, 16)
                    .padding(.top, 20)
            }
            if let message = model.message {
                DetailPara(message, size: 15).padding(.top, 16)
            }
            if let note = model.collectorNote {
                DetailPara(note, color: .inkMute, size: 15).padding(.top, 12).padding(.horizontal, 16)
            }
            if model.opensOnWebsite {
                VStack(alignment: .leading, spacing: 12) {
                    DetailPara("Een vaste last leg je vast op de website: daar kies je de categorie.")
                    Link("Open op de website", destination: client.base.appending(path: "queue"))
                        .font(.display(17, relativeTo: .body, weight: .medium))
                        .foregroundStyle(Color.signalLink)
                }
                .padding(.top, 20)
            }
            VStack(alignment: .leading, spacing: 16) {
                ForEach(model.fields) { f in fieldCard(model, f) }
                ForEach(Array(model.readOnly.enumerated()), id: \.offset) { _, r in
                    DetailCard(r.label) { DetailPara(r.value) }
                }
            }
            .padding(.top, 20)
            sourceRow(s).padding(.top, 24)
        }
    }

    private func badges(_ model: SuggestionDetailModel, _ outcome: SuggestionDetailModel.Outcome?) -> [(String, DetailBadge.Tone)] {
        if let outcome { return [(outcome.kind == "task" ? "Taak aangemaakt" : "Vastgelegd", .okay)] }
        guard model.isOpen else { return [] }
        var out: [(String, DetailBadge.Tone)] = [("Wacht op jou", .waiting)]
        if model.changedCount > 0 { out.append(("\(model.changedCount) aangepast", .neutral)) }
        return out
    }

    private func badgeNote(_ model: SuggestionDetailModel, _ s: SuggestionDTO, _ outcome: SuggestionDetailModel.Outcome?) -> String? {
        if let outcome { return DetailText.stamp(outcome.at) }
        return model.isOpen ? DetailText.age(since: s.createdAt, now: now()) : nil
    }

    @ViewBuilder
    private func outcomeSection(_ model: SuggestionDetailModel, _ o: SuggestionDetailModel.Outcome) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            switch o.kind {
            case "task":
                DetailLabel("Nieuwe taak").padding(.horizontal, 16)
                let due = parseISODate(model.value("dueAt")).map { "Taak · uiterlijk \(ProposalText.dayMonthName($0))" } ?? "Taak"
                DetailRow(title: model.value("title"), meta: due, dot: .attn,
                          route: o.taskId.map { InboxRoute.task($0) })
                DetailPara("De suggestie staat niet meer in Voor jou, de nieuwe taak wel: die wacht op jou.",
                           color: .inkMute, size: 15)
                    .padding(.horizontal, 16).padding(.top, 20)
            case "log-entry":
                DetailLabel("In het logboek").padding(.horizontal, 16)
                DetailRow(title: model.value("summary"), meta: entryMeta(model), dot: .steel)
                DetailPara("Een logboekregel blijft staan. Klopt er iets niet? Op de website voeg je een correctie toe; die komt ernaast.",
                           color: .inkMute, size: 15)
                    .padding(.horizontal, 16).padding(.top, 20)
            case "debt":
                DetailLabel("Vordering vastgelegd").padding(.horizontal, 16)
                DetailRow(title: model.value("creditorName"), meta: model.display(model.field("claimedCents")!), dot: .steel)
            default:
                DetailLabel("Vastgelegd").padding(.horizontal, 16)
                DetailRow(title: model.value("title"), meta: model.value("docType").isEmpty ? nil : "Document · \(model.value("docType"))",
                          dot: .steel, route: model.suggestion?.document.map { .document(id: $0.id, title: model.value("title")) })
            }
        }
        .padding(.top, 24)
    }

    /// "LOGBOEK · TELEFOON · ZA 31 OKT".
    private func entryMeta(_ model: SuggestionDetailModel) -> String {
        var parts = ["Logboek"]
        if let c = model.suggestion?.proposed["channel"]?.string { parts.append(Self.channel(c)) }
        if let at = model.suggestion?.proposed["occurredAt"]?.string.flatMap(parseISODate) { parts.append(DetailText.dayName(at)) }
        return parts.joined(separator: " · ")
    }

    static func channel(_ c: String) -> String {
        switch c {
        case "call": "telefoon"
        case "email": "e-mail"
        case "letter": "brief"
        case "visit": "bezoek"
        default: c
        }
    }

    /// The document itself, or where a task was found.
    @ViewBuilder
    private func sourceRow(_ s: SuggestionDTO) -> some View {
        if s.kind == "document-meta" || s.kind == "task", let d = s.document {
            VStack(alignment: .leading, spacing: 0) {
                DetailLabel(s.kind == "task" ? "Gevonden in" : "Het document").padding(.horizontal, 16)
                DetailRow(title: d.title, meta: "Dossier · \(d.docType ?? "te sorteren")", dot: .signal,
                          route: .document(id: d.id, title: d.title))
            }
        }
    }

    // MARK: Fields

    @ViewBuilder
    private func fieldCard(_ model: SuggestionDetailModel, _ f: SuggestionDetailModel.Field) -> some View {
        let editing = editingKey == f.key && model.isOpen
        let changed = model.isChanged(f.key)
        let state = editing ? (f.style == .dateTime || f.style == .day ? "aan het kiezen" : "aan het aanpassen")
                            : (changed ? "aangepast" : "aanpassen")
        VStack(alignment: .leading, spacing: 8) {
            DetailCard(highlighted: editing, label: {
                if model.isOpen {
                    EyebrowLine(groups: [f.label, state], color: editing ? .signal : .inkLabel,
                                accent: editing ? .signal : (changed ? .ink : .signal))
                } else {
                    DetailLabel(f.label)
                }
            }) {
                if editing { editor(model, f) } else { valueText(model, f) }
            }
            .contentShape(Rectangle())
            .onTapGesture { if model.isOpen, !editing { begin(f) } }
            .accessibilityElement(children: editing ? .contain : .combine)
            .accessibilityAddTraits(model.isOpen && !editing ? .isButton : [])
            .accessibilityHint(model.isOpen && !editing ? "Dubbeltik om aan te passen." : "")
            if changed && model.isOpen { wasLine(model, f) }
        }
        .id(f.key)
    }

    @ViewBuilder
    private func valueText(_ model: SuggestionDetailModel, _ f: SuggestionDetailModel.Field) -> some View {
        let shown = model.display(f)
        switch f.style {
        case .money where SuggestionFormat.cents(from: model.value(f.key)) != nil:
            Text(shown)
                .wholeWords(shown, font: .mono(28, relativeTo: .title))
                .foregroundStyle(Color.inkBright)
        case .money:
            DetailPara(shown, color: .inkMute)
        case .dateTime, .day:
            Text(shown)
                .wholeWords(shown, font: .mono(18, relativeTo: .title3))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
        default:
            DetailPara(shown, color: model.value(f.key).isEmpty ? .inkMute : .ink)
        }
    }

    @ViewBuilder
    private func editor(_ model: SuggestionDetailModel, _ f: SuggestionDetailModel.Field) -> some View {
        let binding = Binding(get: { model.value(f.key) }, set: { model.set(f.key, $0) })
        switch f.style {
        case .dateTime, .day:
            // The wheel sits in the dock, where the keyboard would be.
            valueText(model, f)
        case .money:
            HStack(spacing: 8) {
                Text("€").font(.mono(28, relativeTo: .title)).foregroundStyle(Color.inkMute)
                TextField("onbekend", text: binding)
                    .font(.mono(28, relativeTo: .title))
                    .foregroundStyle(Color.inkBright)
                    .keyboardType(.decimalPad)
                    .focused($focused, equals: f.key)
            }
        default:
            TextField(f.label, text: binding, axis: .vertical)
                .font(.display(17, relativeTo: .body))
                .foregroundStyle(Color.inkBright)
                .lineLimit(1...10)
                .focused($focused, equals: f.key)
                .submitLabel(.done)
        }
    }

    /// "was: ~~oud~~" with "Zet terug" beside it, or under it at the
    /// accessibility sizes.
    private func wasLine(_ model: SuggestionDetailModel, _ f: SuggestionDetailModel.Field) -> some View {
        let old = model.was(f)
        let was = (Text("was: ").foregroundStyle(Color.inkMute)
                   + Text(old).strikethrough().foregroundStyle(Color.inkDim))
            .font(f.style == .line || f.style == .text ? .display(15, relativeTo: .callout) : .mono(15, relativeTo: .callout))
            .fixedSize(horizontal: false, vertical: true)
        let back = Button("Zet terug") { withAnimation(.snappy) { model.revert(f.key) } }
            .font(.display(15, relativeTo: .callout))
            .foregroundStyle(Color.signalLink)
            .accessibilityLabel("Zet \(f.label.lowercased()) terug")
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 16))
        return layout {
            was.frame(maxWidth: .infinity, alignment: .leading)
            back.fixedSize()
        }
        .padding(.horizontal, 16)
        .accessibilityElement(children: .contain)
    }

    private func begin(_ f: SuggestionDetailModel.Field) {
        editingKey = f.key
        if f.style == .dateTime || f.style == .day {
            focused = nil
            if model?.value(f.key).isEmpty == true {
                model?.set(f.key, f.style == .day ? SuggestionFormat.day(from: now()) : SuggestionFormat.iso(now()))
            }
        } else {
            focused = f.key
        }
    }

    private func finishEditing() {
        focused = nil
        editingKey = nil
    }

    // MARK: Dock

    @ViewBuilder
    private func dock(_ model: SuggestionDetailModel) -> some View {
        if let key = editingKey, let f = model.field(key), model.isOpen {
            DetailDock {
                AuthButton(title: "Klaar") { withAnimation(.snappy) { finishEditing() } }
                if f.style == .dateTime || f.style == .day { wheel(model, f) }
            }
        } else if model.outcome != nil || (model.decided && next != nil) {
            DetailDock { NextInVoorJouButton(id: id) }
        } else if model.isOpen {
            DetailDock(note: offline ? SuggestionDetailModel.Copy.offline : nil) {
                if !model.opensOnWebsite {
                    AuthButton(title: model.approveLabel, enabled: model.canApprove && !offline) {
                        Task { if await model.approve() { await next?.refresh() } }
                    }
                }
                AuthButton(title: "Niet relevant", weight: .ghost, enabled: !model.isBusy && !offline) { rejecting = true }
            }
        }
    }

    @ViewBuilder
    private func wheel(_ model: SuggestionDetailModel, _ f: SuggestionDetailModel.Field) -> some View {
        let v = model.value(f.key)
        let date = (f.style == .day ? SuggestionFormat.date(fromDay: v) : parseISODate(v)) ?? now()
        VStack(spacing: 4) {
            DatePicker(f.label, selection: Binding(get: { date }, set: {
                model.set(f.key, f.style == .day ? SuggestionFormat.day(from: $0) : SuggestionFormat.iso($0))
            }), displayedComponents: f.style == .day ? [.date] : [.date, .hourAndMinute])
                .datePickerStyle(.wheel)
                .labelsHidden()
                .environment(\.locale, Locale(identifier: "nl_NL"))
                .environment(\.timeZone, ProposalFormat.amsterdam)
                .frame(maxWidth: .infinity)
            if !v.isEmpty {
                AuthButton(title: "Geen datum", weight: .ghost) { model.set(f.key, "") }
            }
        }
    }

    // MARK: Reject

    private var rejectSheet: some View {
        DecisionSheet(title: "Niet relevant, met reden",
                      text: "Niet verplicht — verder leert ervan. Daarna gaat de suggestie uit Voor jou.",
                      action: "Niet relevant", enabled: model?.isBusy == false && !offline,
                      onConfirm: { Task { if await model?.reject(reason: rejectReason) == true { rejecting = false; await next?.refresh() } } },
                      onCancel: { rejecting = false }) {
            VStack(alignment: .leading, spacing: 8) {
                EyebrowLine(groups: ["Reden", "mag leeg blijven"])
                TextField("Reden", text: $rejectReason, axis: .vertical)
                    .lineLimit(1...6)
                    .modifier(DetailInputStyle(focused: false))
            }
        }
    }

    // MARK: Captures

    private func applyFixture(_ model: SuggestionDetailModel) async {
        #if DEBUG
        guard let launch = FixtureLaunch.current, let s = model.suggestion, !fixtureApplied else { return }
        fixtureApplied = true
        let edits = SuggestionFixtureEdit.edits(kind: s.kind)
        switch launch.detail {
        case .veld?:
            if let (key, value) = edits.first {
                model.set(key, value)
                editingKey = key
                try? await Task.sleep(for: .milliseconds(400))
                focused = key
            }
        case .datum?:
            if let f = model.fields.first(where: { $0.style == .dateTime || $0.style == .day }) {
                if let value = edits.first(where: { $0.0 == f.key })?.1 { model.set(f.key, value) }
                editingKey = f.key
            }
        case .aangepast?, .fout?, .vastgelegd?:
            for (key, value) in edits { model.set(key, value) }
            if launch.detail == .fout || launch.detail == .vastgelegd { _ = await model.approve() }
        case .reden?:
            rejectReason = "Dit gesprek staat al in het logboek."
            rejecting = true
        default: break
        }
        #endif
    }
}

#if DEBUG
/// The captures' edits (frames "aangepast", "vordering / aangepast", "datum kiezen").
enum SuggestionFixtureEdit {
    static func edits(kind: String) -> [(String, String)] {
        switch kind {
        case "log-entry":
            [("summary", "Betalingsregeling met Woonstichting Lindehof afgesproken"),
             ("details", "Afgesproken: € 50 per maand, eerste betaling op 1 december.")]
        case "debt": [("claimedCents", "240,00")]
        case "task": [("dueAt", "2026-11-04T16:00:00.000Z")]
        default: []
        }
    }
}
#endif
