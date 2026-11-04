import Testing
import Foundation
@testable import Verder

/// Voor jou draws what the server ranked, in the server's order, and amber
/// marks exactly the items waiting on Martin.
struct InboxRankingTests {
    /// Priorities deliberately OUT of order (3 before 1) and dates mixed: a
    /// phone that re-sorted by either would change the order.
    static let inbox = Data("""
    {"count":5,"items":[
      {"kind":"suggestion","id":"s1","title":"Brief CAK","subtitle":"Document","priority":3,
       "at":"2026-10-29T08:00:00.000Z","dueAt":null,"verder":false},
      {"kind":"proposal","id":"6f9619ff-8b86-d011-b42d-00c04fc964ff","title":"Loonstrook oktober aanleveren",
       "subtitle":"Verder Bewind","priority":1,"at":"2026-10-30T09:20:01.123Z","dueAt":"2026-11-07","verder":true},
      {"kind":"question","id":"7f9619ff-8b86-d011-b42d-00c04fc964ff","title":"Is de stukkenlijst compleet?",
       "subtitle":null,"priority":2,"at":"2026-10-30T10:00:00.000Z","dueAt":null,"verder":false},
      {"kind":"task","id":"t1","title":"Polis opvragen","subtitle":null,"priority":1,
       "at":"2026-10-20T08:00:00.000Z","dueAt":"2026-10-31T23:00:00.000Z","verder":false},
      {"kind":"stop","id":"st1","title":"Stukken aanleveren","subtitle":null,"priority":3,
       "at":"2026-08-28T00:00:00.000Z","dueAt":null,"verder":false}
    ],"doneByVerder":[\(DoneByVerderFixture.autoFile),\(DoneByVerderFixture.autoName)]}
    """.utf8)

    func decode() throws -> InboxDTO {
        try APIClient.jsonDecoder.decode(InboxDTO.self, from: Self.inbox)
    }

    @Test func rendersServerOrderUnchanged() throws {
        let inbox = try decode()
        let rows = VoorJouList.rows(inbox)
        #expect(rows.map(\.item.id) == inbox.items.map(\.id))
        #expect(rows.map(\.item.priority) == [3, 1, 2, 1, 3], "the phone never re-ranks")
    }

    @Test func doneByVerderIsNeverAmber() throws {
        let inbox = try decode()
        let done = VoorJouList.doneRows(inbox)
        #expect(done.count == 2)
        #expect(done.allSatisfy { !$0.amber })
        // Amber marks what waits on Martin NOW: the Nu rows (proposals and
        // questions); Kan wachten carries its kind's symbol instead.
        let rows = VoorJouList.rows(inbox)
        #expect(rows.filter(\.amber).map(\.item.kind) == [.proposal, .question])
    }

    @Test func replyRowOpensPlan2ProposalScreen() throws {
        let row = try #require(VoorJouList.rows(try decode()).first { $0.item.kind == .proposal })
        #expect(row.route == .proposal("6f9619ff-8b86-d011-b42d-00c04fc964ff"))
    }

    @Test func questionRowOpensPlan2ProposalScreen() throws {
        let row = try #require(VoorJouList.rows(try decode()).first { $0.item.kind == .question })
        #expect(row.route == .proposal("7f9619ff-8b86-d011-b42d-00c04fc964ff"))
    }

    @Test func suggestionAndTaskRowsOpenTheirScreens() throws {
        let rows = VoorJouList.rows(try decode())
        #expect(rows.first { $0.item.kind == .suggestion }?.route == .suggestion("s1"))
        #expect(rows.first { $0.item.kind == .task }?.route == .task("t1"))
        // The map's stop has no phone screen: it is shown, not opened.
        #expect(rows.first { $0.item.kind == .stop }?.route == nil)
    }

    @Test func emptyInboxSaysNothingWaits() throws {
        let empty = try APIClient.jsonDecoder.decode(InboxDTO.self, from: InboxFixture.emptyInbox)
        #expect(VoorJouList.rows(empty).isEmpty)
        #expect(VoorJouList.emptyText == "Niets wacht op je.")
    }
}
