import SwiftUI
import UIKit

/// One proposal (Figma "proposal · final"): the header and its status, the
/// trigger, Grip's draft — Martin's own changes marked — what Grip relied
/// on, and a bar pinned to the bottom that says what a send would do. Versturen
/// is a HOLD (`SendHold`), then a FRESH Face ID every time (`ApprovalGate`).
/// At the accessibility sizes the bar's content sits in the scroll as a
/// "Versturen" section instead, with Aanpassen and Afwijzen at the end.
/// A question shows its options, each with the server's own description.
///
/// The logic is in `ProposalModel` (and `ProposalText`); this draws it.
struct ProposalScreen: View {
    let id: String
    let client: APIClient
    let gate: ApprovalGate
    let onUnauthorized: @MainActor () -> Void
    var now: @Sendable () -> Date = { Date() }

    @State private var model: ProposalModel?
    @State private var editing = false
    @State private var rejecting = false
    @State private var pendingOption: ProposalDetail.Option?
    @State private var freeText = ""
    @State private var hold = SendHold()
    @State private var holdProgress: Double = 0
    @State private var holdTask: Task<Void, Never>?
    @State private var holdTicks = 0
    @State private var confirmingAccessibleSend = false
    /// How far the page has scrolled from its top.
    @State private var scrolled: CGFloat = 0
    /// What a source row, the trigger card or "Originele mail openen" shows
    /// when it has no screen of its own.
    @State private var sourceSheet: SourceSheetItem?
    /// Where the page's large title ends, in the scroll's CONTENT space.
    @State private var titleBottom: CGFloat = .infinity
    /// Derived from both, so whichever arrives last still decides. The last
    /// 8 pt of the title's line are its descender space: once only those are
    /// left above the bar, the words themselves are under it.
    private var showsInlineTitle: Bool { scrolled + 8 > titleBottom }
    @State private var fixtureApplied = false
    @FocusState private var answerFocused: Bool
    @Environment(\.voorJouNext) private var next
    @Environment(\.networkOffline) private var offline
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.dismiss) private var dismiss
    @Environment(CallSession.self) private var call: CallSession?
    /// Vraag Grip: the AANLEIDING card of a proposal a question drafted leads back to it.
    @Environment(\.requestActions) private var requestActions

    private var ax: Bool { typeSize.isAccessibilitySize }
    private var isQuestion: Bool { model?.detail?.kind == "question" }
    private var successes: Int { model?.successes ?? 0 }
    private var softs: Int { model?.softs ?? 0 }
    private var errors: Int { model?.errors ?? 0 }

    var body: some View {
        withSheets(chrome(page))
            .sensoryFeedback(.success, trigger: successes)
            .sensoryFeedback(.impact(flexibility: .soft), trigger: softs)
            .sensoryFeedback(.error, trigger: errors)
            .sensoryFeedback(trigger: holdTicks, Self.holdFeedback)
    }

    /// Each tick of a hold a little firmer than the last (brief §2.5).
    private static func holdFeedback(_ old: Int, _ new: Int) -> SensoryFeedback? {
        guard new > 0 else { return nil }
        let intensity: Double = min(1, 0.35 + 0.2 * Double(new))
        return .impact(weight: .medium, intensity: intensity)
    }

    private var page: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if let model, let detail = model.detail {
                            content(model, detail, proxy)
                        } else if let error = model?.loadError {
                            Text(error)
                                .font(.display(17, relativeTo: .body))
                                .foregroundStyle(Color.ink)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.top, 24)
                        } else {
                            ProposalSkeleton()
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, isQuestion ? 0 : 8)
                    .padding(.bottom, 24)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frameLeading()
                    .coordinateSpace(.named(ProposalAnchor.page))
                    .coordinateSpace(.named(DetailSpace.name))
                }
                .scrollEdgeEffectStyle(.soft, for: .top)
                .scrollDismissesKeyboard(.interactively)
                // The bar names the proposal once the page's own title has
                // gone UNDER it — measured, not a fixed offset, so the rule
                // holds at AX5, where the title is three lines and ~200 pt.
                .onPreferenceChange(LargeTitleBottom.self) { bottom in
                    MainActor.assumeIsolated { if !isQuestion { titleBottom = bottom } }
                }
                .onPreferenceChange(DetailTitleBottom.self) { bottom in
                    MainActor.assumeIsolated { if isQuestion { titleBottom = bottom } }
                }
                .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { _, now in
                    scrolled = now
                }
                // Opaque, as the frames draw it: nothing scrolled under the
                // bar shows through behind its title.
                .safeAreaInset(edge: .top, spacing: 0) {
                    if !isQuestion {
                        Rectangle().fill(Color.void).frame(height: 2)
                            .overlay(alignment: .top) {
                                Rectangle().fill(Color.hairline).frame(height: 1).opacity(showsInlineTitle ? 1 : 0)
                            }
                    } else {
                        // A question rules the bar once anything is under it.
                        Rectangle().fill(Color.hairline).frame(height: 1).opacity(scrolled > 1 ? 1 : 0)
                    }
                }
                .task(id: model?.detail?.id) { await applyFixture(proxy) }
                .task(id: answerFocused) {
                    guard answerFocused, isQuestion else { return }
                    // After the keyboard has taken its room.
                    try? await Task.sleep(for: .milliseconds(700))
                    withAnimation(.snappy) { proxy.scrollTo(ProposalAnchor.answerEnd, anchor: .bottom) }
                }
            }
            // The confirmation sheet stands apart from the page behind it.
            if pendingOption != nil { SheetScrim() }
        }
        .animation(.easeOut(duration: 0.2), value: pendingOption != nil)
    }

    private func chrome(_ page: some View) -> some View {
        page
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !ax, !isQuestion, let model, let bar = model.sendBar(offline: offline, holding: hold.isHolding, now: now()) {
                barPanel(model, bar)
            }
        }
        // A question's dock: "Volgende in Voor jou" once it is answered. A
        // bar, so the page fades under it rather than being cut.
        .safeAreaBar(edge: .bottom, spacing: 0) {
            if isQuestion, model?.detail?.status == "sent", next != nil {
                DetailDock { NextInVoorJouButton(id: id) }
            }
        }
        .preferredColorScheme(.dark)
        .navigationTitle(model?.title ?? "Voorstel")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.void, for: .navigationBar)
        // Opaque for a question too: scrolled words never show through
        // behind the back button or the status bar (the frames).
        .toolbarBackgroundVisibility(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                ViewThatFits(in: .horizontal) {
                    navTitle(model?.title ?? "")
                    navTitle(model?.detail.map { ProposalText.kindTitle($0.kind) } ?? "")
                }
                .opacity(showsInlineTitle ? 1 : 0)
                .accessibilityHidden(!showsInlineTitle)
            }
            ToolbarItem(placement: .topBarTrailing) { moreMenu }
        }
        .toolbar(.visible, for: .navigationBar)
        // The bar takes the bottom of the screen; the tab bar would sit on it.
        .toolbar(.hidden, for: .tabBar)
        .task {
            if model == nil {
                let m = ProposalModel(client: client, gate: gate, onUnauthorized: onUnauthorized)
                m.clock = now
                model = m
                await m.load(id: id)
            }
        }
        // While a send is in flight, follow it until the worker settles it.
        .task(id: model?.status) {
            if model?.isSending == true { await model?.followSend() }
        }
    }

    private func withSheets(_ page: some View) -> some View {
        page
        .sheet(isPresented: $editing) {
            if let model { ProposalEditor(model: model) }
        }
        .sheet(isPresented: $rejecting) {
            if let model { RejectSheet(model: model) }
        }
        .sheet(item: $sourceSheet) { item in
            if let d = model?.detail { sourceSheetView(item, d) }
        }
        // Only an option with consequences asks first (brief §3).
        .sheet(item: $pendingOption) { option in
            DecisionSheet(title: QuestionText.confirmTitle(option, triggerType: model?.detail?.trigger.type ?? ""),
                          text: QuestionText.confirmText(option), action: option.label,
                          enabled: model?.isBusy == false && !offline,
                          onConfirm: {
                              pendingOption = nil
                              Task { if await model?.answer(option: option.index) == true { await next?.refresh() } }
                          },
                          onCancel: { pendingOption = nil })
        }
        // VoiceOver and Switch Control: the hold is one action that asks first.
        .alert(SendCopy.accessibilityConfirm, isPresented: $confirmingAccessibleSend) {
            Button(SendCopy.send) { Task { await send() } }
            Button("Annuleren", role: .cancel) {}
        } message: {
            if let model, let d = model.draft {
                Text(ProposalText.faceIDLine(to: d.to, triggerFrom: model.detail?.trigger.from,
                                             attachments: model.attachmentRows.count))
            }
        }
    }

    private func navTitle(_ text: String) -> some View {
        Text(text)
            .font(.display(17, relativeTo: .headline, weight: .medium))
            .foregroundStyle(Color.inkBright)
            .lineLimit(1)
            .fixedSize()
            .accessibilityAddTraits(.isHeader)
    }

    // MARK: - Content

    @ViewBuilder
    private func content(_ model: ProposalModel, _ d: ProposalDetail, _ proxy: ScrollViewProxy) -> some View {
        if d.kind == "question" {
            questionContent(model, d)
        } else {
            replyContent(model, d, proxy)
        }
    }

    /// A question (Figma "detail · final", Vraag): the question is the title.
    @ViewBuilder
    private func questionContent(_ model: ProposalModel, _ d: ProposalDetail) -> some View {
        let answered = d.status == "sent"
        DetailHeader(eyebrow: QuestionText.eyebrow(d), title: QuestionText.title(d),
                     offlineStamp: offline && model.isPending ? DetailText.offlineStamp(loadedAt: model.loadedAt ?? now(), now: now()) : nil,
                     badges: model.isPending ? [("Wacht op jou", .waiting)] : answered ? [("Beantwoord", .okay)] : [],
                     note: model.isPending ? DetailText.age(since: d.createdAt, now: now())
                         : answered ? model.shownAnsweredAt.map(DetailText.stamp) : nil)
        if model.isPending, let note = model.senderNote { ProposalLabel(note, color: .inkMute).padding(.top, 8) }
        callButton(d)
        QuestionBody(model: model, detail: d, now: now(), pendingOption: $pendingOption, freeText: $freeText,
                     focus: $answerFocused, onTrigger: { sourceSheet = .trigger }, base: client.base)
        if !model.isPending, !answered, let line = model.statusLine {
            DetailPara(line, size: 15).padding(.top, 24)
        }
        if let title = model.proposedTaskTitle {
            Group {
                if model.taskCreated {
                    ProposalLabel("Taak aangemaakt: \(title)", color: .steel)
                } else {
                    AuthButton(title: "Taak aanmaken: \(title)", weight: model.isBusy ? .secondary : .outline,
                               enabled: !model.isBusy) {
                        Task { await model.createTask() }
                    }
                }
            }
            .padding(.top, 32)
        }
        Color.clear.frame(height: 1).id(ProposalAnchor.end)
    }

    @ViewBuilder
    private func replyContent(_ model: ProposalModel, _ d: ProposalDetail, _ proxy: ScrollViewProxy) -> some View {
        header(model, d)
        triggerLink(model, d)
            .padding(.top, 22)
            .id(ProposalAnchor.trigger)
        callButton(d)
        if model.showsMissing {
            section(label: "Wat nog ontbreekt") {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(model.missing, id: \.self) { item in para("· \(item)") }
                }
            }
        }
        if d.kind != "question" { conceptSection(model, d) }
        if let prompt = model.questionPrompt { questionSection(model, prompt) }
        if ax, let bar = model.sendBar(offline: offline, holding: hold.isHolding, now: now()) {
            section(label: "Versturen") { barContent(model, bar, proxy).id(ProposalAnchor.send) }
        }
        if !d.reliedOn.isEmpty { sourcesSection(d) }
        if let summary = model.draft?.entrySummary, !summary.isEmpty {
            section(label: "In het logboek als") { para(summary) }
        }
        if let title = model.proposedTaskTitle {
            Group {
                if model.taskCreated {
                    ProposalLabel("Taak aangemaakt: \(title)", color: .steel)
                } else {
                    AuthButton(title: "Taak aanmaken: \(title)", weight: model.isBusy ? .secondary : .outline,
                               enabled: !model.isBusy) {
                        Task { await model.createTask() }
                    }
                }
            }
            .padding(.top, 32)
        }
        if model.isPending && (ax || d.kind == "question") {
            VStack(spacing: 12) {
                if model.draft != nil, ax {
                    AuthButton(title: "Aanpassen", weight: model.isBusy ? .secondary : .outline,
                               enabled: !model.isBusy) { editing = true }
                }
                AuthButton(title: "Afwijzen", weight: model.isBusy ? .secondary : .outline,
                           enabled: !model.isBusy) { rejecting = true }
            }
            .padding(.top, 32)
        }
        if ax || model.sendBar(offline: offline, holding: false, now: now()) == nil, let message = model.message {
            Text(message)
                .font(.display(15, relativeTo: .callout))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 16)
        }
        Color.clear.frame(height: 1).id(ProposalAnchor.end)
    }

    /// The sender, as a call: what to tell them and what to ask
    /// ("Gesprek voorbereiden"; only for a proposal that has a party).
    @ViewBuilder
    private func callButton(_ d: ProposalDetail) -> some View {
        if let partyId = d.partyId, let call {
            AuthButton(title: CallCopy.title, weight: .outline) {
                Task { await call.open(partyId: partyId, name: d.partyName) }
            }
            .padding(.top, 22)
        }
    }

    /// The trigger card opens what started it: a scanned letter's document,
    /// else the mail (or the earlier question) as the proposal knows it.
    @ViewBuilder
    private func triggerLink(_ model: ProposalModel, _ d: ProposalDetail) -> some View {
        let card = TriggerCard(model: model, detail: d, now: now())
        if ProposalText.isRequest(d.trigger), let actions = requestActions {
            // The question it came from: back to the answer when that is the
            // screen under this one, else the answer pushed.
            Button { actions.openRequest(d.trigger.id) } label: { card }
                .buttonStyle(.plain)
        } else if d.trigger.type == "document" {
            NavigationLink(value: InboxRoute.document(id: d.trigger.id, title: d.trigger.subject ?? "Brief")) { card }
                .buttonStyle(.plain)
        } else {
            Button { sourceSheet = .trigger } label: { card }
                .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private func sourceSheetView(_ item: SourceSheetItem, _ d: ProposalDetail) -> some View {
        switch item {
        case .trigger:
            SourceSheet(title: ProposalText.triggerSheetTitle(d.trigger),
                        meta: ProposalText.triggerMeta(kind: d.kind, trigger: d.trigger, now: now()),
                        why: nil, trigger: d.trigger)
        case .source(let i):
            let c = d.reliedOn[i]
            let s = ProposalText.source(c, trigger: d.trigger)
            SourceSheet(title: s.title, meta: s.meta, why: c.why,
                        trigger: c.type == "email" && c.id == d.trigger.id ? d.trigger : nil)
        }
    }

    private func header(_ model: ProposalModel, _ d: ProposalDetail) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // At AX5 the eyebrow is dropped (frame "AX5 · begin"): the title
            // already says what it is, and three lines of label would push
            // the status off the first screen.
            if !ax { ProposalLabel(ProposalText.eyebrow(kind: d.kind)) }
            Text(model.title)
                .wholeWords(model.title, font: .display(28, relativeTo: .title, weight: ax ? .medium : .regular))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .background {
                    GeometryReader { g in
                        Color.clear.preference(key: LargeTitleBottom.self,
                                               value: g.frame(in: .named(ProposalAnchor.page)).maxY)
                    }
                }
            let badge = ProposalText.badge(status: d.status)
            let note = ProposalText.badgeNote(status: d.status, createdAt: d.createdAt, now: now(), offline: offline)
            if badge != nil || note != nil {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { badgeRow(badge, note) }
                    VStack(alignment: .leading, spacing: 6) { badgeRow(badge, note) }
                }
                .padding(.top, 8)
                .accessibilityElement(children: .combine)
            }
        }
    }

    @ViewBuilder
    private func badgeRow(_ badge: ProposalText.Badge?, _ note: String?) -> some View {
        if let badge { StatusBadge(badge: badge) }
        if let note {
            HStack(spacing: 6) {
                if offline && model?.isPending == true {
                    Image(systemName: "wifi.slash").font(.system(size: 12, weight: .medium)).accessibilityHidden(true)
                }
                ProposalLabel(note, color: .inkDim)
            }
            .foregroundStyle(Color.inkDim)
        }
    }

    @ViewBuilder
    private func conceptSection(_ model: ProposalModel, _ d: ProposalDetail) -> some View {
        let label = model.conceptLabel
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                ProposalLabel(label)
                Spacer(minLength: 12)
                if model.isPending, model.draft != nil, !ax {
                    Button { editing = true } label: {
                        Label("Aanpassen", systemImage: "pencil")
                            .font(.display(15, relativeTo: .callout))
                            .foregroundStyle(Color.signalLink)
                            .labelStyle(TightLabel())
                    }
                    .disabled(model.isBusy)
                }
            }
            switch d.status {
            case "drafting": DraftingCard(redraft: model.isRedraft, followUp: d.updating != nil)
            case "draft-failed": DraftFailedCard(error: d.error)
            default:
                if model.draft != nil {
                    DraftCard(model: model, editable: model.isPending)
                }
            }
        }
        .padding(.top, 32)
    }

    private func sourcesSection(_ d: ProposalDetail) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                ProposalLabel("Waar Grip op leunt")
                Spacer(minLength: 12)
                if !ax { ProposalLabel(ProposalText.sourcesCount(d.reliedOn.count), color: .inkDim) }
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(d.reliedOn.enumerated()), id: \.offset) { i, c in
                    if i > 0 { Rectangle().fill(Color.hairline).frame(height: 1) }
                    SourceRow(citation: c, trigger: d.trigger) { sourceSheet = .source(i) }
                }
            }
            .padding(.horizontal, 16)
            .glassPanel()
        }
        .padding(.top, 32)
    }

    private func questionSection(_ model: ProposalModel, _ prompt: String) -> some View {
        section(label: "Vraag") {
            VStack(alignment: .leading, spacing: 12) {
                para(prompt)
                if model.isPending {
                    ForEach(model.optionButtons) { option in
                        Button { pendingOption = option } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(option.label)
                                    .font(.display(17, relativeTo: .body, weight: .medium))
                                    .foregroundStyle(Color.signalLink)
                                Text(option.target)
                                    .font(.display(15, relativeTo: .callout))
                                    .foregroundStyle(Color.inkMute)
                                    .multilineTextAlignment(.leading)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .padding(12)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
                            .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .disabled(model.isBusy)
                    }
                    TextField("Iets anders…", text: $freeText, axis: .vertical)
                        .font(.display(17, relativeTo: .body))
                        .foregroundStyle(Color.ink)
                        .padding(12)
                        .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
                        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
                    AuthButton(title: "Antwoorden", weight: .secondary,
                               enabled: !model.isBusy && !freeText.trimmingCharacters(in: .whitespaces).isEmpty) {
                        Task { if await model.answer(freeText: freeText) { freeText = "" } }
                    }
                }
            }
        }
    }

    // MARK: - The bar

    private func barPanel(_ model: ProposalModel, _ bar: SendBar) -> some View {
        ScrollViewReader { proxy in
            barContent(model, bar, proxy)
                .frameLeading()
                .padding(.horizontal, 16)
                .padding(.top, 18)
                .padding(.bottom, bar.button == nil ? 20 : 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    Rectangle().fill(.ultraThinMaterial)
                        .overlay(Color.plate.opacity(0.92))
                        .ignoresSafeArea(edges: .bottom)
                }
                .overlay(alignment: .top) { Rectangle().fill(Color.hairline).frame(height: 1) }
        }
    }

    @ViewBuilder
    private func barContent(_ model: ProposalModel, _ bar: SendBar, _ proxy: ScrollViewProxy) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            BarText(bar: bar)
            switch bar.button {
            case .hold(let label)?:
                HoldToSendButton(label: label, progress: holdProgress,
                                 onPress: { startHold(model) }, onRelease: { endHold() },
                                 onAccessibleSend: { confirmingAccessibleSend = true })
            case .disabled(let label)?:
                AuthButton(title: label, weight: .secondary, enabled: false) {}
            case .readDraft?:
                AuthButton(title: SendCopy.readDraft, weight: .outline) {
                    withAnimation { proxy.scrollTo(ProposalAnchor.draftEnd, anchor: .bottom) }
                }
            case .back?:
                AuthButton(title: SendCopy.back, weight: .outline) { dismiss() }
            case nil:
                EmptyView()
            }
        }
    }

    // MARK: - Hold to send

    private func startHold(_ model: ProposalModel) {
        guard model.canSend, !hold.isHolding else { return }
        hold.press(at: Date())
        model.holdStarted()
        holdTicks = 0
        withAnimation(.linear(duration: SendHold.duration)) { holdProgress = 1 }
        holdTask = Task { @MainActor in
            var last: TimeInterval = 0
            for (i, t) in SendHold.ticks.enumerated() {
                try? await Task.sleep(for: .seconds(t - last))
                last = t
                if Task.isCancelled { return }
                holdTicks = i + 1
            }
            try? await Task.sleep(for: .seconds(SendHold.duration - last))
            if Task.isCancelled { return }
            if hold.complete(at: Date()) { await send() }
        }
    }

    private func endHold() {
        let done = hold.release()
        if !done {
            holdTask?.cancel()
            withAnimation(.easeOut(duration: 0.2)) { holdProgress = 0 }
        }
    }

    private func send() async {
        guard let model else { return }
        _ = await model.approve()
        holdProgress = 0
    }

    // MARK: - Menu

    private var moreMenu: some View {
        Menu {
            if let model, model.isPending, model.draft != nil {
                Button("Aanpassen", systemImage: "pencil") { editing = true }
            }
            if model?.isPending == true {
                Button("Afwijzen", systemImage: "xmark") { rejecting = true }
            }
            if let d = model?.detail, d.trigger.type != "document" {
                Button(ProposalText.openTriggerLabel(d.trigger), systemImage: "envelope") { sourceSheet = .trigger }
            }
            if let d = model?.draft {
                Button {
                    UIPasteboard.general.string = ProposalText.copyText(d)
                } label: {
                    Label(ProposalText.copyMenuTitle, systemImage: "doc.on.doc")
                }
                .accessibilityLabel(ProposalText.copyLabel)
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(Color.signal)
        }
        .accessibilityLabel("Meer acties")
        .disabled(model?.detail == nil)
    }

    // MARK: - Pieces

    private func section<C: View>(label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            ProposalLabel(label)
            content()
        }
        .padding(.top, 32)
    }

    private func para(_ text: String) -> some View {
        Text(text)
            .font(.display(17, relativeTo: .body))
            .foregroundStyle(Color.ink)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Captures

    private func applyFixture(_ proxy: ScrollViewProxy) async {
        #if DEBUG
        guard let launch = FixtureLaunch.current, let model, model.detail != nil, !fixtureApplied else { return }
        fixtureApplied = true
        switch launch.proposal {
        case .hold?:
            hold.press(at: Date())
            holdProgress = 0.6
        case .faceid?: model.fixtureSetPhase(.confirming)
        case .afgebroken?: model.fixtureSetPhase(.cancelled)
        case .aangepast?, .editor?, .typen?, .weggooien?:
            if let body = model.draft?.body { model.edit(body: ProposalFixtureEdit.apply(to: body)) }
            if launch.proposal != .aangepast { editing = true }
        case .afwijzen?: rejecting = true
        case .goedgekeurd?: model.fixtureSetApprovedHere()
        case .bron?: sourceSheet = .trigger
        case nil: break
        }
        switch launch.detail {
        case .bevestigen?: pendingOption = model.optionButtons.first(where: QuestionText.needsConfirmation)
        case .typen?:
            freeText = "Alleen de eerste bladzijde hoort erbij; de tweede is van Duinzorg."
            answerFocused = true
        case .fout?:
            if let option = model.optionButtons.first(where: QuestionText.needsConfirmation) {
                _ = await model.answer(option: option.index)
            }
        case .nee?:
            if let d = model.detail, let option = model.optionButtons.first(where: { !QuestionText.needsConfirmation($0) }),
               let action = QuestionText.handBack(option, revision: model.revision) {
                next?.hand?(d.id, action, QuestionText.title(d))
            }
        default: break
        }
        try? await Task.sleep(for: .milliseconds(300))
        switch launch.scroll {
        case .rest?: proxy.scrollTo(ProposalAnchor.trigger, anchor: .top)
        case .middle?: proxy.scrollTo(ProposalAnchor.attachments, anchor: .top)
        case .end?: proxy.scrollTo(ProposalAnchor.end, anchor: .bottom)
        // On a proposal, "waiting" is the accessibility sizes' Versturen
        // section at the top (frame "AX5 · uitkomst onbekend").
        case .waiting?: proxy.scrollTo(ProposalAnchor.send, anchor: .top)
        default: break
        }
        #endif
    }
}

enum ProposalAnchor: Hashable {
    case trigger, attachments, draftEnd, end, page, send
    /// The end of a question's own answer: the button and its note.
    case answerEnd
}

/// Where the page's own large title ends, in the scroll's content space:
/// once the scroll has moved further than that, it is under the bar.
private struct LargeTitleBottom: PreferenceKey {
    static let defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = min(value, nextValue()) }
}

/// The sheet a source opens when it has no screen of its own.
enum SourceSheetItem: Identifiable, Hashable {
    case trigger
    /// The index in `reliedOn`.
    case source(Int)
    var id: Self { self }
}

#if DEBUG
/// The capture's edit (Figma "aangepast door jou"): one sentence Martin added
/// before the sign-off.
enum ProposalFixtureEdit {
    static let sentence = "Excuses dat het iets later is."

    static func apply(to body: String) -> String {
        var paragraphs = ProposalText.paragraphs(body)
        paragraphs.insert(sentence, at: max(0, paragraphs.count - 1))
        return paragraphs.joined(separator: "\n\n") + "\n"
    }
}
#endif

/// Whether the phone has a network path (`UploadCenter.isOffline`), set once in
/// RootView so a screen can say why an action that needs the server is off
/// BEFORE Martin tries it (brief §2.4).
extension View {
    /// Saira's own ~1.57 em leading sets the lines of one wrapped text nearly
    /// a line apart; the proposal frames set them at ~1.33 (`AuthType.lineFactor`)
    /// and at ~1.2 at the accessibility sizes (the Weekoverzicht's rule).
    func frameLeading() -> some View { modifier(FrameLeading()) }
}

private struct FrameLeading: ViewModifier {
    @Environment(\.dynamicTypeSize) private var typeSize
    func body(content: Content) -> some View {
        content.lineHeight(.multiple(factor: typeSize.isAccessibilitySize ? 1.2 : AuthType.lineFactor))
    }
}

extension EnvironmentValues {
    @Entry var networkOffline = false
}
