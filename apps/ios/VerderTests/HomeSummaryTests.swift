import Foundation
import Testing
@testable import Verder

struct HomeSummaryTests {
    private func item(_ n: Int) -> WaitingItem {
        WaitingItem(kind: .task, id: "t\(n)", title: "Taak \(n)", subtitle: nil, priority: 3,
                    at: Date(timeIntervalSince1970: 0), dueAt: nil, verder: false)
    }

    @Test func previewKeepsTheServersOrderAndStopsAtThree() {
        let inbox = InboxDTO(count: 5, items: (1...5).map(item), doneByVerder: [])
        #expect(HomeSummary.preview(inbox, revealed: true).map(\.id) == ["t1", "t2", "t3"])
    }

    /// Locked, the glance shows the count and NO titles: the preview is empty,
    /// so no title exists in the view tree for VoiceOver to read either.
    @Test func lockedPreviewHoldsNoTitles() {
        let inbox = InboxDTO(count: 5, items: (1...5).map(item), doneByVerder: [])
        #expect(HomeSummary.preview(inbox, revealed: false).isEmpty)
        #expect(HomeSummary.preview(inbox, revealed: true).count == 3)
    }

    @Test func waitingLineSaysNothingWaitsAtZero() {
        #expect(HomeSummary.waitingLine(0) == "Niets wacht op je.")
        #expect(HomeSummary.waitingLine(1) == "1 ding wacht op je")
        #expect(HomeSummary.waitingLine(498) == "498 dingen wachten op je")
    }

    @Test func onlyOverdueTasksAreAmber() {
        let lines = HomeSummary.taskLines(.init(openCount: 4, overdueCount: 1, waitingOnOthersCount: 2))
        #expect(lines == [
            .init(text: "4 open", amber: false),
            .init(text: "1 te laat", amber: true),
            .init(text: "2 wacht op een ander", amber: false),
        ])
    }

    @Test func zeroCountsAreLeftOut() {
        let lines = HomeSummary.taskLines(.init(openCount: 0, overdueCount: 0, waitingOnOthersCount: 0))
        #expect(lines == [.init(text: "0 open", amber: false)])
    }

    @Test func headlineDayIsAmsterdamsCalendar() {
        // 2026-07-13 23:30 UTC is already 14 July in Amsterdam.
        let at = ISO8601DateFormatter().date(from: "2026-07-13T23:30:00Z")!
        #expect(HomeSummary.day(at).hasPrefix("14 jul"))
    }
    // MARK: - Door verder gedaan (plan 3 Task GAP)

    private func action(_ n: Int, kind: String = "auto-file") -> VerderAction {
        VerderAction(changeId: "c\(n)", documentId: "d\(n)", documentTitle: "Brief \(n)",
                     at: Date(timeIntervalSince1970: Double(n)), kind: kind,
                     before: .init(status: "inbox", title: nil, docType: nil),
                     after: .init(status: "filed", title: nil, docType: "brief"),
                     proposedTitle: nil, undone: false, undoable: true, notUndoableReason: nil)
    }

    @Test func doneCardCountsWhatVerderDidAndOpensTheSection() {
        let inbox = InboxDTO(count: 0, items: [], doneByVerder: (1...5).map { action($0) })
        let card = HomeSummary.doneCard(inbox, revealed: true)
        #expect(card.line == "5 dingen door verder zelf gedaan")
        #expect(card.items.map(\.changeId) == ["c1", "c2", "c3"], "the server's order, top three")
        #expect(card.opens == .doneByVerder)
    }

    /// Locked, the glance shows the count only: no document title exists.
    @Test func lockedDoneCardHoldsNoTitles() {
        let inbox = InboxDTO(count: 0, items: [], doneByVerder: [action(1)])
        let card = HomeSummary.doneCard(inbox, revealed: false)
        #expect(card.line == "1 ding door verder zelf gedaan")
        #expect(card.items.isEmpty)
        #expect(card.opens == .doneByVerder)
    }

    @Test func nothingDoneOpensNothing() {
        let card = HomeSummary.doneCard(InboxDTO(count: 0, items: [], doneByVerder: []), revealed: true)
        // lowercase: verder is the app; capital Verder is the bewindvoerder.
        #expect(card.line == "verder deed niets zelf.")
        #expect(card.items.isEmpty)
        #expect(card.opens == nil)
    }

    /// What verder already did is never amber: it does not wait on Martin.
    /// Checked against the waiting card on the SAME inbox, so a tint rule
    /// that ignored the card (amber whenever something waits) fails here.
    @Test func doneCardIsNeverAmber() {
        let inbox = InboxDTO(count: 3, items: (1...3).map(item), doneByVerder: [action(1)])
        #expect(HomeSummary.cardAmber(.waiting, inbox: inbox))
        #expect(!HomeSummary.cardAmber(.done, inbox: inbox))
    }

    /// Amber only for waiting on Martin: no other card, and not the waiting
    /// card either when nothing waits or the inbox has not loaded.
    @Test func onlyAWaitingCardWithSomethingWaitingIsAmber() {
        let busy = InboxDTO(count: 2, items: (1...2).map(item), doneByVerder: [action(1)])
        let empty = InboxDTO(count: 0, items: [], doneByVerder: [action(1)])
        for c in HomeSummary.Card.allCases where c != .waiting {
            #expect(!HomeSummary.cardAmber(c, inbox: busy), "\(c)")
        }
        #expect(!HomeSummary.cardAmber(.waiting, inbox: empty))
        #expect(!HomeSummary.cardAmber(.waiting, inbox: nil))
    }

    @Test func doneRowSaysWhatVerderDid() {
        #expect(HomeSummary.doneRowLine(action(1)) == "Opgeborgen door verder")
        #expect(HomeSummary.doneRowLine(action(2, kind: "auto-name")) == "Hernoemd door verder")
    }
}
