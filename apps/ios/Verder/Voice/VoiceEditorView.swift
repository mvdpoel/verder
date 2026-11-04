import SwiftUI

/// The note itself (frames "voorbeeld", "tijd wijzigen", "tekst bewerken",
/// "typen", "niet verstuurd …", "voorbeeld · vergrendeld", AX5, SE): what was
/// said, with whom, when, how, and the pinned send button. Layout only.
struct VoiceEditorPage: View {
    @Bindable var model: VoiceLogModel
    let locked: Bool
    let header: VoiceHeader
    let unlock: () -> Void
    let askDiscard: () -> Void
    @FocusState private var textFocus: Bool
    @State private var choosingChannel = false
    @Environment(\.dynamicTypeSize) private var typeSize

    private var ax: Bool { typeSize.isAccessibilitySize }
    /// Editing a heard transcript: the keyboard takes the room the rows had
    /// (frame "tekst bewerken"); a typed note keeps "Met wie" in view.
    private var textOnly: Bool { model.textFocused && !model.recognizedTranscript.isEmpty }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                if let banner = model.banner {
                    VoiceBannerCard(banner: banner).padding(.top, 16)
                }
                textLabelRow.padding(.top, model.banner == nil ? 20 : 24)
                transcriptField.padding(.top, 8)
                if model.canRecordAgain && !model.textFocused {
                    HStack {
                        if !ax { Spacer(minLength: 0) }
                        Button {
                            if model.needsRecordAgainConfirmation { model.confirmingRecordAgain = true } else { model.recordAgain() }
                        } label: {
                            // Wraps at AX5 (two lines, frame "voorbeeld · AX5"):
                            // a one-line label widened the whole page.
                            Text(VoiceLogModel.Copy.recordAgain)
                                .wholeWords(VoiceLogModel.Copy.recordAgain, font: VoiceType.headlineMedium)
                                .foregroundStyle(Color.signalLink)
                                .multilineTextAlignment(ax ? .leading : .trailing)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(minHeight: 44)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.top, 4)
                }
                if !textOnly {
                    ProposalLabel("Gesprek").padding(.top, model.canRecordAgain ? 12 : 20)
                    conversationCard.padding(.top, 8)
                }
                if ax, let note = model.footnote(locked: locked) {
                    footnoteText(note).padding(.top, 24)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 16)
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollIndicators(.visible)
        .fixtureVoiceScroll()
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
        .onChange(of: model.textFocused, initial: true) { _, focused in
            if textFocus != focused { textFocus = focused }
        }
        .onChange(of: textFocus) { _, focused in
            if model.textFocused != focused { model.textFocused = focused }
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Gereed") { model.textFocused = false }
                    .font(VoiceType.headlineMedium)
                    .foregroundStyle(Color.signalLink)
                Spacer()
            }
        }
        .sheet(isPresented: $model.pickerOpen) { PartyPickerSheet(model: model) }
    }

    // MARK: What was said

    private var textLabelRow: some View {
        HStack(alignment: .firstTextBaseline) {
            ProposalLabel(model.textLabel)
            Spacer(minLength: 12)
            if !ax && !model.textFocused && !model.trimmedTranscript.isEmpty {
                ProposalLabel("Tik om te bewerken").accessibilityHidden(true)
            }
        }
    }

    @ViewBuilder private var transcriptField: some View {
        if model.textFocused || (model.trimmedTranscript.isEmpty && !locked) {
            TextEditor(text: $model.transcript)
                .focused($textFocus)
                .font(VoiceType.headline)
                .foregroundStyle(Color.inkBright)
                .tint(Color.signal)
                .scrollContentBackground(.hidden)
                .frame(minHeight: textOnly ? 200 : 76)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .overlay(alignment: .topLeading) {
                    if model.transcript.isEmpty {
                        Text(VoiceLogModel.Copy.placeholder)
                            .font(VoiceType.headline)
                            .foregroundStyle(Color.inkMute)
                            .padding(.horizontal, 17)
                            .padding(.vertical, 16)
                            .allowsHitTesting(false)
                    }
                }
                .background(RoundedRectangle(cornerRadius: Radius.panel).fill(Color.void.opacity(0.6)))
                .overlay(RoundedRectangle(cornerRadius: Radius.panel)
                    .strokeBorder(Color.signal.opacity(textFocus ? 1 : 0.5), lineWidth: 1.5))
                .accessibilityLabel("Wat je zei")
        } else {
            let text = Text(VoiceMarks.attributed(model.transcript, marks: locked ? [] : model.marks))
                .font(VoiceType.headline)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Group {
                if ax {
                    text.padding(.bottom, 12)
                        .overlay(alignment: .bottom) { Rectangle().fill(Color.hairline).frame(height: 1) }
                } else {
                    text.padding(16).glassPanel()
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { model.textFocused = true }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Dubbeltik om te bewerken.")
        }
    }

    // MARK: With whom, when, how

    private var conversationCard: some View {
        VStack(spacing: 0) {
            let party = model.partyRow(locked: locked)
            Button {
                if locked { unlock() } else { Task { await model.openPicker() } }
            } label: {
                VoiceRow(symbol: locked ? "lock" : "person.crop.circle", title: party.title, meta: party.meta,
                         titleColor: locked || model.partiesState != .loaded ? .inkSoft : .inkBright,
                         chevron: !locked)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(locked ? "Met wie, vergrendeld. \(party.title)" : "Met wie: \(party.title)")
            .accessibilityHint(locked ? "Dubbeltik om te ontgrendelen met Face ID" : "Dubbeltik om een partij te kiezen")
            if !(model.textFocused && model.recognizedTranscript.isEmpty) {
                divider
                timeRow
                divider
                channelControl
                if model.hasRecording {
                    divider
                    keepRow
                }
            }
        }
        .modifier(CardAtRegularSizes(ax: ax))
    }

    private var divider: some View {
        Rectangle().fill(Color.hairline).frame(height: 1).padding(.horizontal, ax ? 0 : 16)
    }

    private var timeRow: some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(.snappy) { model.timeOpen.toggle() }
            } label: {
                VoiceRow(symbol: "clock", title: model.timeRow.title, meta: model.timeRow.meta,
                         titleColor: model.timeOpen ? .signalLink : .inkBright, chevron: false)
            }
            .buttonStyle(.plain)
            .accessibilityHint(model.timeOpen ? "Dubbeltik om te sluiten" : "Dubbeltik om de tijd te wijzigen")
            if model.timeOpen {
                // In an overlay: the wheel's own intrinsic width is wider
                // than the card, and as a plain child it widened the whole
                // page past the screen.
                Color.clear
                    .frame(height: ax ? 260 : 132)
                    .frame(maxWidth: .infinity)
                    .overlay {
                        DatePicker("", selection: Binding(get: { model.occurredAt ?? model.latestOccurredAt },
                                                          set: { model.setOccurredAt($0) }),
                                   in: ...model.latestOccurredAt,
                                   displayedComponents: [.date, .hourAndMinute])
                            .datePickerStyle(.wheel)
                            .labelsHidden()
                            .environment(\.locale, VoiceText.dutch)
                            .environment(\.timeZone, ProposalFormat.amsterdam)
                            .accessibilityLabel(VoiceLogModel.Copy.occurredAt)
                    }
                    .clipped()
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
            }
        }
    }

    @ViewBuilder private var channelControl: some View {
        if ax {
            // A button and a dialog, not a Menu: a Menu lays its label out at
            // its one-line ideal width, which at AX5 widened the whole page.
            Button { choosingChannel = true } label: {
                VoiceRow(symbol: nil, title: model.channelRow.title, meta: model.channelRow.meta, chevron: false)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Hoe: \(model.channel.label)")
            .accessibilityHint("Dubbeltik om te kiezen")
            .confirmationDialog("Hoe was het gesprek?", isPresented: $choosingChannel, titleVisibility: .visible) {
                ForEach(VoiceChannel.allCases) { channel in
                    Button(channel.label) { model.choose(channel: channel) }
                }
                Button("Annuleer", role: .cancel) {}
            }
        } else {
            HStack(spacing: 0) {
                ForEach(VoiceChannel.primary) { channel in
                    segment(channel.label, selected: model.channel == channel) { model.choose(channel: channel) }
                }
                Menu {
                    ForEach(VoiceChannel.more) { channel in
                        Button { model.choose(channel: channel) } label: {
                            if model.channel == channel { Label(channel.label, systemImage: "checkmark") } else { Text(channel.label) }
                        }
                    }
                } label: {
                    let other = VoiceChannel.more.contains(model.channel)
                    segmentLabel(other ? model.channel.label : "Anders…", selected: other)
                }
                .accessibilityLabel(VoiceChannel.more.contains(model.channel) ? model.channel.label : "Anders")
            }
            .padding(3)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.void.opacity(0.5)))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Color.edge, lineWidth: 1))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
    }

    private func segment(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) { segmentLabel(label, selected: selected) }
            .buttonStyle(.plain)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func segmentLabel(_ label: String, selected: Bool) -> some View {
        Text(label)
            .font(VoiceType.callout)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .foregroundStyle(selected ? Color.inkBright : Color.inkSoft)
            .frame(maxWidth: .infinity, minHeight: 38)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 4, style: .continuous).fill(Color.void)
                        .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(Color.edgeStrong, lineWidth: 1))
                }
            }
            .contentShape(Rectangle())
    }

    private var keepRow: some View {
        // The switch beside the row, not a Toggle's label: a Toggle offers
        // its label its one-line ideal width, which at AX5 widened the page.
        HStack(spacing: 12) {
            VoiceRow(symbol: "mic", title: model.keepRow.title, meta: model.keepRow.meta, chevron: false, padded: false)
            Toggle(model.keepRow.title, isOn: $model.keepRecording)
                .labelsHidden()
                .tint(Color.signal)
        }
        .accessibilityElement(children: .combine)
        .padding(.horizontal, ax ? 0 : 16)
        .padding(.vertical, 12)
    }

    // MARK: The footer

    private var footer: some View {
        VoiceFooter(hairline: true) {
            let primary = model.primary(locked: locked)
            AuthButton(title: primary.title, enabled: primary.enabled) {
                switch primary.does {
                case .send: Task { await model.send() }
                case .sendWithout: Task { await model.sendWithoutRecording() }
                case .signIn: model.signInAgain()
                case .unlock: unlock()
                }
            }
            if model.sendFailure != nil {
                AuthButton(title: VoiceLogModel.Copy.discardEllipsis, weight: .ghost, enabled: model.phase == .editing,
                           action: askDiscard)
            } else if !ax, let note = model.footnote(locked: locked) {
                footnoteText(note)
            }
        }
    }

    private func footnoteText(_ note: String) -> some View {
        Text(note)
            .wholeWords(note, font: VoiceType.callout)
            .foregroundStyle(Color.inkSoft)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One row of the GESPREK card: a symbol (none at the accessibility sizes,
/// where it would take a line of its own), the title and a mono meta line.
struct VoiceRow: View {
    let symbol: String?
    let title: String
    let meta: String
    var titleColor: Color = .inkBright
    var chevron = true
    var padded = true
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            if let symbol, !typeSize.isAccessibilitySize {
                Image(systemName: symbol)
                    .font(.system(size: 17, weight: .light))
                    .foregroundStyle(Color.inkSoft)
                    .frame(width: 22)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .wholeWords(title, font: VoiceType.headline)
                    .foregroundStyle(titleColor)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                // MetaLine sets a one-group line unwrapped (it only breaks
                // between groups), so "ANDERS GEWIST NA VERSTUREN" at AX5
                // would widen the page: a single group wraps instead.
                if meta.contains(" · ") {
                    MetaLine(meta, color: .inkLabel)
                } else {
                    ProposalLabel(meta, color: .inkLabel)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if chevron { RowChevron() }
        }
        // At the accessibility sizes the rows stand without a card, edge to
        // gutter (frame "voorbeeld · AX5"): a 53-pt "Woonstichting" needs
        // every point of the line.
        .padding(.horizontal, padded && !typeSize.isAccessibilitySize ? 16 : 0)
        .padding(.vertical, padded ? 12 : 0)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

/// "Niet verstuurd" at the top of the note: the cause and that the text stays.
struct VoiceBannerCard: View {
    let banner: VoiceLogModel.Banner

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            Image(systemName: banner.symbol)
                .font(.system(size: 16, weight: .regular))
                .foregroundStyle(Color.inkSoft)
                .frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(banner.title)
                    .wholeWords(banner.title, font: VoiceType.headlineMedium)
                    .foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
                Text(banner.text)
                    .wholeWords(banner.text, font: VoiceType.callout)
                    .foregroundStyle(Color.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(16)
        .glassPanel()
        .accessibilityElement(children: .combine)
    }
}

/// The transcript with the words it was read from marked: dotted, in signal.
enum VoiceMarks {
    static func attributed(_ text: String, marks: [Range<String.Index>]) -> AttributedString {
        var out = AttributedString()
        var at = text.startIndex
        for mark in marks where mark.lowerBound >= at && mark.upperBound <= text.endIndex {
            var plain = AttributedString(String(text[at..<mark.lowerBound]))
            plain.foregroundColor = .inkBright
            var marked = AttributedString(String(text[mark]))
            marked.foregroundColor = .signalLink
            marked.underlineStyle = Text.LineStyle(pattern: .dot, color: .signalLink.opacity(0.8))
            out += plain
            out += marked
            at = mark.upperBound
        }
        var rest = AttributedString(String(text[at...]))
        rest.foregroundColor = .inkBright
        out += rest
        return out
    }
}

// MARK: - Met wie sprak je?

/// The party picker (frames "met wie", "met wie · geen partijen", "met wie ·
/// laden lukt niet"): a search, RECENT, ALLE PARTIJEN · A–Z.
struct PartyPickerSheet: View {
    @Bindable var model: VoiceLogModel
    @State private var detent: PresentationDetent = .large

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text("Met wie sprak je?")
                    .wholeWords("Met wie sprak je?", font: VoiceType.title)
                    .foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 12)
                Button("Annuleer") {
                    model.pickerOpen = false
                    model.pickerQuery = ""
                }
                .font(VoiceType.headline)
                .foregroundStyle(Color.signalLink)
                .frame(minHeight: 44)
            }
            .padding(.horizontal, 16)
            .padding(.top, 24)
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color.rail.ignoresSafeArea())
        .presentationBackground(Color.rail)
        .preferredColorScheme(.dark)
        .lineHeight(.multiple(factor: AuthType.lineFactor))
        .presentationDetents(model.partiesState == .loaded ? [.large] : [.fraction(0.44), .large], selection: $detent)
        .onChange(of: model.partiesState, initial: true) { _, state in
            detent = state == .loaded ? .large : .fraction(0.44)
        }
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder private var content: some View {
        switch model.partiesState {
        case .loaded:
            list
        case .loading:
            ProgressView().tint(Color.signal).frame(maxWidth: .infinity).padding(.top, 40)
        case .empty:
            stateBody(title: "Nog geen partijen", text: VoiceLogModel.Copy.noParties)
        case .failed:
            stateBody(title: "Partijen laden lukt niet", text: VoiceLogModel.Copy.partiesFailed)
        }
    }

    private func stateBody(title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .wholeWords(title, font: VoiceType.headlineMedium)
                .foregroundStyle(Color.inkBright)
            Text(text)
                .wholeWords(text, font: VoiceType.callout)
                .foregroundStyle(Color.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 24)
            AuthButton(title: VoiceLogModel.Copy.retry, weight: .outline) { Task { await model.retryParties() } }
        }
        .padding(.horizontal, 16)
        .padding(.top, 24)
        .padding(.bottom, 12)
    }

    private var list: some View {
        let sections = VoiceText.sections(model.parties, query: model.pickerQuery)
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                searchField.padding(.top, 16)
                if !sections.recent.isEmpty {
                    ProposalLabel("Recent").padding(.top, 24)
                    card(sections.recent, recent: true).padding(.top, 8)
                }
                if !sections.all.isEmpty {
                    ProposalLabel("Alle partijen · A–Z").padding(.top, 24)
                    card(sections.all, recent: false).padding(.top, 8)
                }
                if sections.recent.isEmpty && sections.all.isEmpty {
                    Text("Geen partij gevonden met “\(model.pickerQuery)”.")
                        .font(VoiceType.callout)
                        .foregroundStyle(Color.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 24)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.immediately)
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(Color.inkSoft)
                .accessibilityHidden(true)
            TextField("", text: $model.pickerQuery, prompt: Text("Zoek een partij").foregroundStyle(Color.inkMute))
                .font(VoiceType.headline)
                .foregroundStyle(Color.inkBright)
                .tint(Color.signal)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .accessibilityLabel("Zoek een partij")
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 44)
        .background(RoundedRectangle(cornerRadius: Radius.panel).fill(Color.void.opacity(0.6)))
    }

    private func card(_ parties: [PartyDTO], recent: Bool) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(parties.enumerated()), id: \.element.id) { i, party in
                if i > 0 { Rectangle().fill(Color.hairline).frame(height: 1).padding(.horizontal, 16) }
                Button { model.choose(party: party.id) } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(party.name)
                                .wholeWords(party.name, font: VoiceType.headline)
                                .foregroundStyle(Color.inkBright)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                            if let meta = Self.meta(party, recent: recent) { MetaLine(meta, color: .inkLabel) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if party.id == model.partyId {
                            Image(systemName: "checkmark")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(Color.signalLink)
                                .accessibilityHidden(true)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(party.id == model.partyId ? .isSelected : [])
            }
        }
        .glassPanel()
    }

    /// "VERHUURDER · LAATST 31 OKT": the role when served, the last contact
    /// in the RECENT section.
    static func meta(_ party: PartyDTO, recent: Bool) -> String? {
        let parts = [party.role?.uppercased(), recent ? party.lastContactAt.map(VoiceText.lastContact) : nil].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// The tab bar's accessory while a hands-free recording runs with the sheet
/// down (frame "opname · blad omlaag"): a tap opens the sheet, "Stop" stops
/// and transcribes.
struct VoiceRecordingAccessory: View {
    let session: VoiceLogSession

    var body: some View {
        HStack(spacing: 12) {
            Button { session.open() } label: {
                HStack(spacing: 12) {
                    Circle().fill(Color.signal).frame(width: 8, height: 8).glow(Glow.signalDot)
                    Text("Opname loopt")
                        .font(VoiceType.headline)
                        .foregroundStyle(Color.inkBright)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        Text(session.model?.elapsedText ?? "")
                            .font(.mono(17, relativeTo: .headline, weight: .medium))
                            .monospacedDigit()
                            .foregroundStyle(Color.inkBright)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Opname loopt. Open de spraaknotitie.")
            Button("Stop") { session.stopInBackground() }
                .font(VoiceType.headlineMedium)
                .foregroundStyle(Color.signalLink)
                .accessibilityLabel("Stop de opname")
        }
        .padding(.horizontal, 18)
    }
}

extension View {
    /// A capture's `-fixtures-scroll end|middle` on the note: the lower parts
    /// of the full-length AX5 frame. Nothing in a Release build.
    @ViewBuilder func fixtureVoiceScroll() -> some View {
        #if DEBUG
        switch FixtureLaunch.current?.scroll {
        case .end?: defaultScrollAnchor(.bottom)
        case .middle?: defaultScrollAnchor(.center)
        default: self
        }
        #else
        self
        #endif
    }
}

/// The GESPREK card's glass, at the ordinary sizes only.
private struct CardAtRegularSizes: ViewModifier {
    let ax: Bool
    func body(content: Content) -> some View {
        if ax { content } else { content.glassPanel() }
    }
}
