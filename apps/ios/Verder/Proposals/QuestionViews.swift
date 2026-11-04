import SwiftUI

/// What a question says, as pure functions (Figma "detail · final", Vraag).
/// Tested in `DetailTextTests`.
enum QuestionText {
    /// "VRAAG VAN VERDER · ZO 1 NOV": who asks, and the day of what started it.
    static func eyebrow(_ d: ProposalDetail) -> [String] {
        ["Vraag van verder", DetailText.dayName(d.trigger.date ?? d.triggerAt ?? d.createdAt)]
    }

    /// The question itself is the title.
    static func title(_ d: ProposalDetail) -> String {
        d.payload?.question?.prompt ?? d.ask ?? "Vraag"
    }

    /// An option with consequences asks first (brief §3); "none" changes
    /// nothing and is recorded at once.
    static func needsConfirmation(_ o: ProposalDetail.Option) -> Bool { o.action != "none" }

    /// The short line under an option: "VRAAGT EERST BEVESTIGING" where it
    /// asks first (its sheet then says what happens, in the server's words);
    /// otherwise the SERVER's own description — never only the model's label.
    static func consequence(_ o: ProposalDetail.Option) -> String {
        needsConfirmation(o) ? "Vraagt eerst bevestiging" : o.target
    }

    static func confirmTitle(_ o: ProposalDetail.Option, triggerType: String) -> String {
        switch o.action {
        case "link-document-to-debt":
            triggerType == "document" ? "Brief koppelen aan de vordering?" : "Document koppelen aan de vordering?"
        case "set-task-status": "Taakstatus wijzigen?"
        case "create-task": "Taak aanmaken?"
        default: "\(o.label)?"
        }
    }

    /// The server's description, plus where a link can be undone.
    static func confirmText(_ o: ProposalDetail.Option) -> String {
        let target = o.target.last.map { ".?!".contains($0) } == true ? o.target : o.target + "."
        switch o.action {
        case "link-document-to-debt": return "\(target) Je kunt hem daar later weer losmaken op de website."
        case "set-task-status": return "\(target) Ook dat wordt vastgelegd."
        default: return target
        }
    }

    /// The row under "WAT ER IS GEBEURD", or nil when nothing changed.
    static func outcome(_ o: ProposalDetail.Option, partyName: String?) -> (title: String, meta: String)? {
        switch o.action {
        case "link-document-to-debt":
            ("Brief gekoppeld aan de vordering", ["Vordering", partyName].compactMap { $0 }.joined(separator: " · "))
        case "set-task-status": ("Taakstatus gewijzigd", o.target)
        case "create-task": ("Taak aangemaakt", o.target)
        default: nil
        }
    }

    static let nothingChanged = "Er is niets veranderd. Je antwoord staat bij de vraag."
    static let freeTextKept = "Er is niets gekoppeld; je antwoord staat bij de vraag, en verder doet er niets mee zonder jou."
    static let offline = "Je bent offline. Antwoorden kan weer zodra je verbinding hebt."
    static let unreached = "Je antwoord kwam niet aan bij verder. Er is niets gekoppeld; je kunt het opnieuw proberen."
    static let ownAnswerNote = "Je antwoord gaat alleen naar verder. Er gaat niets naar anderen."
}

/// The body of a question: why verder asks, the options, an own answer —
/// or, once answered, what was answered and what happened.
struct QuestionBody: View {
    let model: ProposalModel
    let detail: ProposalDetail
    let now: Date
    @Binding var pendingOption: ProposalDetail.Option?
    @Binding var freeText: String
    var focus: FocusState<Bool>.Binding
    let onTrigger: () -> Void
    @Environment(\.networkOffline) private var offline
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if detail.status == "sent" {
            answered
        } else {
            open
        }
    }

    // MARK: Open

    @ViewBuilder private var open: some View {
        if let failed = model.failedOption, let option = model.optionButtons.first(where: { $0.index == failed }) {
            DetailNotice(label: "Niet aangekomen", text: QuestionText.unreached).padding(.top, 24)
            AuthButton(title: "Opnieuw: \(option.label)", enabled: !model.isBusy && !offline) {
                Task { await answer(option.index) }
            }
            .padding(.top, 24)
            let rest = model.optionButtons.filter { $0.index != failed }
            if !rest.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    DetailLabel("Of kies opnieuw").padding(.horizontal, 16)
                    options(rest)
                }
                .padding(.top, 32)
            }
        } else {
            if model.isPending { why.padding(.top, 24) }
            if let message = model.message {
                DetailPara(message, size: 15).padding(.top, 16)
            }
            if model.isPending {
                VStack(alignment: .leading, spacing: 12) {
                    // A capture's `--scroll middle` puts the options at the top.
                    DetailLabel("Kies een antwoord").padding(.horizontal, 16).id(ProposalAnchor.attachments)
                    options(model.optionButtons)
                    if offline { DetailPara(QuestionText.offline, color: .inkMute, size: 15).padding(.horizontal, 16).padding(.top, 8) }
                }
                .padding(.top, 32)
                if !offline { ownAnswer.padding(.top, 32) }
            }
        }
    }

    /// "WAAROM VERDER HET VRAAGT": verder's own reason where it wrote one,
    /// else what started the question. Opens the source.
    @ViewBuilder private var why: some View {
        if let text = detail.payload?.question?.why?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            let card = HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    DetailLabel("Waarom verder het vraagt")
                    DetailPara(text)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                RowChevron().padding(.top, 2)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassPanel()
            .contentShape(Rectangle())
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            if detail.trigger.type == "document" {
                NavigationLink(value: InboxRoute.document(id: detail.trigger.id, title: detail.trigger.subject ?? "Brief")) { card }
                    .buttonStyle(.plain)
            } else {
                Button(action: onTrigger) { card }.buttonStyle(.plain)
            }
        } else {
            if detail.trigger.type == "document" {
                NavigationLink(value: InboxRoute.document(id: detail.trigger.id, title: detail.trigger.subject ?? "Brief")) {
                    TriggerCard(model: model, detail: detail, now: now)
                }
                .buttonStyle(.plain)
            } else {
                Button(action: onTrigger) { TriggerCard(model: model, detail: detail, now: now) }.buttonStyle(.plain)
            }
        }
    }

    private func options(_ list: [ProposalDetail.Option]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(list.enumerated()), id: \.element.id) { i, option in
                if i > 0 { Rectangle().fill(Color.hairline).frame(height: 1) }
                Button {
                    if QuestionText.needsConfirmation(option) { pendingOption = option }
                    else { Task { await answer(option.index) } }
                } label: {
                    HStack(alignment: .center, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(option.label)
                                .wholeWords(option.label, font: .display(17, relativeTo: .body, weight: .medium))
                                .foregroundStyle(Color.inkBright)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                            // At the accessibility sizes the line is set in Saira, as
                            // a sentence (frame "Vraag / AX5 · gescrold").
                            if typeSize.isAccessibilitySize {
                                DetailPara(QuestionText.consequence(option), color: .inkMute)
                            } else {
                                DetailLabel(QuestionText.consequence(option))
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if option.action == "link-document-to-debt" {
                            Image(systemName: "link")
                                .font(.system(size: 17, weight: .regular))
                                .foregroundStyle(Color.signal)
                                .accessibilityHidden(true)
                        }
                    }
                    .padding(.vertical, 14)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(AuthPressStyle())
                .disabled(model.isBusy || offline)
                .opacity(offline ? 0.55 : 1)
                .accessibilityHint(QuestionText.needsConfirmation(option) ? "Vraagt eerst bevestiging." : option.target)
            }
        }
        .padding(.horizontal, 16)
        .glassPanel()
    }

    private var ownAnswer: some View {
        let typed = !freeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return VStack(alignment: .leading, spacing: 12) {
            DetailLabel("Iets anders").padding(.horizontal, 16)
            TextField("Typ je eigen antwoord", text: $freeText, axis: .vertical)
                .lineLimit(1...8)
                .focused(focus)
                .modifier(DetailInputStyle(focused: focus.wrappedValue))
            AuthButton(title: "Geef antwoord", weight: typed ? .primary : .secondary, enabled: typed && !model.isBusy) {
                Task {
                    if await model.answer(freeText: freeText) { freeText = ""; focus.wrappedValue = false }
                }
            }
            if typed { DetailPara(QuestionText.ownAnswerNote, color: .inkMute, size: 15).padding(.horizontal, 16) }
        }
    }

    private func answer(_ index: Int) async {
        _ = await model.answer(option: index)
    }

    // MARK: Answered

    @ViewBuilder private var answered: some View {
        let a = model.shownAnswer
        let option = a?.option.flatMap { i in model.optionButtons.first { $0.index == i } }
        if let a, option != nil || a.freeText != nil {
            DetailCard("Je antwoord") {
                if let option {
                    DetailPara(option.label)
                } else if let text = a.freeText {
                    DetailPara("“\(text)”", size: 15)
                }
            }
            .padding(.top, 24)
        }
        VStack(alignment: .leading, spacing: 0) {
            DetailLabel("Wat er is gebeurd").padding(.horizontal, 16)
            if let option, let o = QuestionText.outcome(option, partyName: detail.partyName) {
                DetailRow(title: o.title, meta: o.meta, dot: .steel)
            } else {
                DetailPara(a?.freeText != nil ? QuestionText.freeTextKept : QuestionText.nothingChanged,
                           color: .inkMute, size: 15)
                    .padding(.horizontal, 16).padding(.top, 10)
            }
        }
        .padding(.top, 32)
    }
}
