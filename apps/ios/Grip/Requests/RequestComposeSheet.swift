import SwiftUI

/// "Vraag Grip" / "Vraag door": the compose sheet (frames "opstellen · *").
/// A field that grows, the attached item as a removable chip, dictation on
/// the phone, "Koppel een stuk", and "Versturen" — which works offline too:
/// the question waits on the phone and goes by itself.
///
/// The sheet HOLDS ITS DRAFT IN `RequestStore.draft`, above the lock gate, so
/// a relock never takes Martin's words. Closing with words in the field asks
/// first ("Vraag weggooien?"); an empty field just closes.
struct RequestComposeSheet: View {
    let store: RequestStore
    let dictation: RequestDictation
    var offline = false
    @State private var text: String
    @State private var about: RequestAbout?
    @State private var detent: PresentationDetent
    @State private var confirmingDiscard = false
    @State private var picking = false
    @FocusState private var focused: Bool
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let draft: RequestDraft
    #if DEBUG
    private let fixture: FixtureLaunch.VraagState?
    #endif

    init(store: RequestStore, dictation: RequestDictation, offline: Bool, draft: RequestDraft) {
        self.store = store
        self.dictation = dictation
        self.offline = offline
        self.draft = draft
        _text = State(initialValue: draft.text)
        _about = State(initialValue: draft.about)
        #if DEBUG
        let f = FixtureLaunch.current?.vraag.first { $0.isCompose }
        fixture = f
        _detent = State(initialValue: f?.composeDetent ?? (draft.text.isEmpty ? Self.compact : .large))
        _picking = State(initialValue: f == .opstellenKoppel)
        _confirmingDiscard = State(initialValue: f == .opstellenWeggooien)
        #else
        _detent = State(initialValue: draft.text.isEmpty ? Self.compact : .large)
        #endif
    }

    /// The short sheet: half the screen, but never shorter than its own
    /// parts (field, example, actions, footnote) — on an iPhone SE half the
    /// screen would put the footnote under the fold.
    static let compact = PresentationDetent.custom(ComposeDetent.self)

    private var ax: Bool { typeSize.isAccessibilitySize }
    private var isFollowUp: Bool { draft.parent != nil }
    private var canSend: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !dictation.isRecording }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.plate.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        header
                        if let about { aboutChip(about) }
                        field
                        if text.isEmpty && !isFollowUp && about == nil && !dictation.isRecording { example }
                        if dictation.isRecording || dictation.phase == .transcribing {
                            dictationPanel
                        } else {
                            actions
                            footnote
                        }
                        if case .failed(let why) = dictation.phase {
                            Text(why)
                                .font(.display(15, relativeTo: .callout))
                                .foregroundStyle(Color.inkSoft)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 16)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(isPresented: $picking) {
                RequestPicker(store: store) { item in
                    about = item
                    picking = false
                }
            }
        }
        .presentationDetents([RequestComposeSheet.compact, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.plate)
        .interactiveDismissDisabled(!text.isEmpty)
        .preferredColorScheme(.dark)
        // "Vraag weggooien?" as the frame draws it: an action sheet at the
        // bottom over the dimmed sheet, "Verder typen" the bold default.
        .overlay(alignment: .bottom) {
            if confirmingDiscard {
                DiscardSheet(discard: discard, keep: { confirmingDiscard = false })
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: confirmingDiscard)
        .sensoryFeedback(.warning, trigger: confirmingDiscard) { _, new in new }
        .sensoryFeedback(.impact(weight: .light), trigger: dictation.stops)
        .onChange(of: focused) { _, f in if f { detent = .large } }
        .task {
            #if DEBUG
            await applyFixture()
            #endif
        }
    }

    // MARK: - Parts

    private var header: some View {
        HStack(alignment: .center) {
            Text(isFollowUp ? RequestText.followUpTitle : RequestText.title)
                .wholeWords(isFollowUp ? RequestText.followUpTitle : RequestText.title,
                            font: .display(17, relativeTo: .headline, weight: .medium))
                .foregroundStyle(Color.inkBright)
                .dynamicTypeSize(...DynamicTypeSize.accessibility2)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 12)
            Button(action: close) {
                Image(systemName: "xmark")
                    .font(.system(size: ax ? 28 : 15, weight: .semibold))
                    .foregroundStyle(Color.inkSoft)
                    .frame(width: ax ? 60 : 36, height: ax ? 60 : 36)
                    .background(Circle().fill(Color.glassA))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(RequestText.close)
        }
        .padding(.top, 14)
    }

    private func aboutChip(_ a: RequestAbout) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ProposalLabel(RequestText.aboutLabel)
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: RequestText.symbol(about: a.type))
                    .font(.system(size: 15))
                    .foregroundStyle(Color.inkSoft)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(a.label)
                        .font(.display(17, relativeTo: .body))
                        .foregroundStyle(Color.inkBright)
                        .fixedSize(horizontal: false, vertical: true)
                    RequestMetaLine(parts: RequestText.aboutMeta(a, now: store.now()), color: .inkLabel)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button { about = nil } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.inkSoft)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Ontkoppel")
            }
            .padding(.leading, 14)
            .padding(.vertical, 6)
            .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
            .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Over: \(RequestText.kind(about: a.type).lowercased()) \(a.label)")
        }
    }

    private var field: some View {
        ZStack(alignment: .topLeading) {
            // A field that GROWS with its text: nothing Martin wrote is ever
            // hidden behind the field's own edge.
            TextField("", text: $text, axis: .vertical)
                .font(.display(17, relativeTo: .body))
                // At AX5 a long Dutch compound would break mid-word (a text
                // field does not hyphenate): one step smaller keeps it whole.
                .dynamicTypeSize(...DynamicTypeSize.accessibility3)
                .foregroundStyle(Color.inkBright)
                .focused($focused)
                .padding(.horizontal, 16)
                .padding(.vertical, 16)
                .frame(minHeight: fieldHeight, alignment: .topLeading)
                .accessibilityLabel("\(RequestText.title), tekstveld")
            if text.isEmpty {
                // Finding 3: an ENABLED placeholder is ink-mute (≥ 7:1).
                Text(isFollowUp ? RequestText.followUpPlaceholder : RequestText.placeholder)
                    .font(.display(17, relativeTo: .body))
                    .foregroundStyle(Color.inkMute)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 16)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
        .overlay(RoundedRectangle(cornerRadius: Radius.chip)
            .strokeBorder(focused ? Color.signal : Color.edgeStrong, lineWidth: 1))
    }

    private var fieldHeight: CGFloat {
        if ax { return 120 }
        if detent == .large && (focused || !text.isEmpty) && about == nil { return 280 }
        return 90
    }

    private var example: some View {
        Button {
            text = RequestText.example
            focused = true
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                ProposalLabel(RequestText.exampleLabel)
                Text("“\(RequestText.example)”")
                    .font(.display(15, relativeTo: .callout))
                    .foregroundStyle(Color.inkSoft)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassPanel()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Voorbeeld: \(RequestText.example)")
        .accessibilityHint("Vult het veld")
    }

    @ViewBuilder private var actions: some View {
        if ax {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 16) { micButton; attachButton }
                sendButton
            }
        } else {
            HStack(spacing: 12) {
                micButton
                attachButton
                sendButton
            }
        }
    }

    private var micButton: some View {
        CircleIconButton(symbol: "mic", size: ax ? 64 : 46, label: "Dicteer") {
            Task { await dictation.start() }
        }
    }

    private var attachButton: some View {
        CircleIconButton(symbol: "paperclip", size: ax ? 64 : 46, label: RequestText.attach) {
            picking = true
        }
    }

    private var sendButton: some View {
        Button(action: send) {
            Text(RequestText.send)
                .wholeWords(RequestText.send, font: .display(ax ? 40 : 17, relativeTo: .body, weight: .medium))
                .foregroundStyle(canSend ? Color.onSignal : Color.inkMute)
                .frame(maxWidth: .infinity, minHeight: ax ? 80 : 46)
                .background {
                    if canSend {
                        RoundedRectangle(cornerRadius: Radius.chip)
                            .fill(LinearGradient(colors: [.signalLit, .signal], startPoint: .top, endPoint: .bottom))
                            .glow(Glow.action)
                    } else {
                        RoundedRectangle(cornerRadius: Radius.chip).fill(Color.field)
                    }
                }
                .overlay {
                    if !canSend { RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edge, lineWidth: 1) }
                }
        }
        .buttonStyle(AuthPressStyle())
        .disabled(!canSend)
        .accessibilityLabel(RequestText.send)
    }

    @ViewBuilder private var footnote: some View {
        if offline {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "wifi.slash").font(.system(size: 13)).accessibilityHidden(true)
                Text(RequestText.offlineNote)
                    .font(.display(15, relativeTo: .callout))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(Color.inkSoft)
        } else {
            Text(RequestText.privacy)
                .font(.display(ax ? 34 : 13, relativeTo: .footnote))
                .foregroundStyle(Color.inkMute)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var dictationPanel: some View {
        VStack(spacing: 16) {
            TimelineView(.periodic(from: .now, by: 0.25)) { ctx in
                HStack(spacing: 12) {
                    DictationMeter(active: !reduceMotion, tick: ctx.date)
                    let since: Date? = if case .recording(let s) = dictation.phase { s } else { nil }
                    RequestMetaLine(parts: [DictationClock.text(since.map { store.now().timeIntervalSince($0) } ?? 0),
                                     RequestText.dictationMeta], color: .inkLabel)
                }
            }
            Button {
                Task {
                    if let words = await dictation.stop() {
                        text = text.isEmpty ? words : "\(text) \(words)"
                    }
                }
            } label: {
                RoundedRectangle(cornerRadius: 4).fill(Color.onSignal).frame(width: 24, height: 24)
                    .frame(width: 72, height: 72)
                    .background(Circle().fill(LinearGradient(colors: [.signalLit, .signal], startPoint: .top, endPoint: .bottom)))
                    .glow(Glow.action)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop met dicteren")
            Text(dictation.phase == .transcribing ? "Zet om in tekst…" : RequestText.dictationStop)
                .font(.display(15, relativeTo: .callout))
                .foregroundStyle(Color.ink)
            Text(RequestText.dictationNote)
                .font(.display(13, relativeTo: .footnote))
                .foregroundStyle(Color.inkMute)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
    }

    // MARK: - Acts

    private func send() {
        guard canSend else { return }
        var d = draft
        d.text = text
        d.about = about
        Task { await store.send(d) }
    }

    private func close() {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { discard() } else { confirmingDiscard = true }
    }

    private func discard() {
        dictation.cancel()
        store.draft = nil
    }

    #if DEBUG
    private func applyFixture() async {
        guard let fixture else { return }
        switch fixture {
        case .opstellenTypen:
            try? await Task.sleep(for: .milliseconds(500))
            focused = true
        case .opstellenDicteren:
            dictation.fixtureRecording(since: store.now().addingTimeInterval(-9))
        default: break
        }
    }
    #endif
}

/// A round 46 pt (64 at AX) glass button with one glyph.
struct CircleIconButton: View {
    let symbol: String
    let size: CGFloat
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size * 0.36, weight: .regular))
                .foregroundStyle(Color.signalLink)
                .frame(width: size, height: size)
                .background(Circle().fill(Color.field))
                .overlay(Circle().strokeBorder(Color.edgeStrong, lineWidth: 1))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// A mono meta line in capitals, wrapping only between parts (one part per
/// line at the accessibility sizes).
struct RequestMetaLine: View {
    let parts: [String]
    var color: Color = .inkLabel
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(parts.enumerated()), id: \.offset) { _, p in
                        Text(p.uppercased()).fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else {
                Text(HomeSummary.metaLine(parts).uppercased())
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.mono(12, relativeTo: .caption))
        .tracking(typeSize.isAccessibilitySize ? 0 : VoorJouMetrics.metaTracking)
        .foregroundStyle(color)
        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
    }
}

/// The dictation meter: eleven bars that breathe while recording. With
/// Reduce Motion they stand still at a steady level.
struct DictationMeter: View {
    let active: Bool
    let tick: Date

    var body: some View {
        let t = tick.timeIntervalSinceReferenceDate
        HStack(spacing: 3) {
            ForEach(0..<11, id: \.self) { i in
                let base = [0.35, 0.55, 0.8, 1, 0.7, 0.9, 0.6, 1, 0.75, 0.5, 0.3][i]
                let wave = active ? 0.65 + 0.35 * sin(t * 6 + Double(i) * 0.9) : 0.8
                Capsule().fill(Color.signal)
                    .frame(width: 3, height: 26 * base * wave)
            }
        }
        .frame(height: 28)
        .accessibilityHidden(true)
    }
}

/// "Vraag weggooien?" — the sheet with Martin's words stays visible, dimmed,
/// above it: he sees what he would throw away.
struct DiscardSheet: View {
    let discard: () -> Void
    let keep: () -> Void

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.void.opacity(0.4).ignoresSafeArea().onTapGesture(perform: keep)
            VStack(spacing: 8) {
                VStack(spacing: 0) {
                    VStack(spacing: 6) {
                        Text(RequestText.discardTitle)
                            .font(.display(17, relativeTo: .headline, weight: .semibold))
                            .foregroundStyle(Color.inkBright)
                        Text(RequestText.discardBody)
                            .font(.display(15, relativeTo: .callout))
                            .foregroundStyle(Color.inkSoft)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(16)
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isHeader)
                    Rectangle().fill(Color.hairline).frame(height: 1)
                    Button(action: discard) {
                        Label(RequestText.discard, systemImage: "trash")
                            .font(.display(17, relativeTo: .body))
                            .foregroundStyle(Color.inkBright)
                            .frame(maxWidth: .infinity, minHeight: 54)
                    }
                    .buttonStyle(.plain)
                }
                .background(Color.plate, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.edgeStrong, lineWidth: 1))
                Button(action: keep) {
                    Text(RequestText.keepTyping)
                        .font(.display(17, relativeTo: .body, weight: .semibold))
                        .foregroundStyle(Color.signalLink)
                        .frame(maxWidth: .infinity, minHeight: 54)
                        .background(Color.plate, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.edgeStrong, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
        }
        .sensoryFeedback(.warning, trigger: true)
    }
}

struct ComposeDetent: CustomPresentationDetent {
    static func height(in context: Context) -> CGFloat? {
        max(context.maxDetentValue * 0.5, min(460, context.maxDetentValue))
    }
}
