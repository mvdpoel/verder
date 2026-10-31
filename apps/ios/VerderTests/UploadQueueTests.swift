import Testing
import Foundation
@testable import Verder

/// A fresh queue directory per test, so the tests run in parallel.
func scratchDir() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appending(path: "uploadqueue-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

struct UploadQueueTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    let pdf = Data("%PDF-1.4 test".utf8)

    /// Review focus 3: app killed, phone rebooted. The queue is the files on
    /// disk, not the actor in memory.
    @Test("queue reloads persisted items") func queueReloadsPersistedItems() async throws {
        let dir = try scratchDir()
        let item = try await UploadQueue(dir: dir).enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan")

        let reloaded = await UploadQueue(dir: dir).items()
        #expect(reloaded.count == 1)
        let again = try #require(reloaded.first)
        #expect(again.id == item.id)
        #expect(again.fileName == "Scan 2027-01-15 09.00.pdf")
        #expect(again.capturedAt == t0)
        #expect(again.source == "phone-scan")
        #expect(again.state == .pending)
        #expect(again.attempts == 0)
        #expect(try Data(contentsOf: dir.appending(path: "\(item.id.uuidString).pdf")) == pdf)
    }

    @Test func enqueueWritesThePdfAndTheIndex() async throws {
        let dir = try scratchDir()
        let item = try await UploadQueue(dir: dir).enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan")
        #expect(FileManager.default.fileExists(atPath: dir.appending(path: "queue.json").path()))
        #expect(UploadQueue(dir: dir).pdfURL(item.id).lastPathComponent == "\(item.id.uuidString).pdf")
    }

    /// Review focus 2: the session expired while items are queued. A 401 is
    /// not the item's fault: it stays pending, costs no attempt, and the app
    /// asks for sign-in once.
    @Test("401 keeps item pending and raises signInRequired") func unauthorizedKeepsPending() async throws {
        let dir = try scratchDir()
        let queue = UploadQueue(dir: dir)
        let item = try await queue.enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan")
        _ = await queue.claimDue(now: t0)
        await queue.markFailure(item.id, error: .unauthorized, now: t0)

        let after = try #require(await queue.items().first)
        #expect(after.state == .pending)
        #expect(after.attempts == 0)
        #expect(after.nextAttemptAt == nil)
        #expect(await queue.signInRequired)
        // Nothing is sent while the session is known to be dead: every send
        // would be another 401.
        #expect(await queue.claimDue(now: t0.addingTimeInterval(3600)).isEmpty)
        // It survives a relaunch, so a killed app does not forget to ask.
        #expect(await UploadQueue(dir: dir).signInRequired)

        await queue.clearSignInRequired()
        #expect(await !queue.signInRequired)
        #expect(await queue.claimDue(now: t0).map(\.id) == [item.id])
    }

    @Test("server error schedules backoff") func serverErrorSchedulesBackoff() async throws {
        let queue = UploadQueue(dir: try scratchDir())
        let item = try await queue.enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan")
        _ = await queue.claimDue(now: t0)
        await queue.markFailure(item.id, error: .server(502), now: t0)

        let after = try #require(await queue.items().first)
        #expect(after.state == .pending)
        #expect(after.attempts == 1)
        #expect(after.nextAttemptAt == t0.addingTimeInterval(30))
        #expect(await !queue.signInRequired)
        // Not due before its time, due at it.
        #expect(await queue.claimDue(now: t0.addingTimeInterval(29)).isEmpty)
        #expect(await queue.claimDue(now: t0.addingTimeInterval(30)).map(\.id) == [item.id])
    }

    @Test func backoffSchedule() {
        #expect((1...7).map(UploadQueue.backoff(attempt:)) == [30, 120, 600, 3600, 3600, 3600, 3600])
    }

    @Test("fifth failure marks failed") func fifthFailureMarksFailed() async throws {
        let queue = UploadQueue(dir: try scratchDir())
        let item = try await queue.enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan")
        var now = t0
        for attempt in 1...5 {
            let claimed = await queue.claimDue(now: now)
            #expect(claimed.map(\.id) == [item.id], "attempt \(attempt) was not due")
            await queue.markFailure(item.id, error: .server(500), now: now)
            now = now.addingTimeInterval(UploadQueue.backoff(attempt: attempt))
        }
        let failed = try #require(await queue.items().first)
        #expect(failed.state == .failed)
        #expect(failed.attempts == 5)
        #expect(await queue.claimDue(now: now.addingTimeInterval(86_400)).isEmpty)

        // Failed is never final: one tap sends it again, from a clean slate.
        await queue.retry(item.id)
        let retried = try #require(await queue.items().first)
        #expect(retried.state == .pending)
        #expect(retried.attempts == 0)
        #expect(retried.nextAttemptAt == nil)
        #expect(await queue.claimDue(now: now).map(\.id) == [item.id])
    }

    /// A refused request (400, 413…) fails at once: the same bytes will be
    /// refused again, and five tries would only delay telling Martin.
    @Test func rejectedFailsAtOnce() async throws {
        let queue = UploadQueue(dir: try scratchDir())
        let item = try await queue.enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan")
        _ = await queue.claimDue(now: t0)
        await queue.markFailure(item.id, error: .rejected(413), now: t0)
        #expect(await queue.items().first?.state == .failed)
    }

    @Test("sent deletes the pdf file") func sentDeletesThePdf() async throws {
        let dir = try scratchDir()
        let queue = UploadQueue(dir: dir)
        let item = try await queue.enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan")
        let file = queue.pdfURL(item.id)
        #expect(FileManager.default.fileExists(atPath: file.path()))

        _ = await queue.claimDue(now: t0)
        await queue.markSent(item.id, now: t0)

        #expect(!FileManager.default.fileExists(atPath: file.path()))
        let sent = try #require(await UploadQueue(dir: dir).items().first)
        #expect(sent.state == .sent)
        #expect(sent.sentAt == t0)
    }

    /// Two drains at once (a capture and the app coming to the front) must
    /// not send one item twice.
    @Test func claimingMarksSendingSoASecondClaimGetsNothing() async throws {
        let queue = UploadQueue(dir: try scratchDir())
        let item = try await queue.enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan")
        #expect(await queue.claimDue(now: t0).map(\.id) == [item.id])
        #expect(await queue.items().first?.state == .sending)
        #expect(await queue.claimDue(now: t0).isEmpty)
    }

    /// A process killed mid-upload leaves `sending` on disk. On the next
    /// launch, anything the upload session no longer owns goes back to pending.
    @Test func sendingWithoutALiveTaskGoesBackToPending() async throws {
        let dir = try scratchDir()
        let queue = UploadQueue(dir: dir)
        let lost = try await queue.enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan")
        let live = try await queue.enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan")
        _ = await queue.claimDue(now: t0)

        let relaunched = UploadQueue(dir: dir)
        await relaunched.resetSending(except: [live.id])
        let states = Dictionary(uniqueKeysWithValues: await relaunched.items().map { ($0.id, $0.state) })
        #expect(states[lost.id] == .pending)
        #expect(states[live.id] == .sending)
    }

    /// An item whose PDF vanished cannot be sent, and must say so rather than
    /// disappear.
    @Test func missingPdfFailsInsteadOfVanishing() async throws {
        let dir = try scratchDir()
        let queue = UploadQueue(dir: dir)
        let item = try await queue.enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan")
        try FileManager.default.removeItem(at: queue.pdfURL(item.id))
        #expect(await queue.claimDue(now: t0).isEmpty)
        #expect(await queue.items().first?.state == .failed)
    }

    /// Sent items stay listed long enough for "verstuurd vandaag", then go.
    @Test func oldSentItemsArePrunedOnLoad() async throws {
        let dir = try scratchDir()
        let queue = UploadQueue(dir: dir)
        let old = try await queue.enqueue(pdf: pdf, capturedAt: t0, source: "phone-scan")
        _ = await queue.claimDue(now: t0)
        await queue.markSent(old.id, now: t0)
        let reloaded = UploadQueue(dir: dir, now: t0.addingTimeInterval(8 * 86_400))
        #expect(await reloaded.items().isEmpty)
    }
}

struct QueueSummaryTests {
    // 2026-10-28 14:05 Amsterdam (CET, UTC+1).
    let now = Date(timeIntervalSince1970: 1_793_192_700)

    func item(_ state: UploadItem.State, sentAt: Date? = nil) -> UploadItem {
        UploadItem(id: UUID(), fileName: "x.pdf", capturedAt: now, source: "phone-scan",
                   state: state, attempts: 0, nextAttemptAt: nil, sentAt: sentAt)
    }

    @Test func stripReadsAsThePlanSpellsIt() {
        let items = [item(.sending)] + Array(repeating: item(.sent, sentAt: now), count: 3) + [item(.failed)]
        let s = QueueSummary(items: items, now: now)
        #expect(s.parts == ["1 wordt verstuurd", "3 verstuurd vandaag", "1 mislukt"])
        #expect(s.failed == 1)
    }

    @Test func pendingAndSendingBothReadAsBeingSent() {
        let s = QueueSummary(items: [item(.pending), item(.sending)], now: now)
        #expect(s.parts == ["2 worden verstuurd"])
    }

    /// "Vandaag" is the Amsterdam day, not the UTC one.
    @Test func todayIsTheAmsterdamDay() {
        let afterMidnight = Date(timeIntervalSince1970: 1_793_143_740) // 2026-10-27 23:29 UTC = 28th 00:29 CET
        let beforeMidnight = Date(timeIntervalSince1970: 1_793_140_140) // 2026-10-27 22:29 UTC = 27th 23:29 CET
        #expect(QueueSummary(items: [item(.sent, sentAt: afterMidnight)], now: now).parts == ["1 verstuurd vandaag"])
        let yesterday = QueueSummary(items: [item(.sent, sentAt: beforeMidnight)], now: now)
        #expect(yesterday.parts.isEmpty)
        #expect(yesterday.isEmpty)
    }
}
