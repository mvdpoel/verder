import Testing
import Foundation
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
}
