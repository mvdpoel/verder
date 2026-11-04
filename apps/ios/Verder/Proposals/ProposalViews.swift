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

    /// The largest size a label grows to. At AX5 a 12-pt caption would grow
    /// to body size and the label/value hierarchy the frames keep (labels
    /// visibly smaller than what they label) would be gone.
    static let largest = DynamicTypeSize.accessibility2

    var body: some View {
        let ax = typeSize.isAccessibilitySize
        let shown = ax ? text : text.uppercased()
        Text(shown)
            .wholeWords(shown, font: .mono(12, relativeTo: .caption))
            .tracking(ax ? 0 : 1.2)
            .foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
            .dynamicTypeSize(...Self.largest)
    }
}

/// A mono meta line ("BIJLAGE · PDF · 184 KB") that, where it does not fit,
/// wraps BETWEEN its groups and drops the dot there — never a line ending
/// on "·" ("Bijlage · PDF" / "184 KB" at AX5).
struct MetaLine: View {
    let parts: [String]
    var color: Color = .inkDim

    init(_ line: String, color: Color = .inkDim) {
        parts = line.components(separatedBy: " · ")
        self.color = color
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            ForEach(Array(stride(from: parts.count, through: 1, by: -1)), id: \.self) { head in
                VStack(alignment: .leading, spacing: 0) {
                    ProposalLabel(parts.prefix(head).joined(separator: " · "), color: color).fixedSize()
                    ForEach(Array(parts.dropFirst(head).enumerated()), id: \.offset) { _, p in
                        ProposalLabel(p, color: color)
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// "● WACHT OP JOU" (amber: the one thing here waiting on Martin), "● VERSTUURD"
/// (okay), "● WORDT OPGESTELD" (steel).
struct StatusBadge: View {
    let badge: ProposalText.Badge
    @Environment(\.dynamicTypeSize) private var typeSize
    /// The dot's gap grows with the text, or at AX5 it touches the "W".
    @ScaledMetric(relativeTo: .caption) private var gap: CGFloat = 6

    private var color: Color {
        switch badge {
        case .waiting: .attn
        case .sent: .okay
        case .drafting, .draftFailed: .steel
        }
    }

    var body: some View {
        let ax = typeSize.isAccessibilitySize
        let text = ProposalText.badgeText(badge)
        HStack(spacing: gap) {
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
        .dynamicTypeSize(...ProposalLabel.largest)
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

/// An e-mail address or a file name that WRAPS rather than clips (Martin's
/// rule: no text is ever cut off), breaking only after "@" and after a dot
/// ("Loonstrook." / "2026-10.pdf") — never inside a word part. VoiceOver
/// reads the text as written.
struct WrappingName: View {
    let text: String
    let font: Font

    init(_ text: String, font: Font) {
        self.text = text
        self.font = font
    }

    var body: some View {
        Text(ProposalText.softBreaks(text))
            .font(font)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(text)
    }
}

/// The small chevron of a row that opens something.
struct RowChevron: View {
    var body: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Color.inkDim)
            .accessibilityHidden(true)
    }
}

// MARK: - Trigger

/// "AANLEIDING · MAIL · 2 NOV 09:14" over "**Ilse** vraagt om je loonstrook van
/// oktober.", with the chevron that opens what started it. The screen wraps
/// it in the link or button.
struct TriggerCard: View {
    let model: ProposalModel
    let detail: ProposalDetail
    let now: Date
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // Beside the one-line meta at the ordinary sizes; at the accessibility
        // sizes the card is tall and the chevron sits centred on it.
        let ax = typeSize.isAccessibilitySize
        HStack(alignment: ax ? .center : .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                meta
                if let line = model.triggerLine {
                    // Saira 15, as the frames set it: at 17 the sentence wraps
                    // beside the chevron even on a 402-pt screen.
                    let lead = Text(line.lead ?? "").font(.display(15, relativeTo: .callout, weight: .semibold))
                        .foregroundStyle(Color.inkBright)
                    let rest = Text(line.rest).font(.display(15, relativeTo: .callout)).foregroundStyle(Color.ink)
                    Text("\(lead)\(rest)")
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let note = model.senderNote { ProposalLabel(note, color: .inkMute) }
                if let due = model.dueText { ProposalLabel(due, color: model.isPending ? .attn : .ink) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            RowChevron().padding(.top, ax ? 0 : 2)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }

    /// One line where it fits; else one group per line, so no line ends on
    /// a dangling "·" (frame "AX5 · begin": "Aanleiding · Mail" / "2 nov 09:14").
    private var meta: some View {
        let groups = ProposalText.triggerMetaGroups(kind: detail.kind, trigger: detail.trigger, now: now)
        return ViewThatFits(in: .horizontal) {
            ProposalLabel(groups.joined(separator: " · ")).fixedSize()
            VStack(alignment: .leading, spacing: 0) {
                ForEach(groups, id: \.self) { ProposalLabel($0) }
            }
        }
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
                    if let summary = model.editSummary {
                        VStack(alignment: .leading, spacing: 2) {
                            ProposalLabel(summary.what, color: .inkDim)
                            ProposalLabel(summary.kept, color: .inkDim)
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
            .modifier(DraftCardSurface(record: isRecord))
        }
    }

    /// The sent message is a read-only RECORD: drawn darker than a draft,
    /// and its attachments are listed, not opened from here.
    private var isRecord: Bool { model.status == "sent" }

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
                WrappingName(joined, font: .mono(13, relativeTo: .footnote)).foregroundStyle(Color.ink)
            }
        }
        .dynamicTypeSize(...ProposalLabel.largest)
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
                    AttachmentRow(attachment: a, removable: editable && a.unavailable, opens: !isRecord) {
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
    /// False in the sent record: a listed file, no chevron.
    var opens = true
    let remove: () -> Void

    var body: some View {
        if attachment.unavailable {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    WrappingName(attachment.title, font: .display(17, relativeTo: .body, weight: .medium))
                        .foregroundStyle(Color.inkMute)
                        .strikethrough()
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
        } else if !opens {
            VStack(alignment: .leading, spacing: 4) {
                WrappingName(attachment.title, font: .display(17, relativeTo: .body, weight: .medium))
                    .foregroundStyle(Color.inkBright)
                MetaLine(meta)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 12)
            .accessibilityElement(children: .combine)
        } else {
            NavigationLink(value: InboxRoute.document(id: attachment.id, title: attachment.title)) {
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        WrappingName(attachment.title, font: .display(17, relativeTo: .body, weight: .medium))
                            .foregroundStyle(Color.inkBright)
                        MetaLine(meta)
                    }
                    Spacer(minLength: 8)
                    RowChevron()
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

/// A draft is a glass panel; the sent message is a record, darker, with a
/// plain edge and no lit top (frame "verstuurd").
private struct DraftCardSurface: ViewModifier {
    let record: Bool
    func body(content: Content) -> some View {
        if record {
            let shape = RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
            content
                .background(Color.void, in: shape)
                .overlay(shape.strokeBorder(Color.edge, lineWidth: 1))
        } else {
            content.glassPanel()
        }
    }
}

/// "Wordt opgesteld · Meestal binnen 5 minuten" over the shape of a draft.
struct DraftingCard: View {
    /// An earlier version exists: "Wordt opnieuw opgesteld".
    var redraft = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "clock")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(Color.steel)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(redraft ? "Wordt opnieuw opgesteld" : "Wordt opgesteld")
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

/// One thing verder relied on, with a chevron: every source opens. A
/// document, a task or an earlier proposal opens its own screen; anything
/// else (the mail, a stop, a debt) opens what the proposal knows of it.
struct SourceRow: View {
    let citation: ProposalDetail.Citation
    let trigger: ProposalDetail.Trigger
    let open: () -> Void

    var body: some View {
        let s = ProposalText.source(citation, trigger: trigger)
        let row = HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(s.title)
                    .font(.display(17, relativeTo: .body, weight: .medium))
                    .foregroundStyle(Color.inkBright)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                MetaLine(s.meta)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            RowChevron()
        }
        .padding(.vertical, 16)
        .contentShape(Rectangle())

        if let route = SourceRow.route(citation) {
            NavigationLink(value: route) { row }
                .buttonStyle(.plain)
        } else {
            Button(action: open) { row }
                .buttonStyle(.plain)
        }
    }

    /// The screen a source opens on the inbox stack; nil when it opens the
    /// proposal's own sheet.
    static func route(_ c: ProposalDetail.Citation) -> InboxRoute? {
        switch c.type {
        case "document": .document(id: c.id, title: c.label)
        case "task": .task(c.id)
        case "proposal": .proposal(c.id)
        default: nil
        }
    }
}

/// What the proposal knows of a source the phone cannot open on its own
/// screen: the mail it answers (sender, subject, when, the opening lines) or
/// a stop or debt (its name, and why verder leaned on it).
struct SourceSheet: View {
    let title: String
    let meta: String
    let why: String?
    let trigger: ProposalDetail.Trigger?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                Color.void.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ProposalLabel(meta)
                        Text(title)
                            .font(.display(22, relativeTo: .title2, weight: .medium))
                            .foregroundStyle(Color.inkBright)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 6)
                            .accessibilityAddTraits(.isHeader)
                        if let t = trigger {
                            VStack(alignment: .leading, spacing: 10) {
                                if let from = t.from { field("Van", from) }
                                if let subject = t.subject { field("Onderwerp", subject) }
                                if let date = t.date { field("Ontvangen", ProposalFormat.dateTime(date)) }
                            }
                            .padding(.top, 20)
                            if let excerpt = t.excerpt?.trimmingCharacters(in: .whitespacesAndNewlines), !excerpt.isEmpty {
                                VStack(alignment: .leading, spacing: 8) {
                                    ProposalLabel("Uit de mail")
                                    Text(excerpt)
                                        .font(.display(17, relativeTo: .body))
                                        .foregroundStyle(Color.ink)
                                        .fixedSize(horizontal: false, vertical: true)
                                        .textSelection(.enabled)
                                }
                                .padding(16)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .glassPanel()
                                .padding(.top, 24)
                            }
                        }
                        if let why = why?.trimmingCharacters(in: .whitespacesAndNewlines), !why.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                ProposalLabel("Waarom verder hierop leunt")
                                Text(why)
                                    .font(.display(17, relativeTo: .body))
                                    .foregroundStyle(Color.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .padding(.top, 28)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frameLeading()
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Klaar") { dismiss() }.foregroundStyle(Color.signalLink)
                }
            }
        }
        .preferredColorScheme(.dark)
        .presentationDragIndicator(.visible)
    }

    private func field(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ProposalLabel(label, color: .inkDim)
            WrappingName(value, font: .mono(13, relativeTo: .footnote)).foregroundStyle(Color.ink)
        }
        .accessibilityElement(children: .combine)
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
                    let extras = ax || !bar.extrasOnlyInSection
                    if extras, let stamp = bar.stamp, bar.extrasOnlyInSection {
                        ProposalLabel(stamp, color: .inkDim).padding(.top, 2)
                    }
                    if extras, let meta = bar.meta { metaLine(meta, ax: ax).padding(.top, 2) }
                    if extras, let stamp = bar.stamp, !bar.extrasOnlyInSection {
                        ProposalLabel(stamp, color: .inkDim).padding(.top, 2)
                    }
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
                WrappingName(to, font: .mono(12, relativeTo: .caption)).foregroundStyle(Color.inkDim)
                ForEach(parts.dropFirst(), id: \.self) { ProposalLabel($0, color: .inkDim) }
            }
            .dynamicTypeSize(...ProposalLabel.largest)
        } else {
            let line = meta.uppercasedKeepingAddresses()
            // One line where it fits; else it wraps after "@" or a dot, never clipped.
            ViewThatFits(in: .horizontal) {
                Text(line).lineLimit(1).fixedSize()
                Text(ProposalText.softBreaks(line)).fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel(line)
            }
            .font(.mono(12, relativeTo: .caption))
            .tracking(1)
            .foregroundStyle(Color.inkDim)
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
