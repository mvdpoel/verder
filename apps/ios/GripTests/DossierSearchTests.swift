import Testing
import Foundation
@testable import Grip

/// On-device search over the pocket dossier, and the pieces of the Dossier
/// tab that are decided outside the view.
struct DossierSearchTests {
    static func doc(_ id: String, _ title: String, text: String? = nil, receivedAt: String = "2026-10-30T09:00:00Z",
                    status: String = "inbox", docType: String? = nil) -> IndexedDoc {
        IndexedDoc(doc: DossierDoc(id: id, title: title, docType: docType, status: status,
                                   receivedAt: parseISODate(receivedAt)!, mime: "application/pdf",
                                   sizeBytes: 1, sha256: "x", hasText: text != nil),
                   text: text)
    }

    static let corpus = [
        doc("1", "Brief Gemeente Westerlaan", text: "We nemen binnen acht weken een besluit."),
        doc("2", "Formulier bijzondere bijstand", text: "Aanvraagformulier bijzondere bijstand."),
        doc("3", "Scan 2026-06-03", text: "De rechtbank wijst de Beschíkking toe."),
        doc("4", "Bevestiging aanmelding", text: "Team Startdossier helpt ook met de aanvraag bijzondere bijstand."),
        doc("5", "ID-kaart"),
    ]

    @Test func searchFindsTextIgnoringDiacritics() {
        #expect(DossierSearch.search("beschikking", in: Self.corpus).map(\.id) == ["3"])
        // And the other way round: an accent typed by Martin matches plain text.
        #expect(DossierSearch.search("bijstánd", in: Self.corpus).map(\.id) == ["2", "4"])
    }

    @Test func searchIgnoresCase() {
        #expect(DossierSearch.search("WESTERLAAN", in: Self.corpus).map(\.id) == ["1"])
        #expect(DossierSearch.search("id-KAART", in: Self.corpus).map(\.id) == ["5"])
    }

    /// Every word must appear, in the title or the text, in any order.
    @Test func everyWordMustMatch() {
        #expect(DossierSearch.search("bijstand team", in: Self.corpus).map(\.id) == ["4"])
        #expect(DossierSearch.search("  aanvraag   bijstand ", in: Self.corpus).map(\.id) == ["2", "4"])
        #expect(DossierSearch.search("bijstand huur", in: Self.corpus).isEmpty)
    }

    /// A title hit is what Martin is most likely looking for; otherwise the
    /// order given (newest first) is kept.
    @Test func titleMatchesComeFirst() {
        let docs = [Self.doc("a", "Bevestiging", text: "over de polis"), Self.doc("b", "Polis Duinzorg 2026")]
        #expect(DossierSearch.search("polis", in: docs).map(\.id) == ["b", "a"])
    }

    @Test func anEmptyQueryKeepsEverythingInOrder() {
        #expect(DossierSearch.search("", in: Self.corpus).map(\.id) == ["1", "2", "3", "4", "5"])
        #expect(DossierSearch.search("   ", in: Self.corpus).count == 5)
    }

    /// The line under a text hit: the original text (accents kept) around the match.
    @Test func snippetShowsTheMatchInTheOriginalText() throws {
        let long = String(repeating: "woord ", count: 30) + "De Beschíkking is getekend. " + String(repeating: "eind ", count: 30)
        let d = Self.doc("x", "Scan", text: long)
        let s = try #require(DossierSearch.snippet(d, query: "beschikking"))
        #expect(s.contains("Beschíkking"))
        #expect(s.hasPrefix("…") && s.hasSuffix("…"))
        #expect(s.count < 120)
        // A title hit shows its text too (the frames' "Formulier bijzondere
        // bijstand"); an empty query or a text without the word shows none.
        #expect(DossierSearch.snippet(Self.doc("y", "Beschikking", text: long), query: "beschikking") != nil)
        #expect(DossierSearch.snippet(d, query: "") == nil)
        #expect(DossierSearch.snippet(Self.doc("z", "Beschikking", text: "Niets hier."), query: "beschikking") == nil)
    }

    /// Whole words only, "…" only where the text goes on (frame "Zoeken /
    /// bijstand · op deze iPhone").
    @Test func snippetCutsAtWordsAndSaysWhereTheTextGoesOn() throws {
        let form = Self.doc("f", "Formulier bijzondere bijstand",
                            text: "Aanvraag bijzondere bijstand voor de periode vanaf 1 oktober 2026. Vul alle velden in en onderteken het formulier.")
        #expect(DossierSearch.snippet(form, query: "bijstand")
                == "Aanvraag bijzondere bijstand voor de periode vanaf 1 oktober 2026. Vul alle…")
        let letter = Self.doc("n", "Bevestiging aanmelding Noordkust",
                              text: "Bewindkantoor Noordkust bevestigt je aanmelding. Team Startdossier helpt bij de aanvraag voor bijzondere bijstand bij de gemeente.")
        #expect(DossierSearch.snippet(letter, query: "bijstand")
                == "…aanvraag voor bijzondere bijstand bij de gemeente.")
        // A cut that would fall inside a word moves to that word's edge.
        let s = try #require(DossierSearch.snippet(Self.doc("w", "Scan", text: "eenlangwoord bijstand tweedelangwoord"),
                                                   query: "bijstand", before: 5, after: 5))
        #expect(s == "…bijstand…")
    }

    /// The server marks keyword matches with «…» (ts_headline's StartSel/StopSel).
    @Test func serverSnippetMarksBecomeSegments() {
        let parts = SearchSnippet.segments("Aanvraag «bijzondere» «bijstand» Westerlaan.")
        #expect(parts == [.init(text: "Aanvraag ", marked: false), .init(text: "bijzondere", marked: true),
                          .init(text: " ", marked: false), .init(text: "bijstand", marked: true),
                          .init(text: " Westerlaan.", marked: false)])
        // An unclosed mark is plain text, never a crash.
        #expect(SearchSnippet.segments("a «b") == [.init(text: "a «b", marked: false)])
        #expect(SearchSnippet.segments("").isEmpty)
    }

    // MARK: - The tab's decisions

    /// Sync only in the foreground after unlock: `.complete` files cannot be
    /// written while the phone is locked, and a silent push never syncs.
    @Test func syncRunsOnlyUnlockedInTheForeground() {
        #expect(DossierSyncPolicy.maySync(isLocked: false, isActive: true))
        #expect(!DossierSyncPolicy.maySync(isLocked: true, isActive: true))
        #expect(!DossierSyncPolicy.maySync(isLocked: false, isActive: false))
    }

    @Test func viewerKindFollowsTheServedType() {
        #expect(ViewerKind(contentType: "application/pdf") == .pdf)
        #expect(ViewerKind(contentType: "application/PDF; charset=binary") == .pdf)
        #expect(ViewerKind(contentType: "image/jpeg") == .image)
        #expect(ViewerKind(contentType: "image/png") == .image)
        #expect(ViewerKind(contentType: "application/vnd.ms-excel") == .unsupported)
        #expect(ViewerKind(contentType: nil) == .unsupported)
    }

    @Test func freshnessLineNamesTheAgeAndOffline() {
        let now = parseISODate("2026-11-01T14:30:00Z")!
        let today = parseISODate("2026-11-01T13:02:00Z")!
        let earlier = parseISODate("2026-10-30T08:15:00Z")!
        #expect(DossierCopy.freshness(syncedAt: today, offline: false, now: now) == "bijgewerkt 14:02")
        #expect(DossierCopy.freshness(syncedAt: today, offline: true, now: now) == "offline · bijgewerkt 14:02")
        #expect(DossierCopy.freshness(syncedAt: earlier, offline: true, now: now) == "offline · bijgewerkt 30 okt 09:15")
        #expect(DossierCopy.freshness(syncedAt: nil, offline: true, now: now) == "offline · nog niet bijgewerkt")
        #expect(DossierCopy.freshness(syncedAt: nil, offline: false, now: now) == nil)
    }

    /// `+` would come back as a space through URLSearchParams.
    @Test func serverSearchPathEscapesTheQuery() {
        #expect(DossierCopy.searchPath("a+b & c=d") == "/api/mobile/v1/search?q=a%2Bb%20%26%20c%3Dd")
        #expect(DossierCopy.searchPath("bijstánd") == "/api/mobile/v1/search?q=bijst%C3%A1nd")
    }

    /// Open tasks are the ones waiting on Martin by the one definition
    /// (`WAITING_TASK_STATUSES`), in the server's order.
    @Test func openTasksAreOpenAndInProgress() {
        func t(_ id: String, _ status: String) -> TaskDTO {
            TaskDTO(id: id, title: id, details: nil, dueAt: nil, status: status, assigneeName: nil, validNext: [])
        }
        let all = [t("a", "waiting"), t("b", "open"), t("c", "done"), t("d", "in-progress"), t("e", "dropped")]
        #expect(DossierCopy.openTasks(all).map(\.id) == ["b", "d"])
    }

    /// A task's readout, all of it waiting on Martin, in Amsterdam time
    /// (frame: "WACHT OP JOU · TE LAAT · 30 OKT", "… · UITERLIJK DI 3 NOV").
    @Test func aTaskLineSaysTheDueDateRelativeToNow() throws {
        let iso = ISO8601DateFormatter()
        let now = try #require(iso.date(from: "2026-11-02T13:02:00Z")) // 14:02 in Amsterdam
        func line(_ s: String?) -> [String] { DossierLine.task(dueAt: s.flatMap(iso.date(from:)), now: now) }
        #expect(line("2026-11-03T16:00:00Z") == ["wacht op jou", "morgen 17:00"])
        #expect(line("2026-11-02T16:00:00Z") == ["wacht op jou", "vandaag 17:00"])
        #expect(line("2026-10-30T16:00:00Z") == ["wacht op jou", "te laat", "30 okt"])
        #expect(line("2026-11-06T16:00:00Z") == ["wacht op jou", "uiterlijk vr 6 nov"])
        #expect(line(nil) == ["wacht op jou"])
    }

    @Test func theEyebrowSaysTheAgeOrWhatIsArriving() {
        #expect(DossierCopy.eyebrow(loaded: true, syncedAt: Date(), freshness: "bijgewerkt 14:02", updating: nil)
                == "bijgewerkt 14:02")
        #expect(DossierCopy.eyebrow(loaded: true, syncedAt: nil, freshness: nil, updating: nil) == "nog niet bijgewerkt")
        #expect(DossierCopy.eyebrow(loaded: false, syncedAt: nil, freshness: nil, updating: nil) == nil)
        let two = DossierStore.Progress(due: 3, done: 2)
        #expect(DossierCopy.eyebrow(loaded: true, syncedAt: Date(), freshness: "bijgewerkt 14:02", updating: two)
                == "bijwerken… · 2 van 3 nieuw")
        // A sync with nothing new keeps the age.
        #expect(DossierCopy.eyebrow(loaded: true, syncedAt: Date(), freshness: "bijgewerkt 14:02",
                                    updating: DossierStore.Progress()) == "bijgewerkt 14:02")
        #expect(DossierCopy.seeAllTasks(6) == "Toon alle 6")
    }

    /// The most pressing first: overdue, then due soonest, then undated.
    @Test func tasksAreListedByDue() {
        func t(_ id: String, _ due: String?) -> TaskDTO {
            TaskDTO(id: id, title: id, details: nil, dueAt: due.flatMap(parseISODate), status: "open",
                    assigneeName: nil, validNext: [])
        }
        let sorted = DossierCopy.byDue([t("a", nil), t("b", "2026-11-03T16:00:00Z"), t("c", "2026-10-30T16:00:00Z"), t("d", nil)])
        #expect(sorted.map(\.id) == ["c", "b", "a", "d"])
    }
}
