import Testing
import Foundation
import Synchronization
@testable import Verder

/// What the Dossier tab and the viewer say ("dossier · final"): soort chips,
/// readout lines, sync progress, the server's hits by kind, the counter's
/// brightness — each rule tested as text or numbers.
@MainActor
struct DossierPresentationTests {
    nonisolated static let now = parseISODate("2026-11-01T13:02:00Z")!

    static func doc(_ id: String, _ title: String, docType: String? = nil, receivedAt: String = "2026-10-30T09:00:00Z",
                    status: String = "filed", source: String? = nil, size: Int = 1, hasText: Bool = true,
                    pages: Int? = nil, text: String? = nil) -> IndexedDoc {
        IndexedDoc(doc: DossierDoc(id: id, title: title, docType: docType, status: status,
                                   receivedAt: parseISODate(receivedAt)!, mime: "application/pdf",
                                   sizeBytes: size, sha256: "x", hasText: hasText, source: source),
                   text: text, pages: pages)
    }

    // MARK: - Soort chips

    @Test func kindsAreCountedMostCommonFirstAndANullSoortIsOverig() {
        let docs = [Self.doc("1", "a", docType: "letter"), Self.doc("2", "b", docType: "Letter "),
                    Self.doc("3", "c", docType: "payslip"), Self.doc("4", "d"), Self.doc("5", "e", docType: "other")]
        let kinds = DossierKinds.counts(docs)
        #expect(kinds.map(\.label) == ["brief", "overig", "loonstrook"])
        #expect(kinds.map(\.count) == [2, 2, 1])
        #expect(DossierKinds.filter(docs, kind: "brief").map(\.id) == ["1", "2"])
        #expect(DossierKinds.filter(docs, kind: nil).count == 5)
    }

    @Test func theChipsShowTheTopSoortTheChosenOneAndTheRestBehindMore() {
        let kinds = [DossierKind(key: "brief", label: "brief", count: 4), DossierKind(key: "contract", label: "contract", count: 2),
                     DossierKind(key: "loonstrook", label: "loonstrook", count: 2)]
        #expect(DossierKinds.visible(kinds, selected: nil).shown.map(\.key) == ["brief"])
        #expect(DossierKinds.visible(kinds, selected: nil).more.map(\.key) == ["contract", "loonstrook"])
        #expect(DossierKinds.visible(kinds, selected: "loonstrook").shown.map(\.key) == ["brief", "loonstrook"])
        #expect(DossierKinds.visible(kinds, selected: "loonstrook").more.map(\.key) == ["contract"])
    }

    // MARK: - Readout lines (the frame's rows)

    @Test func aRowSaysSoortAndDayAndPagesFillInWhereTheyAreNotSaid() {
        let brief = Self.doc("1", "Brief Gemeente Westerlaan 30 okt", docType: "letter", pages: 2)
        #expect(DossierLine.row(brief, now: Self.now) == ["brief", "2 blz"])
        let bevestiging = Self.doc("2", "Bevestiging aanmelding Noordkust", docType: "letter",
                                   receivedAt: "2026-09-18T09:00:00Z", pages: 1)
        #expect(DossierLine.row(bevestiging, now: Self.now) == ["brief", "18 sep"])
        // Filtered on brief: the soort is the filter's, the pages fill in.
        #expect(DossierLine.row(bevestiging, filtered: true, now: Self.now) == ["18 sep", "1 blz"])
        #expect(DossierLine.row(brief, filtered: true, now: Self.now) == ["2 blz"])
        let id = Self.doc("3", "ID-kaart", docType: "id-document", receivedAt: "2026-09-12T09:00:00Z", source: "phone-scan")
        #expect(DossierLine.row(id, now: Self.now) == ["id-bewijs", "12 sep", "foto-scan"])
        let formulier = Self.doc("4", "Formulier bijzondere bijstand", docType: "other",
                                 receivedAt: "2026-10-29T09:00:00Z", status: "inbox", pages: 1)
        #expect(DossierLine.row(formulier, now: Self.now) == ["29 okt", "niet opgeborgen"])
        // A search hit names the soort, "overig" too, and leaves the status out.
        #expect(DossierLine.row(formulier, inSearch: true, now: Self.now) == ["overig", "29 okt"])
        let old = Self.doc("5", "Huurcontract", docType: "contract", receivedAt: "2025-03-01T09:00:00Z")
        #expect(DossierLine.row(old, now: Self.now) == ["contract", "1 mrt 2025"])
    }

    @Test func theViewerLineSaysPagesOrDayThenStatusSourceOrSize() {
        let brief = Self.doc("1", "Brief", docType: "letter").doc
        #expect(DossierLine.viewer(brief, pages: 2, held: true, now: Self.now) == ["brief", "2 blz", "opgeborgen"])
        let id = Self.doc("2", "ID", docType: "id-document", receivedAt: "2026-09-12T09:00:00Z", source: "phone-scan").doc
        #expect(DossierLine.viewer(id, pages: 1, held: true, now: Self.now) == ["id-bewijs", "12 sep", "foto-scan"])
        let loon = Self.doc("3", "Loonstrook", docType: "payslip", receivedAt: "2026-10-28T09:00:00Z", size: 420_000).doc
        #expect(DossierLine.viewer(loon, pages: nil, held: false, now: Self.now) == ["loonstrook", "28 okt", "0,4 MB"])
    }

    @Test func sizesAreDutch() {
        #expect(DossierLine.size(420_000) == "0,4 MB")
        #expect(DossierLine.size(9_800_000) == "9,8 MB")
        #expect(DossierLine.size(1_500) == "2 kB")
        #expect(DossierLine.sizes(4_100_000, of: 9_800_000) == "4,1 van 9,8 MB")
    }

    @Test func theHeadlineWaitsOnMartin() {
        #expect(DossierLine.headline(happenedAt: parseISODate("2026-10-28T09:00:00Z"), now: Self.now) == ["wacht op jou", "28 okt"])
        #expect(DossierLine.headline(happenedAt: nil, now: Self.now) == ["wacht op jou"])
    }

    // MARK: - Sync progress

    @Test func theFirstSyncCardSaysHowFarAndWhatComes() {
        let card = DossierProgressCopy.card(held: 5, heldBytes: 4_100_000, total: 12, totalBytes: 9_800_000,
                                            interrupted: false, offline: false, eta: 20)
        #expect(card.headline == "5 van 12 documenten")
        #expect(card.meta == "4,1 van 9,8 MB · nog ongeveer 20 seconden")
        #expect(card.body == DossierProgressCopy.promise)
        #expect(abs((card.fraction ?? 0) - 4.1 / 9.8) < 0.001)
        let stopped = DossierProgressCopy.card(held: 5, heldBytes: 4_100_000, total: 12, totalBytes: 9_800_000,
                                               interrupted: true, offline: true, eta: nil)
        #expect(stopped.label == "dossier ophalen · onderbroken")
        #expect(stopped.meta == "4,1 van 9,8 MB · wacht op verbinding")
        #expect(stopped.body == DossierProgressCopy.kept)
        // Without the server's total it counts what arrived.
        let bare = DossierProgressCopy.card(held: 1, heldBytes: 400_000, total: nil, totalBytes: nil,
                                            interrupted: false, offline: false, eta: nil)
        #expect(bare.headline == "1 document binnen")
        #expect(bare.meta == "0,4 MB binnen")
        #expect(bare.fraction == nil)
    }

    @Test func theEstimateWaitsForARateAndRoundsLikeSpeech() {
        #expect(DossierProgressCopy.eta(bytesThisRun: 100, elapsed: 1, bytesLeft: 100) == nil)
        #expect(DossierProgressCopy.eta(bytesThisRun: 0, elapsed: 5, bytesLeft: 100) == nil)
        #expect(DossierProgressCopy.eta(bytesThisRun: 4_100_000, elapsed: 20, bytesLeft: 5_700_000).map { Int($0) } == 27)
        #expect(DossierProgressCopy.remaining(4) == "nog een paar seconden")
        #expect(DossierProgressCopy.remaining(23) == "nog ongeveer 20 seconden")
        #expect(DossierProgressCopy.remaining(70) == "nog ongeveer 70 seconden")
        #expect(DossierProgressCopy.remaining(100) == "nog ongeveer 2 minuten")
        #expect(DossierProgressCopy.remaining(61 * 1.5) == "nog ongeveer 2 minuten")
        #expect(DossierProgressCopy.updating(done: 2, due: 3) == "bijwerken… · 2 van 3 nieuw")
        #expect(DossierProgressCopy.documentsLabel(held: 5, total: 12) == "documenten · 5 van 12 binnen")
    }

    // MARK: - The server's hits

    static func hit(_ type: String, _ id: String, status: String? = nil, from: String? = nil,
                    assignee: String? = nil, channel: String? = nil, at: String? = "2026-10-28T10:00:00Z") -> SearchHit {
        SearchHit(entityType: type, entityId: id, title: id, snippet: nil, occurredAt: at, status: status,
                  link: nil, from: from, assigneeName: assignee, channel: channel)
    }

    @Test func serverHitsAreGroupedAndWhatThePhoneHoldsIsLeftOut() {
        let hits = [Self.hit("document", "held"), Self.hit("task", "t1", status: "open"), Self.hit("email", "m1"),
                    Self.hit("entry", "e1"), Self.hit("document", "new"), Self.hit("party", "p1")]
        let fresh = ServerHits.fresh(hits, held: ["held"])
        #expect(fresh.map(\.entityId) == ["t1", "m1", "e1", "new", "p1"])
        let groups = ServerHits.groups(fresh)
        #expect(groups.map(\.label) == ["mails", "documenten", "taken", "logboek", "party"])
    }

    /// Amber only on a task that waits on Martin; every other line is grey.
    @Test func eachKindHasItsOwnLineAndOnlyMartinsTasksAreAmber() {
        #expect(ServerHits.detail(Self.hit("email", "m", from: "Ilse, Noordkust"), now: Self.now) == ["Ilse, Noordkust", "28 okt"])
        let mine = Self.hit("task", "t", status: "open", at: "2026-11-03T16:00:00Z")
        #expect(ServerHits.detail(mine, now: Self.now) == ["wacht op jou", "3 nov"])
        #expect(ServerHits.waitsOnMartin(mine))
        let theirs = Self.hit("task", "u", status: "waiting", assignee: "Gemeente Westerlaan")
        #expect(ServerHits.detail(theirs, now: Self.now) == ["wacht op Gemeente Westerlaan"])
        #expect(!ServerHits.waitsOnMartin(theirs))
        #expect(!ServerHits.waitsOnMartin(Self.hit("email", "m", status: "open")))
        #expect(ServerHits.detail(Self.hit("entry", "e", channel: "phone", at: "2026-10-27T13:30:00Z"), now: Self.now)
                == ["telefoon", "27 okt"])
        // Without the fields the server does not serve yet: kind and day.
        #expect(ServerHits.detail(Self.hit("email", "m"), now: Self.now) == ["mail", "28 okt"])
    }

    // MARK: - Local search's words

    @Test func aShorterTermIsOneThatOccurs() {
        let docs = [Self.doc("1", "Huurcontract Lindehof", text: "Huurovereenkomst zelfstandige woonruimte.")]
        #expect(DossierSearchCopy.shorterTerm("huurtoeslag", in: docs) == "huur")
        #expect(DossierSearchCopy.shorterTerm("zorgtoeslag", in: docs) == nil)
        #expect(DossierSearchCopy.shorterTerm("huu", in: docs) == nil)
        #expect(DossierSearchCopy.nothingAnywhereBody(shorter: "huur").hasSuffix("Probeer een kortere zoekterm, zoals “huur”."))
    }

    @Test func titleOnlyIsSaidInTheSingularAndPlural() {
        #expect(DossierSearchCopy.titleOnly(0) == nil)
        #expect(DossierSearchCopy.titleOnly(1) == "1 document zonder herkende tekst is alleen op de titel doorzocht.")
        #expect(DossierSearchCopy.titleOnly(3) == "3 documenten zonder herkende tekst zijn alleen op de titel doorzocht.")
    }

    @Test func theFoundWordIsMarkedOnTheOriginalText() {
        let parts = DossierSearchCopy.marked("Formulier bijzondere Bijstánd", query: "bijstand")
        #expect(parts == [.init(text: "Formulier bijzondere ", marked: false), .init(text: "Bijstánd", marked: true)])
        #expect(DossierSearchCopy.marked("Niets", query: "").map(\.marked) == [false])
    }

    // MARK: - The viewer

    @Test func thePageReadoutHasThreeSpellings() {
        #expect(PageIndicator.label(page: 1, of: 2, style: .full) == "pagina 1 van 2")
        #expect(PageIndicator.label(page: 1, of: 2, style: .short) == "1 van 2")
        #expect(PageIndicator.label(page: 2, of: 2, style: .counter) == "2 / 2")
        #expect(PageIndicator.label(page: 9, of: 2, style: .counter) == "2 / 2")
        #expect(!PageIndicator.canGoBack(page: 1) && PageIndicator.canGoBack(page: 2))
        #expect(PageIndicator.canGoForward(page: 1, of: 2) && !PageIndicator.canGoForward(page: 2, of: 2))
        #expect(PageIndicator.zoom(scale: 1.55, fit: 0.676) == "230 %")
        #expect(!PageIndicator.isZoomed(scale: 0.68, fit: 0.676) && PageIndicator.isZoomed(scale: 1.5, fit: 0.676))
    }

    @Test func theCounterRestoresTheBrightnessItFound() {
        var level: CGFloat = 0.3
        var awake = false
        let guardian = BrightnessGuard(read: { level }, write: { level = $0 }, keepAwake: { awake = $0 })
        guardian.raise()
        #expect(level == 1 && awake)
        // A second raise (back to the foreground) keeps the ORIGINAL level.
        guardian.raise()
        guardian.restore()
        #expect(level == 0.3 && !awake)
        // Leaving the foreground restores; returning raises again.
        guardian.raise()
        guardian.restore()
        guardian.restore()
        #expect(level == 0.3 && !guardian.isRaised)
    }

    @Test func aSharedFileIsNamedAfterTheTitle() {
        #expect(SharedDocument.name("Brief Gemeente Westerlaan 30 okt", ext: "pdf") == "Brief Gemeente Westerlaan 30 okt.pdf")
        #expect(SharedDocument.name("a/b: c.PDF", ext: "pdf") == "a-b- c.PDF")
        #expect(SharedDocument.name("  ", ext: "pdf") == "document.pdf")
    }

    // MARK: - The model

    @Test func theFilterAppliesToTheSearchAndCancelClearsIt() async throws {
        let server = StubServer()
        server.on { req in
            if req.url?.path() == DossierStore.syncPath {
                return .status(200, headers: ["Content-Type": "application/json"],
                               body: DossierStoreTests.delta(cursor: 3, upserts: [
                                   DossierStoreTests.doc(DossierStoreTests.a, title: "Brief bijstand", bytes: DossierStoreTests.bytesA)]))
            }
            if req.url?.path().hasSuffix("/file") == true { return DossierStoreTests.pdf(DossierStoreTests.bytesA) }
            return .status(200, headers: ["Content-Type": "application/json"], body: Data("[]".utf8))
        }
        let model = DossierModel(store: DossierStore(dir: DossierStoreTests.tempDir()), client: server.client())
        await model.refresh(isLocked: false, isActive: true)
        model.searchActive = true
        model.query = "bijstand"
        #expect(model.results.count == 1)
        model.kind = "loonstrook"
        #expect(model.results.isEmpty)
        model.kind = "brief"
        #expect(model.results.count == 1)
        model.cancelSearch()
        #expect(model.query.isEmpty && !model.searchActive && model.server == .idle)
    }

    @Test func aServerSearchThatHangsTimesOut() async throws {
        let server = StubServer()
        server.on { _ in
            Thread.sleep(forTimeInterval: 2)
            return .status(200, headers: ["Content-Type": "application/json"], body: Data(#"{"hits":[],"nextCursor":null}"#.utf8))
        }
        let model = DossierModel(store: DossierStore(dir: DossierStoreTests.tempDir()), client: server.client(),
                                 serverTimeout: .milliseconds(200))
        model.query = "huur"
        await model.searchServer()
        #expect(model.server == .timedOut)
    }

    /// Each settled document is reported, so a first sync's list fills as it runs.
    /// A readout wraps BEFORE a dot, never after it: no line ends on "·"
    /// (the rule the detail labels follow, 4029dfe).
    @Test func aReadoutWrapsBeforeTheDot() {
        let line = DossierLine.joined(["wacht op jou", "te laat", "30 okt"])
        #expect(line == "WACHT\u{00A0}OP\u{00A0}JOU ·\u{00A0}TE\u{00A0}LAAT ·\u{00A0}30\u{00A0}OKT")
        // The only breakable spaces are the ones in front of a dot.
        let breakable = line.enumerated().filter { $0.element == " " }.map(\.offset)
        let chars = Array(line)
        #expect(breakable.allSatisfy { chars[$0 + 1] == "·" })
        #expect(DossierLine.joined(["brief"]) == "BRIEF")
    }

    /// The viewer's title drops the day it ends on (the final frames), and
    /// only that.
    @Test func theViewerTitleDropsTheDayItEndsOn() {
        let at = parseISODate("2026-10-30T09:00:00Z")!
        #expect(DossierLine.viewerTitle("Brief Gemeente Westerlaan 30 okt", receivedAt: at) == "Brief Gemeente Westerlaan")
        #expect(DossierLine.viewerTitle("Loonstrook 2026-10", receivedAt: at) == "Loonstrook 2026-10")
        // A day that is not the received day, or a title that IS the day, stays.
        #expect(DossierLine.viewerTitle("Sommatie 14 okt", receivedAt: at) == "Sommatie 14 okt")
        #expect(DossierLine.viewerTitle("30 okt", receivedAt: at) == "30 okt")
    }

    /// A first sync keeps a place for every listed document, in date order:
    /// files arrive in the server's order, so a skeleton can stand between
    /// two rows that have come in.
    @Test func theFirstSyncListKeepsAPlaceForEveryDocument() {
        let held = [Self.doc("a", "Brief", receivedAt: "2026-10-30T09:00:00Z"),
                    Self.doc("e", "Beschikking", receivedAt: "2026-08-14T09:00:00Z")]
        let waiting = [DossierStore.Arriving(id: "c", receivedAt: parseISODate("2026-10-28T09:00:00Z")!),
                       DossierStore.Arriving(id: "a", receivedAt: parseISODate("2026-10-30T09:00:00Z")!),
                       DossierStore.Arriving(id: "z", receivedAt: parseISODate("2025-03-01T09:00:00Z")!)]
        let rows = DossierProgressCopy.rows(held: held, waiting: waiting)
        #expect(rows.map(\.id) == ["a", "arriving:c", "e", "arriving:z"], "a held document is never also arriving")
        #expect(DossierProgressCopy.rows(held: [], waiting: []).isEmpty)
    }

    /// A later sync keeps a place for each announced document still on its
    /// way ("bijwerken… · 2 van 3 nieuw": the third is a skeleton between
    /// the two that came in), but only unfiltered and only while it runs.
    @Test func aLaterSyncKeepsAPlaceForTheDocumentStillOnItsWay() {
        let shown = [Self.doc("b", "Brief", receivedAt: "2026-10-30T09:00:00Z"),
                     Self.doc("l", "Loonstrook", receivedAt: "2026-10-28T09:00:00Z"),
                     Self.doc("s", "Sommatie", receivedAt: "2026-10-14T09:00:00Z")]
        let waiting = [DossierStore.Arriving(id: "f", receivedAt: parseISODate("2026-10-29T09:00:00Z")!)]
        let rows = DossierProgressCopy.listRows(shown: shown, waiting: waiting, syncing: true, filtered: false)
        #expect(rows.map(\.id) == ["b", "arriving:f", "l", "s"])
        #expect(DossierProgressCopy.listRows(shown: shown, waiting: waiting, syncing: false, filtered: false)
            .map(\.id) == ["b", "l", "s"], "a finished sync draws no skeleton")
        #expect(DossierProgressCopy.listRows(shown: shown, waiting: waiting, syncing: true, filtered: true)
            .map(\.id) == ["b", "l", "s"], "an arriving document's soort is unknown")
    }

    /// The Documenten label counts the whole dossier while a sync that knows
    /// it runs ("documenten · 12" with the 12th on its way), else what is held.
    @Test func theDocumentCountIsTheWholeWhileASyncKnowsIt() {
        #expect(DossierProgressCopy.documentCount(held: 11, syncing: true, total: 12) == 12)
        #expect(DossierProgressCopy.documentCount(held: 11, syncing: false, total: 12) == 11)
        #expect(DossierProgressCopy.documentCount(held: 11, syncing: true, total: nil) == 11)
        #expect(DossierProgressCopy.documentCount(held: 13, syncing: true, total: 12) == 13)
    }

    /// Sections sit 32 apart, 24 at a compact height (the iPhone SE).
    @Test func theSectionGapFollowsTheScreenHeight() {
        #expect(DossierSpacing.sectionGap(screenHeight: 874) == 32)
        #expect(DossierSpacing.sectionGap(screenHeight: 667) == 24)
        #expect(DossierSpacing.sectionGap(screenHeight: 600) == 24)
        #expect(DossierCopy.tasksShown(compact: false) == 2)
        #expect(DossierCopy.tasksShown(compact: true) == 1)
        #expect(DossierSpacing.underStatusBar(safeTop: 62) == 0)
        #expect(DossierSpacing.underStatusBar(safeTop: 20) == 8)
    }

    /// Zoomed in at the counter, the page starts at the text's leading
    /// margin, within the page.
    @Test func aZoomedPageStartsAtTheTextsMargin() {
        #expect(PageZoom.leadingX(textMinX: 56, pageWidth: 595, visibleWidth: 260, margin: 10) == 46)
        #expect(PageZoom.leadingX(textMinX: 4, pageWidth: 595, visibleWidth: 260, margin: 10) == 0)
        #expect(PageZoom.leadingX(textMinX: 500, pageWidth: 595, visibleWidth: 260, margin: 10) == 335)
        #expect(PageZoom.leadingX(textMinX: nil, pageWidth: 595, visibleWidth: 700, margin: 10) == 0)
    }

    @Test func theStoreReportsEveryDocumentItTakesIn() async throws {
        let server = StubServer()
        server.on { req in
            if req.url?.path() == DossierStore.syncPath {
                return .status(200, headers: ["Content-Type": "application/json"],
                               body: DossierStoreTests.delta(cursor: 3, upserts: [
                                   DossierStoreTests.doc(DossierStoreTests.a, bytes: DossierStoreTests.bytesA),
                                   DossierStoreTests.doc(DossierStoreTests.b, bytes: DossierStoreTests.bytesB)]))
            }
            if req.url?.path().contains(DossierStoreTests.a) == true { return DossierStoreTests.pdf(DossierStoreTests.bytesA) }
            if req.url?.path().contains(DossierStoreTests.b) == true { return DossierStoreTests.pdf(DossierStoreTests.bytesB) }
            return .status(200, headers: ["Content-Type": "application/json"], body: Data("[]".utf8))
        }
        let seen = Mutex<[DossierStore.Progress]>([])
        let store = DossierStore(dir: DossierStoreTests.tempDir())
        try await store.sync(client: server.client()) { p in seen.withLock { $0.append(p) } }
        let reports = seen.withLock { $0 }
        #expect(reports.map(\.due) == [2, 2, 2])
        #expect(reports.map(\.done) == [0, 1, 2])
        // Each listed document waits until its file is settled.
        #expect(reports.map { $0.waiting.map(\.id) } == [[DossierStoreTests.a, DossierStoreTests.b], [DossierStoreTests.b], []])
    }

    /// "Haal nu op" keeps the document (it opens offline next time) and
    /// refuses bytes that do not match the sha.
    @Test func takingOneDocumentInKeepsItAndChecksItsSha() async throws {
        let server = StubServer()
        server.on { req in
            if req.url?.path().contains(DossierStoreTests.a) == true { return DossierStoreTests.pdf(DossierStoreTests.bytesA) }
            return DossierStoreTests.pdf(Data("kapot".utf8))
        }
        let decoder = APIClient.jsonDecoder
        let a = try decoder.decode(DossierDoc.self, from: Data(DossierStoreTests.doc(DossierStoreTests.a, bytes: DossierStoreTests.bytesA).utf8))
        let b = try decoder.decode(DossierDoc.self, from: Data(DossierStoreTests.doc(DossierStoreTests.b, bytes: DossierStoreTests.bytesB).utf8))
        let dir = DossierStoreTests.tempDir()
        let store = DossierStore(dir: dir)
        #expect(try await store.take(a, client: server.client()))
        #expect(try await !store.take(b, client: server.client()))
        // A fresh store on the same folder (a later launch, offline) has it.
        let later = DossierStore(dir: dir)
        #expect(await later.fileURL(DossierStoreTests.a) != nil)
        #expect(await later.fileURL(DossierStoreTests.b) == nil)
    }
}
