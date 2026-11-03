import SwiftUI

/// The queue's line above the tab bar (brief R4: the queue lives there while
/// it has anything to say). Tap it for the Wachtrij; its one action, when it
/// has one, is a button of its own.
///
/// Drawn by Scan itself, not as the TabView's `tabViewBottomAccessory`: the
/// system accessory has one fixed height and shows on every tab, and at AX5
/// this line needs two rows ("1 mislukt" over "Opnieuw proberen").
struct QueueAccessoryView: View {
    let accessory: QueueAccessory
    let ax: Bool
    let open: () -> Void
    let act: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button(action: open) {
                    HStack(alignment: .center, spacing: 12) {
                        icon
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ax ? accessory.compactTitle : accessory.title)
                                .font(.display(17, relativeTo: .headline, weight: .medium))
                                .foregroundStyle(Color.inkBright)
                                .contentTransition(.numericText())
                            if !ax {
                                Text(accessory.meta)
                                    .textCase(.uppercase)
                                    .font(.mono(12, relativeTo: .caption))
                                    .tracking(0.6)
                                    .foregroundStyle(Color.inkDim)
                            }
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        if accessory.action == nil {
                            Image(systemName: "chevron.up")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Color.inkDim)
                                .accessibilityHidden(true)
                        }
                    }
                    .frame(minHeight: 40)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(accessory.accessibilityLabel)
                .accessibilityHint("Opent de wachtrij.")
                if !ax { actionButton }
            }
            if ax {
                actionButton.padding(.leading, iconWidth + 12)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
        .lineHeight(.multiple(factor: HomeType.sairaLineFactor))
        .background(Color.plate, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Color.edgeStrong, lineWidth: 1))
    }

    @ViewBuilder private var actionButton: some View {
        if let title = accessory.actionTitle {
            Button(action: act) {
                Text(title)
                    .font(.display(17, relativeTo: .headline, weight: .medium))
                    .foregroundStyle(Color.signalLink)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .layoutPriority(1)
        }
    }

    /// The icon grows with the text up to AX1, then holds: at AX5 the words
    /// need the width more than the glyph does.
    private var iconWidth: CGFloat { ax ? 34 : 22 }

    private var icon: some View {
        Image(systemName: accessory.symbol)
            .font(.system(size: ax ? 30 : 20, weight: .regular))
            .foregroundStyle(Color.ink)
            .frame(width: iconWidth)
            .symbolEffect(.pulse, isActive: accessory.symbol == "arrow.up.circle")
            .accessibilityHidden(true)
    }
}

/// The Wachtrij: what failed, what is on its way (or waiting), what went
/// today. A sent row opens its document on Dossier.
struct QueueSheetView: View {
    let sheet: QueueSheet
    @Binding var showAllSent: Bool
    let retry: (UUID) -> Void
    let note: (UUID) -> Void
    let remove: (UUID) -> Void
    let signIn: () -> Void
    let open: (String) -> Void

    @State private var confirmRemove: UUID?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Wachtrij")
                        .font(HomeType.title)
                        .foregroundStyle(Color.inkBright)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 12)
                    Button("Klaar") { dismiss() }
                        .font(.display(17, relativeTo: .body, weight: .medium))
                        .foregroundStyle(Color.signalLink)
                        .frame(minWidth: 64, minHeight: 44, alignment: .trailing)
                }
                .padding(.top, 20)
                ForEach(sheet.sections) { section in
                    sectionView(section)
                }
                Text(sheet.footer)
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.inkMute)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 16)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
            .lineHeight(.multiple(factor: HomeType.sairaLineFactor))
        }
        .scrollBounceBehavior(.basedOnSize)
        // The frames' sheet leaves the Scan title showing above it; at the
        // accessibility sizes it may still be pulled to full height.
        .presentationDetents([.fraction(0.87), .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.black)
        .preferredColorScheme(.dark)
        .confirmationDialog("Deze scan verwijderen?", isPresented: Binding(
            get: { confirmRemove != nil }, set: { if !$0 { confirmRemove = nil } }), titleVisibility: .visible) {
            Button("Verwijder", role: .destructive) {
                if let id = confirmRemove { remove(id) }
                confirmRemove = nil
            }
        } message: {
            Text("Hij is nog niet verstuurd en staat dan nergens meer.")
        }
        .sensoryFeedback(.warning, trigger: confirmRemove) { _, new in new != nil }
    }

    private func sectionView(_ section: QueueSheet.Section) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center) {
                Text(section.title)
                    .textCase(.uppercase)
                    .font(.mono(12, relativeTo: .caption))
                    .tracking(0.6)
                    .foregroundStyle(Color.inkLabel)
                    .accessibilityAddTraits(.isHeader)
                if section.kind == .signIn {
                    Spacer(minLength: 8)
                    Button("Opnieuw inloggen", action: signIn)
                        .font(.display(17, relativeTo: .body, weight: .medium))
                        .foregroundStyle(Color.signalLink)
                        .frame(minHeight: 48)
                }
            }
            .frame(minHeight: section.kind == .signIn ? 48 : 0)
            .padding(.top, 20)
            .padding(.bottom, 4)
            ForEach(section.rows) { row in
                rowView(row)
                Rectangle().fill(Color.hairline).frame(height: 1)
            }
            if section.hidden > 0 {
                Button { showAllSent = true } label: {
                    HStack {
                        Text("Toon alle \(section.rows.count + section.hidden)")
                            .font(.display(17, relativeTo: .body, weight: .medium))
                            .foregroundStyle(Color.signalLink)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.signalLink)
                    }
                    .padding(.leading, 48)
                    .frame(minHeight: 46)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Rectangle().fill(Color.hairline).frame(height: 1)
            }
        }
    }

    @ViewBuilder private func rowView(_ row: QueueSheet.Row) -> some View {
        let content = QueueRowContent(row: row, retry: { retry(row.id) })
        if let id = row.documentId {
            Button { open(id) } label: {
                HStack {
                    content
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.inkDim)
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opent het document in Dossier.")
        } else if row.canNote || row.canRetry || row.canRemove {
            content
                .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 12))
                .contextMenu {
                    if row.canRetry {
                        Button("Opnieuw proberen", systemImage: "arrow.clockwise") { retry(row.id) }
                    }
                    if row.canNote {
                        Button(row.note == nil ? "Notitie toevoegen" : "Notitie wijzigen", systemImage: "pencil") {
                            note(row.id)
                        }
                    }
                    if row.canRemove {
                        Divider()
                        Button("Verwijder", systemImage: "trash", role: .destructive) { confirmRemove = row.id }
                    }
                } preview: {
                    QueueRowPreview(row: row)
                }
                .accessibilityActions {
                    if row.canNote { Button("Notitie toevoegen") { note(row.id) } }
                    if row.canRemove { Button("Verwijder") { confirmRemove = row.id } }
                }
        } else {
            content
        }
    }
}

/// One queue row: the page glyph with its state badge, the title, the meta,
/// and — on a failed row — why, and "Opnieuw proberen".
struct QueueRowContent: View {
    let row: QueueSheet.Row
    var retry: () -> Void = {}

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            PageGlyph(badge: row.badge)
            VStack(alignment: .leading, spacing: 4) {
                Text(row.title)
                    .font(.display(17, relativeTo: .headline, weight: .medium))
                    .foregroundStyle(Color.inkBright)
                Text(row.meta)
                    .textCase(.uppercase)
                    .font(.mono(12, relativeTo: .caption))
                    .tracking(0.6)
                    .foregroundStyle(Color.inkDim)
                if let note = row.note {
                    Text("“\(note)”")
                        .font(.display(15, relativeTo: .subheadline))
                        .foregroundStyle(Color.inkMute)
                }
                if let detail = row.detail {
                    Text(detail)
                        .font(.display(15, relativeTo: .callout))
                        .foregroundStyle(Color.ink)
                        .padding(.top, 8)
                }
                if row.canRetry {
                    Button("Opnieuw proberen", action: retry)
                        .font(.display(17, relativeTo: .body, weight: .medium))
                        .foregroundStyle(Color.signalLink)
                        .frame(minHeight: 44)
                        .padding(.top, 4)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.top, 12)
        .padding(.bottom, 20)
        .accessibilityElement(children: row.canRetry ? .contain : .combine)
        .accessibilityLabel(row.canRetry ? "" : row.accessibilityLabel)
    }
}

/// The lifted row of the context menu: the page as paper, on a plate.
struct QueueRowPreview: View {
    let row: QueueSheet.Row

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack(alignment: .bottomTrailing) {
                PageThumb(image: nil).frame(width: 36, height: 46)
                BadgeDot(badge: row.badge).offset(x: 6, y: 4)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(row.title)
                    .font(.display(17, relativeTo: .headline, weight: .medium))
                    .foregroundStyle(Color.inkBright)
                Text(row.meta)
                    .textCase(.uppercase)
                    .font(.mono(12, relativeTo: .caption))
                    .tracking(0.6)
                    .foregroundStyle(Color.inkDim)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(width: 370)
        .background(Color.plate)
    }
}

/// The page glyph of a row: lines, with the state as a small badge.
struct PageGlyph: View {
    let badge: QueueSheet.Row.Badge

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Image(systemName: "text.alignleft")
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(Color.inkMute)
                .frame(width: 32, height: 32, alignment: .topLeading)
            BadgeDot(badge: badge).offset(x: 2, y: 8)
        }
        .frame(width: 32, height: 40, alignment: .topLeading)
        .accessibilityHidden(true)
    }
}

struct BadgeDot: View {
    let badge: QueueSheet.Row.Badge

    var body: some View {
        Image(systemName: badge.rawValue)
            .font(.system(size: 7, weight: .bold))
            .foregroundStyle(Color.ink)
            .frame(width: 15, height: 15)
            .background(Circle().fill(Color.void))
            .overlay(Circle().strokeBorder(Color.ink, lineWidth: 1.2))
    }
}

/// "Iets bijzonders?": one line about this capture, or nothing (it may stay
/// empty). Three quick answers fill the field.
struct ScanNoteSheet: View {
    let target: NoteTarget
    let save: (String) -> Void

    @State private var text = ""
    @State private var height: CGFloat = 450
    @State private var picks = 0
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss

    static let quick = ["Kwam aangetekend", "Achterkant ontbreekt", "Hoort bij vorige scan"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Button("Niet nu") { dismiss() }
                    .font(.display(17, relativeTo: .body, weight: .medium))
                    .foregroundStyle(Color.signalLink)
                    .frame(minHeight: 44)
                Text("Iets bijzonders?")
                    .font(HomeType.title)
                    .foregroundStyle(Color.inkBright)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.top, 20)
                Text((["Bij scan \(target.time)", target.pages, "mag ook leeg"].compactMap { $0 })
                    .joined(separator: " · "))
                    .textCase(.uppercase)
                    .font(.mono(12, relativeTo: .caption))
                    .tracking(0.6)
                    .foregroundStyle(Color.inkLabel)
                    .padding(.top, 2)
                TextField("Bijvoorbeeld: kwam aangetekend", text: $text, axis: .vertical)
                    .font(HomeType.body)
                    .foregroundStyle(Color.ink)
                    .lineLimit(2...4)
                    .focused($focused)
                    .padding(16)
                    .frame(minHeight: 80, alignment: .topLeading)
                    .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
                    .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.steelDim.opacity(0.6), lineWidth: 1))
                    .padding(.top, 16)
                FlowLayout(spacing: 16, lineSpacing: 8) {
                    ForEach(Self.quick, id: \.self) { q in
                        Button {
                            text = text.isEmpty ? q : "\(text). \(q)"
                            picks += 1
                        } label: {
                            Text(q)
                                .font(.display(15, relativeTo: .body))
                                .foregroundStyle(Color.ink)
                                .padding(.horizontal, 16)
                                .frame(minHeight: 44)
                                .background(Color.plate, in: RoundedRectangle(cornerRadius: Radius.chip))
                                .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edge, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.top, 16)
                ScanPrimaryButton(title: "Bewaar bij de scan") {
                    save(text)
                    dismiss()
                }
                .padding(.top, 16)
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 8)
            .lineHeight(.multiple(factor: HomeType.sairaLineFactor))
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .onAppear { text = target.note ?? "" }
        .sensoryFeedback(.selection, trigger: picks)
        .presentationDetents([.height(height), .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.black)
        .preferredColorScheme(.dark)
    }
}

/// Chips that wrap to the next line when the row is full.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let height = rows.last.map { $0.y + $0.height } ?? 0
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for i in row.indices {
                let size = subviews[i].sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
                subviews[i].place(at: CGPoint(x: x, y: bounds.minY + row.y), proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
                x += min(size.width, bounds.width) + spacing
            }
        }
    }

    private struct Row { var indices: [Int] = []; var y: CGFloat = 0; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for (i, view) in subviews.enumerated() {
            let size = view.sizeThatFits(ProposedViewSize(width: width, height: nil))
            let w = min(size.width, width)
            if !rows[rows.count - 1].indices.isEmpty, rows[rows.count - 1].width + spacing + w > width {
                let last = rows[rows.count - 1]
                rows.append(Row(y: last.y + last.height + lineSpacing))
            }
            var row = rows[rows.count - 1]
            row.width += (row.indices.isEmpty ? 0 : spacing) + w
            row.height = max(row.height, size.height)
            row.indices.append(i)
            rows[rows.count - 1] = row
        }
        return rows
    }
}
