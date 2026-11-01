import SwiftUI
import UIKit

/// Makes a voice log's model: one per opening, so each log has its own
/// clientId and its own (emptied) recordings folder.
@MainActor
struct VoiceLogFactory {
    let make: @MainActor () -> VoiceLogModel
}

/// "Gesprek vastleggen" as a sheet (design brief §3: medium sheet with a
/// grabber). The model is made ONCE, on appear: a model made in an
/// initializer would be remade on every re-render, and making one empties
/// the recordings folder.
struct VoiceLogSheet: View {
    let factory: VoiceLogFactory
    @State private var model: VoiceLogModel?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            if let model {
                VoiceLogView(model: model, close: { close(model) })
                    .interactiveDismissDisabled(model.holdsUnsentWork)
                    .task { await model.prepare() }
            } else {
                Color.void.ignoresSafeArea()
            }
        }
        .onAppear { if model == nil { model = factory.make() } }
        // Swiped away or closed: whatever was not sent is thrown away,
        // recording included.
        .onDisappear { model?.discard() }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func close(_ model: VoiceLogModel) {
        model.discard()
        dismiss()
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
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Gesprek vastleggen")
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
            Text(model.phaseLine)
                .font(.display(15, relativeTo: .subheadline))
                .foregroundStyle(Color.inkMute)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
            if model.phase == .transcribing {
                ProgressView().tint(Color.signal).frame(height: 132)
            } else if model.canRecord || model.phase == .recording {
                HoldToRecord(model: model)
            }
            if model.phase == .idle {
                AuthButton(title: "Typ zelf", weight: .secondary) { model.typeInstead() }
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

            if let when = model.occurredLabel {
                Text(when)
                    .font(.mono(12, relativeTo: .caption))
                    .foregroundStyle(Color.inkLabel)
            }

            if model.hasRecording {
                VStack(alignment: .leading, spacing: 6) {
                    Toggle(isOn: $model.keepRecording) {
                        Text("Bewaar opname")
                            .font(.display(17, relativeTo: .body, weight: .medium))
                            .foregroundStyle(Color.inkBright)
                    }
                    .tint(Color.signal)
                    Text("Alleen dan gaat de opname naar verder. Anders wordt ze na het versturen gewist.")
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

    @ViewBuilder private var partyPicker: some View {
        if model.parties.isEmpty {
            Text(model.partiesFailed ? VoiceLogModel.Copy.partiesFailed : "Partijen laden…")
                .font(.display(14, relativeTo: .callout, weight: .light))
                .foregroundStyle(Color.ink)
            if model.partiesFailed {
                AuthButton(title: "Opnieuw laden", weight: .secondary) { Task { await model.loadParties() } }
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
