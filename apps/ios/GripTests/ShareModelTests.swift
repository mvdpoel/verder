import Testing
import Foundation
import PDFKit
import UIKit
@testable import Grip

/// The share extension's screen as state (plan 3 Task 22; "share · final").
@MainActor
struct ShareModelTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func files(_ group: URL) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: IncomingDrop.directory(groupDir: group).path())) ?? []).sorted()
    }

    func model(_ group: URL? = nil, signedOut: Bool = false, bound: Duration = .seconds(20),
               sender: @escaping ShareModel.Sender = { _, _ in .sent },
               writeDrop: @escaping ShareModel.DropWriter = ShareModel.writeDrop) -> ShareModel {
        let t = t0
        return ShareModel(groupDir: group, signedOut: signedOut, sendBound: bound, now: { t },
                          writeDrop: writeDrop, sender: sender)
    }

    let pdf = SharedInput.file(data: Data("%PDF".utf8), fileName: "Brief.pdf", mime: "application/pdf")

    /// A real PDF of `pages` pages, so PDFKit can count them.
    func realPDF(_ name: String, pages: Int) -> SharedInput {
        let data = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 595, height: 842)).pdfData { ctx in
            for _ in 0..<pages { ctx.beginPage() }
        }
        return .file(data: data, fileName: name, mime: "application/pdf")
    }

    func waitWhile(_ model: ShareModel, _ phase: ShareModel.Phase) async {
        for _ in 0..<500 where model.phase == phase { try? await Task.sleep(for: .milliseconds(10)) }
    }

    // MARK: - Versturen

    @Test func commitWritesOneDropPerFileAndReportsDelivered() async throws {
        let group = try scratchDir()
        let m = model(group)
        m.loaded([.file(data: Data("%PDF a".utf8), fileName: "Brief.pdf", mime: "application/pdf"),
                  .file(data: Data("PK".utf8), fileName: "Afschrift.xlsx", mime: "application/zip")])
        #expect(m.phase == .ready)
        #expect(m.title == "2 bestanden")

        await m.commit()

        #expect(m.phase == .done(.delivered))
        #expect(m.closing?.title == "Staan in de wachtrij van verder")
        #expect(files(group).filter { $0.hasSuffix(".json") }.count == 2)
        #expect(files(group).filter { $0.hasSuffix(".bin") }.count == 2)
    }

    /// The extension never waits out a slow upload: the drop is safe on disk
    /// and the app's queue sends it.
    @Test func aSlowSendFinishesAsKeptWithinTheBound() async throws {
        let group = try scratchDir()
        let m = model(group, bound: .milliseconds(50)) { _, _ in
            try? await Task.sleep(for: .seconds(30))
            return .sent
        }
        m.loaded([pdf])
        let started = ContinuousClock.now
        await m.commit()

        #expect(ContinuousClock.now - started < .seconds(10))
        #expect(m.phase == .done(.kept(.unknown)))
        #expect(m.closing?.title == "Bewaard in verder")
        #expect(m.closing?.reason == "in wachtrij")
        #expect(files(group).filter { $0.hasSuffix(".json") }.count == 1)
    }

    /// The closing screen says WHY a file waits.
    @Test func theOutcomeNamesTheReason() {
        let a = PreparedShare(data: Data(count: 10), fileName: "a.pdf", mime: "application/pdf")
        let b = PreparedShare(data: Data(count: 20), fileName: "Afschrift.pdf", mime: "application/pdf")
        #expect(ShareModel.outcome([.sent, .sent], files: [a, b]) == .delivered)
        #expect(ShareModel.outcome([.sent, .unauthorized], files: [a, b]) == .kept(.signedOut))
        #expect(ShareModel.outcome([.offline, .tooLargeForExtension], files: [a, b]) == .kept(.offline))
        #expect(ShareModel.outcome([.sent, .tooLargeForExtension], files: [a, b])
                == .kept(.largeFile(fileName: "Afschrift.pdf", bytes: 20)))
        #expect(ShareModel.outcome([.sent, nil], files: [a, b]) == .kept(.unknown))
        #expect(ShareModel.outcome([], files: []) == .kept(.unknown))
    }

    @Test func offlineAndLargeReadoutsFollowTheFrames() async throws {
        let offline = model(try scratchDir()) { _, _ in .offline }
        offline.loaded([pdf])
        await offline.commit()
        #expect(offline.closing == .init(title: "Bewaard in verder", body: "Hij gaat mee zodra je verder opent.",
                                         reason: "offline · in wachtrij", name: "Brief.pdf", facts: [], delivered: false))

        let large = model(try scratchDir()) { _, _ in .tooLargeForExtension }
        large.loaded([.file(data: Data(count: 14_000_000), fileName: "Afschrift september.pdf", mime: "application/pdf")])
        await large.commit()
        #expect(large.closing?.reason == "groot bestand · in wachtrij")
        #expect(large.closing?.name == "Afschrift september.pdf")
        #expect(large.closing?.facts == ["14\u{00A0}MB"])
    }

    @Test func theSendersOutcomeComesFromItsError() {
        #expect(ShareSendResult(APIError.unauthorized) == .unauthorized)
        #expect(ShareSendResult(APIError.transport(APIError.transportDescription(URLError(.notConnectedToInternet))))
                == .offline)
        #expect(ShareSendResult(APIError.transport(APIError.transportDescription(URLError(.timedOut)))) == .failed)
        #expect(ShareSendResult(APIError.server(503)) == .failed)
    }

    // MARK: - Signed out

    /// No session: the sheet says so before Versturen, the button reads
    /// Bewaar, the drops are written and NO attempt is made.
    @Test func signedOutIsToldBeforeAndKeepsWithoutAnAttempt() async throws {
        let group = try scratchDir()
        let attempts = Counter()
        let m = model(group, signedOut: true) { _, _ in
            await attempts.add()
            return .sent
        }
        m.loaded([pdf])
        #expect(m.notice?.head == "Je bent niet ingelogd")
        #expect(m.trailing == .send(label: "Bewaar", enabled: true))
        #expect(m.explanation?.label == "Na het inloggen")

        await m.commit()

        #expect(m.phase == .done(.kept(.signedOut)))
        #expect(await attempts.value == 0)
        #expect(m.closing?.body == "Open verder en log in; daarna gaat het bestand vanzelf naar je dossier.")
        #expect(files(group).filter { $0.hasSuffix(".json") }.count == 1)
        #expect(!m.closesByItself())
    }

    // MARK: - Refusals

    @Test func nothingUsableIsRefused() {
        let m = model()
        m.loaded([])
        #expect(m.phase == .refused(.nothing))
        #expect(!m.canSend)
        #expect(m.leading == .close)
        #expect(m.trailing == nil)
    }

    @Test func onlyUnreadableItemsAreRefusedAsUnreadable() {
        let m = model()
        m.loaded([.unreadable, .unreadable])
        #expect(m.phase == .refused(.unreadable))
        #expect(m.failure?.title == "Niet te lezen")
    }

    /// A share of only a link gets its own answer, with the link itself.
    @Test func aLinkIsAnsweredAsALink() {
        let m = model()
        m.loaded([.link("https://www.westerlaan.example/bijstand/")])
        #expect(m.phase == .refused(.link("westerlaan.example/bijstand")))
        #expect(m.failure?.title == "Hier zit geen bestand in")
        #expect(m.leading == .close)
    }

    /// A link beside a file does not go, and the notice says so.
    @Test func aLinkBesideAFileIsNamedNotSent() {
        let m = model()
        m.loaded([pdf, .link("https://westerlaan.example")])
        #expect(m.phase == .ready)
        #expect(m.prepared.count == 1)
        #expect(m.notice?.head == "verder neemt er 1 van de 2 mee.")
        #expect(m.notice?.body == "De link gaat niet mee; verder bewaart alleen bestanden.")
    }

    // MARK: - Too large

    /// Only a file over the limit: refused with the file and its size.
    @Test func aSingleTooLargeFileIsRefusedWithItsSize() throws {
        let group = try scratchDir()
        let m = model(group)
        m.loaded([.tooLarge(fileName: "Jaaropgaaf 2025 scan.pdf", bytes: 62_000_000)])
        #expect(m.phase == .refused(.tooLarge))
        #expect(m.failure?.title == "Te groot om mee te nemen")
        #expect(m.tooLargeFiles.first?.bytes == 62_000_000)
        #expect(m.leading == .close)
        #expect(m.trailing == nil)
        #expect(files(group).isEmpty)
    }

    /// One file over 48 MB among others: it is left out BY NAME, in its
    /// place in the list, and the others go.
    @Test func aTooLargeFileIsLeftOutAndTheRestGo() async throws {
        let group = try scratchDir()
        let m = model(group)
        m.loaded([realPDF("Bevestiging.pdf", pages: 2),
                  .tooLarge(fileName: "Jaaropgaaf 2025 scan.pdf", bytes: 62_000_000),
                  realPDF("Polis.pdf", pages: 4)])

        #expect(m.phase == .ready)
        #expect(m.prepared.map(\.fileName) == ["Bevestiging.pdf", "Polis.pdf"])
        #expect(m.notice?.head == "verder neemt er 2 van de 3 mee.")
        #expect(m.notice?.body == "Jaaropgaaf 2025 scan.pdf is te groot (62\u{00A0}MB, max.\u{00A0}48\u{00A0}MB). Scan de "
                + "brief met verder, of deel later een kleinere versie.")
        #expect(m.rows.map(\.fileName) == ["Bevestiging.pdf", "Jaaropgaaf 2025 scan.pdf", "Polis.pdf"])
        #expect(m.rows.map(\.included) == [true, false, true])
        #expect(m.rows[1].detail == ["Gaat niet mee", "62\u{00A0}MB, max.\u{00A0}48\u{00A0}MB"])
        #expect(m.rows[2].detail.dropFirst().first == "4\u{00A0}pagina's")
        #expect(m.explanation?.text == "De twee die meegaan komen in je dossier onder Gedeeld.")
        #expect(!m.closesByItself())

        await m.commit()
        #expect(files(group).filter { $0.hasSuffix(".json") }.count == 2)
    }

    // MARK: - More than ten

    /// More than `maxItems`: the first ten are loaded and go, and the rest
    /// is named so it can be shared again.
    @Test func moreThanTheLimitKeepsTheFirstTen() async throws {
        let m = model()
        #expect(m.handedOver(count: 14) == ShareModel.maxItems)
        m.loaded(Array(repeating: .photo(url: Fixture.letterPageURL), count: ShareModel.maxItems))
        await m.photosCombined()

        #expect(m.phase == .ready)
        #expect(m.photoPages == 10)
        #expect(m.notice == .init(head: "Dat zijn er 14; verder neemt de eerste 10 mee.",
                                  body: "Deel foto 11–14 daarna opnieuw."))
        #expect(m.photoBadge == "foto 1–10 van 14")
        #expect(m.detail(of: 0).prefix(2) == ["PDF van 10\u{00A0}foto's", "10\u{00A0}pagina's"])
    }

    /// Handed more than ten in one go, the loaded list is cut to ten too.
    @Test func moreThanTenLoadedIsCutToTen() {
        let m = model()
        m.loaded(Array(repeating: pdf, count: 11))
        #expect(m.prepared.count == 10)
        #expect(m.notice?.body == "Deel bestand 11 daarna opnieuw.")
    }

    // MARK: - Nothing leaves the share in silence

    @Test func anUnreadableItemIsReportedAndStaysOnScreen() async throws {
        let group = try scratchDir()
        let m = model(group)
        m.loaded([pdf, .unreadable, pdf])

        #expect(m.phase == .ready)
        #expect(m.prepared.count == 2)
        #expect(m.notice == .init(head: "verder neemt er 2 van de 3 mee.", body: "1 bestand kon niet worden gelezen."))
        #expect(!m.closesByItself())

        await m.commit()
        #expect(m.phase == .done(.delivered))
        #expect(!m.closesByItself())
        #expect(files(group).filter { $0.hasSuffix(".json") }.count == 2)
    }

    /// A whole share closes itself, but never for VoiceOver, Switch Control
    /// or accessibility text sizes, where Klaar is the way out.
    @Test func aWholeShareClosesByItselfUnlessAssistiveTechIsOn() async throws {
        let m = model(try scratchDir())
        m.loaded([pdf])
        #expect(m.notice == nil)
        await m.commit()
        #expect(m.closesByItself())
        #expect(!m.closesByItself(voiceOver: true))
        #expect(!m.closesByItself(switchControl: true))
        #expect(!m.closesByItself(largeText: true))
        #expect(ShareModel.autoCloseDelay >= .seconds(3))
    }

    @Test func anImageThePDFCannotEncodeIsCountedOut() async throws {
        let m = model()
        let broken = try notAnImage()
        m.loaded([.photo(url: Fixture.letterPageURL), .photo(url: broken), .photo(url: Fixture.letterPageURL)])
        await m.photosCombined()

        #expect(m.photoPages == 2)
        #expect(m.detail(of: 0).prefix(2) == ["PDF van 2\u{00A0}foto's", "2\u{00A0}pagina's"])
        #expect(m.notice?.head == "verder neemt er 2 van de 3 mee.")
        let pdfData = try #require(m.prepared.first?.data)
        #expect(PDFDocument(data: pdfData)?.pageCount == 2)
    }

    @Test func noEncodablePhotoLeavesOnlyTheFiles() async throws {
        let m = model()
        let broken = try notAnImage()
        m.loaded([.photo(url: broken), .photo(url: broken), pdf])
        await m.photosCombined()

        #expect(m.prepared.map(\.fileName) == ["Brief.pdf"])
        #expect(m.photoPages == 0)
        #expect(!m.detail.joined().contains("foto"))
        #expect(m.notice?.body == "2 bestanden konden niet worden gelezen.")
    }

    // MARK: - What the screen says

    @Test func oneFileIsTitledByItsNameWithItsPages() {
        let m = model()
        m.loaded([realPDF("Beschikking.pdf", pages: 2)])
        #expect(m.title == "Beschikking.pdf")
        #expect(m.detail.prefix(2) == ["PDF", "2\u{00A0}pagina's"])
        #expect(m.explanation?.text == "Komt in je dossier onder Gedeeld. Daarna zet verder een suggestie voor naam en "
                + "soort klaar in Voor jou.")
        #expect(m.rows.isEmpty)
    }

    @Test func onePageIsSingular() {
        let m = model()
        m.loaded([realPDF("Brief.pdf", pages: 1)])
        #expect(m.detail.dropFirst().first == "1\u{00A0}pagina")
    }

    @Test func aFileThatIsNotAPDFHasNoPageCount() {
        let m = model()
        m.loaded([.file(data: Data(count: 14_000), fileName: "Afschrift.xlsx", mime: "application/zip")])
        #expect(m.detail == ["XLSX", "14\u{00A0}kB"])
        m.loaded([.file(data: Data(count: 14_000), fileName: "Gedeeld bestand", mime: "application/octet-stream")])
        #expect(m.detail.first == "Bestand")
    }

    @Test func severalFilesHaveRowsAndATotal() {
        let m = model()
        m.loaded([realPDF("A.pdf", pages: 2), realPDF("B.pdf", pages: 4), realPDF("C.pdf", pages: 1)])
        #expect(m.title == "3 bestanden")
        #expect(m.detail.first == "PDF")
        #expect(m.detail.last?.hasPrefix("samen ") == true)
        #expect(m.rows.count == 3)
        #expect(m.rows.allSatisfy { $0.included })
        #expect(m.explanation?.text == "Komen alle drie in je dossier onder Gedeeld, elk als eigen document. Daarna "
                + "staan de suggesties in Voor jou.")
    }

    @Test func photosNameTheirOrderAndTheTemporaryName() async {
        let m = model()
        m.loaded(Array(repeating: .photo(url: Fixture.letterPageURL), count: 3))
        await m.photosCombined()
        #expect(m.title == "Gedeeld 15 jan 09.00.pdf")
        #expect(m.photoBadge == "3\u{00A0}foto's")
        #expect(m.orderNote == "Pagina's in de volgorde waarin je ze koos.")
        #expect(m.explanation?.text.contains("eerst met deze tijdelijke naam") == true)
    }

    @Test func aDayAndItsMonthNeverPart() {
        #expect(ShareModel.displayName("Bevestiging aanmelding Noordkust 30 okt.pdf")
                == "Bevestiging aanmelding Noordkust 30\u{00A0}okt.pdf")
        #expect(ShareModel.displayName("Gedeeld 1 nov 14.02.pdf") == "Gedeeld 1\u{00A0}nov 14.02.pdf")
        #expect(ShareModel.displayName("Polis 2026 oktober.pdf") == "Polis 2026 oktober.pdf")
    }

    @Test func linksAreShownWithoutSchemeOrWww() {
        #expect(ShareModel.displayLink("https://www.westerlaan.example/bijstand/") == "westerlaan.example/bijstand")
        #expect(ShareModel.displayLink("http://example.com") == "example.com")
    }

    @Test func photosTitleIsDutchOnTheAmsterdamClock() {
        // 2026-11-01 13:02 UTC is 14:02 in Amsterdam (CET).
        #expect(SharePreparation.photosTitle(capturedAt: Date(timeIntervalSince1970: 1_793_538_120))
                == "Gedeeld 1 nov 14.02.pdf")
        // 2026-07-05 08:30 UTC is 10:30 in Amsterdam (CEST).
        #expect(SharePreparation.photosTitle(capturedAt: Date(timeIntervalSince1970: 1_783_240_200))
                == "Gedeeld 5 jul 10.30.pdf")
    }

    // MARK: - Loading

    /// A source that never answers ends in a cause and "Opnieuw proberen",
    /// which loads again; a late answer from the first attempt is ignored.
    @Test func aLoadThatNeverAnswersTimesOutAndRetries() async {
        let m = ShareModel(groupDir: nil, sourceApp: "Mail") { _, _ in .sent }
        let attempt = Counter()
        let input = pdf
        m.load(timeout: .milliseconds(50)) {
            let n = await attempt.add()
            if n == 1 { try? await Task.sleep(for: .milliseconds(300)) }
            return [input]
        }
        await waitWhile(m, .loading)
        #expect(m.phase == .loadFailed)
        #expect(m.failure?.title == "Bestand laden lukt niet")
        #expect(m.failure?.body.hasPrefix("Mail gaf het bestand niet binnen 10 seconden door.") == true)
        #expect(m.failure?.retry == true)
        #expect(m.leading == .cancel(enabled: true))

        m.retryLoad(timeout: .seconds(5))
        await waitWhile(m, .loading)
        #expect(m.phase == .ready)
        #expect(await attempt.value == 2)
    }

    @Test func anUnknownSourceAppGetsANeutralLine() {
        #expect(ShareModel.Copy.loadFailedBody(app: nil).hasPrefix("De app gaf het bestand"))
    }

    @Test func loadingShowsTheShapeAndADisabledSend() {
        let m = model()
        m.handedOver(count: 1)
        #expect(m.phase == .loading)
        #expect(m.trailing == .send(label: "Versturen", enabled: false))
        #expect(m.explanation?.label == "Waar het heen gaat")
    }

    // MARK: - Annuleren only while it is true

    @Test func cancelIsOfferedBeforeVersturenAndAfterARefusal() {
        let m = model()
        #expect(m.canCancel)                  // loading
        m.loaded([pdf])
        #expect(m.canCancel)                  // ready
        let refused = model()
        refused.loaded([])
        #expect(refused.canCancel)
    }

    /// From `.saving` on, the drops are written and the app will send them:
    /// Annuleren is shown dimmed, the capsule shows the upload, and the
    /// closing screen offers Klaar alone.
    @Test func cancelIsDimmedOnceTheDropsAreWritten() async throws {
        let group = try scratchDir()
        let m = model(group, bound: .seconds(5)) { _, _ in
            try? await Task.sleep(for: .milliseconds(300))
            return .sent
        }
        m.loaded([pdf, .unreadable])
        let commit = Task { await m.commit() }
        while m.phase != .saving { await Task.yield() }
        #expect(!m.canCancel)
        #expect(m.leading == .cancel(enabled: false))
        #expect(m.trailing == .progress)
        while m.progress?.current != 1 { await Task.yield() }
        #expect(m.progress?.label == "Versturen")
        await commit.value

        #expect(m.phase == .done(.delivered))
        #expect(!m.closesByItself())            // partial: the screen stays
        #expect(m.leading == nil)
        #expect(m.trailing == .done)
        #expect(m.progress == nil)
    }

    @Test func progressCountsFiles() {
        let p = ShareModel.Progress(current: 2, total: 3, finished: 1)
        #expect(p.label == "Versturen · bestand 2 van 3")
        #expect(abs(p.fraction - 0.5) < 0.001)
    }

    @Test func progressWhileCombiningNamesThePhoto() {
        let p = ShareModel.Progress(current: 2, total: 3, finished: 1, stage: .combining)
        #expect(p.label == "PDF maken · foto 2 van 3")
    }

    // MARK: - The photo PDF, a page at a time

    /// A gate the combine loop waits at before photo `index`; `open` lets it on.
    @MainActor final class Gate {
        var held: Int
        init(holding index: Int) { held = index }
        func wait(_ index: Int) async {
            while index >= held { try? await Task.sleep(for: .milliseconds(5)) }
        }
    }

    func gatedModel(_ group: URL? = nil, gate: Gate,
                    sender: @escaping ShareModel.Sender = { _, _ in .sent }) -> ShareModel {
        let t = t0
        return ShareModel(groupDir: group, sendBound: .seconds(5), now: { t }, pace: { await gate.wait($0) },
                          sender: sender)
    }

    /// The screen is up while the photos are combined, and states only what
    /// is known: how many photos, no pages and no size until the PDF exists.
    @Test func photosAreCombinedAfterTheScreenIsUp() async {
        let gate = Gate(holding: 1)
        let m = gatedModel(gate: gate)
        m.loaded(Array(repeating: .photo(url: Fixture.letterPageURL), count: 3))
        #expect(m.phase == .ready)
        #expect(m.title == "Gedeeld 15 jan 09.00.pdf")
        #expect(m.photoBadge == "3\u{00A0}foto's")
        while m.combining?.photo != 2 { await Task.yield() }
        #expect(m.detail == ["PDF van 3\u{00A0}foto's"])
        #expect(m.progress == nil)            // nothing on screen before Versturen

        gate.held = .max
        await m.photosCombined()
        #expect(m.combining == nil)
        #expect(m.photoPages == 3)
        #expect(m.detail.prefix(2) == ["PDF van 3\u{00A0}foto's", "3\u{00A0}pagina's"])
        #expect(m.detail.count == 3)          // and its size
    }

    /// Versturen while the PDF is still being made: the caption says which
    /// photo it is on, then Versturen, and the drop written is the whole PDF.
    @Test func versturenDuringCombiningShowsThePhotoThenSends() async throws {
        let group = try scratchDir()
        let gate = Gate(holding: 1)
        let m = gatedModel(group, gate: gate) { _, _ in
            try? await Task.sleep(for: .milliseconds(200))
            return .sent
        }
        m.loaded(Array(repeating: .photo(url: Fixture.letterPageURL), count: 3))
        let commit = Task { await m.commit() }
        while m.progress?.stage != .combining || m.combining?.photo != 2 { await Task.yield() }
        #expect(m.phase == .saving)
        #expect(m.progress?.label == "PDF maken · foto 2 van 3")
        #expect(m.leading == .cancel(enabled: false))
        #expect(files(group).isEmpty)         // nothing written before the PDF exists

        gate.held = .max
        while m.progress?.stage != .sending { await Task.yield() }
        #expect(m.progress?.label == "Versturen")
        await commit.value

        #expect(m.phase == .done(.delivered))
        let bin = try #require(files(group).first { $0.hasSuffix(".bin") })
        let data = try Data(contentsOf: IncomingDrop.directory(groupDir: group).appending(path: bin))
        #expect(PDFDocument(data: data)?.pageCount == 3)
    }

    /// Versturen on photos none of which could be made a page ends where
    /// the screen would have: nothing to send, said so.
    @Test func versturenOnPhotosThatAllFailEndsUnreadable() async throws {
        let group = try scratchDir()
        let broken = try notAnImage()
        let gate = Gate(holding: 0)
        let m = gatedModel(group, gate: gate)
        m.loaded([.photo(url: broken), .photo(url: broken)])
        let commit = Task { await m.commit() }
        while m.phase != .saving { await Task.yield() }
        gate.held = .max
        await commit.value
        #expect(m.phase == .refused(.unreadable))
        #expect(m.progress == nil)
        #expect(files(group).isEmpty)
    }

    // MARK: - A failed save

    /// A save that fails part-way takes back what it had written, says why,
    /// and "Opnieuw proberen" runs Versturen again.
    @Test func aSaveFailureTakesBackWhatWasWrittenAndRetries() async throws {
        let group = try scratchDir()
        let failing = ShareFlag(true)
        let m = model(group, writeDrop: { file, date, dir in
            if failing.value, file.fileName == "Tweede.pdf" { throw CocoaError(.fileWriteOutOfSpace) }
            return try ShareModel.writeDrop(file, capturedAt: date, to: dir)
        })
        m.loaded([pdf, .file(data: Data("%PDF".utf8), fileName: "Tweede.pdf", mime: "application/pdf")])

        await m.commit()

        #expect(m.phase == .saveFailed(.outOfSpace))
        #expect(m.failure?.title == "Opslaan lukte niet")
        #expect(m.failure?.body == ShareModel.Copy.outOfSpace)
        #expect(files(group).isEmpty)
        #expect(m.canCancel)

        failing.value = false
        await m.commit()
        #expect(m.phase == .done(.delivered))
        #expect(files(group).filter { $0.hasSuffix(".json") }.count == 2)
    }

    @Test func outOfSpaceIsRecognisedUnderneathAWrappingError() {
        let posix = NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC))
        let wrapped = NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnknownError,
                              userInfo: [NSUnderlyingErrorKey: posix])
        #expect(ShareModel.saveFailure(wrapped) == .outOfSpace)
        #expect(ShareModel.saveFailure(CocoaError(.fileWriteNoPermission)) == .other)
    }

    /// A staged file that vanished before Versturen is a plain save failure.
    @Test func aMissingStagedFileIsAPlainSaveFailure() async throws {
        let group = try scratchDir()
        let missing = try scratchDir().appending(path: "gone.pdf")
        let m = model(group)
        m.loaded([pdf, .staged(url: missing, fileName: "gone.pdf", mime: "application/pdf", bytes: 10)])
        await m.commit()
        #expect(m.phase == .saveFailed(.other))
        #expect(files(group).isEmpty)
    }

    @Test func noGroupIsRefused() async {
        let m = model(nil)
        m.loaded([pdf])
        await m.commit()
        #expect(m.phase == .refused(.noGroup))
    }

    // MARK: - Large files

    /// A staged file is written into its drop from disk and reported by its
    /// measured size.
    @Test func aStagedFileIsSharedFromDisk() async throws {
        let group = try scratchDir()
        let source = try scratchDir().appending(path: "Brief.pdf")
        let bytes = Data("%PDF-1.4 staged".utf8)
        try bytes.write(to: source)
        let m = model(group)
        m.loaded([.staged(url: source, fileName: "Brief.pdf", mime: "application/pdf", bytes: bytes.count)])
        #expect(m.phase == .ready)
        #expect(m.prepared.first?.data == nil)
        #expect(m.prepared.first?.byteCount == bytes.count)

        await m.commit()

        #expect(m.phase == .done(.delivered))
        let bin = try #require(files(group).first { $0.hasSuffix(".bin") })
        #expect(try Data(contentsOf: IncomingDrop.directory(groupDir: group).appending(path: bin)) == bytes)
    }

    /// A prepared file that grew past the limit is left out like a measured one.
    @Test func aPreparedFileOverTheLimitIsLeftOut() {
        let m = model()
        m.loaded([.file(data: Data(count: ShareModel.maxFileBytes + 1), fileName: "groot.pdf", mime: "application/pdf")])
        #expect(m.phase == .refused(.tooLarge))
    }
}

private actor Counter {
    private(set) var value = 0
    @discardableResult func add() -> Int { value += 1; return value }
}

private final class ShareFlag: @unchecked Sendable {
    var value: Bool
    init(_ value: Bool) { self.value = value }
}
