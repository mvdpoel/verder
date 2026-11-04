import SwiftUI

/// The small labels of the proposal screen ("CONCEPT", "AANLEIDING · MAIL"):
/// IBM Plex Mono 12, upper case and tracked at the ordinary sizes. At the
/// accessibility sizes the frames set them in sentence case and untracked,
/// because capitals at 28 pt run a label off the line.
struct ProposalLabel: View {
    let text: String
    var color: Color = .inkLabel
    @Environment(\.dynamicTypeSize) private var typeSize

    init(_ text: String, color: Color = .inkLabel) {
        self.text = text
        self.color = color
    }

    var body: some View {
        let ax = typeSize.isAccessibilitySize
        let shown = ax ? text : text.uppercased()
        Text(shown)
            .wholeWords(shown, font: .mono(12, relativeTo: .caption))
            .tracking(ax ? 0 : 1.2)
            .foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// "● WACHT OP JOU" (amber: the one thing here waiting on Martin), "● VERSTUURD"
/// (okay), "● WORDT OPGESTELD" (steel).
struct StatusBadge: View {
    let badge: ProposalText.Badge
    @Environment(\.dynamicTypeSize) private var typeSize

    private var color: Color {
        switch badge {
        case .waiting: .attn
        case .sent: .okay
        case .drafting: .steel
        }
    }

    var body: some View {
        let ax = typeSize.isAccessibilitySize
        let text = ProposalText.badgeText(badge)
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: ax ? 10 : 5, height: ax ? 10 : 5)
            Text(ax ? text : text.uppercased())
                .font(.mono(12, relativeTo: .caption, weight: .medium))
                .tracking(ax ? 0 : 1)
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(color.opacity(0.85), lineWidth: 1))
    }
}

/// A label with its icon 6 pt before it ("✎ Aanpassen").
struct TightLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}

/// An e-mail address or a file name on ONE line, cut in the middle when it
/// does not fit — never wrapped at its "@" or its dots (Martin's rule for
/// the accessibility sizes). At the ordinary sizes a file name may wrap,
/// as the frames draw "Beschikking Rechtbank Westerlaan 2026.pdf".
struct OneLine: ViewModifier {
    var always = false
    @Environment(\.dynamicTypeSize) private var typeSize

    func body(content: Content) -> some View {
        if always || typeSize.isAccessibilitySize {
            content.lineLimit(1).truncationMode(.middle)
        } else {
            content.fixedSize(horizontal: false, vertical: true)
        }
    }
}

extension View {
    func oneLine(always: Bool = false) -> some View { modifier(OneLine(always: always)) }
}

// MARK: - Trigger

/// "AANLEIDING · MAIL · 2 NOV 09:14" over "**Ilse** vraagt om je loonstrook van
/// oktober." The mail itself does not open on the phone yet (F-29).
struct TriggerCard: View {
    let model: ProposalModel
    let detail: ProposalDetail
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProposalLabel(ProposalText.triggerMeta(kind: detail.kind, trigger: detail.trigger, now: now))
            if let line = ProposalText.triggerLine(kind: detail.kind, ask: detail.ask, trigger: detail.trigger,
                                                   partyName: detail.partyName) {
                let lead = Text(line.lead ?? "").font(.display(17, relativeTo: .body, weight: .semibold))
                    .foregroundStyle(Color.inkBright)
                let rest = Text(line.rest).font(.display(17, relativeTo: .body)).foregroundStyle(Color.ink)
                Text("\(lead)\(rest)")
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let note = model.senderNote { ProposalLabel(note, color: .inkMute) }
            if let due = model.dueText { ProposalLabel(due, color: model.isPending ? .attn : .ink) }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Draft

/// The draft as it would leave: Aan, the subject, the body — paragraphs Martin
/// added marked — what he changed in one line, then the attachments.
struct DraftCard: View {
    let model: ProposalModel
    let editable: Bool
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if let draft = model.draft {
            let changes = model.changes
            let lines = changes?.lines ?? ProposalText.paragraphs(draft.body).map { .same($0) }
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 10) {
                    recipients("Aan", draft.to)
                    if !draft.cc.isEmpty { recipients("Cc", draft.cc) }
                    Text(draft.subject)
                        .font(.display(17, relativeTo: .body, weight: .semibold))
                        .foregroundStyle(Color.inkBright)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 2)
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in paragraph(line) }
                        .textSelection(.enabled)
                    if let summary = changes?.summary {
                        VStack(alignment: .leading, spacing: 2) {
                            ProposalLabel("Aangepast door jou · \(summary)", color: .inkDim)
                            ProposalLabel("Het concept van verder blijft bewaard", color: .inkDim)
                        }
                        .padding(.top, 4)
                    }
                }
                attachments
                Color.clear.frame(height: 1)
                    .id(ProposalAnchor.draftEnd)
                    .onScrollVisibilityChange(threshold: 0.5) { visible in
                        if visible { model.markDraftSeen() }
                    }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassPanel()
        }
    }

    @ViewBuilder
    private func recipients(_ label: String, _ addresses: [String]) -> some View {
        let joined = addresses.joined(separator: ", ")
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                ProposalLabel(label)
                Text(joined).font(.mono(13, relativeTo: .footnote)).foregroundStyle(Color.ink).lineLimit(1)
                    .fixedSize()
            }
            VStack(alignment: .leading, spacing: 2) {
                ProposalLabel(label)
                Text(joined).font(.mono(13, relativeTo: .footnote)).foregroundStyle(Color.ink).oneLine(always: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func paragraph(_ line: DraftChanges.Line) -> some View {
        switch line {
        case .same(let text):
            Text(text)
                .font(.display(17, relativeTo: .body))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
        case .added(let text):
            Text(text)
                .font(.display(17, relativeTo: .body))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 4)
                .padding(.leading, 8)
                .padding(.trailing, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.signal.opacity(0.10))
                .overlay(alignment: .leading) { Rectangle().fill(Color.signal).frame(width: 2) }
                .accessibilityLabel("Toegevoegd door jou: \(text)")
        }
    }

    @ViewBuilder
    private var attachments: some View {
        let rows = model.attachmentRows
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Rectangle().fill(Color.hairline).frame(height: 1).padding(.top, 14)
                    .id(ProposalAnchor.attachments)
                if let total = ProposalText.attachmentsTotal(rows) {
                    ProposalLabel(total, color: .inkDim).padding(.top, 14)
                }
                ForEach(Array(rows.enumerated()), id: \.element.id) { i, a in
                    if i > 0 { Rectangle().fill(Color.hairline).frame(height: 1) }
                    AttachmentRow(attachment: a, removable: editable && a.unavailable) {
                        model.edit(removing: a.id)
                    }
                }
            }
        }
    }
}

/// One attachment: its title, "BIJLAGE · PDF · 184 KB", and a chevron that
/// opens the document. One that is no longer in the dossier is struck through
/// and offers "Weghalen" instead.
struct AttachmentRow: View {
    let attachment: ProposalDetail.Attachment
    let removable: Bool
    let remove: () -> Void

    var body: some View {
        if attachment.unavailable {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(attachment.title)
                        .font(.display(17, relativeTo: .body, weight: .medium))
                        .foregroundStyle(Color.inkMute)
                        .strikethrough()
                        .oneLine()
                    ProposalLabel("Niet meer beschikbaar", color: .inkDim)
                }
                Spacer(minLength: 8)
                if removable {
                    Button("Weghalen", action: remove)
                        .font(.display(15, relativeTo: .callout))
                        .foregroundStyle(Color.signalLink)
                }
            }
            .padding(.vertical, 12)
        } else {
            NavigationLink(value: InboxRoute.document(id: attachment.id, title: attachment.title)) {
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(attachment.title)
                            .font(.display(17, relativeTo: .body, weight: .medium))
                            .foregroundStyle(Color.inkBright)
                            .multilineTextAlignment(.leading)
                            .oneLine()
                        ProposalLabel(meta, color: .inkDim)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.inkDim)
                        .accessibilityHidden(true)
                }
                .padding(.vertical, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private var meta: String {
        ["Bijlage", ProposalText.fileKind(attachment.title), ProposalText.bytes(attachment.sizeBytes)]
            .compactMap { $0 }.joined(separator: " · ")
    }
}

/// "Wordt opgesteld · Meestal binnen 5 minuten" over the shape of a draft.
struct DraftingCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "clock")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(Color.steel)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Wordt opgesteld")
                        .font(.display(17, relativeTo: .body, weight: .medium))
                        .foregroundStyle(Color.inkBright)
                    Text("Meestal binnen 5 minuten. Je krijgt een melding als het klaar is.")
                        .font(.display(15, relativeTo: .callout))
                        .foregroundStyle(Color.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            VStack(alignment: .leading, spacing: 10) {
                ForEach([0.55, 0.6, 1.0, 0.82, 0.5, 0.33], id: \.self) { w in bar(w) }
                Rectangle().fill(Color.hairline).frame(height: 1).padding(.vertical, 8)
                bar(0.6, opacity: 0.14)
                bar(0.3)
            }
            .accessibilityHidden(true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
    }

    private func bar(_ width: CGFloat, opacity: Double = 0.07) -> some View {
        GeometryReader { g in
            RoundedRectangle(cornerRadius: 1).fill(Color.inkSoft.opacity(opacity)).frame(width: g.size.width * width)
        }
        .frame(height: 12)
    }
}

/// "Het concept is niet gelukt", with the drafter's own reason.
struct DraftFailedCard: View {
    let error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "exclamationmark.bubble")
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(Color.steel)
                .padding(.bottom, 8)
                .accessibilityHidden(true)
            Text("Het concept is niet gelukt")
                .font(.display(17, relativeTo: .body, weight: .medium))
                .foregroundStyle(Color.inkBright)
            Text(error ?? "Het opstellen is gestopt.")
                .font(.display(15, relativeTo: .callout))
                .foregroundStyle(Color.inkMute)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
        .accessibilityElement(children: .combine)
    }
}

/// One thing verder relied on. A dossier document opens; the others are
/// shown, not opened, until the phone can show them.
struct SourceRow: View {
    let citation: ProposalDetail.Citation
    let trigger: ProposalDetail.Trigger

    var body: some View {
        let s = ProposalText.source(citation, trigger: trigger)
        let row = HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(s.title)
                    .font(.display(17, relativeTo: .body, weight: .medium))
                    .foregroundStyle(Color.inkBright)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                ProposalLabel(s.meta, color: .inkDim)
            }
            Spacer(minLength: 8)
            if citation.type == "document" {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.inkDim)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 16)
        .contentShape(Rectangle())

        if citation.type == "document" {
            NavigationLink(value: InboxRoute.document(id: citation.id, title: citation.label)) { row }
                .buttonStyle(.plain)
        } else {
            row.accessibilityElement(children: .combine)
        }
    }
}

// MARK: - The bar

/// The words of the bar: an icon or a spinner, a title, a line under it and
/// the mono "NAAR … · 1 BIJLAGE".
struct BarText: View {
    let bar: SendBar
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let ax = typeSize.isAccessibilitySize
        let layout = ax ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                        : AnyLayout(HStackLayout(alignment: .top, spacing: 14))
        if bar.icon != nil || bar.spinning || bar.title != nil || bar.detail != nil || bar.meta != nil {
            layout {
                if bar.spinning {
                    ProgressView().tint(Color.inkMute).frame(width: 22, height: 22)
                } else if let icon = bar.icon ?? (ax && isHold ? "faceid" : nil) {
                    Image(systemName: icon)
                        .font(.system(size: ax ? 34 : 20, weight: .regular))
                        .foregroundStyle(iconColor)
                        .frame(width: ax ? nil : 22)
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 4) {
                    if let title = bar.title {
                        Text(title)
                            .font(.display(17, relativeTo: .body, weight: .medium))
                            .foregroundStyle(Color.inkBright)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let detail = bar.detail {
                        Text(detail)
                            .font(.display(15, relativeTo: .callout))
                            .foregroundStyle(bar.title == nil ? Color.ink : Color.inkSoft)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let meta = bar.meta { metaLine(meta, ax: ax).padding(.top, 2) }
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    /// At the accessibility sizes the address gets a line of its own, cut in
    /// the middle if it must be: "Naar" / the address / "1 bijlage".
    @ViewBuilder
    private func metaLine(_ meta: String, ax: Bool) -> some View {
        if ax {
            let parts = meta.components(separatedBy: " · ")
            let head = parts.first ?? meta
            let to = head.hasPrefix("Naar ") ? String(head.dropFirst(5)) : head
            VStack(alignment: .leading, spacing: 2) {
                if head.hasPrefix("Naar ") { ProposalLabel("Naar", color: .inkDim) }
                Text(to).font(.mono(12, relativeTo: .caption)).foregroundStyle(Color.inkDim).oneLine(always: true)
                ForEach(parts.dropFirst(), id: \.self) { ProposalLabel($0, color: .inkDim) }
            }
        } else {
            Text(meta.uppercasedKeepingAddresses())
                .font(.mono(12, relativeTo: .caption))
                .tracking(1)
                .foregroundStyle(Color.inkDim)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    /// At the accessibility sizes the send section leads with Face ID's
    /// mark (frame "AX5 · hele scroll"); the 402 bar has no room for it.
    private var isHold: Bool {
        if case .hold? = bar.button { return true }
        return false
    }

    private var iconColor: Color {
        switch bar.tone {
        case .plain: .inkSoft
        case .ok: .okay
        case .problem: .inkSoft
        }
    }
}

extension String {
    /// "NAAR ilse@noordkust.example · 1 BIJLAGE": capitals, except an address.
    func uppercasedKeepingAddresses() -> String {
        split(separator: " ", omittingEmptySubsequences: false)
            .map { $0.contains("@") ? String($0) : $0.uppercased() }
            .joined(separator: " ")
    }
}

/// Versturen as a HOLD: the fill runs along the button's foot for
/// `SendHold.duration`; letting go earlier stops it and nothing is sent. For
/// VoiceOver and Switch Control the hold is one action that asks first.
struct HoldToSendButton: View {
    let label: String
    let progress: Double
    let onPress: () -> Void
    let onRelease: () -> Void
    let onAccessibleSend: () -> Void
    @State private var pressed = false

    var body: some View {
        Text(label)
            .wholeWords(label, font: AuthType.button)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .foregroundStyle(Color.onSignal)
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 14)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(
                RoundedRectangle(cornerRadius: Radius.chip)
                    .fill(LinearGradient(colors: [.signalLit, .signal], startPoint: .top, endPoint: .bottom))
            )
            .overlay(alignment: .bottom) {
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.onSignal.opacity(0.22))
                        Capsule().fill(Color.onSignal.opacity(0.85)).frame(width: g.size.width * progress)
                    }
                }
                .frame(height: 3)
                .padding(.horizontal, 12)
                .padding(.bottom, 5)
                .accessibilityHidden(true)
            }
            .glow(Glow.action)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        if !pressed { pressed = true; onPress() }
                    }
                    .onEnded { _ in
                        pressed = false
                        onRelease()
                    }
            )
            .accessibilityElement()
            .accessibilityLabel(SendCopy.send)
            .accessibilityHint("Houd vast om te versturen, daarna Face ID. Of dubbeltik om eerst te bevestigen.")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { onAccessibleSend() }
    }
}

/// The screen's shape before the proposal has loaded (brief §2.1): never a
/// bare spinner.
struct ProposalSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            block(width: 120, height: 12)
            block(width: 260, height: 28)
            block(width: 180, height: 18)
            block(height: 84).padding(.top, 16)
            block(width: 90, height: 12).padding(.top, 28)
            block(height: 260)
        }
        .accessibilityElement()
        .accessibilityLabel("Voorstel wordt geladen")
    }

    private func block(width: CGFloat? = nil, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: Radius.chip)
            .fill(Color.inkSoft.opacity(0.06))
            .frame(maxWidth: width ?? .infinity, alignment: .leading)
            .frame(width: width, height: height)
    }
}
