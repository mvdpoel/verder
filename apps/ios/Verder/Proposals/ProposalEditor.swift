import SwiftUI

/// "Concept aanpassen" (F-37): a sheet over the proposal that edits a WORKING
/// COPY. "Klaar" hands it to the model; "Annuleren" leaves the draft as it was
/// when the sheet opened — and asks first when that would throw edits away
/// (F-40). Nothing here sends: Klaar brings Martin back to the proposal,
/// where sending is a hold and a fresh Face ID.
struct ProposalEditor: View {
    let model: ProposalModel

    @State private var working: ReplyDraft
    @State private var toText: String
    @State private var ccText: String
    @State private var confirmingDiscard = false
    /// The body is a UIKit text view (`DraftBodyEditor`), outside FocusState.
    @State private var bodyFocused = false
    @FocusState private var focus: Field?
    enum Field: Hashable { case to, cc, subject }
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize

    init(model: ProposalModel) {
        self.model = model
        let d = model.draft ?? ReplyDraft(to: [], cc: [], subject: "", body: "", attachmentDocumentIds: [], entrySummary: "")
        _working = State(initialValue: d)
        _toText = State(initialValue: d.to.joined(separator: ", "))
        _ccText = State(initialValue: d.cc.joined(separator: ", "))
    }

    private var ax: Bool { typeSize.isAccessibilitySize }

    /// The working copy as Klaar would hand it over.
    private var result: ReplyDraft {
        var d = working
        d.to = Self.addresses(toText)
        d.cc = Self.addresses(ccText)
        return d
    }

    private var dirty: Bool { result != model.draft }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.void.ignoresSafeArea()
                ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        // Addresses stay on ONE line (a field scrolls sideways,
                        // never wraps at "@" or a dot); only the Cc prompt,
                        // which is words, wraps.
                        row("Aan") { toField }
                        row("Cc") {
                            ZStack(alignment: .topLeading) {
                                if ccText.isEmpty {
                                    Text("Iemand toevoegen")
                                        .font(.display(17, relativeTo: .body))
                                        .foregroundStyle(Color.inkDim)
                                        .fixedSize(horizontal: false, vertical: true)
                                        .allowsHitTesting(false)
                                        .accessibilityHidden(true)
                                }
                                TextField("", text: $ccText)
                                    .keyboardType(.emailAddress)
                                    .focused($focus, equals: .cc)
                                    .modifier(EditorField(mono: false))
                            }
                        }
                        row("Onderwerp") {
                            TextField("", text: $working.subject, axis: .vertical)
                                .focused($focus, equals: .subject)
                                .modifier(EditorField(mono: false))
                        }
                        DraftBodyEditor(text: $working.body, original: model.originalDraft?.body ?? "",
                                        focused: $bodyFocused, attachable: addable,
                                        attach: { working.attachmentDocumentIds.append($0) })
                            .padding(.top, 18)
                            .id(EditorAnchor.body)
                        if let original = model.originalDraft,
                           let summary = DraftChanges(original: original, current: result).summary {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Image(systemName: "pencil")
                                    .font(.mono(12, relativeTo: .caption))
                                    .foregroundStyle(Color.inkDim)
                                    .accessibilityHidden(true)
                                ProposalLabel("Aangepast door jou · \(summary)", color: .inkDim)
                            }
                            .dynamicTypeSize(...ProposalLabel.largest)
                            .padding(.top, 14)
                        }
                        attachments.padding(.top, 28).id(EditorAnchor.attachments)
                        Text("Klaar bewaart je versie en brengt je terug naar het voorstel. Versturen gebeurt daar, met vasthouden en Face ID.")
                            .font(.display(15, relativeTo: .callout))
                            .foregroundStyle(Color.inkMute)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 28)
                        Color.clear.frame(height: 1).id(EditorAnchor.end)
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 32)
                    .frameLeading()
                }
                .scrollDismissesKeyboard(.interactively)
                .task { await applyFixtureScroll(proxy) }
                }
                if confirmingDiscard { discardSheet }
            }
            .animation(.easeOut(duration: 0.2), value: confirmingDiscard)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Annuleren") {
                        if dirty { focus = nil; bodyFocused = false; confirmingDiscard = true } else { dismiss() }
                    }
                    .foregroundStyle(Color.signalLink)
                    .disabled(confirmingDiscard)
                }
                ToolbarItem(placement: .principal) {
                    Text("Concept aanpassen")
                        .font(.display(17, relativeTo: .headline, weight: .medium))
                        .foregroundStyle(Color.inkBright)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                        .accessibilityAddTraits(.isHeader)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Klaar") {
                        model.replaceDraft(result)
                        dismiss()
                    }
                    .foregroundStyle(Color.signalLink)
                    .disabled(confirmingDiscard)
                }
                // Over the keyboard: a file from the dossier, and the keyboard away.
                ToolbarItemGroup(placement: .keyboard) {
                    attachMenu {
                        // Words and icon both: a bare Label here draws the icon only.
                        HStack(spacing: 6) {
                            Image(systemName: "paperclip")
                            Text("Bijlage").font(.display(17, relativeTo: .body))
                        }
                        .foregroundStyle(Color.signalLink)
                        .fixedSize()
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("Bijlage uit je dossier")
                    }
                    Spacer()
                    Button { focus = nil } label: {
                        Image(systemName: "keyboard.chevron.compact.down")
                            .foregroundStyle(Color.signalLink)
                    }
                    .accessibilityLabel("Toetsenbord weg")
                }
            }
        }
        .preferredColorScheme(.dark)
        // A swipe down with edits is held: only Annuleren (which asks) or
        // Klaar can close it then.
        .interactiveDismissDisabled(dirty)
        .onChange(of: focus) { _, f in if f != nil { bodyFocused = false } }
        .onChange(of: bodyFocused) { _, on in if on { focus = nil } }
        .presentationDragIndicator(.visible)
        .task { await applyFixture() }
    }

    // MARK: - Rows

    private func row<C: View>(_ label: String, @ViewBuilder _ field: () -> C) -> some View {
        let layout = ax ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                        : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
        return VStack(spacing: 0) {
            layout {
                // A one-word label: set plainly (no whole-word stepping, which
                // measured it against the 96-pt column it no longer has at AX).
                Text(ax ? label : label.uppercased())
                    .font(.mono(12, relativeTo: .caption))
                    .tracking(ax ? 0 : 1.2)
                    .foregroundStyle(Color.inkLabel)
                    .fixedSize()
                    .dynamicTypeSize(...ProposalLabel.largest)
                    .frame(width: ax ? nil : 96, alignment: .leading)
                    .accessibilityHidden(true)
                field().accessibilityLabel(label)
            }
            .padding(.vertical, 12)
            Rectangle().fill(Color.hairline).frame(height: 1)
        }
    }

    @ViewBuilder
    private var attachments: some View {
        let ids = working.attachmentDocumentIds
        let known = Dictionary((model.detail?.attachments ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let offered = (model.detail?.attachable ?? [])
        let titles = Dictionary(offered.map { ($0.id, $0.title) }, uniquingKeysWith: { a, _ in a })
        VStack(alignment: .leading, spacing: 0) {
            ProposalLabel("Bijlagen · \(ids.count)")
            ForEach(Array(ids.enumerated()), id: \.element) { i, id in
                if i > 0 { Rectangle().fill(Color.hairline).frame(height: 1) }
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        let title = known[id]?.title ?? titles[id] ?? id
                        WrappingName(title, font: .display(17, relativeTo: .body, weight: .medium))
                            .foregroundStyle(Color.inkBright)
                        if let size = known[id]?.sizeBytes, size > 0 {
                            ProposalLabel([ProposalText.fileKind(title), ProposalText.bytes(size)].compactMap { $0 }
                                .joined(separator: " · "), color: .inkDim)
                        }
                    }
                    Spacer(minLength: 8)
                    Button {
                        working.attachmentDocumentIds.removeAll { $0 == id }
                    } label: {
                        Image(systemName: "xmark.circle")
                            .font(.system(size: 20))
                            .foregroundStyle(Color.inkSoft)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Haal \(known[id]?.title ?? titles[id] ?? "bijlage") weg")
                }
                .padding(.vertical, 4)
            }
            if !addable.isEmpty {
                attachMenu {
                    Label("Bijlage uit je dossier", systemImage: "plus")
                        .font(.display(17, relativeTo: .body))
                        .foregroundStyle(Color.signalLink)
                        .labelStyle(TightLabel())
                        .frame(minHeight: 44)
                }
                .padding(.top, 8)
            }
        }
    }

    /// What the dossier offers that is not attached yet: ONLY the server's
    /// `attachable` (approve refuses anything else).
    private var addable: [ProposalDetail.Attachable] {
        (model.detail?.attachable ?? []).filter { !working.attachmentDocumentIds.contains($0.id) }
    }

    private func attachMenu<L: View>(@ViewBuilder label: () -> L) -> some View {
        Menu {
            ForEach(addable) { doc in
                Button(doc.title) { working.attachmentDocumentIds.append(doc.id) }
            }
        } label: { label() }
        .disabled(addable.isEmpty)
    }

    /// The Aan field. At the accessibility sizes, at rest, the address WRAPS
    /// after "@" and its dots ("ilse@" / "noordkust." / "example") — a field
    /// would scroll it sideways and show a part; a tap puts the field back.
    @ViewBuilder
    private var toField: some View {
        if ax, focus != .to, !toText.isEmpty {
            Button { focus = .to } label: {
                WrappingName(toText, font: .display(17, relativeTo: .body))
                    .foregroundStyle(Color.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Dubbeltik om aan te passen")
        } else {
            TextField("", text: $toText, axis: ax ? .vertical : .horizontal)
                .keyboardType(.emailAddress)
                .focused($focus, equals: .to)
                .modifier(EditorField(mono: false))
        }
    }

    /// "Wijzigingen weggooien?" as a sheet from the bottom (frame "Aanpassen ·
    /// wijzigingen weggooien"): the question, the destructive row, and its
    /// own way back. Not a confirmationDialog: anchored to Annuleren, iOS 26
    /// draws that as a narrow popover with no cancel row.
    private var discardSheet: some View {
        ZStack(alignment: .bottom) {
            Color.scrim.ignoresSafeArea()
                .onTapGesture { confirmingDiscard = false }
                .accessibilityHidden(true)
            ViewThatFits(in: .vertical) {
                discardButtons
                ScrollView { discardButtons }.scrollBounceBehavior(.basedOnSize)
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
        }
        .transition(.opacity.combined(with: .move(edge: .bottom)))
        .accessibilityAddTraits(.isModal)
    }

    private var discardButtons: some View {
        VStack(spacing: 8) {
            VStack(spacing: 0) {
                VStack(spacing: 6) {
                    Text("Wijzigingen weggooien?")
                        .font(.display(17, relativeTo: .headline, weight: .medium))
                        .foregroundStyle(Color.inkBright)
                        .accessibilityAddTraits(.isHeader)
                    Text("Je aanpassingen aan dit concept gaan verloren. Het oorspronkelijke concept blijft staan.")
                        .font(.display(15, relativeTo: .callout))
                        .foregroundStyle(Color.inkMute)
                }
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity)
                .padding(16)
                Rectangle().fill(Color.hairline).frame(height: 1)
                Button(role: .destructive) { dismiss() } label: {
                    Label("Wijzigingen weggooien", systemImage: "trash")
                        .font(.display(17, relativeTo: .body))
                        .foregroundStyle(Color.inkBright)
                        .labelStyle(TightLabel())
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, minHeight: 56)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .background(sheetCard)
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.edgeStrong, lineWidth: 1))
            Button { confirmingDiscard = false } label: {
                Text("Doorgaan met aanpassen")
                    .font(.display(17, relativeTo: .body, weight: .medium))
                    .foregroundStyle(Color.signalLink)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, minHeight: 56)
                    .background(sheetCard)
                    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.edgeStrong, lineWidth: 1))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    /// An action-sheet card: opaque, so the editor never shows through it.
    private var sheetCard: some View {
        RoundedRectangle(cornerRadius: 14).fill(Color.void)
            .overlay(RoundedRectangle(cornerRadius: 14).fill(Color.plate))
    }

    static func addresses(_ text: String) -> [String] {
        ProposalScreenAddresses.split(text)
    }

    private enum EditorAnchor: Hashable { case body, attachments, end }

    private func applyFixtureScroll(_ proxy: ScrollViewProxy) async {
        #if DEBUG
        let scroll = FixtureLaunch.current?.scroll
        guard scroll == .end || scroll == .middle else { return }
        try? await Task.sleep(for: .milliseconds(500))
        // middle: the body's end at the bottom (the highlight in view).
        if scroll == .end { proxy.scrollTo(EditorAnchor.end, anchor: .bottom) }
        else { proxy.scrollTo(EditorAnchor.body, anchor: .bottom) }
        #endif
    }

    private func applyFixture() async {
        #if DEBUG
        switch FixtureLaunch.current?.proposal {
        case .typen?:
            try? await Task.sleep(for: .milliseconds(400))
            bodyFocused = true
        case .weggooien?:
            try? await Task.sleep(for: .milliseconds(400))
            confirmingDiscard = true
        default: break
        }
        #endif
    }
}

/// "ilse@a.example, demi@b.example" → the addresses (split on commas,
/// semicolons and whitespace).
enum ProposalScreenAddresses {
    static func split(_ text: String) -> [String] {
        text.split(whereSeparator: { $0 == "," || $0 == ";" || $0.isWhitespace })
            .map { String($0) }
            .filter { !$0.isEmpty }
    }
}

private struct EditorField: ViewModifier {
    let mono: Bool
    func body(content: Content) -> some View {
        content
            .font(mono ? .mono(15, relativeTo: .body) : .display(17, relativeTo: .body))
            .foregroundStyle(Color.ink)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
    }
}

// MARK: - Reject

/// "Voorstel afwijzen" (F-14, F-51): four reasons with one tap, or Martin's
/// own words, or neither. Nothing is sent; the reason goes to the server as
/// the one free-text `reason` the route takes (`ProposalText.rejectReason`).
struct RejectSheet: View {
    let model: ProposalModel
    @State private var choice: String?
    @State private var words = ""
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        NavigationStack {
            ZStack {
                Color.void.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Er wordt niets verstuurd. Waarom wijs je het af? Niet verplicht; het helpt de volgende concepten.")
                            .font(.display(15, relativeTo: .callout))
                            .foregroundStyle(Color.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(ProposalText.rejectReasons.enumerated()), id: \.element) { i, reason in
                                if i > 0 { Rectangle().fill(Color.hairline).frame(height: 1) }
                                Button {
                                    choice = choice == reason ? nil : reason
                                } label: {
                                    HStack(spacing: 12) {
                                        Text(reason)
                                            .font(.display(17, relativeTo: .body, weight: choice == reason ? .semibold : .regular))
                                            .foregroundStyle(choice == reason ? Color.inkBright : Color.ink)
                                            .multilineTextAlignment(.leading)
                                            .fixedSize(horizontal: false, vertical: true)
                                        Spacer(minLength: 8)
                                        if choice == reason {
                                            Image(systemName: "checkmark")
                                                .font(.system(size: 15, weight: .medium))
                                                .foregroundStyle(Color.signal)
                                        }
                                    }
                                    .padding(.vertical, 8)
                                    .frame(minHeight: 44)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityAddTraits(choice == reason ? .isSelected : [])
                            }
                        }
                        .padding(.horizontal, 16)
                        .glassPanel()
                        .padding(.top, 16)
                        TextField("", text: $words,
                                  prompt: Text("Of zeg het in je eigen woorden…").foregroundStyle(Color.inkDim),
                                  axis: .vertical)
                            .font(.display(17, relativeTo: .body))
                            .foregroundStyle(Color.ink)
                            .lineLimit(2, reservesSpace: true)
                            .padding(16)
                            .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
                            .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
                            .padding(.top, 16)
                        Text("Het voorstel verdwijnt uit Voor jou.")
                            .font(.display(15, relativeTo: .callout))
                            .foregroundStyle(Color.ink)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 20)
                        if let message = model.message {
                            Text(message)
                                .font(.display(15, relativeTo: .callout))
                                .foregroundStyle(Color.inkSoft)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.top, 8)
                        }
                        RejectButton(enabled: !model.isBusy) {
                            Task {
                                if await model.reject(reason: ProposalText.rejectReason(choice: choice, free: words)) {
                                    dismiss()
                                }
                            }
                        }
                        .padding(.top, 16)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .padding(.bottom, 24)
                    .frameLeading()
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Annuleren") { dismiss() }.foregroundStyle(Color.signalLink)
                }
                ToolbarItem(placement: .principal) {
                    Text("Voorstel afwijzen")
                        .font(.display(17, relativeTo: .headline, weight: .medium))
                        .foregroundStyle(Color.inkBright)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                        .accessibilityAddTraits(.isHeader)
                }
            }
        }
        .preferredColorScheme(.dark)
        .presentationDetents(typeSize.isAccessibilitySize ? [.large] : [.fraction(0.66), .large])
        .presentationDragIndicator(.visible)
        .task {
            #if DEBUG
            if FixtureLaunch.current?.proposal == .afwijzen { choice = ProposalText.rejectReasons[2] }
            #endif
        }
    }
}

/// "Afwijzen": outlined, its label in signal — rejecting is a choice, not a
/// danger, so never red and never the filled primary.
private struct RejectButton: View {
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text("Afwijzen")
                .wholeWords("Afwijzen", font: AuthType.button)
                .foregroundStyle(Color.signalLink)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(RoundedRectangle(cornerRadius: Radius.chip).fill(Color.field))
                .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
                .contentShape(Rectangle())
        }
        .buttonStyle(AuthPressStyle())
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.5)
    }
}
