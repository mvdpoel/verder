import Foundation
import Testing
@testable import Verder

struct HomeSummaryTests {
    private static func date(_ s: String) -> Date { ISO8601DateFormatter().date(from: s)! }
    /// The synthetic case's "today": Sun 1 nov 2026, 09:41 Amsterdam.
    private let now = date("2026-11-01T08:41:00Z")

    private func item(_ n: Int, kind: WaitingKind = .task, subtitle: String? = nil, at: Date? = nil,
                      dueAt: String? = nil) -> WaitingItem {
        WaitingItem(kind: kind, id: "t\(n)", title: "Taak \(n)", subtitle: subtitle, priority: 3,
                    at: at ?? Date(timeIntervalSince1970: 0), dueAt: dueAt, verder: false)
    }

    // MARK: - Wacht op jou

    @Test func previewKeepsTheServersOrderAndStopsAtTheLimit() {
        let inbox = InboxDTO(count: 5, items: (1...5).map { item($0) }, doneByVerder: [])
        #expect(HomeSummary.preview(inbox, revealed: true).map(\.id) == ["t1", "t2", "t3"])
        #expect(HomeSummary.preview(inbox, revealed: true, limit: 1).map(\.id) == ["t1"])
    }

    /// Locked, the glance shows the count and NO titles: the preview is empty,
    /// so no title exists in the view tree for VoiceOver to read either.
    @Test func lockedPreviewHoldsNoTitles() {
        let inbox = InboxDTO(count: 5, items: (1...5).map { item($0) }, doneByVerder: [])
        #expect(HomeSummary.preview(inbox, revealed: false).isEmpty)
        #expect(HomeSummary.preview(inbox, revealed: false, limit: 1).isEmpty)
    }

    /// Three rows; two on the iPhone SE; one at the accessibility sizes.
    @Test func previewLimitFollowsTheScreen() {
        #expect(HomeSummary.previewLimit(accessibilitySize: false, compactHeight: false) == 3)
        #expect(HomeSummary.previewLimit(accessibilitySize: false, compactHeight: true) == 2)
        #expect(HomeSummary.previewLimit(accessibilitySize: true, compactHeight: false) == 1)
        #expect(HomeSummary.previewLimit(accessibilitySize: true, compactHeight: true) == 1)
    }

    @Test func countWordsAgreeWithTheNumber() {
        #expect(HomeSummary.waitingLine(0) == "Niets wacht op je.")
        #expect(HomeSummary.waitingLine(1) == "1 ding wacht op je")
        #expect(HomeSummary.waitingLine(498) == "498 dingen wachten op je")
        #expect(HomeSummary.countCaption(1) == "ding wacht op je")
        #expect(HomeSummary.countCaption(10) == "dingen wachten op je")
        #expect(HomeSummary.seeAll(498) == "Alle 498\u{00A0}bekijken")
    }

    /// Only a long list gets the "not all at once" line, and it names the
    /// number of rows actually shown.
    @Test func manyHintOnlyForALongList() {
        #expect(HomeSummary.manyHint(10, shown: 3) == nil)
        #expect(HomeSummary.manyHint(498, shown: 3) == "Veel, maar niet alles tegelijk. Begin bij de bovenste drie.")
        #expect(HomeSummary.manyHint(498, shown: 2)?.hasSuffix("bovenste twee.") == true)
        #expect(HomeSummary.manyHint(498, shown: 1)?.hasSuffix("Begin bovenaan.") == true)
    }

    /// Ages are worked out against now, on Amsterdam's calendar.
    @Test func agesAreRelativeToNowInAmsterdam() {
        #expect(HomeSummary.age(Self.date("2026-11-01T08:30:00Z"), now: now) == "vandaag")
        // 23:30 UTC on 31 okt is already 1 nov in Amsterdam (CET, +1).
        #expect(HomeSummary.age(Self.date("2026-10-31T23:30:00Z"), now: now) == "vandaag")
        #expect(HomeSummary.age(Self.date("2026-10-31T14:05:00Z"), now: now) == "gisteren")
        #expect(HomeSummary.age(Self.date("2026-10-30T09:00:00Z"), now: now) == "vr 30 okt")
        #expect(HomeSummary.age(Self.date("2026-11-02T08:30:00Z"), now: now) == "ma 2 nov",
                "a date after today is its day, never 'vandaag'")
    }

    @Test func metaIsKindWhoAndAge() {
        let row = item(1, kind: .proposal, subtitle: "Bewindkantoor Noordkust", at: Self.date("2026-11-01T08:30:00Z"))
        #expect(HomeSummary.meta(row, now: now) == ["voorstel", "Bewindkantoor Noordkust", "vandaag"])
        #expect(HomeSummary.meta(item(2, at: Self.date("2026-10-31T10:00:00Z")), now: now) == ["taak", "gisteren"])
        #expect(HomeSummary.rowAccessibilityLabel(row, now: now)
                == "voorstel, Taak 1, Bewindkantoor Noordkust, wacht op jou, vandaag")
    }

    /// The meta wraps only after a " ·": a party name never breaks inside itself.
    @Test func metaLineBindsEachSegment() {
        let line = HomeSummary.metaLine(["vraag", "Incassobureau Kade & Partners", "vandaag"])
        #expect(line == "vraag\u{00A0}· Incassobureau\u{00A0}Kade\u{00A0}&\u{00A0}Partners\u{00A0}· vandaag")
    }

    // MARK: - Eyebrow

    @Test func eyebrowIsTheDayUntilTheBoardIsOld() {
        #expect(HomeSummary.eyebrow(now: now, fetchedAt: now, error: nil).text == "zondag 1 nov")
        let server = HomeSummary.eyebrow(now: now, fetchedAt: Self.date("2026-11-01T07:58:00Z"), error: .server(503))
        #expect(server.text == "zondag 1 nov · bijgewerkt 08:58")
        #expect(!server.offline)
        let offline = HomeSummary.eyebrow(now: now, fetchedAt: Self.date("2026-10-31T21:14:00Z"),
                                          error: .transport("URLError -1009"))
        #expect(offline.offline)
        #expect(offline.text == "offline · bijgewerkt gisteren 22:14")
        #expect(offline.accessibilityLabel == "Offline. Dit is de stand van gisteren 22:14.")
        // No board kept: nothing to date, so the eyebrow is just the day.
        #expect(HomeSummary.eyebrow(now: now, fetchedAt: nil, error: .server(503)).text == "zondag 1 nov")
    }

    @Test func errorNoticeNamesTheCauseAndTheNextAttempt() throws {
        let attempted = Self.date("2026-11-01T13:05:00Z")
        let server = try #require(HomeSummary.errorNotice(.server(503), attemptedAt: attempted))
        #expect(server.readout == ["server 503", "volgende poging 14:06"])
        #expect(server.strip == "Overzicht nu niet op te halen.")
        #expect(server.step?.contains("aanstaat") == true)
        let offline = try #require(HomeSummary.errorNotice(.transport("x"), attemptedAt: attempted))
        #expect(offline.readout == ["offline", "volgende poging 14:06"])
        #expect(HomeSummary.errorNotice(.unauthorized, attemptedAt: attempted) == nil)
        #expect(HomeSummary.errorNotice(nil, attemptedAt: attempted) == nil)
    }

    // MARK: - The rest card

    @Test func tasksRowNamesTheNextDeadlineAndOnlyLateIsAmber() {
        let inbox = InboxDTO(count: 2, items: [
            item(1, dueAt: "2026-11-03T16:00:00.000Z"),
            item(2, dueAt: "2026-10-30T16:00:00.000Z"),
        ], doneByVerder: [])
        let row = HomeSummary.tasksRow(.init(openCount: 6, overdueCount: 1, waitingOnOthersCount: 2), inbox: inbox, now: now)
        #expect(row.title == "6 taken voor jou")
        #expect(row.amberSuffix == "1 te laat")
        #expect(row.dot)
        #expect(row.meta == ["taken", "volgende 3 nov"])
    }

    @Test func noOpenTasksSaysWhoElseIsWaitingAndIsNeverAmber() {
        let row = HomeSummary.tasksRow(.init(openCount: 0, overdueCount: 0, waitingOnOthersCount: 2), inbox: nil, now: now)
        #expect(row.title == "Geen taken voor jou")
        #expect(row.amberSuffix == nil)
        #expect(!row.dot)
        #expect(row.meta == ["taken", "2 wachten op een ander"])
        #expect(HomeSummary.tasksRow(.init(openCount: 1, overdueCount: 0, waitingOnOthersCount: 1), inbox: nil, now: now)
                == .init(title: "1 taak voor jou", amberSuffix: nil, meta: ["taken", "1 wacht op een ander"]))
    }

    @Test func scansRowIsThePhonesOwnQueue() {
        func q(_ underway: Int, _ sent: Int, _ failed: Int = 0) -> QueueSummary {
            var s = QueueSummary(items: [], now: Date())
            s.underway = underway; s.sentToday = sent; s.failed = failed
            return s
        }
        #expect(HomeSummary.scansRow(q(1, 2), offline: false).title == "Vandaag 2 verstuurd · 1 in de wachtrij")
        #expect(HomeSummary.scansRow(q(1, 0), offline: true).title == "1 wacht op verbinding")
        #expect(HomeSummary.scansRow(q(0, 0), offline: false).title == "Vandaag nog niets gescand")
        #expect(HomeSummary.scansRow(q(0, 0, 1), offline: false).title == "1 mislukt")
        #expect(HomeSummary.scansRow(q(0, 0), offline: false).meta == ["scans"])
    }

    // MARK: - Door verder gedaan

    private func action(_ n: Int, kind: String = "auto-file") -> VerderAction {
        VerderAction(changeId: "c\(n)", documentId: "d\(n)", documentTitle: "Brief \(n)",
                     at: Date(timeIntervalSince1970: Double(n)), kind: kind,
                     before: .init(status: "inbox", title: nil, docType: nil),
                     after: .init(status: "filed", title: nil, docType: "brief"),
                     proposedTitle: nil, undone: false, undoable: true, notUndoableReason: nil)
    }

    /// Counts only — so it shows while locked — and it opens the section.
    @Test func doneRowCountsWhatVerderDidByKind() {
        let inbox = InboxDTO(count: 0, items: [], doneByVerder: [action(1), action(2, kind: "auto-name"), action(3)])
        let row = HomeSummary.doneRow(inbox)
        #expect(row.title == "Door verder gedaan · 3")
        #expect(row.meta == ["2 opgeborgen", "1 hernoemd"])
        #expect(!row.accessibilityLabel.contains("Brief"), "no document title reaches the glance")
        #expect(HomeSummary.doneOpens(inbox) == .doneByVerder)
    }

    @Test func nothingDoneOpensNothing() {
        let inbox = InboxDTO(count: 0, items: [], doneByVerder: [])
        // lowercase: verder is the app; capital Verder is the bewindvoerder.
        #expect(HomeSummary.doneRow(inbox).meta == ["verder deed niets zelf"])
        #expect(HomeSummary.doneOpens(inbox) == nil)
    }

    /// What verder already did is never amber: it does not wait on Martin.
    @Test func doneRowIsNeverAmber() {
        let inbox = InboxDTO(count: 3, items: (1...3).map { item($0) }, doneByVerder: [action(1)])
        #expect(HomeSummary.cardAmber(.waiting, inbox: inbox))
        #expect(!HomeSummary.cardAmber(.done, inbox: inbox))
        #expect(!HomeSummary.doneRow(inbox).dot)
        #expect(HomeSummary.doneRow(inbox).amberSuffix == nil)
    }

    /// Amber only for waiting on Martin: no other card, and not the waiting
    /// card either when nothing waits or the inbox has not loaded.
    @Test func onlyAWaitingCardWithSomethingWaitingIsAmber() {
        let busy = InboxDTO(count: 2, items: (1...2).map { item($0) }, doneByVerder: [action(1)])
        let empty = InboxDTO(count: 0, items: [], doneByVerder: [action(1)])
        for c in HomeSummary.Card.allCases where c != .waiting {
            #expect(!HomeSummary.cardAmber(c, inbox: busy), "\(c)")
        }
        #expect(!HomeSummary.cardAmber(.waiting, inbox: empty))
        #expect(!HomeSummary.cardAmber(.waiting, inbox: nil))
    }

    @Test func headlineDayIsAmsterdamsCalendar() {
        // 2026-07-13 23:30 UTC is already 14 July in Amsterdam.
        #expect(HomeSummary.day(Self.date("2026-07-13T23:30:00Z")) == "14 jul")
        let h = DashboardSummaryDTO.Headline(stopTitle: "Stukken", trackTitle: "Opstart bewind",
                                             happenedAt: Self.date("2026-10-28T09:00:00Z"), note: nil)
        #expect(HomeSummary.headlineMeta(h) == ["Opstart bewind", "28 okt"])
    }

    @Test func eyebrowDayIsLongAndDutch() {
        #expect(HomeSummary.longDay(now) == "zondag 1 nov")
        #expect(HomeSummary.stamp(Self.date("2026-10-30T21:14:00Z"), now: now) == "vr 30 okt 22:14")
    }
}

struct HomeHyphenationTests {
    /// A long Dutch word gains soft hyphens and reads the same without them.
    @Test func longWordsGetSoftHyphensOnly() {
        let out = HomeSummary.hyphenated("Antwoord aan Bewindkantoor Noordkust")
        #expect(out.contains("\u{00AD}"))
        #expect(out.replacingOccurrences(of: "\u{00AD}", with: "") == "Antwoord aan Bewindkantoor Noordkust")
        #expect(HomeSummary.hyphenated("dingen wachten op je") == "dingen wachten op je",
                "a word that fits a line moves whole")
        let footnote = HomeSummary.hyphenated("Alleen je leefgeldrekening.")
        #expect(footnote.contains("\u{00AD}"), "punctuation does not hide a word from the dictionary")
        #expect(footnote.hasSuffix("ning."))
    }
}
