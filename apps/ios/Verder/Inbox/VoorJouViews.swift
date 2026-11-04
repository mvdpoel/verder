import SwiftUI

/// Voor jou's geometry and type ramp (Figma "voorjou · final": display/*
/// Saira, mono/* IBM Plex Mono, 16 pt gutters, text at x 52).
enum VoorJouMetrics {
    /// The symbol column: the text starts 36 pt in from the 16 pt margin.
    static let gutter: CGFloat = 36
    static let margin: CGFloat = 16
    static let title = Font.display(17, relativeTo: .body, weight: .medium)
    static let body = Font.display(15, relativeTo: .subheadline)
    static let link = Font.display(17, relativeTo: .body, weight: .medium)
    static let label = Font.mono(12, relativeTo: .caption)
    static let labelTracking: CGFloat = 1.2
    static let metaTracking: CGFloat = 0.6
    static let lineFactor: CGFloat = 23.0 / 17.0
}

extension View {
    /// A full-width, flat list row on the void: no system separator, no
    /// system inset beyond the frame's 16 pt margin.
    func voorJouRow() -> some View {
        self
            .listRowInsets(EdgeInsets(top: 0, leading: VoorJouMetrics.margin, bottom: 0, trailing: VoorJouMetrics.margin))
            .listRowBackground(Color.void)
            .listRowSeparator(.hidden)
    }
}

// MARK: - Header

/// "MAANDAG 2 NOV", "Voor jou" with "Selecteer", and the count with its words
/// and how fresh it is.
struct VoorJouHeader: View {
    let eyebrow: String
    let count: Int
    let empty: Bool
    let freshness: String?
    let canSelect: Bool
    let select: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(eyebrow)
                .font(VoorJouMetrics.label)
                .tracking(VoorJouMetrics.labelTracking)
                .foregroundStyle(Color.inkLabel)
                .padding(.bottom, 4)
            HStack(alignment: .firstTextBaseline) {
                Text(VoorJouCopy.title)
                    .font(.display(28, relativeTo: .title, weight: .light))
                    .foregroundStyle(Color.inkBright)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 12)
                if canSelect {
                    Button(VoorJouCopy.select, action: select)
                        .font(.display(17, relativeTo: .body))
                        .foregroundStyle(Color.signal)
                        .buttonStyle(.borderless)
                }
            }
            if !empty {
                HStack(alignment: .center, spacing: 14) {
                    Text("\(count)")
                        .font(.display(48, relativeTo: .largeTitle, weight: .light))
                        .foregroundStyle(Color.inkBright)
                        .contentTransition(.numericText())
                        .monospacedDigit()
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(spacing: 8) {
                            Circle().fill(Color.attn).frame(width: 7, height: 7).glow(Glow.attn)
                            Text(VoorJouList.countCaption(count))
                                .font(.display(17, relativeTo: .body))
                                .foregroundStyle(Color.ink)
                        }
                        if let freshness {
                            Text(freshness)
                                .font(VoorJouMetrics.label)
                                .foregroundStyle(Color.inkLabel)
                        }
                    }
                }
                .padding(.top, -4)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel([VoorJouList.countLine(count), freshness].compactMap { $0 }.joined(separator: ", "))
            }
        }
        .padding(.top, 0)
        .padding(.bottom, empty ? 0 : 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The header once the big one has scrolled away (and always at the
/// accessibility sizes): "Voor jou" with the count under it, so the number
/// stays in sight further down the list.
struct VoorJouCompactHeader: View {
    let count: Int
    let canSelect: Bool
    let select: () -> Void

    var body: some View {
        VStack(spacing: 2) {
            ZStack {
                Text(VoorJouCopy.title)
                    .font(.display(17, relativeTo: .headline, weight: .medium))
                    .foregroundStyle(Color.inkBright)
                    .dynamicTypeSize(...DynamicTypeSize.xxLarge)
                    .accessibilityAddTraits(.isHeader)
                if canSelect {
                    HStack {
                        Spacer()
                        Button(VoorJouCopy.select, action: select)
                            .font(.display(17, relativeTo: .body))
                            .dynamicTypeSize(...DynamicTypeSize.xxLarge)
                            .foregroundStyle(Color.signal)
                            .buttonStyle(.borderless)
                    }
                }
            }
            HStack(alignment: .center, spacing: 8) {
                Circle().fill(Color.attn).frame(width: 7, height: 7).glow(Glow.attn)
                Text(VoorJouList.countLine(count))
                    .font(VoorJouMetrics.label)
                    // AX5's 28/34 is the size the frame measured "498 wachten
                    // op jou" on ONE line beside its dot; larger wraps it.
                    .dynamicTypeSize(...DynamicTypeSize.accessibility3)
                    .foregroundStyle(Color.inkSoft)
                    .contentTransition(.numericText())
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.center)
            }
            .accessibilityElement(children: .combine)
        }
        .padding(.horizontal, VoorJouMetrics.margin)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity)
        .background(Color.void)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.hairline).frame(height: 1) }
    }
}

/// "NU  2" / "KAN WACHTEN  496 … 20 GETOOND", pinned while its rows scroll.
struct VoorJouSectionHeader: View {
    let section: VoorJouList.Section
    let trailing: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let ax = typeSize.isAccessibilitySize
        let label = HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(section.label.uppercased())
            Text("\(section.total)").monospacedDigit()
        }
        .foregroundStyle(Color.inkSoft)
        Group {
            if ax {
                VStack(alignment: .leading, spacing: 2) {
                    label
                    if let trailing { Text(trailing.uppercased()).foregroundStyle(Color.inkLabel) }
                }
            } else {
                HStack(alignment: .firstTextBaseline) {
                    label
                    Spacer(minLength: 12)
                    if let trailing { Text(trailing.uppercased()).foregroundStyle(Color.inkLabel) }
                }
            }
        }
        .font(VoorJouMetrics.label)
        .tracking(VoorJouMetrics.labelTracking)
        .padding(.horizontal, VoorJouMetrics.margin)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.void)
        .listRowInsets(EdgeInsets())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Row

/// One thing waiting, read like a departure board (brief §1.1): what it is,
/// from whom, how long it has waited, and — on Nu — the amber dot.
struct VoorJouRowView: View {
    let row: VoorJouList.Row
    let now: Date
    let ax: Bool
    let selecting: Bool
    let selected: Bool
    let failed: Bool

    var body: some View {
        let item = row.item
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 0) {
                if !ax {
                    gutter
                        .frame(width: VoorJouMetrics.gutter, alignment: .leading)
                        .padding(.top, 3)
                }
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        title(item.title)
                        meta(item)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if row.route != nil && !ax {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color.inkDim)
                            .accessibilityHidden(true)
                    }
                }
            }
            .padding(.vertical, 14)
            // Selecting: what cannot be selected in Kan wachten steps back; Nu
            // keeps its weight, since its note says why it is not selectable.
            .opacity(selecting && !row.selectable && row.section == .kanWachten ? 0.55 : 1)
            if !failed { RowHairlineShape(leading: ax ? 0 : VoorJouMetrics.gutter) }
        }
        .background(Color.void)
        .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 12, style: .continuous))
        .contentShape(Rectangle())
    }

    @ViewBuilder private var gutter: some View {
        if selecting && row.selectable {
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .symbolRenderingMode(.palette)
                .foregroundStyle(selected ? Color.onSignal : Color.inkLabel, Color.signal)
                .font(.system(size: 20))
                .frame(width: 22, height: 22)
        } else {
            Image(systemName: VoorJouList.symbol(row.item))
                .font(.system(size: 16, weight: .regular))
                .foregroundStyle(Color.inkLabel)
                .frame(width: 22, height: 22)
                .overlay(alignment: .topTrailing) {
                    if row.amber {
                        Circle().fill(Color.attn)
                            .frame(width: 8, height: 8)
                            .overlay(Circle().stroke(Color.void, lineWidth: 1.5))
                            .glow(Glow.attn)
                            .offset(x: 3, y: -3)
                    }
                }
        }
    }

    @ViewBuilder private func title(_ text: String) -> some View {
        if ax {
            Text(text)
                .wholeWords(text, font: VoorJouMetrics.title)
                .lineHeight(.multiple(factor: 1.15))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Text(text)
                .font(VoorJouMetrics.title)
                .lineHeight(.multiple(factor: VoorJouMetrics.lineFactor))
                .foregroundStyle(Color.inkBright)
                .lineLimit(2)
                .truncationMode(VoorJouList.looksLikeFileName(text) ? .middle : .tail)
                .multilineTextAlignment(.leading)
        }
    }

    @ViewBuilder private func meta(_ item: WaitingItem) -> some View {
        let parts = VoorJouList.meta(item, now: now).map { $0.uppercased() }
        let age = VoorJouList.age(item.at, now: now).uppercased()
        if ax {
            // One fact per line at the accessibility sizes (brief §2.7).
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array((parts + [age]).enumerated()), id: \.offset) { _, line in
                    Text(line).fixedSize(horizontal: false, vertical: true)
                }
            }
            .font(VoorJouMetrics.label)
            .foregroundStyle(Color.inkLabel)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(HomeSummary.metaLine(parts))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Text(age).fixedSize()
            }
            .font(VoorJouMetrics.label)
            .tracking(VoorJouMetrics.metaTracking)
            .foregroundStyle(Color.inkLabel)
        }
    }
}

/// "NIET OPGESLAGEN": a decision from the list the server did not take,
/// kept in place under its row with the cause and two ways on.
struct VoorJouNotSavedNotice: View {
    let failure: InboxDecisions.Failure
    let ax: Bool
    let retry: () -> Void
    let withdraw: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "exclamationmark.triangle").font(.system(size: 12))
                Text(VoorJouCopy.notSaved.uppercased())
                    .tracking(VoorJouMetrics.labelTracking)
            }
            .font(VoorJouMetrics.label)
            .foregroundStyle(Color.inkSoft)
            Text(failure.message)
                .font(VoorJouMetrics.body)
                .foregroundStyle(Color.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
            Button(VoorJouCopy.retry, action: retry)
                .font(VoorJouMetrics.link)
                .foregroundStyle(Color.signal)
                .buttonStyle(.borderless)
                .padding(.vertical, 10)
            Button(failure.decision.withdrawLabel, action: withdraw)
                .font(.display(17, relativeTo: .body))
                .foregroundStyle(Color.inkSoft)
                .buttonStyle(.borderless)
                .padding(.bottom, 10)
        }
        .padding(.leading, ax ? 0 : VoorJouMetrics.gutter)
        .padding(.bottom, 6)
        .overlay(alignment: .bottom) { RowHairlineShape(leading: ax ? 0 : VoorJouMetrics.gutter) }
        .accessibilityElement(children: .contain)
    }
}

/// "Toon alle 496 … 20 VAN 496 ›".
struct VoorJouShowAllRow: View {
    let shown: Int
    let total: Int
    let ax: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text("Toon alle \(total)")
                    .font(VoorJouMetrics.link)
                    .foregroundStyle(Color.signal)
                Spacer(minLength: 0)
                if !ax {
                    Text("\(shown) van \(total)".uppercased())
                        .font(VoorJouMetrics.label)
                        .tracking(VoorJouMetrics.metaTracking)
                        .foregroundStyle(Color.inkLabel)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Color.inkLabel)
                }
            }
            .padding(.leading, ax ? 0 : VoorJouMetrics.gutter)
            .padding(.vertical, 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Toon alle \(total). \(shown) van \(total) getoond.")
    }
}

// MARK: - States

/// "OFFLINE" / "STORING" over a kept list.
struct VoorJouNoticeCard: View {
    let notice: VoorJouList.Notice
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text((notice == .offline ? VoorJouCopy.offlineLabel : VoorJouCopy.failureLabel).uppercased())
                .font(VoorJouMetrics.label)
                .tracking(VoorJouMetrics.labelTracking)
                .foregroundStyle(Color.inkLabel)
            Text(notice == .offline ? VoorJouCopy.offlineBody : VoorJouCopy.failureBody)
                .font(VoorJouMetrics.body)
                .foregroundStyle(Color.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
            if notice == .failure {
                Button(VoorJouCopy.retry, action: retry)
                    .font(VoorJouMetrics.link)
                    .foregroundStyle(Color.signal)
                    .buttonStyle(.borderless)
                    .padding(.top, 6)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
        .accessibilityElement(children: .contain)
    }
}

/// Nothing waits: the seal, the headline and when the last thing was done.
struct VoorJouEmptyState: View {
    let body_: String
    let readout: String

    init(body: String, readout: String) {
        self.body_ = body
        self.readout = readout
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: "checkmark.seal")
                .font(.system(size: 44, weight: .regular))
                .foregroundStyle(Color.okay)
                .glow(Glow.okay)
                .padding(.bottom, 20)
                .accessibilityHidden(true)
            Text(VoorJouCopy.emptyHeadline)
                .wholeWords(VoorJouCopy.emptyHeadline, font: .display(40, relativeTo: .largeTitle, weight: .light))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(body_)
                .font(VoorJouMetrics.body)
                .foregroundStyle(Color.inkMute)
                .fixedSize(horizontal: false, vertical: true)
            Text(readout)
                .font(VoorJouMetrics.label)
                .foregroundStyle(Color.inkLabel)
                .padding(.top, 6)
        }
        .padding(.top, 72)
        .padding(.bottom, 48)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The page's top before any list: eyebrow and title only.
private struct VoorJouPageTop: View {
    let eyebrow: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(eyebrow)
                .font(VoorJouMetrics.label)
                .tracking(VoorJouMetrics.labelTracking)
                .foregroundStyle(Color.inkLabel)
            Text(VoorJouCopy.title)
                .font(.display(28, relativeTo: .title, weight: .light))
                .foregroundStyle(Color.inkBright)
                .accessibilityAddTraits(.isHeader)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Before the first answer: grey rows in the shape of the real sections,
/// never a bare spinner where a list will appear (brief §2.1).
struct VoorJouLoadingPage: View {
    let eyebrow: String

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VoorJouPageTop(eyebrow: eyebrow)
                VStack(alignment: .leading, spacing: 8) {
                    bar(170, 8)
                    bar(96, 6)
                }
                .padding(.top, 22)
                bar(70, 6).padding(.top, 40)
                ForEach(0..<2, id: \.self) { _ in skeletonRow }
                bar(70, 6).padding(.top, 40)
                ForEach(0..<4, id: \.self) { _ in skeletonRow }
            }
            .padding(.horizontal, VoorJouMetrics.margin)
        }
        .scrollDisabled(true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Voor jou laadt")
    }

    private var skeletonRow: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 0) {
                Circle().fill(Color.hairlineLit).frame(width: 16, height: 16)
                    .frame(width: VoorJouMetrics.gutter, alignment: .leading)
                VStack(alignment: .leading, spacing: 14) {
                    bar(220, 10)
                    HStack {
                        bar(110, 7)
                        Spacer()
                        bar(48, 7)
                    }
                }
            }
            .padding(.vertical, 22)
            RowHairlineShape(leading: VoorJouMetrics.gutter)
        }
    }

    private func bar(_ width: CGFloat, _ height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 1).fill(Color.edge).frame(width: width, height: height)
    }
}

/// No list to show and the fetch failed: what happened, one button, and
/// when it was last tried (brief §2.4: never a dead end).
struct VoorJouFailurePage: View {
    let eyebrow: String
    let error: APIError
    let readout: String
    let retry: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VoorJouPageTop(eyebrow: eyebrow)
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 30, weight: .regular))
                    .foregroundStyle(Color.inkSoft)
                    .padding(.top, 84)
                    .accessibilityHidden(true)
                Text(VoorJouCopy.failedHeadline)
                    .wholeWords(VoorJouCopy.failedHeadline, font: .display(28, relativeTo: .title, weight: .light))
                    .foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 18)
                    .accessibilityAddTraits(.isHeader)
                Text(isOffline ? VoorJouCopy.failedOffline : VoorJouCopy.failedServer)
                    .font(VoorJouMetrics.body)
                    .foregroundStyle(Color.inkMute)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 6)
                AuthButton(title: VoorJouCopy.retry, action: retry)
                    .padding(.top, 22)
                Text(readout)
                    .font(VoorJouMetrics.label)
                    .foregroundStyle(Color.inkLabel)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 12)
            }
            .padding(.horizontal, VoorJouMetrics.margin)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var isOffline: Bool {
        if case .transport = error { return true }
        return false
    }
}

// MARK: - Selection

/// "Annuleer · 3 geselecteerd · Alle 18 hier".
struct VoorJouSelectionBar: View {
    let count: Int
    let all: Int
    let cancel: () -> Void
    let selectAll: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Button(VoorJouCopy.cancel, action: cancel)
                .foregroundStyle(Color.signal)
            Spacer(minLength: 8)
            Text(VoorJouList.selectedLine(count))
                .font(.display(17, relativeTo: .headline, weight: .medium))
                .foregroundStyle(Color.inkBright)
                .contentTransition(.numericText())
            Spacer(minLength: 8)
            Button(VoorJouList.allHere(all), action: selectAll)
                .foregroundStyle(Color.signal)
        }
        .font(.display(17, relativeTo: .body))
        .buttonStyle(.borderless)
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .padding(.horizontal, VoorJouMetrics.margin)
        .padding(.vertical, 12)
        .background(Color.void)
    }
}

/// "Niet relevant (3)" · "Keur 3 goed". Suggestions only; never a send.
struct VoorJouSelectionToolbar: View {
    let count: Int
    let canApprove: Bool
    let reject: () -> Void
    let approve: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: reject) {
                Text(VoorJouList.rejectMany(count))
                    .font(.display(17, relativeTo: .body))
                    .foregroundStyle(Color.signal)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(RoundedRectangle(cornerRadius: Radius.chip).fill(Color.field))
                    .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
            }
            .disabled(count == 0)
            .opacity(count == 0 ? 0.5 : 1)
            Button(action: approve) {
                Text(VoorJouList.approveMany(count))
                    .font(.display(17, relativeTo: .body, weight: .medium))
                    .foregroundStyle(Color.onSignal)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(RoundedRectangle(cornerRadius: Radius.chip)
                        .fill(LinearGradient(colors: [.signalLit, .signal], startPoint: .top, endPoint: .bottom))
                        .opacity(canApprove ? 1 : 0.42))
            }
            .disabled(!canApprove)
        }
        .buttonStyle(AuthPressStyle())
        .padding(.horizontal, VoorJouMetrics.margin)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .background(Color.void)
        .overlay(alignment: .top) { Rectangle().fill(Color.hairline).frame(height: 1) }
    }
}

// MARK: - Toast

/// What a decision from the list did, with its undo and the time left.
/// An undo, not a warning (brief §3, R24).
struct DecisionToastView: View {
    let content: DecisionToast.Content
    let decisions: InboxDecisions
    let ax: Bool
    let undo: () -> Void
    let review: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            // The list fades out under the toast instead of ending against it.
            LinearGradient(colors: [Color.void.opacity(0), Color.void], startPoint: .top, endPoint: .bottom)
                .frame(height: 24)
                .allowsHitTesting(false)
            TimelineView(.periodic(from: .now, by: 0.25)) { _ in
                card(remaining: decisions.remaining(), progress: decisions.progress())
            }
            .padding(.horizontal, VoorJouMetrics.margin)
            .padding(.bottom, 8)
            .background(Color.void)
        }
    }

    private func card(remaining: Int, progress: Double) -> some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        return VStack(alignment: .leading, spacing: 6) {
            if ax {
                Text(content.title)
                    .wholeWords(content.title, font: .display(17, relativeTo: .headline, weight: .semibold))
                    .foregroundStyle(Color.inkBright)
                Text(content.body)
                    .wholeWords(content.body, font: VoorJouMetrics.body)
                    .foregroundStyle(Color.inkSoft)
                    .lineLimit(2)
                buttons
                Text(DecisionToast.countdown(remaining))
                    .font(VoorJouMetrics.label)
                    .foregroundStyle(Color.inkLabel)
            } else {
                HStack(alignment: .center, spacing: 14) {
                    glyph
                    Text(content.title)
                        .font(.display(17, relativeTo: .headline, weight: .medium))
                        .foregroundStyle(Color.inkBright)
                    Spacer(minLength: 8)
                    Text(DecisionToast.countdown(remaining))
                        .font(VoorJouMetrics.label)
                        .foregroundStyle(Color.inkLabel)
                        .monospacedDigit()
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(content.body)
                        .font(VoorJouMetrics.body)
                        .foregroundStyle(Color.inkSoft)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    buttons
                }
                .padding(.leading, 36)
            }
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Rectangle().fill(Color.edge)
                    Rectangle().fill(Color.signal).frame(width: g.size.width * progress)
                }
            }
            .frame(height: 2)
            .padding(.top, 6)
            .accessibilityHidden(true)
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.plate, in: shape)
        .overlay(shape.strokeBorder(Color.edgeStrong, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(content.title). \(content.body). \(DecisionToast.countdown(remaining))")
        .accessibilityAction(named: VoorJouCopy.undo, undo)
    }

    private var buttons: some View {
        HStack(spacing: 24) {
            Button(action: undo) {
                Text(VoorJouCopy.undo)
                    .wholeWords(VoorJouCopy.undo, font: .display(17, relativeTo: .body, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
            }
            .foregroundStyle(Color.signal)
            if let all = content.reviewAll {
                Button(all, action: review)
                    .font(.display(17, relativeTo: .body, weight: .medium))
                    .foregroundStyle(Color.inkBright)
            }
        }
        .buttonStyle(.borderless)
        .padding(.vertical, 4)
    }

    private var glyph: some View {
        ZStack {
            Circle().fill(content.undoGlyph ? Color.steel : Color.okay)
            Image(systemName: content.undoGlyph ? "arrow.uturn.backward" : "checkmark")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(Color.onSignal)
        }
        .frame(width: 22, height: 22)
        .accessibilityHidden(true)
    }
}

/// "Bekijk beide": every held decision, each with its own undo.
struct DecisionReviewSheet: View {
    let decisions: InboxDecisions
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(decisions.held) { d in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(d.verb.uppercased())
                            .font(VoorJouMetrics.label)
                            .tracking(VoorJouMetrics.labelTracking)
                            .foregroundStyle(Color.inkLabel)
                        Text(d.title)
                            .font(VoorJouMetrics.title)
                            .foregroundStyle(Color.inkBright)
                            .fixedSize(horizontal: false, vertical: true)
                        Button(VoorJouCopy.undo) { decisions.undo(d.id) }
                            .font(VoorJouMetrics.link)
                            .foregroundStyle(Color.signal)
                            .buttonStyle(.borderless)
                    }
                    .padding(.vertical, 6)
                    .listRowBackground(Color.void)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color.void)
            .navigationTitle("Beslissingen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Klaar") { dismiss() } }
            }
            .onChange(of: decisions.held.isEmpty) { _, empty in if empty { dismiss() } }
        }
        .preferredColorScheme(.dark)
    }
}
