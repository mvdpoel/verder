import Foundation

/// Search over the pocket dossier, entirely on the phone and entirely in
/// memory: it has to work at a counter with no network.
///
/// Case-, diacritic- and width-insensitive ("beschikking" finds
/// "Beschíkking", and the other way round). Every word of the query must
/// appear somewhere in the title or the text, in any order. Title hits come
/// first; otherwise the given order (newest first) is kept.
///
/// If this ever measures above 100 ms on the real corpus (Task 21 Step 3),
/// the answer is SQLite FTS5 — `sqlite3` is in the SDK, so no dependency.
enum DossierSearch {
    static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
                  locale: Locale(identifier: "nl_NL"))
    }

    static func words(_ q: String) -> [String] {
        fold(q).split(whereSeparator: \.isWhitespace).map(String.init)
    }

    static func search(_ q: String, in docs: [IndexedDoc]) -> [IndexedDoc] {
        let words = words(q)
        guard !words.isEmpty else { return docs }
        let hits = docs.filter { d in words.allSatisfy { d.haystack.contains($0) } }
        let inTitle = hits.filter { d in words.allSatisfy { d.foldedTitle.contains($0) } }
        let titleIDs = Set(inTitle.map(\.id))
        return inTitle + hits.filter { !titleIDs.contains($0.id) }
    }

    /// About `radius` characters of the ORIGINAL text on either side of the
    /// first word's match, accents kept. Nil when the title already matches
    /// every word (the title says enough), or when there is no text match.
    static func snippet(_ d: IndexedDoc, query: String, radius: Int = 40) -> String? {
        let words = words(query)
        guard let first = words.first, let text = d.text,
              !words.allSatisfy({ d.foldedTitle.contains($0) }) else { return nil }
        let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]
        guard let hit = text.range(of: first, options: options, locale: Locale(identifier: "nl_NL")) else {
            return nil
        }
        let from = text.index(hit.lowerBound, offsetBy: -radius, limitedBy: text.startIndex) ?? text.startIndex
        let to = text.index(hit.upperBound, offsetBy: radius, limitedBy: text.endIndex) ?? text.endIndex
        let body = text[from..<to].split(whereSeparator: \.isNewline).joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        return (from > text.startIndex ? "…" : "") + body + (to < text.endIndex ? "…" : "")
    }
}

/// The server's search snippet, split at its «…» marks (ts_headline's
/// StartSel/StopSel) so a view can emphasise the matches. An unclosed mark is
/// plain text.
enum SearchSnippet {
    struct Segment: Equatable, Sendable {
        let text: String
        let marked: Bool
    }

    static func segments(_ s: String) -> [Segment] {
        var out: [Segment] = []
        var rest = Substring(s)
        while let open = rest.firstIndex(of: "«"),
              let close = rest[rest.index(after: open)...].firstIndex(of: "»") {
            if open > rest.startIndex { out.append(Segment(text: String(rest[..<open]), marked: false)) }
            out.append(Segment(text: String(rest[rest.index(after: open)..<close]), marked: true))
            rest = rest[rest.index(after: close)...]
        }
        if !rest.isEmpty { out.append(Segment(text: String(rest), marked: false)) }
        return out
    }
}
