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

    /// The ORIGINAL text around the first word's match, accents kept:
    /// whole words only, about `before` characters ahead of the match and
    /// `after` behind it, with "…" where the text goes on. Shown under a
    /// title hit too ("Formulier bijzondere bijstand" says what the form is
    /// FOR in its text — the final frames). Nil when the text has no match.
    static func snippet(_ d: IndexedDoc, query: String, before: Int = 25, after: Int = 50) -> String? {
        let words = words(query)
        guard let first = words.first, let text = d.text else { return nil }
        let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]
        guard let hit = text.range(of: first, options: options, locale: Locale(identifier: "nl_NL")) else {
            return nil
        }
        var from = text.index(hit.lowerBound, offsetBy: -before, limitedBy: text.startIndex) ?? text.startIndex
        var to = text.index(hit.upperBound, offsetBy: after, limitedBy: text.endIndex) ?? text.endIndex
        // A cut inside a word moves to that word's edge, never into the match.
        if from > text.startIndex, !text[text.index(before: from)].isWhitespace {
            from = text[from..<hit.lowerBound].firstIndex(where: \.isWhitespace).map { text.index(after: $0) } ?? hit.lowerBound
        }
        if to < text.endIndex, !text[to].isWhitespace {
            to = text[hit.upperBound..<to].lastIndex(where: \.isWhitespace) ?? hit.upperBound
        }
        let body = text[from..<to].split(whereSeparator: \.isNewline).joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        let lead = text[..<from].contains(where: { !$0.isWhitespace }) ? "…" : ""
        let tail = text[to...].contains(where: { !$0.isWhitespace }) ? "…" : ""
        return lead + body + tail
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
