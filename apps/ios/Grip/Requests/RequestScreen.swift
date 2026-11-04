import SwiftUI

/// One question and what Grip made of it (frames "antwoord · *"): the outcome,
/// Martin's own words, the answer, what only he can do (tappable), the
/// proposal card — which opens the EXISTING proposal screen, where sending
/// stays behind Face ID — and the sources. While Grip works, "Wat Grip nu
/// doet" is live (polled). "Vraag door" asks a follow-up in the same thread.
struct RequestScreen: View {
    let store: RequestStore
    @State private var model: RequestScreenModel
    @State private var expandedEarlier = false
    @State private var bankSource: RequestDetail.Source?
    @State private var confirmingStop = false
    @State private var scrolled = false
    @Environment(\.requestActions) private var actions
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.networkOffline) private var offline
    /// The account a bank row names ("Leefgeldrekening"), from Geld.
    var accountName: (String) -> String? = { _ in nil }
    let push: (InboxRoute) -> Void

    init(id: String, store: RequestStore, accountName: @escaping (String) -> String? = { _ in nil },
         push: @escaping (InboxRoute) -> Void) {
        self.store = store
        self.accountName = accountName
        self.push = push
        _model = State(initialValue: RequestScreenModel(id: id, store: store))
    }

    private var ax: Bool { typeSize.isAccessibilitySize }
    private var now: Date { store.now() }

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            if let d = model.detail {
                page(d)
            } else if let e = model.loadError {
                VStack(spacing: 16) {
                    Text(e == .unauthorized ? "Log opnieuw in." : (isTransport(e) ? "Er is geen verbinding. Je vraag staat veilig bij Grip." : "Dit antwoord laadt nu niet. Er is niets verloren gegaan."))
                        .font(.display(17, relativeTo: .body))
                        .foregroundStyle(Color.ink)
                        .multilineTextAlignment(.center)
                    AuthButton(title: RequestText.retry, weight: .outline) { Task { await model.load() } }
                }
                .padding(24)
            } else {
                ProgressView().tint(Color.signal)
            }
        }
        // The inline title only once the big one has scrolled away (frame
        // "antwoord · met voorstel · gescrold").
        .navigationTitle(scrolled ? RequestText.answerNav : "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.hidden, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { if let d = model.detail { menu(d) } } }
        .task { await model.poll() }
        .sensoryFeedback(.impact(weight: .light), trigger: model.ticks)
        .sensoryFeedback(.warning, trigger: model.detail?.status == "failed")
        .sheet(item: $bankSource) { s in
            RequestBankSheet(source: s, accountName: accountName, now: now) {
                bankSource = nil
                actions?.openLink(.money)
            }
            .presentationDetents([.medium])
        }
        .onChange(of: model.announced) { _, line in
            if let line { AccessibilityNotification.Announcement(line).post() }
        }
        #if DEBUG
        .task { await applyFixture() }
        #endif
    }

    private func isTransport(_ e: APIError) -> Bool { if case .transport = e { true } else { false } }

    // MARK: - Page

    private func page(_ d: RequestDetail) -> some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if !d.thread.isEmpty { earlier(d).padding(.bottom, 20) }
                if !d.thread.isEmpty { question(d).padding(.bottom, 20) }
                if d.thread.isEmpty { ProposalLabel(RequestText.eyebrow(d)).padding(.bottom, 4) }
                title(d)
                statusLine(d).padding(.top, 8)
                if d.thread.isEmpty { question(d).padding(.top, 20) }
                content(d)
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 32)
        }
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .onScrollGeometryChange(for: Bool.self) { $0.contentOffset.y + $0.contentInsets.top > 90 } action: { _, past in
            scrolled = past
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if let t = store.toast { RequestToastView(toast: t) { Task { await store.undo(t) } } }
                if let bar = followUpBar(d) { bar }
            }
        }
        .refreshable { await model.load() }
        #if DEBUG
        // `--scroll middle`: the frame "· gescrold", the steps at the top.
        .task {
            guard FixtureLaunch.current?.scroll != nil else { return }
            try? await Task.sleep(for: .milliseconds(900))
            proxy.scrollTo("steps", anchor: .top)
        }
        #endif
        }
    }

    private func title(_ d: RequestDetail) -> some View {
        let text = RequestText.headline(d)
        return Text(text)
            .wholeWords(text, font: .display(28, relativeTo: .title, weight: ax ? .medium : .regular))
            .foregroundStyle(Color.inkBright)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    private func statusLine(_ d: RequestDetail) -> some View {
        let s = RequestText.status(d, now: now)
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Group {
                switch s.dot {
                case .ring: Circle().strokeBorder(Color.steel, lineWidth: 1.5)
                case .steel: Circle().fill(Color.steel)
                case .okay: Circle().fill(Color.okay)
                case .dim: Circle().fill(Color.inkDim)
                }
            }
            .frame(width: 7, height: 7)
            .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
            .accessibilityHidden(true)
            RequestMetaLine(parts: s.text.components(separatedBy: " · "), color: .inkLabel)
        }
    }

    private func question(_ d: RequestDetail) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Rectangle().fill(Color.edgeStrong).frame(width: 2)
            VStack(alignment: .leading, spacing: 4) {
                ProposalLabel(RequestText.questionLabel(d))
                Text(d.text)
                    .font(.display(15, relativeTo: .callout))
                    .foregroundStyle(Color.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }

    /// The thread's earlier questions, folded to one card each; a tap opens them.
    @ViewBuilder private func earlier(_ d: RequestDetail) -> some View {
        ForEach(d.thread) { e in
            Button { withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { expandedEarlier.toggle() } } label: {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        ProposalLabel("\(RequestText.firstQuestion) · \(HomeSummary.clock(e.createdAt))")
                        Spacer()
                        Image(systemName: expandedEarlier ? "chevron.down" : "chevron.right")
                            .font(.system(size: 12, weight: .medium)).foregroundStyle(Color.inkDim)
                    }
                    Text(e.title)
                        .font(.display(17, relativeTo: .body, weight: .medium))
                        .foregroundStyle(Color.inkBright)
                        .fixedSize(horizontal: false, vertical: true)
                    if expandedEarlier, let answer = e.answer {
                        answerBlocks(answer)
                    } else {
                        Text(RequestText.earlierSummary(e))
                            .font(.display(15, relativeTo: .callout))
                            .foregroundStyle(Color.inkMute)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .multilineTextAlignment(.leading)
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassPanel()
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(expandedEarlier ? "Klapt in" : "Klapt uit")
        }
    }

    // MARK: - By state

    @ViewBuilder private func content(_ d: RequestDetail) -> some View {
        switch d.status {
        case "queued":
            expectation.padding(.top, 20)
            skeleton.padding(.top, 20)
            stopLink(d).padding(.top, 20)
        case "working":
            if let p = d.progress, !p.steps.isEmpty {
                section(RequestText.whatGripDoes) { activity(p.steps) }.padding(.top, 20)
            }
            if d.parentRequestId == nil {
                expectation.padding(.top, 20)
                skeleton.padding(.top, 20)
            } else if let card = RequestText.card(d) {
                proposalCard(card, d).padding(.top, 20)
            }
            stopLink(d).padding(.top, 20)
        case "failed":
            failureCard(d).padding(.top, 20)
            if let p = d.progress, !p.steps.isEmpty {
                section(RequestText.whatGripDid) { activity(p.steps) }.padding(.top, 20)
            }
            failedActions(d).padding(.top, 20)
        case "cancelled":
            Text(RequestText.stoppedBody)
                .font(.display(17, relativeTo: .body))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 20)
            AuthButton(title: RequestText.askAgain, weight: .outline) { Task { await askAgain(d) } }
                .padding(.top, 20)
            linkButton(RequestText.letGo) { Task { await letGo(d) } }.padding(.top, 12)
        default:
            if let answer = d.answer { answerBlocks(answer).padding(.top, 20) }
            if !d.steps.isEmpty {
                Color.clear.frame(height: 0).id("steps")
                section(RequestText.yourSteps) {
                    VStack(alignment: .leading, spacing: 0) { ForEach(d.steps) { stepRow($0) } }
                }
                .padding(.top, 20)
            }
            if let card = RequestText.card(d) { proposalCard(card, d).padding(.top, 20) }
            if !d.sources.isEmpty {
                section("\(RequestText.sources)  \(d.sources.count)") {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(d.sources.enumerated()), id: \.offset) { i, s in sourceRow(s, index: i, d) }
                    }
                }
                .padding(.top, 20)
            }
        }
    }

    private func section<C: View>(_ label: String, @ViewBuilder _ body: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ProposalLabel(label)
            body()
        }
    }

    private var expectation: some View {
        Text(RequestText.expectation)
            .font(.display(15, relativeTo: .callout))
            .foregroundStyle(Color.inkMute)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var skeleton: some View {
        VStack(spacing: 0) {
            ForEach(0..<3, id: \.self) { _ in
                HStack(alignment: .top, spacing: 0) {
                    Circle().fill(Color.inkFaint.opacity(0.5)).frame(width: 7, height: 7)
                        .frame(width: 36, alignment: .leading).padding(.top, 22)
                    VStack(alignment: .leading, spacing: 8) {
                        RoundedRectangle(cornerRadius: 1).fill(Color.inkSoft.opacity(0.07)).frame(width: 220, height: 12)
                        RoundedRectangle(cornerRadius: 1).fill(Color.inkSoft.opacity(0.07)).frame(width: 110, height: 8)
                    }
                    .padding(.vertical, 16)
                    Spacer(minLength: 0)
                }
                .overlay(alignment: .bottom) { RowHairlineShape(leading: 36) }
            }
        }
        .accessibilityHidden(true)
    }

    private func stopLink(_ d: RequestDetail) -> some View {
        HStack {
            Spacer()
            linkButton(RequestText.stop) { Task { _ = await store.cancel(d.id); await model.load() } }
            Spacer()
        }
    }

    private func linkButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .wholeWords(title, font: .display(17, relativeTo: .body, weight: .medium))
                .foregroundStyle(Color.signal)
                .frame(minHeight: 44)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
    }

    private func activity(_ steps: [RequestDetail.Progress.Step]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.offset) { _, s in
                HStack(alignment: .firstTextBaseline, spacing: 14) {
                    Group {
                        switch s.state {
                        case "current":
                            if reduceMotion {
                                Circle().trim(from: 0, to: 0.75).stroke(Color.ink, lineWidth: 1.5)
                            } else {
                                SpinningArc()
                            }
                        case "failed":
                            Image(systemName: "xmark.circle").foregroundStyle(Color.inkDim)
                        default:
                            Image(systemName: "checkmark.circle").foregroundStyle(Color.okay)
                        }
                    }
                    .font(.system(size: 20))
                    .frame(width: 22, height: 22)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 5 }
                    .accessibilityHidden(true)
                    Text(s.label)
                        .font(.display(17, relativeTo: .body, weight: .medium))
                        .foregroundStyle(s.state == "current" ? Color.inkBright : (s.state == "failed" ? Color.ink : Color.inkSoft))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.top, 12)
                .frame(minHeight: 44, alignment: .leading)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(s.label)\(s.state == "done" ? ", klaar" : s.state == "failed" ? ", mislukt" : "")")
            }
        }
    }

    private func answerBlocks(_ answer: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(RequestText.blocks(answer).enumerated()), id: \.offset) { _, b in
                switch b {
                case .paragraph(let t):
                    Text(t).wholeWords(t, font: .display(17, relativeTo: .body))
                        .foregroundStyle(Color.ink)
                        .fixedSize(horizontal: false, vertical: true)
                case .bullet(let t):
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("•").foregroundStyle(Color.inkDim).font(.display(17, relativeTo: .body))
                        Text(t).wholeWords(t, font: .display(17, relativeTo: .body))
                            .foregroundStyle(Color.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .textSelection(.enabled)
    }

    private func stepRow(_ s: RequestDetail.Step) -> some View {
        let done = model.doneAt(s)
        return Button { Task { await model.toggle(s) } } label: {
            HStack(alignment: .firstTextBaseline, spacing: 14) {
                Image(systemName: done == nil ? "circle" : "checkmark.circle")
                    .font(.system(size: ax ? 30 : 22))
                    .foregroundStyle(done == nil ? Color.inkSoft : Color.okay)
                    .contentTransition(.symbolEffect(.replace))
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 5 }
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(s.text)
                        .wholeWords(s.text, font: .display(17, relativeTo: .body, weight: .medium))
                        .foregroundStyle(done == nil ? Color.inkBright : Color.inkSoft)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if let done { RequestMetaLine(parts: ["Gedaan", HomeSummary.clock(done)]) }
                }
                Spacer(minLength: 0)
            }
            .padding(.top, 12)
            .frame(minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(s.text)
        .accessibilityValue(done == nil ? "nog te doen" : "gedaan")
        .accessibilityHint(done == nil ? "Dubbeltik om af te vinken" : "Dubbeltik om terug te zetten")
    }

    private func proposalCard(_ card: RequestText.Card, _ d: RequestDetail) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
        let body = VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                ProposalLabel(card.label, color: card.amber ? .attn : .inkLabel)
                Spacer(minLength: 8)
                if card.opens && !ax {
                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .medium)).foregroundStyle(Color.inkDim)
                }
            }
            Text(card.title)
                .wholeWords(card.title, font: .display(17, relativeTo: .body, weight: .medium))
                .foregroundStyle(card.opens ? Color.inkBright : Color.inkSoft)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
            if let meta = card.meta { RequestMetaLine(parts: meta.components(separatedBy: " · ")) }
            if let caption = card.caption {
                Text(caption)
                    .font(.display(15, relativeTo: .callout))
                    .foregroundStyle(Color.inkMute)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.glassA, in: shape)
        .overlay(shape.strokeBorder(card.amber ? Color.attn.opacity(0.85) : Color.edge, lineWidth: 1))
        .modifier(GlowIf(on: card.amber))
        return Group {
            if card.opens, let id = d.proposal?.id {
                Button { push(.proposal(id)) } label: { body }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(card.label). \(card.title). \(card.meta ?? "")")
                    .accessibilityHint(card.amber ? "Wacht op jou. Opent het voorstel." : "Opent het voorstel.")
            } else {
                body.accessibilityElement(children: .combine)
            }
        }
    }

    private func sourceRow(_ s: RequestDetail.Source, index: Int, _ d: RequestDetail) -> some View {
        let meta = RequestText.sourceMeta(s, accountName: accountName)
        let when = RequestText.sourceWhen(s.at, now: now)
        return Button { open(s, index: index, d) } label: {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 0) {
                    Image(systemName: RequestText.symbol(source: s.type))
                        .font(.system(size: 15))
                        .foregroundStyle(Color.inkLabel)
                        .frame(width: 36, alignment: .leading)
                        .padding(.top, 3)
                        .accessibilityHidden(true)
                    HStack(alignment: .center, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(s.label)
                                .font(.display(17, relativeTo: .body, weight: .medium))
                                .foregroundStyle(Color.inkBright)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                            if let t = s.transaction {
                                RowMeta(lead: meta + [when].compactMap { $0 }, trailing: MoneyFormat.euro(cents: t.amountCents))
                            } else {
                                RowMeta(lead: meta, trailing: when)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if !ax {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Color.inkDim)
                        }
                    }
                }
                .padding(.vertical, 12)
                RowHairlineShape(leading: 36)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint(s.inDossier ? "Opent de bron" : "Gmail-bericht, niet in je dossier, alleen lezen")
    }

    private func open(_ s: RequestDetail.Source, index: Int, _ d: RequestDetail) {
        switch s.type {
        case "document": push(.document(id: s.id, title: s.label))
        case "task": push(.task(s.id))
        case "transaction": bankSource = s
        default: push(.requestSource(requestId: d.id, index: index))
        }
    }

    private func failureCard(_ d: RequestDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ProposalLabel(RequestText.whatHappened)
            Text(d.failureDetail ?? "Er is niets verstuurd en niets veranderd.")
                .font(.display(17, relativeTo: .body))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
    }

    private func failedActions(_ d: RequestDetail) -> some View {
        VStack(spacing: 12) {
            AuthButton(title: RequestText.retry) { Task { await askAgain(d) } }
            AuthButton(title: RequestText.edit, weight: .outline) {
                // The failed question is put away once the edited one is sent.
                store.draft = RequestDraft(text: d.text, about: d.about,
                                           parent: d.parentRequestId.map { ($0, d.title) }, replaces: d.id)
            }
            linkButton(RequestText.letGo) { Task { await letGo(d) } }
        }
    }

    private func followUpBar(_ d: RequestDetail) -> AnyView? {
        let answered = d.status == "answered"
        let working = (d.status == "working" || d.status == "queued") && d.parentRequestId != nil
        guard answered || working else { return nil }
        return AnyView(FollowUpBar(enabled: answered) { store.followUp(d) })
    }

    // MARK: - Menu

    private func menu(_ d: RequestDetail) -> some View {
        Menu {
            if let answer = d.answer {
                Button(RequestText.copyAnswer, systemImage: "doc.on.doc") { UIPasteboard.general.string = answer }
                ShareLink(item: answer) { Label(RequestText.shareAnswer, systemImage: "square.and.arrow.up") }
            }
            if d.status == "answered" || d.status == "failed" || d.status == "cancelled" {
                Button(RequestText.askAgain, systemImage: "arrow.trianglehead.2.clockwise") { Task { await askAgain(d) } }
            }
            if d.status == "queued" || d.status == "working" {
                Button(RequestText.stop, systemImage: "stop.circle") { Task { _ = await store.cancel(d.id); await model.load() } }
            }
            if d.dismissedAt == nil {
                Button { Task { await letGo(d) } } label: {
                    // Title, subtitle, glyph: the system menu's own two-line item.
                    Text(RequestText.letGo)
                    Text(d.proposal?.status == "pending" ? RequestText.letGoKeepsProposal : RequestText.letGoNote)
                    Image(systemName: "trash")
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(Color.signal)
        }
        .accessibilityLabel(RequestText.more)
    }

    // MARK: - Acts

    /// "Opnieuw proberen" / "Vraag opnieuw stellen": the same question, a new
    /// research; the screen moves to the new request.
    private func askAgain(_ d: RequestDetail) async {
        if d.status == "answered" {
            await store.send(RequestDraft(text: d.text, about: d.about, parent: d.parentRequestId.map { ($0, d.title) }))
            dismiss()
            return
        }
        if let fresh = await store.retry(d.id) {
            dismiss()
            push(.request(fresh))
        }
    }

    private func letGo(_ d: RequestDetail) async {
        await store.dismiss(d.id, carriesProposal: d.proposal?.status == "pending")
        dismiss()
    }

    #if DEBUG
    private func applyFixture() async {
        let states = FixtureLaunch.current?.vraag ?? []
        try? await Task.sleep(for: .milliseconds(700))
        guard let d = model.detail else { return }
        for s in states {
            switch s {
            case .afgevinkt:
                if let step = d.steps.first {
                    model.fixtureTick(step.index, at: step.doneAt ?? now)
                    store.fixtureToast(RequestToast(text: RequestText.allDoneToast, undo: .untick(id: d.id, index: step.index)))
                }
            case .bronBank:
                bankSource = d.sources.first { $0.transaction != nil }
            case .bronGmail:
                if let i = d.sources.firstIndex(where: { $0.type == "gmail" }) { push(.requestSource(requestId: d.id, index: i)) }
            default: break
            }
        }
    }
    #endif
}

/// The proposal card's amber glow, only while it waits on Martin.
private struct GlowIf: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View {
        if on { content.glow(Glow.attn) } else { content }
    }
}

/// The "Vraag door" bar on the glass foot of the answer. Disabled while Grip
/// works on a follow-up (finding 3: the glyph and the edge dim; the words are
/// never brighter than the enabled placeholder's ink-mute).
struct FollowUpBar: View {
    let enabled: Bool
    let open: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let ax = typeSize.isAccessibilitySize
        Button(action: open) {
            HStack(spacing: 12) {
                Text(enabled ? RequestText.followUpPlaceholder : RequestText.followUpWaiting)
                    .font(.display(17, relativeTo: .body))
                    .dynamicTypeSize(...DynamicTypeSize.accessibility2)
                    .foregroundStyle(enabled ? Color.inkMute : Color.inkLabel)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "mic")
                    .font(.system(size: ax ? 24 : 17))
                    .foregroundStyle(enabled ? Color.signalLink : Color.inkFaint)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 8)
            .frame(minHeight: ax ? 72 : 50)
            .background(RoundedRectangle(cornerRadius: 25, style: .continuous).fill(Color.field))
            .overlay(RoundedRectangle(cornerRadius: 25, style: .continuous)
                .strokeBorder(enabled ? Color.edgeStrong : Color.edge.opacity(0.6), lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 8)
        .background(.ultraThinMaterial.opacity(0.94))
        .background(Color.plate.opacity(0.94))
        .overlay(alignment: .top) { Rectangle().fill(Color.hairline).frame(height: 1) }
        .accessibilityLabel(enabled ? RequestText.followUpTitle : "\(RequestText.followUpTitle), uitgeschakeld, kan zodra Grip klaar is")
    }
}

/// "Vraag weggelegd. … · Ongedaan maken" (finding 1: the whole word).
struct RequestToastView: View {
    let toast: RequestToast
    let undo: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        let ax = typeSize.isAccessibilitySize
        VStack(spacing: 0) {
            // The last 18 pt above the toast are opaque void: no glyph sliver.
            LinearGradient(stops: [.init(color: Color.void.opacity(0), location: 0),
                                   .init(color: Color.void, location: 0.55), .init(color: Color.void, location: 1)],
                           startPoint: .top, endPoint: .bottom)
                .frame(height: 40)
                .allowsHitTesting(false)
            Group {
                if ax {
                    VStack(alignment: .leading, spacing: 8) { words; button }
                } else {
                    HStack(alignment: .center, spacing: 12) { words; Spacer(minLength: 0); button }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.plate, in: shape)
            .overlay(shape.strokeBorder(Color.edgeStrong, lineWidth: 1))
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .background(Color.void)
        }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: RequestText.undo, undo)
    }

    private var words: some View {
        Text(toast.text)
            .font(.display(15, relativeTo: .callout))
            .foregroundStyle(Color.ink)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var button: some View {
        Button(action: undo) {
            Text(RequestText.undo)
                .wholeWords(RequestText.undo, font: .display(17, relativeTo: .body, weight: .medium))
                .foregroundStyle(Color.signal)
                .fixedSize()
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
    }
}

/// The working step's 270° arc, turning.
struct SpinningArc: View {
    @State private var turn = false
    var body: some View {
        Circle().trim(from: 0, to: 0.75)
            .stroke(Color.ink, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
            .rotationEffect(.degrees(turn ? 360 : 0))
            .animation(.linear(duration: 1.1).repeatForever(autoreverses: false), value: turn)
            .onAppear { turn = true }
            .padding(2)
    }
}
