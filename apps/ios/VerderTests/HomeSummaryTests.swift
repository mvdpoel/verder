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
        #expect(HomeSummary.preview(inbox).map(\.id) == ["t1", "t2", "t3"])
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
}
