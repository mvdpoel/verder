import SwiftUI

/// What a question says, as pure functions (Figma "detail · final", Vraag).
/// Tested in `DetailTextTests`.
enum QuestionText {
    /// "VRAAG VAN GRIP · ZO 1 NOV": who asks, and the day of what started it.
    static func eyebrow(_ d: ProposalDetail) -> [String] {
        ["Vraag van Grip", DetailText.dayName(d.trigger.date ?? d.triggerAt ?? d.createdAt)]
    }

    /// The question itself is the title.
    static func title(_ d: ProposalDetail) -> String {
        d.payload?.question?.prompt ?? d.ask ?? "Vraag"
    }

    /// An option with consequences asks first (brief §3); "none" changes
    /// nothing and is recorded at once.
    static func needsConfirmation(_ o: ProposalDetail.Option) -> Bool { o.action != "none" }

    /// An option that changes nothing goes back to Voor jou and is HELD there
    /// with "Beantwoord: Nee · Ongedaan maken" before it posts (the frame
    /// "beantwoord · Nee of Weet ik niet"); nil for one that asks first, or
    /// without the revision the answer must name.
    static func handBack(_ o: ProposalDetail.Option, revision: Int?) -> ListDecision.Action? {
        guard !needsConfirmation(o), let revision else { return nil }
        return .answer(option: o.index, revision: revision, label: o.label)
    }

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
        // "Daar": the vordering, where "Brief losmaken" leads.
        case "link-document-to-debt": return "\(target) Je kunt hem daar later weer losmaken."
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

    /// Under "Brief gekoppeld aan de vordering": the way back. The phone has
    /// no route to unlink (`debts.unlinkDocument` is the web's), so "Brief
    /// losmaken" OPENS the vordering on the website and the note says so.
    /// Not the frame's "Ook dat wordt vastgelegd": a `debt_documents` link is
    /// not evidence, and removing it appends nothing to the ledger.
    static func undoNote(_ o: ProposalDetail.Option) -> String? {
        o.action == "link-document-to-debt" ? "Verkeerd gekozen? Maak de brief weer los op de website." : nil
    }

    /// Where "Brief losmaken" goes on the website: the vordering itself when
    /// the server named it, else the vorderingen.
    static func unlinkPath(_ o: ProposalDetail.Option) -> String? {
        guard o.action == "link-document-to-debt" else { return nil }
        return o.debtId.map { "registry/debts/\($0)" } ?? "registry"
    }

    static let nothingChanged = "Er is niets veranderd. Je antwoord staat bij de vraag."
    /// Not the frame's "Grip bekijkt je antwoord": nothing reads a free
    /// answer yet (FEATURES "Grip pakt een vrij antwoord op").
    static let freeTextKept = "Er is nog niets gekoppeld; je antwoord staat bij de vraag. Stelt Grip iets voor, dan zie je dat in Voor jou."
    static let offline = "Je bent offline. Antwoorden kan weer zodra je verbinding hebt."
    static let unreached = "Je antwoord kwam niet aan bij Grip. Er is niets gekoppeld; je kunt het opnieuw proberen."
    static let ownAnswerNote = "Je antwoord gaat alleen naar Grip. Er gaat niets naar anderen."
}

/// The body of a question: why Grip asks, the options, an own answer —
/// or, once answered, what was answered and what happened.
struct QuestionBody: View {
    let model: ProposalModel
    let detail: ProposalDetail
    let now: Date
    @Binding var pendingOption: ProposalDetail.Option?
    @Binding var freeText: String
    var focus: FocusState<Bool>.Binding
    let onTrigger: () -> Void
    /// The website, for what the phone hands over to it ("Brief losmaken").
    var base: URL? = nil
    @Environment(\.networkOffline) private var offline
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.voorJouNext) private var next
    @Environment(\.openURL) private var openURL
    /// The trailing link glyph grows with the option's words.
    @ScaledMetric(relativeTo: .body) private var glyph: CGFloat = 17

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
                .padding(.top, 24)
                if !offline { ownAnswer.padding(.top, 24) }
            }
        }
    }

    /// "WAAROM GRIP HET VRAAGT": Grip's own reason where it wrote one,
    /// else what started the question. Opens the source.
    @ViewBuilder private var why: some View {
        if let text = detail.payload?.question?.why?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            let card = HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    DetailLabel("Waarom Grip het vraagt")
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
                    if QuestionText.needsConfirmation(option) {
                        pendingOption = option
                    } else if let hand = next?.hand, let action = QuestionText.handBack(option, revision: model.revision) {
                        hand(detail.id, action, QuestionText.title(detail))
                    } else {
                        Task { await answer(option.index) }
                    }
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
                                .font(.system(size: glyph, weight: .regular))
                                .foregroundStyle(Color.signal)
                                .accessibilityHidden(true)
                        }
                    }
                    .padding(.vertical, 11)
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
            // While typing, the screen keeps this end above the keyboard:
            // the button and the reassurance under it both show.
            Color.clear.frame(height: 1).id(ProposalAnchor.answerEnd)
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
                // The brief it is about opens from the row.
                DetailRow(title: o.title, meta: o.meta, dot: .steel,
                          route: detail.trigger.type == "document"
                              ? .document(id: detail.trigger.id, title: detail.trigger.subject ?? "Brief") : nil)
                if let note = QuestionText.undoNote(option) {
                    DetailPara(note, color: .inkMute, size: 15).padding(.horizontal, 16).padding(.top, 14)
                }
                if let path = QuestionText.unlinkPath(option), let base {
                    AuthButton(title: "Brief losmaken", weight: .outline) { openURL(base.appending(path: path)) }
                        .accessibilityHint("Opent de vordering op de website.")
                        .padding(.top, 16)
                }
            } else {
                DetailPara(a?.freeText != nil ? QuestionText.freeTextKept : QuestionText.nothingChanged,
                           color: .inkMute, size: 15)
                    .padding(.horizontal, 16).padding(.top, 10)
            }
        }
        .padding(.top, 32)
    }
}
