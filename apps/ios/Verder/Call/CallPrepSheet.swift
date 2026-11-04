import SwiftUI

/// "Gesprek voorbereiden" as a sheet (design brief §3: medium/large with a
/// grabber). Holds no state of its own: the call lives in `CallSession`,
/// above the lock gate, so a relock or the Phone app taking the screen never
/// loses a tick. Layout only — every word and count comes from
/// `CallChecklist`, `CallCopy` and `CallPrepModel` (CallPrepTests).
///
/// Amber appears nowhere: a point to RAISE with someone else is not waiting
/// on Martin. Ticked points turn steel (done).
struct CallPrepSheet: View {
    let session: CallSession
    /// A source link (`verder://task/<id>`, `verder://dossier`, …): the sheet
    /// steps aside and the link lands where a push's would.
    let open: (String) -> Void

    var body: some View {
        Group {
            if let model = session.model {
                CallPrepView(session: session, model: model, open: open)
            } else {
                Color.void.ignoresSafeArea()
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

struct CallPrepView: View {
    let session: CallSession
    @Bindable var model: CallPrepModel
    let open: (String) -> Void

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header
                    if session.callEnded { endedCard }
                    content
                    if let notice = session.notice {
                        Text(notice)
                            .font(.display(14, relativeTo: .callout, weight: .light))
                            .foregroundStyle(Color.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(CallCopy.noListening)
                        .font(.mono(11, relativeTo: .caption2))
                        .foregroundStyle(Color.inkDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 26)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .refreshable { await model.load() }
        }
        .preferredColorScheme(.dark)
        .sensoryFeedback(.selection, trigger: model.checklist.discussed)
    }

    // MARK: - Top

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(CallCopy.title.uppercased())
                    .font(.mono(11, relativeTo: .caption2, weight: .medium))
                    .foregroundStyle(Color.inkLabel)
                Spacer(minLength: 8)
                Button("Sluiten") { session.close() }
                    .font(.display(14, relativeTo: .callout))
                    .foregroundStyle(Color.signalLink)
            }
            Text(model.partyName ?? "")
                .font(.display(26, relativeTo: .title, weight: .ultraLight))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let line = model.freshness {
                Text(line)
                    .font(.mono(12, relativeTo: .caption))
                    .foregroundStyle(Color.inkLabel)
            }
        }
    }

    private var endedCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label {
                Text(CallCopy.ended)
                    .font(.display(17, relativeTo: .body, weight: .light))
                    .foregroundStyle(Color.inkBright)
            } icon: {
                Image(systemName: "phone.down").foregroundStyle(Color.steel)
            }
            Text(model.checklist.progressText)
                .font(.mono(12, relativeTo: .caption))
                .foregroundStyle(Color.inkMute)
            AuthButton(title: CallCopy.logCall) { session.logCall() }
            AuthButton(title: CallCopy.notNow, weight: .secondary) { session.dismissEnded() }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
    }

    // MARK: - States

    @ViewBuilder private var content: some View {
        switch model.screen {
        case .loading:
            HStack(spacing: 10) {
                ProgressView().tint(Color.signal)
                Text(CallCopy.loading).font(.mono(12, relativeTo: .caption)).foregroundStyle(Color.inkMute)
            }
        case .offlineNothingCached:
            stateText(CallCopy.offlineNothing, retry: true)
        case .notFound:
            stateText(CallCopy.notFound, retry: false)
        case .failed:
            stateText(CallCopy.failed, retry: true)
        case .points:
            points
        }
    }

    @ViewBuilder private func stateText(_ text: String, retry: Bool) -> some View {
        Text(text)
            .font(.display(15, relativeTo: .subheadline, weight: .light))
            .foregroundStyle(Color.ink)
            .fixedSize(horizontal: false, vertical: true)
        if retry {
            AuthButton(title: "Opnieuw proberen", weight: .secondary) { Task { await model.load() } }
        }
    }

    // MARK: - The points

    @ViewBuilder private var points: some View {
        if let summary = model.dto?.summary { summaryCard(summary) }

        VStack(alignment: .leading, spacing: 6) {
            Text(model.checklist.progressText)
                .font(.mono(12, relativeTo: .caption, weight: .medium))
                .foregroundStyle(Color.inkLabel)
                .monospacedDigit()
            if model.checklist.total > 0 {
                ProgressView(value: Double(model.checklist.discussed), total: Double(model.checklist.total))
                    .tint(Color.steel)
                    .accessibilityHidden(true)
            }
        }

        ForEach(CallList.allCases, id: \.self) { list in listSection(list) }

        actions
    }

    /// The ONE AI line, marked as AI with its day; a tap unfolds what it was
    /// written from, each opening its own screen.
    private func summaryCard(_ s: TalkingPointsDTO.Summary) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { model.showsSummarySources.toggle() } label: {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkles").accessibilityHidden(true)
                        Text(CallCopy.summaryLabel(s).uppercased())
                        Spacer(minLength: 0)
                        Image(systemName: model.showsSummarySources ? "chevron.up" : "chevron.down")
                            .accessibilityHidden(true)
                    }
                    .font(.mono(11, relativeTo: .caption2, weight: .medium))
                    .foregroundStyle(Color.inkLabel)
                    Text(s.text)
                        .font(.display(16, relativeTo: .body, weight: .light))
                        .foregroundStyle(Color.inkBright)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(model.showsSummarySources ? "Verbergt de bronnen." : "Toont waar dit op is gebaseerd.")
            if model.showsSummarySources {
                Text("GEBASEERD OP")
                    .font(.mono(11, relativeTo: .caption2, weight: .medium))
                    .foregroundStyle(Color.inkLabel)
                ForEach(CallCopy.sources(s)) { source in
                    Button { open(source.link) } label: {
                        HStack {
                            Text(source.label)
                                .font(.display(15, relativeTo: .subheadline))
                                .foregroundStyle(Color.signalLink)
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Color.inkFaint)
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
    }

    private func listSection(_ list: CallList) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(list.title.uppercased())
                .font(.mono(11, relativeTo: .caption2, weight: .medium))
                .foregroundStyle(Color.inkLabel)
                .accessibilityAddTraits(.isHeader)
            let items = model.checklist.items(list)
            if items.isEmpty {
                Text(list.emptyText)
                    .font(.display(14, relativeTo: .callout, weight: .light))
                    .foregroundStyle(Color.inkMute)
            }
            ForEach(items) { item in row(item) }
        }
    }

    private func row(_ item: CallPoint) -> some View {
        let ticked = model.checklist.isTicked(item.id)
        return HStack(alignment: .top, spacing: 12) {
            Button { session.toggle(item.id) } label: {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: ticked ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 22, weight: .light))
                        .foregroundStyle(ticked ? Color.steel : Color.inkFaint)
                        .contentTransition(.symbolEffect(.replace))
                    Text(item.text)
                        .font(.display(16, relativeTo: .body, weight: .regular))
                        .foregroundStyle(ticked ? Color.inkMute : Color.inkBright)
                        .strikethrough(ticked, color: Color.inkFaint)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isToggle)
            .accessibilityValue(ticked ? "besproken" : "nog niet besproken")

            Button { open(item.link) } label: {
                Image(systemName: "arrow.up.forward.square")
                    .font(.system(size: 17, weight: .light))
                    .foregroundStyle(Color.signalLink)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open de bron")
        }
        .padding(.leading, 16)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
    }

    // MARK: - Bel and the Live Activity

    @ViewBuilder private var actions: some View {
        if let phone = model.phone, model.dialURL != nil {
            AuthButton(title: "Bel \(phone)") { session.bel() }
        } else {
            Text(CallCopy.noNumber)
                .font(.display(14, relativeTo: .callout, weight: .light))
                .foregroundStyle(Color.inkMute)
                .fixedSize(horizontal: false, vertical: true)
        }
        if session.activityRunning {
            Text(CallCopy.showing)
                .font(.mono(11, relativeTo: .caption2))
                .foregroundStyle(Color.inkMute)
                .fixedSize(horizontal: false, vertical: true)
            AuthButton(title: CallCopy.stopShowing, weight: .secondary) { session.endActivity() }
        } else if !session.callEnded {
            AuthButton(title: CallCopy.showDuring, weight: .secondary) { session.startActivity() }
        }
    }
}
