import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Makes a voice log's model: one per fresh log (`VoiceLogSession`), so each
/// log has its own clientId and its own (emptied) recordings folder.
@MainActor
struct VoiceLogFactory {
    let make: @MainActor () -> VoiceLogModel
}

/// "Gesprek vastleggen" as a sheet (design brief §3: medium sheet with a
/// grabber). Holds NO state of its own: the model lives in `VoiceLogSession`,
/// above the lock gate and the sign-in screen, so a relock or a 401 that
/// tears this view down cannot take the text or the recording with it. Only
/// an explicit close discards (`VoiceLogSession.close`).
struct VoiceLogSheet: View {
    let session: VoiceLogSession

    var body: some View {
        Group {
            if let model = session.model {
                VoiceLogView(model: model, close: { session.close() })
                    .interactiveDismissDisabled(model.holdsUnsentWork)
                    .task { await model.prepare() }
            } else {
                Color.void.ignoresSafeArea()
            }
        }
        // Gone without a close (lock screen, sign-in): keep, never discard.
        .onDisappear { session.sheetDisappeared() }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

extension VoiceLogModel {
    /// A swipe must not throw away a recording or typed text by accident.
    var holdsUnsentWork: Bool {
        switch phase {
        case .recording, .transcribing, .sending: true
        case .editing: !trimmedTranscript.isEmpty || hasRecording
        case .idle, .sent: false
        }
    }
}

/// The screen. Layout only: every word comes from `VoiceLogModel`
/// (VoiceLogModelTests). Amber appears nowhere — nothing here waits on Martin.
/// No haptics while recording (brief §2.5: never disturb the microphone).
struct VoiceLogView: View {
    @Bindable var model: VoiceLogModel
    let close: () -> Void
    /// "Opname kiezen": the document picker for a call recording.
    @State private var picking = false

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header
                    if let line = model.speechLine {
                        Text(line)
                            .font(.mono(12, relativeTo: .caption))
                            .foregroundStyle(model.speech == .ready ? Color.inkDim : Color.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        if model.canRetrySpeech {
                            AuthButton(title: VoiceLogModel.Copy.retry, weight: .secondary) {
                                Task { await model.retrySpeech() }
                            }
                        }
                    }
                    content
                    if let notice = model.notice {
                        Text(notice)
                            .font(.display(14, relativeTo: .callout, weight: .light))
                            .foregroundStyle(Color.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        if model.micDenied { settingsButton }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 26)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .preferredColorScheme(.dark)
        // Audio only; the picked file is copied, never moved or changed.
        .fileImporter(isPresented: $picking, allowedContentTypes: [.audio]) { result in
            guard case .success(let url) = result else { return }
            Task { await model.importPicked(url) }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(model.title)
                .font(.display(26, relativeTo: .title, weight: .ultraLight))
                .foregroundStyle(Color.inkBright)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            Button("Sluiten", action: close)
                .font(.display(14, relativeTo: .callout))
                .foregroundStyle(Color.signalLink)
        }
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .idle, .recording, .transcribing:
            capture
        case .editing, .sending:
            editor
        case .sent:
            sent
        }
    }

    // MARK: - Capture

    private var capture: some View {
        VStack(spacing: 20) {
            // From a finished call (`CallSession`): goes on top of the text.
            if let prefill = model.prefill {
                section("Uit je gesprekspunten") {
                    Text(prefill)
                        .font(.display(15, relativeTo: .subheadline, weight: .light))
                        .foregroundStyle(Color.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(12)
                        .glassPanel()
                }
            }
            Text(model.phaseLine)
                .font(.display(15, relativeTo: .subheadline))
                .foregroundStyle(Color.inkMute)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
            if model.phase == .transcribing, let progress = model.transcriptionProgress {
                // A long call takes a while on the phone: say how far.
                ProgressView(value: progress)
                    .tint(Color.signal)
                    .frame(maxWidth: .infinity)
                    .frame(height: 132)
                    .accessibilityLabel(model.phaseLine)
            } else if model.phase == .transcribing {
                ProgressView().tint(Color.signal).frame(height: 132)
            } else if model.canRecord || model.phase == .recording {
                HoldToRecord(model: model)
            }
            if model.phase == .idle {
                AuthButton(title: "Typ zelf", weight: .secondary) { model.typeInstead() }
                AuthButton(title: VoiceLogModel.Copy.pickRecording, weight: .secondary) { picking = true }
                Text(VoiceLogModel.Copy.phoneRecordingHint)
                    .font(.display(13, relativeTo: .footnote, weight: .light))
                    .foregroundStyle(Color.inkMute)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Editor

    private var editor: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(model.phaseLine)
                .font(.display(14, relativeTo: .callout, weight: .light))
                .foregroundStyle(Color.inkMute)
                .fixedSize(horizontal: false, vertical: true)

            section("Tekst") {
                TextEditor(text: $model.transcript)
                    .font(.display(17, relativeTo: .body, weight: .light))
                    .foregroundStyle(Color.inkBright)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 140)
                    .padding(12)
                    .glassPanel()
                    .accessibilityLabel("Tekst van het gesprek")
            }

            section("Met wie") { partyPicker }

            section("Hoe") {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(VoiceChannel.allCases) { channel in
                            ChannelChip(label: channel.label, selected: model.channel == channel) {
                                model.channel = channel
                            }
                        }
                    }
                }
            }

            if model.occurredAt != nil { occurredPicker }

            if model.canRecordAgain {
                AuthButton(title: VoiceLogModel.Copy.recordAgain, weight: .secondary) { model.recordAgain() }
            }
            if model.canRetryTranscription {
                AuthButton(title: VoiceLogModel.Copy.retryTranscription, weight: .secondary) {
                    Task { await model.retryTranscription() }
                }
            }

            if model.hasRecording {
                VStack(alignment: .leading, spacing: 6) {
                    Toggle(isOn: $model.keepRecording) {
                        Text("Bewaar opname")
                            .font(.display(17, relativeTo: .body, weight: .medium))
                            .foregroundStyle(Color.inkBright)
                    }
                    .tint(Color.signal)
                    Text(model.keepRecordingHint)
                        .font(.display(14, relativeTo: .callout, weight: .light))
                        .foregroundStyle(Color.inkMute)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            AuthButton(title: model.phase == .sending ? "Versturen…" : "Verstuur als voorstel",
                       enabled: model.canSend) {
                Task { await model.send() }
            }
            AuthButton(title: "Weggooien", weight: .secondary, enabled: model.phase == .editing) {
                model.discard()
            }
        }
    }

    /// "Gesprek was om …": compact, Amsterdam's clock, never in the future.
    private var occurredPicker: some View {
        DatePicker(selection: Binding(get: { model.occurredAt ?? model.latestOccurredAt },
                                      set: { model.setOccurredAt($0) }),
                   in: ...model.latestOccurredAt,
                   displayedComponents: [.date, .hourAndMinute]) {
            Text(VoiceLogModel.Copy.occurredAt)
                .font(.mono(12, relativeTo: .caption, weight: .medium))
                .foregroundStyle(Color.inkLabel)
        }
        .datePickerStyle(.compact)
        .environment(\.locale, Locale(identifier: "nl_NL"))
        .environment(\.timeZone, ProposalFormat.amsterdam)
        .tint(Color.signal)
    }

    @ViewBuilder private var partyPicker: some View {
        if let line = model.partiesLine {
            Text(line)
                .font(.display(14, relativeTo: .callout, weight: .light))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
            if model.canRetryParties {
                AuthButton(title: VoiceLogModel.Copy.retry, weight: .secondary) { Task { await model.retryParties() } }
            }
        } else {
            Menu {
                Picker("Met wie", selection: $model.partyId) {
                    ForEach(model.parties) { party in
                        Text(party.name).tag(Optional(party.id))
                    }
                }
            } label: {
                HStack {
                    Text(model.selectedParty?.name ?? "Kies een partij")
                        .font(.display(17, relativeTo: .body, weight: .medium))
                        .foregroundStyle(Color.inkBright)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Color.inkFaint)
                }
                .padding(16)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .glassPanel()
            }
        }
    }

    // MARK: - Sent

    private var sent: some View {
        VStack(alignment: .leading, spacing: 20) {
            Label {
                Text(model.phaseLine)
                    .font(.display(17, relativeTo: .body, weight: .light))
                    .foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "checkmark.circle").foregroundStyle(Color.okay)
            }
            AuthButton(title: "Nog een gesprek", weight: .secondary) { model.startOver() }
            AuthButton(title: "Klaar", action: close)
        }
    }

    private func section(_ title: String, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.mono(11, relativeTo: .caption2, weight: .medium))
                .foregroundStyle(Color.inkLabel)
            content()
        }
    }

    private var settingsButton: some View {
        AuthButton(title: "Open Instellingen", weight: .secondary) {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        }
    }
}

/// The hold-to-record control: down starts, up stops. VoiceOver and Switch
/// Control get a plain activate action that toggles instead, because a hold
/// is not a gesture they can perform.
private struct HoldToRecord: View {
    let model: VoiceLogModel

    private var recording: Bool { model.phase == .recording }

    var body: some View {
        ZStack {
            Circle()
                .fill(recording ? Color.signal : Color.field)
                .overlay(Circle().strokeBorder(recording ? Color.signalLit : Color.edgeStrong, lineWidth: 1))
                .shadow(color: recording ? Glow.action.color : .clear, radius: Glow.action.radius)
            Image(systemName: recording ? "waveform" : "mic.fill")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(recording ? Color.onSignal : Color.signalLink)
                .symbolEffect(.variableColor.iterative, isActive: recording)
        }
        .frame(width: 132, height: 132)
        .contentShape(Circle())
        .onLongPressGesture(minimumDuration: .infinity, maximumDistance: 80, perform: {}) { pressing in
            Task { pressing ? await model.startRecording() : await model.stopRecording() }
        }
        .accessibilityElement()
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(recording ? "Stop opname" : "Neem op")
        .accessibilityHint("Houd ingedrukt zolang je praat.")
        .accessibilityAction {
            Task { recording ? await model.stopRecording() : await model.startRecording() }
        }
        .frame(maxWidth: .infinity)
    }
}

private struct ChannelChip: View {
    let label: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.mono(12, relativeTo: .caption, weight: .medium))
                .foregroundStyle(selected ? Color.onSignal : Color.ink)
                .padding(.horizontal, 12)
                .frame(minHeight: 36)
                .background(RoundedRectangle(cornerRadius: Radius.chip).fill(selected ? Color.signal : Color.field))
                .overlay(RoundedRectangle(cornerRadius: Radius.chip)
                    .strokeBorder(selected ? Color.signalLit : Color.edgeStrong, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
