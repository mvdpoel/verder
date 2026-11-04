import SwiftUI
import UIKit

/// Makes a voice log's model: one per fresh log (`VoiceLogSession`), so each
/// log has its own clientId and its own (emptied) recordings folder.
@MainActor
struct VoiceLogFactory {
    let make: @MainActor () -> VoiceLogModel
}

/// "Spraaknotitie" as a sheet (Figma "Voice quick-log · final"). Holds NO
/// state of its own: the model lives in `VoiceLogSession`, above the lock gate
/// and the sign-in screen, so a relock or a 401 that tears this view down
/// cannot take the text or the recording with it. Only an explicit close
/// discards (`VoiceLogSession.close`).
///
/// THE LOCK: an empty log behind the lock is the lock screen, as every gated
/// screen is. A log holding a note keeps the note in view (frame "voorbeeld ·
/// vergrendeld"): the parties are not loaded into view and sending waits for
/// Face ID, so "je notitie blijft staan" is visibly true.
struct VoiceLogSheet: View {
    let session: VoiceLogSession
    let lock: AppLock
    var offline = false
    var openSuggestion: (String) -> Void = { _ in }
    @State private var detent: PresentationDetent = VoiceLogSheet.short
    @Environment(\.dynamicTypeSize) private var typeSize

    /// The frames' short sheet (559 of 874 pt), plus the room the floating
    /// sheet of iOS 26 keeps under itself.
    static let short = PresentationDetent.fraction(0.68)
    /// The note's sheet (frame "voorbeeld"): its top at 120 of 874 pt, so
    /// Overzicht's title stays in view, dimmed, behind it.
    static let note = PresentationDetent.fraction(VoiceLogSheet.noteFraction)
    static let noteFraction: CGFloat = 0.96

    var body: some View {
        Group {
            if let model = session.model {
                let locked = lock.isGated(.dossier)
                if locked && !(model.screen == .editor && model.holdsUnsentWork) {
                    LockView(lock: lock)
                } else {
                    VoiceLogView(model: model, locked: locked, close: { session.close() },
                                 unlock: { Task { await lock.unlock() } },
                                 openSuggestion: { id in
                                     session.close()
                                     openSuggestion(id)
                                 })
                        .interactiveDismissDisabled(model.blocksSwipe || model.micPrePrompt)
                        .onChange(of: offline, initial: true) { _, offline in
                            Task { await model.networkChanged(offline: offline) }
                        }
                }
            } else {
                Color.void.ignoresSafeArea()
            }
        }
        // On the whole sheet, so the lock screen and the note agree on the
        // height (a locked note once kept the lock screen's short detent).
        .presentationDetents(session.model.map(detents) ?? [Self.short, .large], selection: $detent)
        .onChange(of: session.model.map(fitting) ?? Self.short, initial: true) { _, fitting in
            detent = fitting
        }
        .task(id: session.model.map(ObjectIdentifier.init)) {
            guard let model = session.model else { return }
            await model.prepare()
            #if DEBUG
            await FixtureVoiceDriver.drive(model, session: session)
            #endif
        }
        // Gone without a close (lock screen, sign-in): keep, never discard.
        .onDisappear { session.sheetDisappeared() }
        .presentationDragIndicator(.visible)
        // Opaque, as the frames draw it: the footer and the page are one surface.
        .presentationBackground(VoiceSurface.color)
    }

    /// The detent a screen opens at: full height for the pre-prompt, the
    /// accessibility sizes, a keyboard (frames "typen", "tekst bewerken")
    /// and the party picker; the note's height for the note; short for the
    /// rest.
    private func fitting(_ model: VoiceLogModel) -> PresentationDetent {
        if typeSize.isAccessibilitySize || model.screen == .prePrompt { return .large }
        // Under the party picker too (frames "met wie · …"): a sheet that
        // presents a short sheet from a shorter detent is pushed out of view.
        // A failed send's banner makes the note too tall for the note's
        // detent (frames "niet verstuurd …" are drawn full height).
        if model.screen == .editor {
            return model.textFocused || model.pickerOpen || model.banner != nil ? .large : Self.note
        }
        return Self.short
    }

    private func detents(_ model: VoiceLogModel) -> Set<PresentationDetent> {
        model.screen == .prePrompt ? [.large] : [Self.short, Self.note, .large]
    }
}

/// The microphone pre-prompt: the first voice log asks before iOS does.
struct MicrophonePrePrompt: View {
    let proceed: () -> Void

    enum Copy {
        static let title = "Een gesprek vastleggen"
        static let purpose = "Houd de knop vast en vertel wat er gezegd is. De microfoon staat alleen aan zolang jij vasthoudt."
        static let promises = ["Het wordt een suggestie die jij goedkeurt, geen logboekregel."]
        static let sample = "“Gebeld met Woonstichting Lindehof…”"
    }

    var body: some View {
        PermissionPrePrompt(title: Copy.title, purpose: Copy.purpose, promises: Copy.promises, proceed: proceed) { _ in
            VStack(spacing: 20) {
                Capsule().fill(Color.inkFaint).frame(width: 36, height: 4)
                Image(systemName: "mic")
                    .font(.system(size: 26, weight: .light))
                    .foregroundStyle(Color.inkBright)
                    .frame(width: 96, height: 96)
                    .overlay(Circle().strokeBorder(Color.signal.opacity(0.5), lineWidth: 1.5))
                Text(Copy.sample)
                    .wholeWords(Copy.sample, font: AuthType.callout)
                    .foregroundStyle(Color.inkSoft)
                    .multilineTextAlignment(.center)
            }
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity)
            .background(Color.rail, in: RoundedRectangle(cornerRadius: Radius.panel))
            .overlay(RoundedRectangle(cornerRadius: Radius.panel).strokeBorder(Color.edge, lineWidth: 1))
        }
    }
}

/// The sheet's surface: `rail` over `void`. `rail` alone is 60% alpha, so
/// a pinned footer drawn in it let the rows scrolled under it show through.
enum VoiceSurface {
    static let color: Color = {
        let base = Tokens.rgba(Tokens.hex["void"] ?? "#04070d") ?? (0, 0, 0, 1)
        let top = Tokens.rgba(Tokens.hex["rail"] ?? "#060b1499") ?? (0, 0, 0, 0.6)
        func mix(_ a: Double, _ b: Double) -> Double { b * top.opacity + a * (1 - top.opacity) }
        return Color(red: mix(base.red, top.red), green: mix(base.green, top.green), blue: mix(base.blue, top.blue))
    }()
}

/// The type ramp of the frames: 22 / 17 / 15 / 12 (display/title-2,
/// headline, callout, mono/meta).
enum VoiceType {
    static let title = Font.display(22, relativeTo: .title2)
    static let headline = Font.display(17, relativeTo: .headline)
    static let headlineMedium = Font.display(17, relativeTo: .headline, weight: .medium)
    static let callout = Font.display(15, relativeTo: .callout)
}

/// The voice log's mono labels ("WAT JE ZEI", "GESPREK", "MET WIE · UIT JE
/// TEKST"): upper case at every size, and growing with Dynamic Type to about
/// 60% of the body at AX5 (frame "voorbeeld · AX5") — further than the
/// detail screens' labels, which stop at AX2 and read as footnotes there.
struct VoiceLabel: View {
    static let largest = DynamicTypeSize.accessibility4
    let text: String
    var color: Color = .inkLabel

    init(_ text: String, color: Color = .inkLabel) {
        self.text = text
        self.color = color
    }

    var body: some View {
        ProposalLabel(text, color: color, cap: Self.largest, alwaysUpper: true)
    }
}

/// A meta line of groups, in `VoiceLabel`'s size (`MetaLine`'s wrapping).
struct VoiceMetaLine: View {
    let line: String
    init(_ line: String) { self.line = line }

    var body: some View {
        MetaLine(line, color: .inkLabel, cap: VoiceLabel.largest, alwaysUpper: true)
    }
}

/// The screen. Layout only: every word and every rule comes from
/// `VoiceLogModel` (VoiceLogModelTests). Amber appears only on "WACHT OP JOU".
/// No haptics while recording (brief §2.5: never disturb the microphone);
/// `.error` on a failed send, `.warning` on the destructive choice.
struct VoiceLogView: View {
    @Bindable var model: VoiceLogModel
    var locked = false
    let close: () -> Void
    var unlock: () -> Void = {}
    var openSuggestion: (String) -> Void = { _ in }
    @State private var discards = 0
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.openURL) private var openURL

    private var ax: Bool { typeSize.isAccessibilitySize }

    var body: some View {
        Group {
            switch model.screen {
            case .prePrompt:
                MicrophonePrePrompt { Task { await model.acceptMicPrePrompt() } }
            case .state(let page):
                VoiceStatePage(page: page, model: model, header: header(titled: false), perform: perform)
            case .capture:
                VoiceCapturePage(model: model, header: header(titled: true))
            case .transcribing:
                VoiceTranscribingPage(model: model, header: header(titled: true))
            case .editor:
                VoiceEditorPage(model: model, locked: locked, header: header(titled: true), unlock: unlock,
                                askDiscard: { if model.requestClose() { close() } })
            case .sent:
                VoiceSentPage(model: model, header: header(titled: false), close: close,
                              open: { if let id = model.sentSuggestionId { openSuggestion(id) } })
            }
        }
        .background(VoiceSurface.color.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .lineHeight(.multiple(factor: AuthType.lineFactor))
        // Bottom action sheets drawn here, not confirmationDialogs: iOS 26
        // anchors a dialog to its source and draws a mid-sheet popover with
        // no cancel row and no dimming (frame "weggooien?").
        .overlay {
            if model.confirmingClose {
                VoiceActionSheet(title: VoiceLogModel.Copy.confirmTitle,
                                 actions: closeActions, cancel: VoiceLogModel.Copy.keepEditing,
                                 dismiss: { model.confirmingClose = false })
            } else if model.confirmingRecordAgain {
                VoiceActionSheet(title: VoiceLogModel.Copy.recordAgainTitle,
                                 actions: [.init(title: VoiceLogModel.Copy.recordAgain, destructive: true) {
                                     model.recordAgain()
                                 }],
                                 cancel: VoiceLogModel.Copy.keepEditing,
                                 dismiss: { model.confirmingRecordAgain = false })
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.confirmingClose || model.confirmingRecordAgain)
        .sensoryFeedback(.error, trigger: model.sendFailures)
        .sensoryFeedback(.warning, trigger: discards)
    }

    private var closeActions: [VoiceActionSheet.Action] {
        var out: [VoiceActionSheet.Action] = []
        if model.canSend && !locked {
            out.append(.init(title: VoiceLogModel.Copy.send) { Task { await model.send() } })
        }
        out.append(.init(title: VoiceLogModel.Copy.discard, symbol: "trash", destructive: true) {
            discards += 1
            close()
        })
        return out
    }

    private func header(titled: Bool) -> VoiceHeader {
        VoiceHeader(title: titled ? VoiceLogModel.Copy.title : nil, close: {
            if model.requestClose() { close() }
        })
    }

    private func perform(_ action: VoiceLogModel.Action) {
        switch action {
        case .openSettings:
            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
        case .typeNote: model.typeInstead()
        case .recordAgain: model.recordAgain()
        case .retrySpeech: Task { await model.retrySpeech() }
        }
    }
}

// MARK: - Header

/// "Spraaknotitie" with the round close button; at the accessibility sizes
/// the button takes its own line above the title (frame "voorbeeld · AX5").
struct VoiceHeader: View {
    let title: String?
    let close: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 4) {
                HStack { Spacer(); closeButton }
                if let title { titleText(title) }
            }
        } else {
            HStack(alignment: .center) {
                if let title { titleText(title) }
                Spacer(minLength: 12)
                closeButton
            }
        }
    }

    private func titleText(_ title: String) -> some View {
        Text(title)
            .wholeWords(title, font: VoiceType.title)
            .foregroundStyle(Color.inkBright)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    /// The ✕ grows with the text, to a large ✕ in a 56-pt circle at AX5
    /// (frame "voorbeeld · AX5 · 874-venster").
    @ScaledMetric(relativeTo: .body) private var glyph: CGFloat = 13
    @ScaledMetric(relativeTo: .body) private var circle: CGFloat = 32

    private var closeButton: some View {
        Button(action: close) {
            Image(systemName: "xmark")
                .font(.system(size: min(glyph, 22), weight: .semibold))
                .foregroundStyle(Color.inkSoft)
                .frame(width: min(circle, 56), height: min(circle, 56))
                .background(Circle().fill(Color.plate))
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Sluit")
    }
}

/// A bottom action sheet over the voice log (frame "weggooien?"): the
/// question, its actions in one card, and the way back in its own card,
/// over a dimmed sheet. Tapping the dimmed part is the way back too.
struct VoiceActionSheet: View {
    struct Action: Identifiable {
        let id = UUID()
        let title: String
        var symbol: String? = nil
        var destructive = false
        let perform: () -> Void
    }

    let title: String
    let actions: [Action]
    let cancel: String
    let dismiss: () -> Void

    var body: some View {
        ZStack(alignment: .bottom) {
            // Darker than `scrim`: the frame's dimmed note reads as near-black,
            // and the pinned send button must not glow between the cards.
            Color.void.opacity(0.92).ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture(perform: dismiss)
                .accessibilityHidden(true)
            ViewThatFits(in: .vertical) {
                cards
                ScrollView { cards }.scrollBounceBehavior(.basedOnSize)
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
        }
        .transition(.opacity.combined(with: .move(edge: .bottom)))
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape, dismiss)
    }

    private var cards: some View {
        VStack(spacing: 8) {
            VStack(spacing: 0) {
                Text(title)
                    .wholeWords(title, font: VoiceType.callout)
                    .foregroundStyle(Color.inkMute)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 16)
                    .accessibilityAddTraits(.isHeader)
                ForEach(actions) { action in
                    Rectangle().fill(Color.hairline).frame(height: 1)
                    Button {
                        dismiss()
                        action.perform()
                    } label: {
                        row(action)
                    }
                    .buttonStyle(.plain)
                }
            }
            .background(card)
            Button(action: dismiss) {
                Text(cancel)
                    .wholeWords(cancel, font: VoiceType.headlineMedium)
                    .foregroundStyle(Color.signalLink)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, minHeight: 56)
                    .padding(.horizontal, 16)
                    .background(card)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private func row(_ action: Action) -> some View {
        // iOS's own destructive red: the one red in the app, on the one
        // action that loses work.
        let color: Color = action.destructive ? Color(uiColor: .systemRed) : .signalLink
        return HStack(spacing: 8) {
            if let symbol = action.symbol {
                Image(systemName: symbol)
                    .font(VoiceType.callout)
                    .accessibilityHidden(true)
            }
            Text(action.title)
                .wholeWords(action.title, font: VoiceType.headline)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(color)
        .frame(maxWidth: .infinity, minHeight: 56)
        .padding(.horizontal, 16)
        .contentShape(Rectangle())
    }

    /// Opaque, so the note never shows through it.
    private var card: some View {
        RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.plate)
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.edge, lineWidth: 1))
    }
}

/// The pinned bottom of a page: a hairline, then its buttons and words,
/// clear of the home indicator.
struct VoiceFooter<Content: View>: View {
    /// The scroll-edge fade's height above the hairline.
    static var fade: CGFloat { 24 }
    var hairline = false
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) { content }
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(VoiceSurface.color)
            .overlay(alignment: .top) {
                if hairline { Rectangle().fill(Color.hairline).frame(height: 1) }
            }
            // The 24-pt scroll-edge fade of the frames: a row scrolled under
            // the footer fades out instead of being sliced.
            .background(alignment: .top) {
                if hairline {
                    LinearGradient(colors: [VoiceSurface.color.opacity(0), VoiceSurface.color], startPoint: .top, endPoint: .bottom)
                        .frame(height: Self.fade)
                        .offset(y: -Self.fade)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
    }
}

private struct VoiceNote: View {
    let text: String
    var color: Color = .inkSoft
    var centered = false

    var body: some View {
        Text(text)
            .wholeWords(text, font: VoiceType.callout)
            .foregroundStyle(color)
            .multilineTextAlignment(centered ? .center : .leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: centered ? .center : .leading)
    }
}

// MARK: - Capture (idle and recording)

private struct VoiceCapturePage: View {
    let model: VoiceLogModel
    let header: VoiceHeader

    private var recording: Bool { model.phase == .recording }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                if recording {
                    RecordingLine(model: model).padding(.top, 20)
                    LiveTextView(live: model.live).padding(.top, 10)
                } else {
                    VoiceNote(text: VoiceLogModel.Copy.idlePrompt, centered: true).padding(.top, 16)
                }
                RecordButton(model: model)
                    .padding(.top, recording ? 16 : 28)
                    .frame(maxWidth: .infinity)
                VStack(spacing: 4) {
                    Text(model.pressTitle)
                        .wholeWords(model.pressTitle, font: VoiceType.headlineMedium)
                        .foregroundStyle(model.pressOutside ? Color.inkBright : Color.inkBright)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    VoiceNote(text: model.pressHint, color: model.phase == .recording ? .inkSoft : .inkMute, centered: true)
                    if let notice = model.notice {
                        VoiceNote(text: notice, color: .ink, centered: true).padding(.top, 8)
                    }
                }
                .padding(.top, recording ? 12 : 16)
                .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VoiceFooter {
                if recording {
                    AuthButton(title: "Annuleer", weight: .ghost) { model.cancelRecording() }
                } else {
                    VoiceNote(text: VoiceLogModel.Copy.privacy, color: .inkMute, centered: true)
                    AuthButton(title: VoiceLogModel.Copy.typeNote, weight: .ghost) { model.typeInstead() }
                        .padding(.top, 4)
                }
            }
        }
    }
}

/// "● 0:14  NEDERLANDS · OP JE IPHONE".
private struct RecordingLine: View {
    let model: VoiceLogModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Circle().fill(Color.signal).frame(width: 7, height: 7).glow(Glow.signalDot)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] }
                Text(model.elapsedText)
                    .font(.mono(17, relativeTo: .headline, weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(Color.inkBright)
                VoiceLabel("Nederlands · op je iPhone", color: .inkLabel)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Opname loopt, \(model.elapsedText). Nederlands, op je iPhone.")
    }
}

/// The words so far: settled in ink, the still-changing tail in signal.
private struct LiveTextView: View {
    let live: LiveText

    var body: some View {
        if !live.isEmpty {
            Text(Self.attributed(live))
                .font(VoiceType.headline)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel(live.whole)
        }
    }

    static func attributed(_ live: LiveText) -> AttributedString {
        var settled = AttributedString(live.settled)
        settled.foregroundColor = .inkBright
        guard !live.volatile.isEmpty else { return settled }
        var tail = AttributedString((live.settled.isEmpty ? "" : " ") + live.volatile)
        tail.foregroundColor = .signalLink
        return settled + tail
    }
}

/// The round button: a ring at rest; filled, ringed and with a stop square
/// while recording. Down starts; a short press leaves it running hands-free
/// until the next tap; a long press stops on release; sliding off cancels.
/// VoiceOver and Switch Control get a plain toggle, because a hold is not a
/// gesture they can perform.
private struct RecordButton: View {
    let model: VoiceLogModel
    @State private var downAt: Date?
    @ScaledMetric(relativeTo: .largeTitle) private var size: CGFloat = 140

    private var recording: Bool { model.phase == .recording }
    private var d: CGFloat { min(size, 220) }

    var body: some View {
        ZStack {
            if recording {
                Circle().strokeBorder(Color.signal.opacity(0.85), lineWidth: 1.5).frame(width: d + 30, height: d + 30)
                Circle().strokeBorder(Color.signal, lineWidth: 1.5).frame(width: d + 16, height: d + 16)
                Circle()
                    .fill(model.pressOutside ? Color.signal.opacity(0.4) : Color.signal)
                    .frame(width: d, height: d)
                    .glow(Glow.action)
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.void)
                    .frame(width: d * 0.24, height: d * 0.24)
            } else {
                Circle().strokeBorder(Color.signal, lineWidth: 1.5).frame(width: d, height: d)
                Image(systemName: "mic")
                    .font(.system(size: d * 0.26, weight: .ultraLight))
                    .foregroundStyle(Color.signalLink)
                    .opacity(model.canRecord ? 1 : 0.4)
            }
        }
        .frame(width: d + 30, height: d + 30)
        .contentShape(Circle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    if downAt == nil {
                        downAt = Date()
                        Task { await model.press() }
                    }
                    let c = CGPoint(x: (d + 30) / 2, y: (d + 30) / 2)
                    let distance = hypot(value.location.x - c.x, value.location.y - c.y)
                    model.drag(outside: distance > d / 2 + 60)
                }
                .onEnded { _ in
                    let held = downAt.map { Date().timeIntervalSince($0) } ?? 0
                    downAt = nil
                    Task { await model.release(heldFor: held) }
                }
        )
        .allowsHitTesting(model.canRecord || recording)
        .accessibilityElement()
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(recording ? "Stop opname" : "Neem op")
        .accessibilityHint(recording ? "Dubbeltik om te stoppen." : "Dubbeltik om te starten en weer om te stoppen.")
        .accessibilityAction { Task { await model.toggleRecording() } }
    }
}

// MARK: - Transcribing

private struct VoiceTranscribingPage: View {
    let model: VoiceLogModel
    let header: VoiceHeader

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                HStack(spacing: 8) {
                    Image(systemName: "waveform")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(Color.signalLink)
                        .symbolEffect(.variableColor.iterative)
                    VoiceLabel("Omzetten naar tekst…", color: .inkBright)
                }
                .padding(.top, 20)
                .accessibilityElement(children: .combine)
                if !model.live.isEmpty {
                    Text(model.live.whole)
                        .wholeWords(model.live.whole, font: VoiceType.headline)
                        .foregroundStyle(Color.inkBright)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 10)
                }
                VoiceLabel("Gesprek").padding(.top, 24)
                VStack(spacing: 0) {
                    SkeletonLine()
                    Rectangle().fill(Color.hairline).frame(height: 1).padding(.leading, 48)
                    SkeletonLine()
                }
                .glassPanel()
                .padding(.top, 8)
                .accessibilityHidden(true)
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VoiceFooter { VoiceNote(text: VoiceLogModel.Copy.onPhone, color: .inkMute) }
        }
    }
}

private struct SkeletonLine: View {
    var body: some View {
        HStack(alignment: .top, spacing: 18) {
            Circle().fill(Color.inkFaint.opacity(0.6)).frame(width: 7, height: 7).padding(.top, 9)
            VStack(alignment: .leading, spacing: 8) {
                RoundedRectangle(cornerRadius: 2).fill(Color.inkFaint.opacity(0.45)).frame(width: 220, height: 12)
                RoundedRectangle(cornerRadius: 2).fill(Color.inkFaint.opacity(0.3)).frame(width: 110, height: 8)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 18)
    }
}

// MARK: - A sheet-filling state

private struct VoiceStatePage: View {
    let page: VoiceLogModel.StatePage
    let model: VoiceLogModel
    let header: VoiceHeader
    let perform: (VoiceLogModel.Action) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                symbol.padding(.top, 4)
                Text(page.title)
                    .wholeWords(page.title, font: VoiceType.title)
                    .foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.top, 20)
                VoiceNote(text: page.text).padding(.top, 8)
                if let progress = page.progress {
                    ProgressBar(fraction: progress.fraction).padding(.top, 20)
                    HStack(alignment: .firstTextBaseline) {
                        VoiceLabel("Eenmalig")
                        Spacer(minLength: 12)
                        if let amount = model.installAmount { VoiceLabel(amount) }
                    }
                    .padding(.top, 8)
                    .accessibilityElement(children: .combine)
                }
                if let meta = page.meta { VoiceLabel(meta).padding(.top, 16) }
                if let note = page.note { VoiceNote(text: note, color: .inkMute).padding(.top, 16) }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VoiceFooter {
                if let primary = page.primary { AuthButton(title: primary.label) { perform(primary) } }
                if let secondary = page.secondary {
                    AuthButton(title: secondary.label, weight: .ghost) { perform(secondary) }
                }
            }
        }
    }

    @ViewBuilder private var symbol: some View {
        let image = Image(systemName: page.symbol)
            .font(.system(size: 30, weight: .ultraLight))
            .foregroundStyle(Color.inkSoft)
            .frame(width: 40, height: 40, alignment: .leading)
        if page.kind == .speechOff {
            // No slashed speech bubble in SF Symbols: the bubble, struck through.
            image.overlay {
                Rectangle().fill(Color.inkSoft).frame(width: 1.6, height: 44).rotationEffect(.degrees(-45))
                    .offset(x: -2)
            }
            .accessibilityHidden(true)
        } else {
            image.accessibilityHidden(true)
        }
    }
}

private struct ProgressBar: View {
    let fraction: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.inkFaint.opacity(0.7))
                Capsule().fill(Color.signal).frame(width: geo.size.width * min(max(fraction, 0), 1))
            }
        }
        .frame(height: 6)
        .accessibilityElement()
        .accessibilityLabel("Voortgang")
        .accessibilityValue("\(Int((fraction * 100).rounded())) procent")
    }
}

// MARK: - Sent

private struct VoiceSentPage: View {
    let model: VoiceLogModel
    let header: VoiceHeader
    let close: () -> Void
    let open: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                Image(systemName: "tray")
                    .font(.system(size: 28, weight: .ultraLight))
                    .foregroundStyle(Color.inkSoft)
                    .padding(.top, 4)
                    .accessibilityHidden(true)
                Text(model.sentTitle)
                    .wholeWords(model.sentTitle, font: VoiceType.title)
                    .foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.top, 20)
                VoiceNote(text: model.sentText).padding(.top, 8)
                Button(action: open) {
                    HStack(alignment: .center, spacing: 12) {
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Circle().fill(Color.attn).frame(width: 7, height: 7).glow(Glow.attn)
                                .alignmentGuide(.firstTextBaseline) { $0[.bottom] + 1 }
                            VStack(alignment: .leading, spacing: 4) {
                                Text(model.sentSummary)
                                    .wholeWords(model.sentSummary, font: VoiceType.headline)
                                    .foregroundStyle(Color.inkBright)
                                    .multilineTextAlignment(.leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                Text(Self.meta)
                                    .font(.mono(12, relativeTo: .caption))
                                    .tracking(1.2)
                                    .dynamicTypeSize(...VoiceLabel.largest)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        RowChevron()
                    }
                    .padding(16)
                    .glassPanel()
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.top, 20)
                .accessibilityElement(children: .combine)
                .accessibilityHint("Opent de suggestie in Voor jou.")
                VoiceLabel(model.sentRecordingLine, color: .inkLabel).padding(.top, 16)
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VoiceFooter {
                AuthButton(title: "Bekijk in Voor jou", weight: .outline, action: open)
                AuthButton(title: "Klaar", weight: .ghost, action: close)
            }
        }
    }

    /// "SUGGESTIE · NU · WACHT OP JOU", the last part in amber: it waits on
    /// Martin, and amber is for nothing else.
    static var meta: AttributedString {
        var head = AttributedString("SUGGESTIE · NU · ")
        head.foregroundColor = .inkDim
        var tail = AttributedString("WACHT OP JOU")
        tail.foregroundColor = .attn
        return head + tail
    }
}
