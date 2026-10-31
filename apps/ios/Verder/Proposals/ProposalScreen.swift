import SwiftUI

/// One proposal: the trigger, what is asked and by when, what is missing, what
/// verder relied on, and the draft — editable, with Versturen behind a FRESH
/// Face ID every time (`ApprovalGate`). A question shows its options, each
/// with the server's own description of what it does.
struct ProposalScreen: View {
    let id: String
    let client: APIClient
    let gate: ApprovalGate
    let onUnauthorized: @MainActor () -> Void

    @State private var model: ProposalModel?
    @State private var editing = false
    @State private var toText = ""
    @State private var ccText = ""
    @State private var rejecting = false
    @State private var rejectReason = ""
    @State private var pendingOption: ProposalDetail.Option?
    @State private var freeText = ""

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    if let model, let detail = model.detail {
                        content(model, detail)
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
                let m = ProposalModel(client: client, gate: gate, onUnauthorized: onUnauthorized)
                model = m
                await m.load(id: id)
            }
        }
        // While a send is in flight, follow it until the worker settles it.
        .task(id: model?.status) {
            if model?.isSending == true { await model?.followSend() }
        }
        .sheet(isPresented: $rejecting) { rejectSheet }
        .confirmationDialog(pendingOption?.target ?? "", isPresented: Binding(
            get: { pendingOption != nil }, set: { if !$0 { pendingOption = nil } }
        ), titleVisibility: .visible) {
            if let option = pendingOption {
                Button(option.label) { Task { _ = await model?.answer(option: option.index); pendingOption = nil } }
            }
            Button("Annuleren", role: .cancel) { pendingOption = nil }
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private func content(_ model: ProposalModel, _ d: ProposalDetail) -> some View {
        header(model, d)
        if let ask = d.ask { section("Wat ze vragen") { para(ask) } }
        if let due = model.dueText {
            Text(due)
                .font(.mono(13, relativeTo: .callout, weight: .medium))
                .foregroundStyle(model.isPending ? Color.attn : Color.ink)
        }
        if model.showsMissing {
            section("Wat nog ontbreekt") {
                ForEach(model.missing, id: \.self) { item in para("· \(item)") }
            }
        }
        if !d.reliedOn.isEmpty {
            section("Waar verder op leunt") {
                ChipFlow(spacing: 6) {
                    ForEach(d.reliedOn, id: \.id) { c in chip(c.label) }
                }
            }
        }
        if model.draft != nil { draftSection(model) }
        if let prompt = model.questionPrompt { questionSection(model, prompt) }
        if let title = model.proposedTaskTitle {
            if model.taskCreated {
                Text("Taak aangemaakt: \(title)")
                    .font(.mono(12, relativeTo: .caption))
                    .foregroundStyle(Color.steel)
            } else {
                AuthButton(title: "Taak aanmaken: \(title)", weight: .secondary, enabled: !model.isBusy) {
                    Task { await model.createTask() }
                }
            }
        }
        if let message = model.message {
            Text(message)
                .font(.display(14, relativeTo: .callout, weight: .light))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        if let line = model.statusLine {
            Text(line)
                .font(.mono(13, relativeTo: .callout, weight: .medium))
                .foregroundStyle(model.status == "sent" ? Color.steel : Color.ink)
        }
        if model.isPending { actions(model) }
    }

    private func header(_ model: ProposalModel, _ d: ProposalDetail) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.isPending {
                Text("WACHT OP JOU")
                    .font(.mono(11, relativeTo: .caption2, weight: .medium))
                    .foregroundStyle(Color.attn)
            }
            Text(d.trigger.from ?? d.partyName ?? "Onbekend")
                .font(.display(22, relativeTo: .title2, weight: .light))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
            if let note = model.senderNote {
                Text(note).font(.mono(11, relativeTo: .caption2)).foregroundStyle(Color.inkMute)
            }
            HStack(spacing: 8) {
                Text(ProposalFormat.kind(d.kind))
                if let date = d.trigger.date ?? d.triggerAt { Text(ProposalFormat.dateTime(date)) }
            }
            .font(.mono(11, relativeTo: .caption2))
            .foregroundStyle(Color.inkDim)
            if let subject = d.trigger.subject {
                Text(subject).font(.display(15, relativeTo: .body)).foregroundStyle(Color.ink)
            }
            if let excerpt = d.trigger.excerpt {
                Text(excerpt)
                    .font(.display(14, relativeTo: .callout, weight: .light))
                    .foregroundStyle(Color.inkMute)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func draftSection(_ model: ProposalModel) -> some View {
        if let draft = model.draft {
            section("Concept") {
                if editing {
                    field("Aan", text: $toText)
                        .onChange(of: toText) { _, _ in pushRecipients(model) }
                    field("Cc", text: $ccText)
                        .onChange(of: ccText) { _, _ in pushRecipients(model) }
                    field("Onderwerp", text: Binding(get: { model.draft?.subject ?? "" },
                                                     set: { model.edit(subject: $0) }))
                    TextEditor(text: Binding(get: { model.draft?.body ?? "" }, set: { model.edit(body: $0) }))
                        .font(.display(15, relativeTo: .body))
                        .foregroundStyle(Color.ink)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 220)
                        .padding(8)
                        .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
                        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
                } else {
                    meta("Aan", draft.to.joined(separator: ", "))
                    if !draft.cc.isEmpty { meta("Cc", draft.cc.joined(separator: ", ")) }
                    meta("Onderwerp", draft.subject)
                    Text(draft.body)
                        .font(.display(15, relativeTo: .body))
                        .foregroundStyle(Color.ink)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .glassPanel()
                }
            }
            section("Bijlagen") {
                if model.attachmentRows.isEmpty { para("Geen bijlagen.") }
                ForEach(model.attachmentRows) { a in
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(a.title)
                                .font(.display(14, relativeTo: .callout))
                                .foregroundStyle(a.unavailable ? Color.inkMute : Color.ink)
                                .strikethrough(a.unavailable)
                            Text(a.unavailable ? "niet meer beschikbaar" : ProposalFormat.bytes(a.sizeBytes))
                                .font(.mono(11, relativeTo: .caption2))
                                .foregroundStyle(Color.inkDim)
                        }
                        Spacer()
                        if model.isPending && (editing || a.unavailable) {
                            Button("Weghalen") { model.edit(removing: a.id) }
                                .font(.mono(12, relativeTo: .caption, weight: .medium))
                                .foregroundStyle(Color.signalLink)
                        }
                    }
                }
                if editing, !model.attachableNotAttached.isEmpty {
                    Menu {
                        ForEach(model.attachableNotAttached) { doc in
                            Button(doc.title) { model.attach(doc.id) }
                        }
                    } label: {
                        Text("Bijlage toevoegen")
                            .font(.mono(12, relativeTo: .caption, weight: .medium))
                            .foregroundStyle(Color.signalLink)
                    }
                }
            }
            section("In het logboek als") {
                if editing {
                    field("Samenvatting", text: Binding(get: { model.draft?.entrySummary ?? "" },
                                                        set: { model.setEntrySummary(String($0.prefix(100))) }))
                } else {
                    para(draft.entrySummary)
                }
            }
        }
    }

    private func questionSection(_ model: ProposalModel, _ prompt: String) -> some View {
        section("Vraag") {
            para(prompt)
            if model.isPending {
                ForEach(model.optionButtons) { option in
                    Button { pendingOption = option } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(option.label)
                                .font(.mono(14, relativeTo: .body, weight: .medium))
                                .foregroundStyle(Color.signalLink)
                            Text(option.target)
                                .font(.display(13, relativeTo: .footnote, weight: .light))
                                .foregroundStyle(Color.inkMute)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
                        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .disabled(model.isBusy)
                }
                field("Iets anders…", text: $freeText)
                AuthButton(title: "Antwoorden", weight: .secondary,
                           enabled: !model.isBusy && !freeText.trimmingCharacters(in: .whitespaces).isEmpty) {
                    Task { if await model.answer(freeText: freeText) { freeText = "" } }
                }
            }
        }
    }

    @ViewBuilder
    private func actions(_ model: ProposalModel) -> some View {
        VStack(spacing: 10) {
            if model.draft != nil {
                AuthButton(title: "Versturen", enabled: model.canSend) {
                    pushRecipients(model)
                    Task {
                        if await model.approve() == .approved { editing = false }
                    }
                }
                AuthButton(title: editing ? "Klaar met aanpassen" : "Aanpassen", weight: .secondary,
                           enabled: !model.isBusy) {
                    if !editing, let d = model.draft {
                        toText = d.to.joined(separator: ", ")
                        ccText = d.cc.joined(separator: ", ")
                    }
                    editing.toggle()
                }
            }
            AuthButton(title: "Afwijzen", weight: .secondary, enabled: !model.isBusy) { rejecting = true }
        }
    }

    private var rejectSheet: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 16) {
                Text("Afwijzen")
                    .font(.display(22, relativeTo: .title2, weight: .light))
                    .foregroundStyle(Color.inkBright)
                Text("Waarom? Niet verplicht — verder leert ervan.")
                    .font(.display(14, relativeTo: .callout, weight: .light))
                    .foregroundStyle(Color.inkMute)
                field("Reden", text: $rejectReason)
                AuthButton(title: "Afwijzen", enabled: model?.isBusy == false) {
                    Task {
                        if await model?.reject(reason: rejectReason) == true { rejecting = false }
                    }
                }
                AuthButton(title: "Annuleren", weight: .secondary) { rejecting = false }
                Spacer()
            }
            .padding(16)
        }
        .preferredColorScheme(.dark)
        .presentationDetents([.medium])
    }

    // MARK: - Pieces

    private func pushRecipients(_ model: ProposalModel) {
        guard editing else { return }
        model.setRecipients(to: Self.addresses(toText), cc: Self.addresses(ccText))
    }

    static func addresses(_ text: String) -> [String] {
        text.split(whereSeparator: { $0 == "," || $0 == ";" || $0.isWhitespace })
            .map { String($0) }
            .filter { !$0.isEmpty }
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased())
                .font(.mono(11, relativeTo: .caption2, weight: .medium))
                .foregroundStyle(Color.inkLabel)
            content()
        }
    }

    private func para(_ text: String) -> some View {
        Text(text)
            .font(.display(15, relativeTo: .body, weight: .light))
            .foregroundStyle(Color.ink)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func meta(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label).font(.mono(11, relativeTo: .caption2)).foregroundStyle(Color.inkDim).frame(width: 74, alignment: .leading)
            Text(value).font(.display(14, relativeTo: .callout)).foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func field(_ label: String, text: Binding<String>) -> some View {
        TextField(label, text: text, axis: .vertical)
            .font(.display(15, relativeTo: .body))
            .foregroundStyle(Color.ink)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(10)
            .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
            .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
    }

    private func chip(_ text: String) -> some View {
        Text(text)
            .font(.mono(11, relativeTo: .caption2))
            .foregroundStyle(Color.steel)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edge, lineWidth: 1))
    }
}

/// Lays chips out left to right, wrapping to the next line.
struct ChipFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { x = 0; y += line + spacing; line = 0 }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX { x = bounds.minX; y += line + spacing; line = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}
