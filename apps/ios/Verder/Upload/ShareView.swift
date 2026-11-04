import PDFKit
import SwiftUI
import UIKit

/// The share extension's one screen ("share · final"). Thin: everything it
/// says comes from `ShareModel`; this decides only where it goes. Compiled
/// into the extension AND the app, so the captures draw the same view.
///
/// The bar ("Annuleren · Naar verder · Versturen") stays put and does not
/// scale with Dynamic Type, as a system navigation bar does not (a long press
/// shows the Large Content Viewer); everything under it scrolls, so at AX5
/// nothing is pushed off the sheet.
struct ShareView: View {
    let model: ShareModel
    let cancel: () -> Void
    let send: () -> Void
    let close: () -> Void
    let retryLoad: () -> Void
    /// Opens scrolled to the end (the "doorgescrold" captures).
    var startsAtEnd = false

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(spacing: 0) {
            ShareNavBar(model: model, cancel: cancel, send: send, close: close)
                .padding(.horizontal, 16)
                .padding(.top, 25)
            ScrollViewReader { proxy in
                ScrollView {
                    content
                        .padding(.horizontal, 16)
                        .padding(.top, 24)
                        // At accessibility sizes the end of the scroll leaves
                        // room enough that no line of what scrolled away
                        // rests half-cut under the bar (the AX5 frames' 80).
                        .padding(.bottom, typeSize.isAccessibilitySize ? 80 : 24)
                    Color.clear.frame(height: 1).id(ShareView.end)
                }
                .scrollIndicatorsFlash(onAppear: true)
                .onAppear {
                    guard startsAtEnd else { return }
                    Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(300))
                        proxy.scrollTo(ShareView.end, anchor: .bottom)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color.plate.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .sensoryFeedback(trigger: model.phase) { _, new in
            switch new {
            case .done: .impact(weight: .medium)
            case .loadFailed, .saveFailed: .error
            default: nil
            }
        }
    }

    private static let end = "end"

    @ViewBuilder private var content: some View {
        if let closing = model.closing {
            ShareClosingView(closing: closing)
        } else if let failure = model.failure {
            ShareFailureView(model: model, failure: failure, retryLoad: retryLoad, retrySave: send)
        } else if model.phase == .loading {
            ShareLoadingView(explanation: model.explanation)
        } else {
            ShareReadyView(model: model)
        }
    }
}

/// Saira's own line height is ~1.57 em; the ramp sets it tighter (15 on 20,
/// 17 on 22, 28 on 34, Figma), as a multiple of the point size so it scales
/// with Dynamic Type.
private enum ShareLines {
    static let callout = 20.0 / 15.0
    static let headline = 22.0 / 17.0
    static let title = 34.0 / 28.0
}

// MARK: - The bar

private struct ShareNavBar: View {
    let model: ShareModel
    let cancel: () -> Void
    let send: () -> Void
    let close: () -> Void

    var body: some View {
        ShareNavLayout {
            leading
            Text(ShareModel.Copy.heading)
                .font(.display(17, relativeTo: .headline, weight: .medium))
                .foregroundStyle(Color.inkBright)
                .lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            trailing
        }
        .frame(height: 44)
        .dynamicTypeSize(...DynamicTypeSize.large)
    }

    @ViewBuilder private var leading: some View {
        switch model.leading {
        case .cancel(let enabled):
            Button(ShareModel.Copy.cancel, action: cancel)
                .font(.display(17, relativeTo: .body))
                .foregroundStyle(enabled ? Color.inkSoft : Color.inkLabel)
                .disabled(!enabled)
                .frame(minHeight: 44)
                .accessibilityHint(enabled ? "" : "De bestanden staan al in de wachtrij.")
                .accessibilityShowsLargeContentViewer()
        case .close:
            Button(ShareModel.Copy.close, action: cancel)
                .font(.display(17, relativeTo: .body))
                .foregroundStyle(Color.inkSoft)
                .frame(minHeight: 44)
                .accessibilityShowsLargeContentViewer()
        case nil:
            Color.clear.frame(width: 0, height: 0)
        }
    }

    @ViewBuilder private var trailing: some View {
        switch model.trailing {
        case .send(let label, let enabled):
            Button(action: send) { CapsuleLabel(enabled: enabled) { Text(label) } }
                .disabled(!enabled)
                .accessibilityLabel(label)
                .accessibilityHint(enabled ? "" : "Het bestand wordt nog geladen.")
                .accessibilityShowsLargeContentViewer()
        case .progress:
            CapsuleLabel(enabled: true) { ProgressSymbol() }
                .accessibilityElement()
                .accessibilityLabel(model.progress?.label ?? ShareModel.Copy.sending)
        case .done:
            Button(action: close) { CapsuleLabel(enabled: true) { Text(ShareModel.Copy.done) } }
                .accessibilityShowsLargeContentViewer()
        case nil:
            Color.clear.frame(width: 0, height: 0)
        }
    }
}

/// The trailing capsule: cyan with the action glow when it can be pressed;
/// `field` with an `edge-strong` ring and an `ink-label` label (4.9:1) when it
/// cannot. At least 104 wide, 16 inside its ends.
private struct CapsuleLabel<Label: View>: View {
    let enabled: Bool
    @ViewBuilder let label: Label

    var body: some View {
        label
            .font(.display(17, relativeTo: .body, weight: .medium))
            .foregroundStyle(enabled ? Color.onSignal : Color.inkLabel)
            .lineLimit(1)
            .padding(.horizontal, 16)
            .frame(minWidth: 104, minHeight: 36)
            .background {
                if enabled {
                    Capsule().fill(LinearGradient(colors: [.signalLit, .signal], startPoint: .top, endPoint: .bottom))
                        .glow(Glow.action)
                } else {
                    Capsule().fill(Color.field).overlay(Capsule().strokeBorder(Color.edgeStrong, lineWidth: 1))
                }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
    }
}

private struct ProgressSymbol: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Image(systemName: "arrow.up.circle")
            .font(.system(size: 20, weight: .regular))
            .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion)
    }
}

/// Leading, title, trailing. The title is centred on the sheet, as a
/// navigation bar centres it, unless that would bring it within 12 pt of a
/// button; then it is centred in the room between them (what UIKit does on a
/// narrow phone), and truncated only when even that room is too small.
private struct ShareNavLayout: Layout {
    static let clearance: CGFloat = 12

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        CGSize(width: proposal.width ?? 375, height: 44)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 3 else { return }
        let lead = subviews[0].sizeThatFits(.unspecified)
        let trail = subviews[2].sizeThatFits(.unspecified)
        subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading,
                          proposal: ProposedViewSize(lead))
        subviews[2].place(at: CGPoint(x: bounds.maxX, y: bounds.midY), anchor: .trailing,
                          proposal: ProposedViewSize(trail))
        let left = bounds.minX + (lead.width > 0 ? lead.width + Self.clearance : 0)
        let right = bounds.maxX - (trail.width > 0 ? trail.width + Self.clearance : 0)
        let room = max(0, right - left)
        let ideal = subviews[1].sizeThatFits(.unspecified)
        let width = min(ideal.width, room)
        var x = bounds.midX - width / 2
        if x < left || x + width > right { x = left + (room - width) / 2 }
        subviews[1].place(at: CGPoint(x: x, y: bounds.midY), anchor: .leading,
                          proposal: ProposedViewSize(width: width, height: ideal.height))
    }
}

// MARK: - Before Versturen

private struct ShareReadyView: View {
    let model: ShareModel
    @Environment(\.dynamicTypeSize) private var typeSize
    private var large: Bool { typeSize.isAccessibilitySize }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            if let notice = model.notice {
                ShareNotice(notice: notice)
            }
            if model.rows.isEmpty {
                single
            } else {
                if model.notice == nil {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(ShareModel.displayName(model.title))
                            .font(.display(28, relativeTo: .title))
                            .lineHeight(.multiple(factor: ShareLines.title))
                            .foregroundStyle(Color.inkBright)
                        ShareFacts(parts: model.detail)
                    }
                    .accessibilityElement(children: .combine)
                }
                ShareRows(rows: model.rows)
            }
            if let order = model.orderNote {
                Text(order)
                    .font(.display(15, relativeTo: .callout))
                    .lineHeight(.multiple(factor: ShareLines.callout))
                    .foregroundStyle(Color.inkMute)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let progress = model.progress {
                ShareProgress(progress: progress)
            }
            if let explanation = model.explanation {
                ShareExplanation(explanation: explanation)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var single: some View {
        if let file = model.prepared.first {
            VStack(alignment: .leading, spacing: 0) {
                if model.hasPhotoPDF {
                    if large, let badge = model.photoBadge {
                        PhotoBadge(text: badge).padding(.bottom, 24)
                    }
                    PhotoStack(file: file)
                    if !large, let badge = model.photoBadge {
                        PhotoBadge(text: badge).padding(.top, 8)
                    }
                } else {
                    PageThumbnail(file: file, width: large ? 96 : (model.notice == nil ? 168 : 112))
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(ShareModel.displayName(file.fileName))
                        .font(model.signedOut ? .display(15, relativeTo: .callout)
                                              : .display(17, relativeTo: .headline, weight: .medium))
                                              .lineHeight(.multiple(factor: ShareLines.headline))
                        .foregroundStyle(model.signedOut ? Color.inkSoft : Color.inkBright)
                        // The confirm screen keeps the whole name at AX sizes:
                        // this is where Martin checks what he is sending.
                        .lineLimit(large ? nil : 2)
                        .truncationMode(.middle)
                        .fixedSize(horizontal: false, vertical: true)
                    ShareFacts(parts: model.detail(of: 0))
                }
                .padding(.top, 24)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

private struct ShareNotice: View {
    let notice: ShareModel.Notice
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: typeSize.isAccessibilitySize ? 16 : 8) {
            Text(notice.head)
                .font(.display(17, relativeTo: .headline, weight: .semibold))
                .lineHeight(.multiple(factor: ShareLines.headline))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
            Text(notice.body)
                .font(.display(15, relativeTo: .callout))
                .lineHeight(.multiple(factor: ShareLines.callout))
                .foregroundStyle(Color.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}

/// `PDF · 2 pagina's · 312 kB`; at accessibility sizes one fact per line,
/// so no line starts or ends on a dangling dot.
private struct ShareFacts: View {
    let parts: [String]
    var color: Color = .inkLabel
    var alignment: HorizontalAlignment = .leading
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: alignment, spacing: 0) {
                ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                    Text(part).font(.mono(13, relativeTo: .caption)).foregroundStyle(color)
                }
            }
        } else {
            Text(parts.joined(separator: " · "))
                .font(.mono(13, relativeTo: .caption))
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct ShareRows: View {
    let rows: [ShareModel.Row]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(rows) { row in
                HStack(alignment: .top, spacing: 12) {
                    RowThumbnail(row: row)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(ShareModel.displayName(row.fileName))
                            .font(.display(15, relativeTo: .callout))
                            .lineHeight(.multiple(factor: ShareLines.callout))
                            .foregroundStyle(row.included ? Color.ink : Color.inkMute)
                            .lineLimit(2)
                            .truncationMode(.middle)
                            .fixedSize(horizontal: false, vertical: true)
                        ShareFacts(parts: row.detail, color: row.included ? .inkLabel : .inkSoft)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 12)
                .overlay(alignment: .bottom) {
                    if row.id != rows.last?.id {
                        Rectangle().fill(Color.hairline).frame(height: 1).padding(.leading, 44)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

private struct ShareProgress: View {
    let progress: ShareModel.Progress
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.edgeStrong)
                    Capsule().fill(Color.signal).frame(width: geo.size.width * progress.fraction)
                }
            }
            .frame(height: 4)
            .animation(reduceMotion ? nil : .linear(duration: 0.4), value: progress.fraction)
            Text(progress.label)
                .font(.mono(13, relativeTo: .caption))
                .foregroundStyle(Color.inkLabel)
        }
        .accessibilityElement()
        .accessibilityLabel(progress.label)
        .accessibilityValue("\(Int((progress.fraction * 100).rounded())) procent")
    }
}

private struct ShareExplanation: View {
    let explanation: ShareModel.Explanation

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(explanation.label.uppercased())
                .font(.mono(12, relativeTo: .caption, weight: .medium))
                .tracking(1.2)
                .foregroundStyle(Color.inkLabel)
            Text(explanation.text)
                .font(.display(15, relativeTo: .callout))
                .lineHeight(.multiple(factor: ShareLines.callout))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
        .accessibilityElement(children: .combine)
    }
}

/// The shape of what is coming (brief §2.4: a skeleton, never a spinner).
private struct ShareLoadingView: View {
    let explanation: ShareModel.Explanation?

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 0) {
                RoundedRectangle(cornerRadius: Radius.chip)
                    .fill(Color.void)
                    .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edge, lineWidth: 1))
                    .frame(width: 168, height: 238)
                RoundedRectangle(cornerRadius: Radius.chip).fill(Color.edgeStrong).frame(width: 220, height: 12)
                    .padding(.top, 30)
                RoundedRectangle(cornerRadius: Radius.chip).fill(Color.edgeStrong).frame(width: 110, height: 8)
                    .padding(.top, 12)
            }
            .accessibilityElement()
            .accessibilityLabel("Bestand wordt geladen")
            if let explanation {
                ShareExplanation(explanation: explanation)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Failures and refusals

private struct ShareFailureView: View {
    let model: ShareModel
    let failure: ShareModel.Failure
    let retryLoad: () -> Void
    let retrySave: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            if let symbol = failure.symbol {
                Image(systemName: symbol)
                    .font(.system(size: 24, weight: .light))
                    .foregroundStyle(Color.inkBright)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 12) {
                Text(failure.title)
                    .font(.display(28, relativeTo: .title))
                    .lineHeight(.multiple(factor: ShareLines.title))
                    .foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(failure.body)
                    .font(.display(15, relativeTo: .callout))
                    .lineHeight(.multiple(factor: ShareLines.callout))
                    .foregroundStyle(Color.inkMute)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            what
            if failure.retry {
                Button(action: { if model.phase == .loadFailed { retryLoad() } else { retrySave() } }) {
                    Text(ShareModel.Copy.retry)
                        .font(.display(15, relativeTo: .callout))
                        .lineHeight(.multiple(factor: ShareLines.callout))
                        .foregroundStyle(Color.signalLink)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .frame(minWidth: 240, maxWidth: typeSize.isAccessibilitySize ? .infinity : nil, minHeight: 48)
                        .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
                        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// What the failure is about: the share (a save), the file (too large),
    /// or the link.
    @ViewBuilder private var what: some View {
        switch model.phase {
        case .saveFailed:
            VStack(alignment: .leading, spacing: 4) {
                Text(ShareModel.displayName(model.title))
                    .font(.display(17, relativeTo: .headline, weight: .medium))
                    .lineHeight(.multiple(factor: ShareLines.headline))
                    .foregroundStyle(Color.inkBright)
                    .lineLimit(2)
                    .truncationMode(.middle)
                ShareFacts(parts: model.detail)
            }
            .accessibilityElement(children: .combine)
        case .refused(.tooLarge):
            if model.tooLargeFiles.count == 1, let file = model.tooLargeFiles.first {
                VStack(alignment: .leading, spacing: 0) {
                    TooLargeThumbnail(data: file.thumbnail, width: typeSize.isAccessibilitySize ? 96 : 112)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(ShareModel.displayName(file.fileName))
                            .font(.display(17, relativeTo: .headline, weight: .medium))
                            .lineHeight(.multiple(factor: ShareLines.headline))
                            .foregroundStyle(Color.inkBright)
                            .lineLimit(2)
                            .truncationMode(.middle)
                        ShareFacts(parts: [file.bytes.map(ShareModel.size) ?? "", "max.\u{00A0}48\u{00A0}MB"]
                            .filter { !$0.isEmpty }, color: .inkSoft)
                    }
                    .padding(.top, 24)
                    .accessibilityElement(children: .combine)
                }
            } else {
                ShareRows(rows: model.rows)
            }
        case .refused(.link(let link)):
            ShareExplanation(explanation: .init(label: ShareModel.Copy.linkLabel, text: link))
        default:
            EmptyView()
        }
    }
}

// MARK: - The closing screen

private struct ShareClosingView: View {
    let closing: ShareModel.Closing
    @Environment(\.dynamicTypeSize) private var typeSize
    private var large: Bool { typeSize.isAccessibilitySize }

    var body: some View {
        VStack(alignment: large ? .leading : .center, spacing: large ? 32 : 24) {
            OutcomeDisc(delivered: closing.delivered, size: large ? 80 : 120)
                .padding(.top, large ? 0 : 24)
            VStack(alignment: large ? .leading : .center, spacing: large ? 24 : 12) {
                Text(closing.title)
                    .font(.display(28, relativeTo: .title))
                    .lineHeight(.multiple(factor: ShareLines.title))
                    .foregroundStyle(Color.inkBright)
                    .accessibilityAddTraits(.isHeader)
                Text(closing.body)
                    .font(.display(15, relativeTo: .callout))
                    .lineHeight(.multiple(factor: ShareLines.callout))
                    .foregroundStyle(large ? Color.inkMute : Color.inkSoft)
            }
            .multilineTextAlignment(large ? .leading : .center)
            .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: large ? .leading : .center, spacing: large ? 16 : 4) {
                if let reason = closing.reason {
                    Text(reason).font(.mono(13, relativeTo: .caption)).foregroundStyle(Color.inkSoft)
                }
                if large {
                    readoutName
                    if !closing.facts.isEmpty { ShareFacts(parts: closing.facts, alignment: .leading) }
                } else if closing.reason != nil, !closing.facts.isEmpty {
                    // "Afschrift september.pdf · 14 MB": the size is the reason's fact.
                    Text(([ShareModel.displayName(closing.name)] + closing.facts).joined(separator: " · "))
                        .font(.mono(13, relativeTo: .caption))
                        .foregroundStyle(Color.inkLabel)
                        .lineLimit(2)
                        .truncationMode(.middle)
                } else {
                    readoutName
                    if !closing.facts.isEmpty {
                        Text(closing.facts.joined(separator: " · "))
                            .font(.mono(13, relativeTo: .caption))
                            .foregroundStyle(Color.inkLabel)
                    }
                }
            }
            .multilineTextAlignment(large ? .leading : .center)
            .accessibilityElement(children: .combine)
        }
        .frame(maxWidth: .infinity, alignment: large ? .leading : .center)
    }

    /// A file name and its size in one line when the outcome names the size
    /// ("Afschrift september.pdf · 14 MB"); otherwise the name alone, two
    /// lines at most, cut in the middle so "30 okt.pdf" survives.
    private var readoutName: some View {
        Text(ShareModel.displayName(closing.name))
            .font(.mono(13, relativeTo: .caption))
            .foregroundStyle(Color.inkLabel)
            .lineLimit(2)
            .truncationMode(.middle)
    }
}

private struct OutcomeDisc: View {
    let delivered: Bool
    let size: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    var body: some View {
        let tint: Color = delivered ? .okay : .steel
        Image(systemName: "tray.and.arrow.down")
            .font(.system(size: size * 0.34, weight: .light))
            .foregroundStyle(tint)
            .symbolEffect(.bounce, value: shown)
            .frame(width: size, height: size)
            .background(Circle().fill(tint.opacity(delivered ? 0.10 : 0.08)))
            .overlay(Circle().strokeBorder(tint.opacity(0.45), lineWidth: 1))
            .accessibilityHidden(true)
            .onAppear { if !reduceMotion { shown = true } }
    }
}

// MARK: - Thumbnails

/// A PDF's first page, rendered by PDFKit; a document symbol for anything else.
struct PageThumbnail: View {
    let file: PreparedShare
    let width: CGFloat

    var body: some View {
        let height = (width * 1.414).rounded()
        Group {
            if let image = Self.image(file, page: 0, width: width) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: "doc").font(.system(size: width * 0.2, weight: .light)).foregroundStyle(Color.steel)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.field)
            }
        }
        .frame(width: width, height: height)
        .clipShape(RoundedRectangle(cornerRadius: Radius.chip))
        .shadow(color: .black.opacity(0.35), radius: 6, y: 3)
        .accessibilityHidden(true)
    }

    static func document(_ file: PreparedShare) -> PDFDocument? {
        guard file.mime == "application/pdf" else { return nil }
        return switch file.content {
        case .data(let data): PDFDocument(data: data)
        case .file(let url): PDFDocument(url: url)
        }
    }

    static func image(_ file: PreparedShare, page: Int, width: CGFloat) -> UIImage? {
        document(file)?.page(at: page)?.thumbnail(of: CGSize(width: width * 2, height: width * 2.83), for: .mediaBox)
    }
}

private struct RowThumbnail: View {
    let row: ShareModel.Row

    var body: some View {
        Group {
            if let file = row.file, let image = PageThumbnail.image(file, page: 0, width: 32) {
                Image(uiImage: image).resizable().scaledToFill()
            } else if let data = row.thumbnail, let image = UIImage(data: data) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: "doc").font(.system(size: 14, weight: .light)).foregroundStyle(Color.steel)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).background(Color.field)
            }
        }
        .frame(width: 32, height: 42)
        .clipShape(RoundedRectangle(cornerRadius: Radius.chip))
        .saturation(row.included ? 1 : 0)
        .opacity(row.included ? 1 : 0.45)
        .accessibilityHidden(true)
    }
}

/// A file over the limit: its first page when PDFKit could draw one while
/// it was measured, dimmed, because it is not going.
private struct TooLargeThumbnail: View {
    let data: Data?
    let width: CGFloat

    var body: some View {
        Group {
            if let data, let image = UIImage(data: data) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: "doc").font(.system(size: width * 0.2, weight: .light)).foregroundStyle(Color.steel)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).background(Color.field)
            }
        }
        .frame(width: width, height: (width * 1.414).rounded())
        .saturation(0)
        .opacity(0.5)
        .clipShape(RoundedRectangle(cornerRadius: Radius.chip))
        .accessibilityHidden(true)
    }
}

/// The photo PDF as the photos it was made of: up to three of its pages,
/// fanned, the first on top.
private struct PhotoStack: View {
    let file: PreparedShare
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let scale: CGFloat = typeSize.isAccessibilitySize ? 0.95 : 1
        let pages = (0..<3).map { PageThumbnail.image(file, page: $0, width: 120) }
        ZStack(alignment: .topLeading) {
            // Back right: the third photo, as an outline over the sheet.
            page(pages[2])
                .opacity(0.35)
                .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
                .rotationEffect(.degrees(6))
                .offset(x: 64, y: 22)
            // Back left: the second, larger and tinted like a photo.
            page(pages[1], width: 132)
                .overlay(Color.steelDim.opacity(0.45))
                .opacity(0.85)
                .rotationEffect(.degrees(-5))
                .offset(x: 4, y: 4)
            page(pages[0], width: 96)
                .rotationEffect(.degrees(-3))
                .offset(x: 50, y: 26)
                .shadow(color: .black.opacity(0.45), radius: 8, y: 4)
        }
        .frame(width: 192 * scale, height: 200 * scale, alignment: .topLeading)
        .accessibilityHidden(true)
    }

    private func page(_ image: UIImage?, width: CGFloat = 120) -> some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFill() } else { Color.field }
        }
        .frame(width: width, height: (width * 1.33).rounded())
        .clipShape(RoundedRectangle(cornerRadius: Radius.chip))
    }
}

/// `3 FOTO'S`, boxed; at accessibility sizes the plain words, unboxed and
/// in sentence case, so they wrap like text rather than overflow a chip.
private struct PhotoBadge: View {
    let text: String
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if typeSize.isAccessibilitySize {
            Text(text)
                .font(.mono(13, relativeTo: .caption))
                .foregroundStyle(Color.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Text(text.uppercased())
                .font(.mono(13, relativeTo: .caption))
                .foregroundStyle(Color.inkSoft)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
        }
    }
}
