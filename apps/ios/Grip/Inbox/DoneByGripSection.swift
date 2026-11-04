import SwiftUI
import Observation

/// The words "Door Grip gedaan" uses for one action. The web spells the same
/// sentences in apps/web/src/lib/grip-action-copy.ts; keep the two in step.
enum DoneByGripCopy {
    static let title = "Door Grip gedaan"
    static let explanation = "Wat Grip zelf heeft opgeborgen of hernoemd. Klopt iets niet? Wat hier kan, maak je met één tik ongedaan."
    /// Grip is the app; Verder is the bewindvoerder.
    static let none = "Grip deed niets zelf."
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

    static func headline(_ a: GripAction) -> String {
        a.kind == "auto-file" ? "Opgeborgen door Grip" : "Hernoemd door Grip"
    }

    /// What changed, before → after, one clause per field that moved.
    static func changes(_ a: GripAction) -> [String] {
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
    static func note(_ a: GripAction) -> String? {
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
/// the document as it was before Grip touched it.
///
/// After every answer, good or refused, the list is refreshed: an undo moves a
/// document back into the inbox, and a 409 means the row the button sat on is
/// already out of date.
@MainActor
@Observable
final class DoneByGripModel {
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

    nonisolated static func undoPath(_ changeId: String) -> String { "/api/mobile/v1/grip-actions/\(changeId)/undo" }

    /// Only a row the server called undoable is ever posted.
    func canUndo(_ a: GripAction) -> Bool { a.undoable && !a.undone && !busy.contains(a.changeId) }

    @discardableResult
    func undo(_ a: GripAction) async -> Bool {
        guard canUndo(a) else { return false }
        busy.insert(a.changeId)
        defer { busy.remove(a.changeId) }
        messages[a.changeId] = nil
        do {
            // `{}` (Plan 2's EmptyBody): the undo route takes no options.
            let _: Ignored = try await client.postJSON(Self.undoPath(a.changeId), EmptyBody())
            messages[a.changeId] = DoneByGripCopy.undone
            await onChanged()
            return true
        } catch APIError.rejected(409) {
            messages[a.changeId] = DoneByGripCopy.changedSince
            await onChanged()
        } catch APIError.rejected(400) {
            messages[a.changeId] = DoneByGripCopy.refused
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

/// "Door Grip gedaan" at the end of Voor jou: a header that opens it in
/// place ("BEKIJKEN ›" / "INKLAPPEN ⌄"), and — open — the explanation and
/// one row per action with its one-tap undo. NEVER AMBER: what Grip already
/// did is there to check, not waiting on Martin. On the empty list the
/// closed section says in a sentence what is behind it.
///
/// The list's undo is HELD like every other decision on it (`InboxDecisions`,
/// a toast with its own "Ongedaan maken"); the screen of its own posts at once.
struct DoneByGripListSection: View {
    let actions: [GripAction]
    let total: Int
    @Binding var open: Bool
    /// The empty list: the closed section says what is behind it.
    let summary: Bool
    let ax: Bool
    let undo: (GripAction) -> Void

    var body: some View {
        Section {
            Button { open.toggle() } label: { header }
                .buttonStyle(.plain)
                .voorJouRow()
                .accessibilityLabel("\(DoneByGripCopy.title), \(total)")
                .accessibilityHint(open ? "Klapt in" : "Klapt open")
                // On the header ROW: a List scrolls to a row's id, not a Section's.
                .id("done")
            // At the accessibility sizes the explanation would fill a screen
            // above the rows it explains; the frame goes straight to them.
            if (open && !ax) || (summary && !open) {
                Text(open ? DoneByGripCopy.explanation : DoneByGripList.summary(total))
                    .font(VoorJouMetrics.body)
                    .foregroundStyle(Color.inkMute)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 14)
                    .voorJouRow()
            }
            if open {
                ForEach(actions) { a in
                    DoneByGripListRow(action: a, ax: ax, undo: { undo(a) })
                        .voorJouRow()
                        .id(ListDecision.key(grip: a.changeId))
                }
            }
        }
    }

    private var header: some View {
        let label = HStack(spacing: 8) {
            Image(systemName: "checkmark.seal").font(.system(size: 12))
            Text(DoneByGripCopy.title.uppercased())
            Text("\(total)").padding(.leading, 4)
        }
        .foregroundStyle(Color.inkSoft)
        let action = HStack(spacing: 4) {
            Text((open ? "Inklappen" : "Bekijken").uppercased())
            Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 10, weight: .semibold))
        }
        .foregroundStyle(Color.signal)
        return Group {
            if ax {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(DoneByGripCopy.title.uppercased())\u{00A0}\u{00A0}\(total)").foregroundStyle(Color.inkSoft)
                    action
                }
            } else {
                HStack(alignment: .firstTextBaseline) { label; Spacer(minLength: 12); action }
            }
        }
        .font(VoorJouMetrics.label)
        .tracking(VoorJouMetrics.labelTracking)
        .padding(.vertical, 14)
        .contentShape(Rectangle())
    }
}

/// One thing Grip did, as the list draws it: the sentence, its soort (or
/// "hernoemd") and day, and "Ongedaan maken" where the server allows it —
/// otherwise the server's reason why not.
struct DoneByGripListRow: View {
    let action: GripAction
    let ax: Bool
    let undo: () -> Void

    var body: some View {
        let a = action
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 0) {
                if !ax {
                    Image(systemName: "checkmark.seal")
                        .font(.system(size: 15))
                        .foregroundStyle(Color.inkSoft)
                        .frame(width: VoorJouMetrics.gutter, alignment: .leading)
                        .padding(.top, 3)
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(DoneByGripList.title(a))
                        .wholeWords(DoneByGripList.title(a), font: VoorJouMetrics.title)
                        .lineHeight(.multiple(factor: ax ? 1.15 : VoorJouMetrics.lineFactor))
                        .foregroundStyle(Color.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                    if ax {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(DoneByGripList.meta(a), id: \.self) { Text($0.uppercased()) }
                        }
                        .font(VoorJouMetrics.label)
                        .foregroundStyle(Color.inkLabel)
                        if a.undoable && !a.undone { undoButton }
                    } else {
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(HomeSummary.metaLine(DoneByGripList.meta(a).map { $0.uppercased() }))
                                .font(VoorJouMetrics.label)
                                .tracking(VoorJouMetrics.metaTracking)
                                .foregroundStyle(Color.inkLabel)
                            Spacer(minLength: 0)
                            if a.undoable && !a.undone { undoButton }
                        }
                    }
                    if !(a.undoable && !a.undone), let note = DoneByGripList.note(a) {
                        Text(note)
                            .font(VoorJouMetrics.body)
                            .foregroundStyle(Color.inkMute)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 2)
                    }
                }
            }
            .padding(.vertical, 14)
            RowHairlineShape(leading: ax ? 0 : VoorJouMetrics.gutter)
        }
        .accessibilityElement(children: .combine)
    }

    /// Wrapped at AX5, the label stays flush left ("Ongedaan" / "maken"),
    /// never centred under itself.
    private var undoButton: some View {
        Button(action: undo) {
            Text(VoorJouCopy.undo)
                .wholeWords(VoorJouCopy.undo, font: .display(ax ? 17 : 16, relativeTo: .body))
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: ax ? .infinity : nil, alignment: .leading)
        }
            .foregroundStyle(Color.signal)
            .buttonStyle(.borderless)
    }
}

/// A hairline from the text's leading edge to the screen's right edge.
struct RowHairlineShape: View {
    var leading: CGFloat
    var body: some View {
        Rectangle().fill(Color.hairline).frame(height: 1)
            .padding(.leading, leading)
            .padding(.trailing, -VoorJouMetrics.margin)
            .accessibilityHidden(true)
    }
}

/// The same list, open, on a screen of its own (`InboxRoute.doneByGrip`):
/// where Overzicht's card and the daily digest push lead. Read from the one
/// `InboxStore`, so it is the list the section shows.
struct DoneByGripScreen: View {
    let store: InboxStore
    let model: DoneByGripModel

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(DoneByGripCopy.title)
                        .font(.display(28, relativeTo: .title, weight: .regular))
                        .foregroundStyle(Color.inkBright)
                    Text(DoneByGripCopy.explanation)
                        .font(.display(15, relativeTo: .subheadline, weight: .regular))
                        .foregroundStyle(Color.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                    if let actions = store.inbox?.doneByGrip {
                        if actions.isEmpty {
                            Text(DoneByGripCopy.none)
                                .font(.display(15, relativeTo: .subheadline, weight: .regular))
                                .foregroundStyle(Color.inkMute)
                        }
                        ForEach(actions) { DoneByGripRow(action: $0, model: model) }
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

/// One thing Grip did, with its one-tap undo when the server allows it.
struct DoneByGripRow: View {
    let action: GripAction
    let model: DoneByGripModel

    var body: some View {
        let a = action
        VStack(alignment: .leading, spacing: 6) {
            Text("\(DoneByGripCopy.headline(a)) · \(ProposalFormat.dateTime(a.at))")
                .font(.mono(11, relativeTo: .caption2))
                .foregroundStyle(Color.inkDim)
            Text(a.documentTitle ?? "Document")
                .font(.display(15, relativeTo: .body, weight: .regular))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(DoneByGripCopy.changes(a), id: \.self) { line in
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
                } else if let note = DoneByGripCopy.note(a) {
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
