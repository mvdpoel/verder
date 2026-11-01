import SwiftUI
import Observation

/// The words "Door verder gedaan" uses for one action. The web spells the same
/// sentences in apps/web/src/lib/verder-action-copy.ts; keep the two in step.
enum DoneByVerderCopy {
    static let title = "Door verder gedaan"
    static let explanation = "Wat verder zelf heeft opgeborgen of hernoemd. Klopt iets niet? Wat hier kan, maak je met één tik ongedaan."
    static let none = "Verder deed niets zelf."
    static let undone = "Ongedaan gemaakt."
    static let changedSince = "Al aangepast of vernietigd — de lijst is bijgewerkt."
    static let refused = "Dit kan hier niet ongedaan worden gemaakt."

    private static func status(_ s: String) -> String {
        switch s {
        case "inbox": "inbox"
        case "filed": "opgeborgen"
        case "discarded": "weggegooid"
        default: s
        }
    }

    private static func soort(_ t: String?) -> String {
        let trimmed = t?.trimmingCharacters(in: .whitespaces) ?? ""
        return trimmed.isEmpty ? "zonder soort" : trimmed
    }

    static func headline(_ a: VerderAction) -> String {
        a.kind == "auto-file" ? "Opgeborgen door verder" : "Hernoemd door verder"
    }

    /// What changed, before → after, one clause per field that moved.
    static func changes(_ a: VerderAction) -> [String] {
        var out: [String] = []
        if a.before.status != a.after.status { out.append("\(status(a.before.status)) → \(status(a.after.status))") }
        if soort(a.before.docType) != soort(a.after.docType) {
            out.append("soort \(soort(a.before.docType)) → \(soort(a.after.docType))")
        }
        if a.before.title != a.after.title {
            out.append("naam \(a.before.title ?? "—") → \(a.after.title ?? "—")")
        }
        return out
    }

    /// Why the button is off; an undo already done wins.
    static func note(_ a: VerderAction) -> String? {
        if a.undone { return "Ongedaan gemaakt" }
        switch a.notUndoableReason {
        case "al aangepast"?: return "Al aangepast — niet meer terug te draaien"
        case "vernietigd"?: return "Vernietigd"
        case "naam staat ook op de NAS"?: return "De naam staat ook op de NAS; terugdraaien gaat op de server"
        case let other?: return other
        case nil: return nil
        }
    }
}

/// The one-tap undo. NO FACE ID, deliberately: an undo reveals nothing and
/// sends nothing — the server appends a correction in Martin's name restoring
/// the document as it was before verder touched it.
///
/// After every answer, good or refused, the list is refreshed: an undo moves a
/// document back into the inbox, and a 409 means the row the button sat on is
/// already out of date.
@MainActor
@Observable
final class DoneByVerderModel {
    private(set) var busy: Set<String> = []
    private(set) var messages: [String: String] = [:]

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let onChanged: @MainActor () async -> Void
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void

    init(client: APIClient,
         onChanged: @escaping @MainActor () async -> Void = {},
         onUnauthorized: @escaping @MainActor () -> Void = {}) {
        self.client = client
        self.onChanged = onChanged
        self.onUnauthorized = onUnauthorized
    }

    nonisolated static func undoPath(_ changeId: String) -> String { "/api/mobile/v1/verder-actions/\(changeId)/undo" }

    /// Only a row the server called undoable is ever posted.
    func canUndo(_ a: VerderAction) -> Bool { a.undoable && !a.undone && !busy.contains(a.changeId) }

    @discardableResult
    func undo(_ a: VerderAction) async -> Bool {
        guard canUndo(a) else { return false }
        busy.insert(a.changeId)
        defer { busy.remove(a.changeId) }
        messages[a.changeId] = nil
        do {
            // `{}` (Plan 2's EmptyBody): the undo route takes no options.
            let _: Ignored = try await client.postJSON(Self.undoPath(a.changeId), EmptyBody())
            messages[a.changeId] = DoneByVerderCopy.undone
            await onChanged()
            return true
        } catch APIError.rejected(409) {
            messages[a.changeId] = DoneByVerderCopy.changedSince
            await onChanged()
        } catch APIError.rejected(400) {
            messages[a.changeId] = DoneByVerderCopy.refused
        } catch APIError.unauthorized {
            onUnauthorized()
            messages[a.changeId] = "Log opnieuw in."
        } catch APIError.transport {
            messages[a.changeId] = ProposalModel.Copy.offline
        } catch {
            messages[a.changeId] = ProposalModel.Copy.failed
        }
        return false
    }
}

/// "Door verder gedaan" under Voor jou: collapsed, never amber. What verder
/// already did is there to check, not waiting on Martin.
struct DoneByVerderSection: View {
    let actions: [VerderAction]
    let model: DoneByVerderModel

    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(actions) { DoneByVerderRow(action: $0, model: model) }
            }
            .padding(.top, 10)
        } label: {
            Text("\(DoneByVerderCopy.title.uppercased()) · \(actions.count)")
                .font(.mono(11, relativeTo: .caption2, weight: .medium))
                .foregroundStyle(Color.inkLabel)
        }
        .tint(Color.inkDim)
        .padding(.top, 10)
    }
}

/// The same list, open, on a screen of its own (`InboxRoute.doneByVerder`):
/// where Overzicht's card and the daily digest push lead. Read from the one
/// `InboxStore`, so it is the list the section shows.
struct DoneByVerderScreen: View {
    let store: InboxStore
    let model: DoneByVerderModel

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(DoneByVerderCopy.title)
                        .font(.display(28, relativeTo: .title, weight: .regular))
                        .foregroundStyle(Color.inkBright)
                    Text(DoneByVerderCopy.explanation)
                        .font(.display(15, relativeTo: .subheadline, weight: .regular))
                        .foregroundStyle(Color.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                    if let actions = store.inbox?.doneByVerder {
                        if actions.isEmpty {
                            Text(DoneByVerderCopy.none)
                                .font(.display(15, relativeTo: .subheadline, weight: .regular))
                                .foregroundStyle(Color.inkMute)
                        }
                        ForEach(actions) { DoneByVerderRow(action: $0, model: model) }
                    } else if store.lastError == nil {
                        ProgressView().tint(Color.signal)
                    } else if let error = store.lastError {
                        Text(VoorJouTab.message(error))
                            .font(.display(15, relativeTo: .subheadline, weight: .regular))
                            .foregroundStyle(Color.ink)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 26)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .refreshable { await store.refresh() }
        }
        .preferredColorScheme(.dark)
    }
}

/// One thing verder did, with its one-tap undo when the server allows it.
struct DoneByVerderRow: View {
    let action: VerderAction
    let model: DoneByVerderModel

    var body: some View {
        let a = action
        VStack(alignment: .leading, spacing: 6) {
            Text("\(DoneByVerderCopy.headline(a)) · \(ProposalFormat.dateTime(a.at))")
                .font(.mono(11, relativeTo: .caption2))
                .foregroundStyle(Color.inkDim)
            Text(a.documentTitle ?? "Document")
                .font(.display(15, relativeTo: .body, weight: .regular))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(DoneByVerderCopy.changes(a), id: \.self) { line in
                Text(line)
                    .font(.mono(11, relativeTo: .caption2))
                    .foregroundStyle(Color.inkSoft)
            }
            HStack(spacing: 12) {
                if model.canUndo(a) {
                    Button("Ongedaan maken") { Task { await model.undo(a) } }
                        .font(.mono(12, relativeTo: .footnote, weight: .medium))
                        .foregroundStyle(Color.signalLink)
                        .buttonStyle(.plain)
                } else if let note = DoneByVerderCopy.note(a) {
                    Text(note)
                        .font(.display(12, relativeTo: .footnote, weight: .light))
                        .foregroundStyle(Color.inkDim)
                }
                if model.busy.contains(a.changeId) { ProgressView().tint(Color.signal) }
            }
            if let message = model.messages[a.changeId] {
                Text(message)
                    .font(.display(12, relativeTo: .footnote, weight: .light))
                    .foregroundStyle(Color.ink)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
    }
}
