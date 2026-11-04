import SwiftUI
import Testing
@testable import Grip

/// Martin's rule that no word breaks in the middle, as the steps the
/// sign-in, lock and pre-prompt screens take at the accessibility sizes.
@Suite struct WholeWordsTests {
    @Test func theLongestWordsComeFirst() {
        let words = WholeWords.candidates(in: "Geen toegangssleutel gevonden op deze iPhone.")
        #expect(words == ["toegangssleutel", "gevonden", "iPhone."])
    }

    @Test func aNoBreakSpaceKeepsItsWordWhole() {
        // "Face ID" cannot break at its no-break space, so it is one word.
        let words = WholeWords.candidates(in: "Wacht op Face\u{00A0}ID…", count: 1)
        #expect(words == ["Face\u{00A0}ID…"])
    }

    @Test func aLineMayBreakAfterAHyphen() {
        #expect(WholeWords.splitAfterHyphens("iCloud-sleutelhanger") == ["iCloud-", "sleutelhanger"])
        #expect(WholeWords.candidates(in: "via iCloud-sleutelhanger.", count: 1) == ["sleutelhanger."])
        // A lone dash is a word of its own, not a break inside one.
        #expect(WholeWords.splitAfterHyphens("-") == ["-"])
    }

    @Test func newlinesAndRepeatsAreNotWords() {
        #expect(WholeWords.candidates(in: "een\nwoord woord") == ["woord", "een"])
        #expect(WholeWords.candidates(in: "").isEmpty)
    }

    @Test func itStepsDownOneSizeAtATimeAndNeverBelowLarge() {
        #expect(WholeWords.smaller(than: .accessibility5) == .accessibility4)
        #expect(WholeWords.smaller(than: .accessibility1) == .xxxLarge)
        #expect(WholeWords.smaller(than: .xLarge) == .large)
        // Below the user's own normal size is never the fix.
        #expect(WholeWords.smaller(than: .large) == nil)
        #expect(WholeWords.smaller(than: .small) == nil)
    }

    @Test func aWordWiderThanItsTextWasSplit() {
        #expect(WholeWords.splits(wordWidth: 380, textWidth: 338))
        #expect(!WholeWords.splits(wordWidth: 338.4, textWidth: 338))
        #expect(!WholeWords.splits(wordWidth: 120, textWidth: 338))
        // Not yet measured: nothing to judge.
        #expect(!WholeWords.splits(wordWidth: 120, textWidth: 0))
    }
}
