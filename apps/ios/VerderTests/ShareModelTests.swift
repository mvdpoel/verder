import Testing
import Foundation
import PDFKit
import UIKit
@testable import Verder

/// The share extension's screen as state (plan 3 Task 22).
@MainActor
struct ShareModelTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func files(_ group: URL) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: IncomingDrop.directory(groupDir: group).path())) ?? []).sorted()
    }

    @Test func commitWritesOneDropPerFileAndReportsDelivered() async throws {
        let group = try scratchDir()
        let t = t0
        let model = ShareModel(groupDir: group, now: { t }) { ids, _ in ids }
        model.loaded([.file(data: Data("%PDF a".utf8), fileName: "Brief.pdf", mime: "application/pdf"),
                      .file(data: Data("PK".utf8), fileName: "Afschrift.xlsx", mime: "application/zip")])
        #expect(model.phase == .ready)
        #expect(model.title == "2 bestanden")

        await model.commit()

        #expect(model.phase == .done(delivered: true))
        #expect(model.message == ShareModel.Copy.delivered)
        #expect(files(group).filter { $0.hasSuffix(".json") }.count == 2)
        #expect(files(group).filter { $0.hasSuffix(".bin") }.count == 2)
    }

    /// The extension never waits out a slow upload: the drop is safe on disk
    /// and the app's queue sends it.
    @Test func aSlowSendFinishesAsQueuedWithinTheBound() async throws {
        let group = try scratchDir()
        let model = ShareModel(groupDir: group, sendBound: .milliseconds(50)) { ids, _ in
            try? await Task.sleep(for: .seconds(30))
            return ids
        }
        model.loaded([.file(data: Data("%PDF".utf8), fileName: "Brief.pdf", mime: "application/pdf")])
        let started = ContinuousClock.now
        await model.commit()

        #expect(ContinuousClock.now - started < .seconds(10))
        #expect(model.phase == .done(delivered: false))
        #expect(model.message == ShareModel.Copy.queued)
        #expect(files(group).filter { $0.hasSuffix(".json") }.count == 1)
    }

    @Test func nothingUsableIsRefused() {
        let model = ShareModel(groupDir: nil) { ids, _ in ids }
        model.loaded([])
        #expect(model.phase == .refused(ShareModel.Copy.nothing))
        #expect(!model.canSend)
    }

    @Test func tooLargeIsRefusedBeforeAnythingIsWritten() throws {
        let group = try scratchDir()
        let model = ShareModel(groupDir: group) { ids, _ in ids }
        model.loaded([.file(data: Data(count: ShareModel.maxFileBytes + 1), fileName: "groot.pdf", mime: "application/pdf")])
        #expect(model.phase == .refused(ShareModel.Copy.tooLarge))
        #expect(files(group).isEmpty)
    }

    @Test func oneFileIsTitledByItsName() {
        let model = ShareModel(groupDir: nil) { ids, _ in ids }
        model.loaded([.file(data: Data("%PDF".utf8), fileName: "Beschikking.pdf", mime: "application/pdf")])
        #expect(model.title == "Beschikking.pdf")
        #expect(model.detail.hasPrefix("PDF · "))
    }

    // MARK: - Nothing leaves the share in silence

    let pdf = SharedInput.file(data: Data("%PDF".utf8), fileName: "Brief.pdf", mime: "application/pdf")

    /// An item the extension could not load is reported, before Versturen and
    /// after "Staat in je dossier.", and the screen does not close itself.
    @Test func anUnreadableItemIsReportedAndStaysOnScreen() async throws {
        let group = try scratchDir()
        let model = ShareModel(groupDir: group) { ids, _ in ids }
        model.loaded([pdf, .unreadable, pdf])

        #expect(model.phase == .ready)
        #expect(model.prepared.count == 2)
        #expect(model.warning == "1 van 3 kon niet worden meegenomen.")
        #expect(!model.closesByItself)

        await model.commit()
        #expect(model.phase == .done(delivered: true))
        #expect(model.warning == "1 van 3 kon niet worden meegenomen.")
        #expect(files(group).filter { $0.hasSuffix(".json") }.count == 2)
    }

    @Test func aWholeShareClosesByItselfWithNoWarning() {
        let model = ShareModel(groupDir: nil) { ids, _ in ids }
        model.loaded([pdf])
        #expect(model.warning == nil)
        #expect(model.closesByItself)
    }

    /// Only unreadable items: refused as unreadable, not as an empty share.
    @Test func onlyUnreadableItemsAreRefusedAsUnreadable() {
        let model = ShareModel(groupDir: nil) { ids, _ in ids }
        model.loaded([.unreadable, .unreadable])
        #expect(model.phase == .refused(ShareModel.Copy.unreadable))
        #expect(!model.canSend)
    }

    /// More than `maxItems` is refused with its count, never cut to the first
    /// ten; the view controller asks before loading anything.
    @Test func moreThanTheLimitIsRefusedNotCut() throws {
        let group = try scratchDir()
        let model = ShareModel(groupDir: group) { ids, _ in ids }
        #expect(!model.handedOver(count: 12))
        #expect(model.phase == .refused("Dat zijn er 12. verder neemt er maximaal 10 tegelijk mee; deel ze in delen."))

        let loaded = ShareModel(groupDir: group) { ids, _ in ids }
        loaded.loaded(Array(repeating: pdf, count: ShareModel.maxItems + 1))
        #expect(loaded.phase == .refused(ShareModel.Copy.tooMany(11)))
        #expect(loaded.prepared.isEmpty)
        #expect(files(group).isEmpty)

        let atLimit = ShareModel(groupDir: group) { ids, _ in ids }
        #expect(atLimit.handedOver(count: ShareModel.maxItems))
        atLimit.loaded(Array(repeating: pdf, count: ShareModel.maxItems))
        #expect(atLimit.phase == .ready)
        #expect(atLimit.prepared.count == ShareModel.maxItems)
    }

    /// An image the PDF cannot encode (no bitmap) is a page that did not go:
    /// the detail line counts pages IN the PDF, and the warning says one is missing.
    @Test func anImageThePDFCannotEncodeIsCountedOut() throws {
        let model = ShareModel(groupDir: nil) { ids, _ in ids }
        model.loaded([.image(Fixture.letterPage), .image(UIImage()), .image(Fixture.letterPage)])

        #expect(model.photoPages == 2)
        #expect(model.detail.hasPrefix("2 foto's als één PDF · "))
        #expect(model.warning == "1 van 3 kon niet worden meegenomen.")
        let pdfData = try #require(model.prepared.first?.data)
        #expect(PDFDocument(data: pdfData)?.pageCount == 2)
    }

    /// When no photo encodes, there is no zero-page PDF passing for a document
    /// and no "3 foto's" line over nothing.
    @Test func noEncodablePhotoLeavesOnlyTheFiles() {
        let model = ShareModel(groupDir: nil) { ids, _ in ids }
        model.loaded([.image(UIImage()), .image(UIImage()), pdf])

        #expect(model.prepared.map(\.fileName) == ["Brief.pdf"])
        #expect(model.photoPages == 0)
        #expect(!model.detail.contains("foto"))
        #expect(model.warning == "2 van 3 konden niet worden meegenomen.")
    }
}
