import SwiftUI

/// Martin's rule: a word never breaks in the middle — not with a hyphen, not
/// without one. At the largest accessibility sizes some Dutch words
/// ("toegangssleutel", "vergrendelscherm", "spraakherkenning") are wider than
/// a phone's line, and SwiftUI would then split them. The final auth frames
/// solve it per TEXT: only a text whose longest word does not fit is set
/// smaller, until that word fits whole; every other text keeps its full size.
/// `wholeWords(_:font:)` does the same, one Dynamic Type step at a time.
///
/// The steps are the pure part (`WholeWords`, tested); the view measures.
enum WholeWords {
    /// The words most likely to be the widest: the `count` longest by
    /// characters. A line can break at a space, a newline or after a hyphen,
    /// so those are the word boundaries; a no-break space (`Face\u{00A0}ID`)
    /// is not, and keeps its two halves one word.
    static func candidates(in text: String, count: Int = 3) -> [String] {
        let words = text
            .split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" })
            .flatMap { splitAfterHyphens(String($0)) }
        var seen = Set<String>()
        let unique = words.filter { seen.insert($0).inserted }
        return Array(unique.sorted { $0.count > $1.count }.prefix(count))
    }

    /// "iCloud-sleutelhanger" → ["iCloud-", "sleutelhanger"]: the line may
    /// break after the hyphen, so each half only has to fit on its own.
    static func splitAfterHyphens(_ word: String) -> [String] {
        var parts: [String] = []
        var current = ""
        for ch in word {
            current.append(ch)
            if ch == "-" && current.count > 1 {
                parts.append(current)
                current = ""
            }
        }
        if !current.isEmpty { parts.append(current) }
        return parts
    }

    /// The next Dynamic Type size down, or nil at the default size and
    /// below: a word that does not fit at Large is a layout bug, not a
    /// reason to set text smaller than the user's own choice of normal.
    static func smaller(than size: DynamicTypeSize) -> DynamicTypeSize? {
        guard size > .large else { return nil }
        let all = DynamicTypeSize.allCases
        guard let i = all.firstIndex(of: size), i > 0 else { return nil }
        return all[i - 1]
    }

    /// Whether a text that is `textWidth` wide has had a word of
    /// `wordWidth` split: a text never grows wider than its line, so a word
    /// wider than the whole text was broken. Half a point absorbs rounding.
    static func splits(wordWidth: CGFloat, textWidth: CGFloat) -> Bool {
        textWidth > 0 && wordWidth > textWidth + 0.5
    }

    /// The line has grown by more than rounding since a step was taken at
    /// `from`: the step may no longer be needed.
    static func widened(from: CGFloat, to: CGFloat) -> Bool { to > from + 8 }
}

private struct WholeWordsModifier: ViewModifier {
    let words: [String]
    let font: Font

    @Environment(\.dynamicTypeSize) private var outer
    @State private var cap: DynamicTypeSize?
    @State private var textWidth: CGFloat = 0
    @State private var wordWidth: CGFloat = 0
    /// The line width the last step was taken at. A text laid out once in a
    /// transient narrow box (a sheet mid-presentation) would otherwise stay
    /// stepped down for good: once the line is wider again, measure afresh.
    @State private var steppedAt: CGFloat?

    func body(content: Content) -> some View {
        content
            .font(font)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: {
                if let at = steppedAt, WholeWords.widened(from: at, to: $0) {
                    steppedAt = nil
                    cap = nil
                }
                textWidth = $0
                stepIfSplit()
            }
            .background(alignment: .topLeading) {
                // The candidates unwrapped, in the same font and size.
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(words, id: \.self) { Text($0) }
                }
                .font(font)
                .fixedSize()
                .hidden()
                .accessibilityHidden(true)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: {
                    wordWidth = $0
                    stepIfSplit()
                }
            }
            .dynamicTypeSize(...(cap ?? .accessibility5))
            .onChange(of: outer) { _, _ in cap = nil }
    }

    private func stepIfSplit() {
        guard WholeWords.splits(wordWidth: wordWidth, textWidth: textWidth) else { return }
        let current = min(outer, cap ?? outer)
        if let next = WholeWords.smaller(than: current) {
            cap = next
            steppedAt = textWidth
        }
    }
}

extension Text {
    /// Sets `font`, and sets this one text a Dynamic Type step smaller for as
    /// long as a word of `string` (the text's own words) would break in the
    /// middle (see `WholeWords`).
    func wholeWords(_ string: String, font: Font) -> some View {
        modifier(WholeWordsModifier(words: WholeWords.candidates(in: string), font: font))
    }
}

extension View {
    /// A capture's `-fixtures-scroll end` on a screen that scrolls as a whole
    /// (sign-in, the unlock sheet, a pre-prompt at the accessibility sizes):
    /// it opens at its end, so the lower half of an AX5 frame can be shot.
    /// Nothing in a Release build.
    @ViewBuilder func fixtureScrollAnchor() -> some View {
        #if DEBUG
        if FixtureLaunch.current?.scroll == .end { defaultScrollAnchor(.bottom) } else { self }
        #else
        self
        #endif
    }
}
