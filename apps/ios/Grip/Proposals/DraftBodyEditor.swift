import SwiftUI
import UIKit

/// The draft's body as the editor shows it (frame "Aanpassen · editor typen"):
/// one paragraph per line, set apart by PARAGRAPH SPACING rather than the
/// blank line the stored body carries, and every paragraph Martin added
/// marked as the read-only concept marks it. Pure, so the round trip is
/// unit-tested (`DraftBodyCodecTests`).
///
/// - A paragraph break in the body (a blank line, or more) is ONE "\n" here.
/// - A line break INSIDE a paragraph (a signature's "groet,\nMartin") is
///   U+2028 LINE SEPARATOR, so it stays a break without becoming a paragraph.
/// - What the body had before its first and after its last paragraph is
///   kept aside and put back, so opening and closing the editor without
///   typing never changes the draft.
enum DraftBodyCodec {
    static let lineSeparator: Character = "\u{2028}"

    static func display(_ body: String) -> String {
        paragraphs(body).map { $0.replacingOccurrences(of: "\n", with: String(lineSeparator)) }
            .joined(separator: "\n")
    }

    /// The body for what is on screen, with `original`'s leading and trailing
    /// whitespace around it.
    static func body(_ display: String, like original: String) -> String {
        let lines = display.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.replacingOccurrences(of: String(lineSeparator), with: "\n") }
        let text = lines.joined(separator: "\n\n")
        let o = original.replacingOccurrences(of: "\r\n", with: "\n")
        let lead = String(o.prefix { $0.isWhitespace })
        let trail = String(o.reversed().prefix { $0.isWhitespace }.reversed())
        guard !o.allSatisfy(\.isWhitespace) else { return text }
        return lead + text.trimmingCharacters(in: .whitespacesAndNewlines) + trail
    }

    /// The paragraphs of a stored body, split on blank lines, each with its
    /// own line breaks; leading and trailing whitespace dropped.
    static func paragraphs(_ body: String) -> [String] {
        let b = body.replacingOccurrences(of: "\r\n", with: "\n")
        return b.components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    /// Which display lines (by index) Martin added against verder's draft —
    /// the same longest-common-subsequence rule as `DraftChanges`, so the
    /// editor and the read-only concept mark the same paragraphs.
    static func addedLines(_ display: String, original: String) -> Set<Int> {
        let lines = display.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.replacingOccurrences(of: String(lineSeparator), with: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines) }
        let kept = DraftChanges.commonSubsequence(ProposalText.paragraphs(original), lines.filter { !$0.isEmpty })
        var added = Set<Int>()
        var k = 0
        for (i, line) in lines.enumerated() where !line.isEmpty {
            if k < kept.count, kept[k] == line { k += 1 } else { added.insert(i) }
        }
        return added
    }
}

/// The editor's body field: a UITextView, because SwiftUI's text fields can
/// neither space paragraphs nor mark a range. Over the keyboard it carries a
/// full-width bar with "Bijlage" (a file from the dossier) and the keyboard
/// away, so nothing floats over the text.
struct DraftBodyEditor: UIViewRepresentable {
    @Binding var text: String
    /// verder's own body: what "added" is measured against.
    let original: String
    @Binding var focused: Bool
    /// The dossier files that may be attached (empty: the button is off).
    let attachable: [ProposalDetail.Attachable]
    let attach: (String) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> MarkedTextView {
        let v = MarkedTextView()
        v.isScrollEnabled = false
        v.backgroundColor = .clear
        v.textContainerInset = .zero
        v.textContainer.lineFragmentPadding = 0
        v.delegate = context.coordinator
        v.keyboardAppearance = .dark
        v.tintColor = UIColor(Color.signal)
        v.accessibilityLabel = "Tekst van het concept"
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        v.inputAccessoryView = context.coordinator.accessory
        context.coordinator.lastBody = text
        context.coordinator.render(v, display: DraftBodyCodec.display(text), keepSelection: false)
        return v
    }

    func updateUIView(_ v: MarkedTextView, context: Context) {
        let c = context.coordinator
        c.parent = self
        c.updateAccessory()
        // Only a change from OUTSIDE re-renders from the body: what Martin is
        // typing (a fresh empty line included) is the text view's own.
        let resized = c.typeSize != typeSize
        c.typeSize = typeSize
        if text != c.lastBody {
            c.lastBody = text
            c.render(v, display: DraftBodyCodec.display(text), keepSelection: true)
        } else if resized {
            c.render(v, display: v.text ?? "", keepSelection: true)
        }
        if focused, !v.isFirstResponder { DispatchQueue.main.async { v.becomeFirstResponder() } }
        if !focused, v.isFirstResponder { DispatchQueue.main.async { v.resignFirstResponder() } }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MarkedTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 320
        let size = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: max(size.height, 44))
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: DraftBodyEditor
        var typeSize: DynamicTypeSize
        var lastBody = ""
        lazy var accessory: KeyboardBar = KeyboardBar(done: { [weak self] in self?.parent.focused = false })

        init(_ parent: DraftBodyEditor) {
            self.parent = parent
            self.typeSize = parent.typeSize
        }

        func updateAccessory() {
            accessory.setAttachable(parent.attachable, attach: parent.attach)
        }

        /// The text, styled: Saira at the body size, paragraph spacing, and
        /// the added paragraphs' ranges handed to the view to mark.
        func render(_ v: MarkedTextView, display: String, keepSelection: Bool) {
            let selection = v.selectedRange
            let category = UIContentSizeCategory(typeSize)
            let traits = UITraitCollection(preferredContentSizeCategory: category)
            let base = UIFont(name: FontFamily.display, size: 17) ?? .systemFont(ofSize: 17)
            let font = UIFontMetrics(forTextStyle: .body).scaledFont(for: base, compatibleWith: traits)
            let style = NSMutableParagraphStyle()
            let factor = typeSize.isAccessibilitySize ? 1.2 : AuthType.lineFactor
            style.minimumLineHeight = font.pointSize * factor
            style.maximumLineHeight = font.pointSize * factor
            // The frames' ~10 pt between paragraphs, which does not grow with the
            // text: at AX5 a proportional gap reads as a blank line again.
            style.paragraphSpacing = min(font.pointSize * 0.55, 10)
            let attrs: [NSAttributedString.Key: Any] = [
                .font: font, .foregroundColor: UIColor(Color.ink), .paragraphStyle: style,
                .baselineOffset: (font.pointSize * factor - font.lineHeight) / 4,
            ]
            v.attributedText = NSAttributedString(string: display, attributes: attrs)
            v.typingAttributes = attrs
            if keepSelection, selection.location + selection.length <= (display as NSString).length {
                v.selectedRange = selection
            }
            mark(v)
            v.invalidateIntrinsicContentSize()
        }

        func mark(_ v: MarkedTextView) {
            let display = v.text ?? ""
            let added = DraftBodyCodec.addedLines(display, original: parent.original)
            var ranges: [NSRange] = []
            var location = 0
            for (i, line) in display.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                let length = (String(line) as NSString).length
                if added.contains(i) { ranges.append(NSRange(location: location, length: length)) }
                location += length + 1
            }
            v.addedRanges = ranges
        }

        func textViewDidChange(_ v: UITextView) {
            guard let v = v as? MarkedTextView else { return }
            let body = DraftBodyCodec.body(v.text ?? "", like: lastBody)
            lastBody = body
            parent.text = body
            mark(v)
            v.invalidateIntrinsicContentSize()
        }

        func textViewDidBeginEditing(_ textView: UITextView) { if !parent.focused { parent.focused = true } }
        func textViewDidEndEditing(_ textView: UITextView) { if parent.focused { parent.focused = false } }
    }
}

/// A text view that draws Martin's added paragraphs as the read-only concept
/// does: a faint signal tint and a 2-pt signal bar at the left, full width.
final class MarkedTextView: UITextView {
    var addedRanges: [NSRange] = [] { didSet { setNeedsLayout() } }
    private var marks: [UIView] = []

    override func layoutSubviews() {
        super.layoutSubviews()
        marks.forEach { $0.removeFromSuperview() }
        marks = []
        for range in addedRanges {
            guard let start = position(from: beginningOfDocument, offset: range.location),
                  let end = position(from: start, offset: range.length),
                  let textRange = textRange(from: start, to: end) else { continue }
            let rects = selectionRects(for: textRange).map(\.rect).filter { !$0.isNull && $0.height > 0 }
            guard var box = rects.first else { continue }
            for r in rects.dropFirst() { box = box.union(r) }
            let frame = CGRect(x: -8, y: box.minY - 4, width: bounds.width + 16, height: box.height + 8)
            let mark = UIView(frame: frame)
            mark.isUserInteractionEnabled = false
            mark.backgroundColor = UIColor(Color.signal).withAlphaComponent(0.10)
            let bar = UIView(frame: CGRect(x: 0, y: 0, width: 2, height: frame.height))
            bar.backgroundColor = UIColor(Color.signal)
            bar.autoresizingMask = [.flexibleHeight]
            mark.addSubview(bar)
            insertSubview(mark, at: 0)
            marks.append(mark)
        }
        clipsToBounds = false
    }
}

/// The bar over the keyboard: "Bijlage" (a menu of the dossier's files) and
/// the keyboard away, edge to edge.
final class KeyboardBar: UIInputView {
    private let attachButton = UIButton(type: .system)
    private let doneButton = UIButton(type: .system)

    init(done: @escaping () -> Void) {
        super.init(frame: CGRect(x: 0, y: 0, width: 320, height: 48), inputViewStyle: .default)
        allowsSelfSizing = true
        backgroundColor = UIColor(Color.plate)
        let hairline = UIView()
        hairline.backgroundColor = UIColor(Color.hairline)
        var config = UIButton.Configuration.plain()
        config.image = UIImage(systemName: "paperclip")
        config.imagePadding = 6
        config.baseForegroundColor = UIColor(Color.signalLink)
        config.contentInsets = .init(top: 8, leading: 0, bottom: 8, trailing: 8)
        var title = AttributedString("Bijlage")
        title.uiKit.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: UIFont(name: FontFamily.display, size: 17) ?? .systemFont(ofSize: 17))
        config.attributedTitle = title
        attachButton.configuration = config
        attachButton.showsMenuAsPrimaryAction = true
        attachButton.accessibilityLabel = "Bijlage uit je dossier"
        var doneConfig = UIButton.Configuration.plain()
        doneConfig.image = UIImage(systemName: "keyboard.chevron.compact.down")
        doneConfig.baseForegroundColor = UIColor(Color.signalLink)
        doneButton.configuration = doneConfig
        doneButton.accessibilityLabel = "Toetsenbord weg"
        doneButton.addAction(UIAction { _ in done() }, for: .primaryActionTriggered)
        for v in [hairline, attachButton, doneButton] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        NSLayoutConstraint.activate([
            hairline.topAnchor.constraint(equalTo: topAnchor),
            hairline.leadingAnchor.constraint(equalTo: leadingAnchor),
            hairline.trailingAnchor.constraint(equalTo: trailingAnchor),
            hairline.heightAnchor.constraint(equalToConstant: 1),
            attachButton.leadingAnchor.constraint(equalTo: layoutMarginsGuide.leadingAnchor, constant: 8),
            attachButton.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            attachButton.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
            doneButton.trailingAnchor.constraint(equalTo: layoutMarginsGuide.trailingAnchor, constant: -8),
            doneButton.centerYAnchor.constraint(equalTo: attachButton.centerYAnchor),
            doneButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 44),
            doneButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func setAttachable(_ docs: [ProposalDetail.Attachable], attach: @escaping (String) -> Void) {
        attachButton.isEnabled = !docs.isEmpty
        attachButton.menu = UIMenu(children: docs.map { doc in
            UIAction(title: doc.title) { _ in attach(doc.id) }
        })
    }
}
