import Foundation
import Observation
import UIKit

/// The upload queue as the screens see it: a snapshot of the items, the
/// "sign in again" flag, and the actions (capture, retry, resend). The queue
/// and the uploader do the work; this only keeps the snapshot fresh and
/// decides WHEN to drain.
///
/// Drains happen on launch (after `recover`), after every capture, when the
/// app comes to the front, after a re-sign-in, and — while the app is in the
/// foreground — at the next item's backoff deadline. A backed-off item whose
/// deadline passes while the app is suspended waits for the next of those;
/// an upload already handed to the background session finishes on its own,
/// offline included (a background session waits for the network).
@MainActor
@Observable
final class UploadCenter {
    enum Copy {
        static let signInRequired = "Log opnieuw in om je scans te versturen"
        static let saveFailed = "De scan kon niet worden bewaard. Probeer het opnieuw."
    }

    static let appGroup = "group.pro.vanderpoel.verder"

    private(set) var items: [UploadItem] = []
    private(set) var signInRequired = false
    /// Captures being cleaned and packed into a PDF right now.
    private(set) var preparing = 0
    private(set) var message: String?
    /// The answer of the last same-clientId resend (Meer → Ontwikkelaar).
    private(set) var resendResult: String?
    private(set) var isResending = false

    @ObservationIgnored let queue: UploadQueue
    @ObservationIgnored let uploader: BackgroundUploader
    @ObservationIgnored let client: APIClient
    @ObservationIgnored private var recovery: Task<Void, Never>?
    @ObservationIgnored private var timer: Task<Void, Never>?

    init(queue: UploadQueue, uploader: BackgroundUploader, client: APIClient) {
        self.queue = queue
        self.uploader = uploader
        self.client = client
        uploader.setOnSettle { [weak self] in
            Task { @MainActor in await self?.refresh() }
        }
    }

    /// The phone's queue: in the App Group container, so the share extension
    /// (spec §7.8) enqueues into the same one.
    static func live(client: APIClient) -> UploadCenter {
        let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? URL.applicationSupportDirectory
        let queue = UploadQueue(dir: base.appending(path: "uploads", directoryHint: .isDirectory))
        return UploadCenter(queue: queue, uploader: BackgroundUploader(queue: queue, client: client), client: client)
    }

    var summary: QueueSummary { QueueSummary(items: items, now: Date()) }

    /// Newest sent item: the one the debug resend sends again.
    var lastSent: UploadItem? {
        items.filter { $0.state == .sent }.max { ($0.sentAt ?? .distantPast) < ($1.sentAt ?? .distantPast) }
    }

    /// Once per process, recover BEFORE any drain: a drain racing `recover`
    /// could see its own fresh uploads reset to pending and sent twice. Every
    /// caller (launch, activation, both at once) awaits the same recovery.
    func start() async {
        await recovered()
        await refresh()
        await drain()
    }

    private func recovered() async {
        if recovery == nil {
            let uploader = uploader
            recovery = Task { await uploader.recover() }
        }
        await recovery?.value
    }

    func drain() async {
        await recovered()
        await uploader.drain()
        await refresh()
    }

    func refresh() async {
        items = await queue.items()
        signInRequired = await queue.signInRequired
        scheduleNextAttempt()
    }

    /// Clean, pack, enqueue — off the main thread, so the camera is back at
    /// once — then send. Held open as a background task: a letter snapped just
    /// before the phone is pocketed must still reach the queue.
    func capture(_ pages: [UIImage], source: String = "phone-scan") {
        guard !pages.isEmpty else { return }
        let capturedAt = Date()
        let background = UIApplication.shared.beginBackgroundTask(withName: "verder.scan")
        preparing += 1
        message = nil
        Task {
            let pdf = await Task.detached(priority: .userInitiated) {
                PDFAssembler.makePDF(pages: pages.map { PageCleaner.clean($0) })
            }.value
            do {
                guard !pdf.isEmpty else { throw CocoaError(.fileWriteUnknown) }
                try await queue.enqueue(pdf: pdf, capturedAt: capturedAt, source: source)
            } catch {
                message = Copy.saveFailed
            }
            preparing -= 1
            await refresh()
            UIApplication.shared.endBackgroundTask(background)
            await drain()
        }
    }

    func retryFailed() async {
        await queue.retryAllFailed()
        await refresh()
        await drain()
    }

    /// A new session (AuthModel.sessionGeneration changed): sending resumes.
    func sessionRenewed() async {
        await queue.clearSignInRequired()
        await refresh()
        await drain()
    }

    /// Task 12 step 3. Reports the server's answer as plain text.
    func resendLastSent() async {
        guard let item = lastSent, !isResending else { return }
        isResending = true
        defer { isResending = false }
        do {
            let answer = try await ResendProbe.resend(item, client: client)
            resendResult = "duplicate: \(answer.duplicate) · id \(answer.id) · clientId \(item.clientId)"
        } catch {
            resendResult = "Mislukt: \(error)"
        }
    }

    private func scheduleNextAttempt() {
        timer?.cancel()
        timer = nil
        guard recovery != nil, !signInRequired,
              let next = items.filter({ $0.state == .pending }).compactMap(\.nextAttemptAt).min()
        else { return }
        let delay = max(1, next.timeIntervalSinceNow)
        timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.drain()
        }
    }
}
