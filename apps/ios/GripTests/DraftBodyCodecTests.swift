import Testing
@testable import Grip

/// The editor's body: paragraphs a line apart on screen, a blank line apart
/// in the draft, and opening the editor never changes a draft by itself.
struct DraftBodyCodecTests {
    static let body = "Beste Ilse,\n\nHierbij de loonstrook.\n\nMet vriendelijke groet,\nMartin\n"

    @Test func paragraphsAreOneLineApartOnScreen() {
        #expect(DraftBodyCodec.display(Self.body) == "Beste Ilse,\nHierbij de loonstrook.\nMet vriendelijke groet,\u{2028}Martin")
    }

    @Test func untouchedRoundTripIsTheSameBody() {
        #expect(DraftBodyCodec.body(DraftBodyCodec.display(Self.body), like: Self.body) == Self.body)
        let crlf = "Beste Ilse,\r\n\r\nTot ziens."
        #expect(DraftBodyCodec.body(DraftBodyCodec.display(crlf), like: crlf) == "Beste Ilse,\n\nTot ziens.")
    }

    @Test func aNewLineOnScreenIsANewParagraph() {
        let display = "Beste Ilse,\nHierbij de loonstrook.\nExcuses dat het iets later is.\nMet vriendelijke groet,\u{2028}Martin"
        let body = DraftBodyCodec.body(display, like: Self.body)
        #expect(body == "Beste Ilse,\n\nHierbij de loonstrook.\n\nExcuses dat het iets later is.\n\nMet vriendelijke groet,\nMartin\n")
        #expect(DraftBodyCodec.addedLines(display, original: Self.body) == [2])
    }

    @Test func nothingAddedMarksNothing() {
        #expect(DraftBodyCodec.addedLines(DraftBodyCodec.display(Self.body), original: Self.body).isEmpty)
        #expect(DraftBodyCodec.addedLines("Beste Ilse,\n\nHierbij de loonstrook.", original: Self.body).isEmpty)
    }

    @Test func anEmptyBodyStaysEmpty() {
        #expect(DraftBodyCodec.body("", like: "") == "")
        #expect(DraftBodyCodec.body("Hoi", like: "") == "Hoi")
    }
}
