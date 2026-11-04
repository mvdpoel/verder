import Foundation
import Network
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

    static let appGroup = AppGroup.id

    private(set) var items: [UploadItem] = []
    private(set) var signInRequired = false
    /// Captures being cleaned and packed into a PDF right now.
    private(set) var preparing = 0
    private(set) var message: String?
    /// The answer of the last same-clientId resend (Meer → Ontwikkelaar).
    private(set) var resendResult: String?
    /// The resend's answer as Ontwikkelaar draws it: whether the server said
    /// `duplicate: true`, and when it answered. Nil until a resend answered.
    private(set) var resendAnswer: ResendAnswer?
    private(set) var isResending = false
    /// Whether this phone ever queued anything ("Nog geen scans" until then).
    private(set) var everEnqueued = false
    /// No network path at all. The Scan tab says so ("Scannen werkt gewoon
    /// zonder verbinding.") and names the waiting scans by it.
    private(set) var isOffline = false
    /// Bumped each time a capture reaches the queue: the `.impact(.medium)`
    /// the brief puts on "scan handed to the queue" (§2.6).
    private(set) var enqueuedCount = 0
    /// The clock the Scan tab reads ("vandaag", the duplex window). The
    /// fixtures run it from the synthetic case's day.
    @ObservationIgnored let now: @Sendable () -> Date
    @ObservationIgnored private var pathMonitor: NWPathMonitor?

    @ObservationIgnored let queue: UploadQueue
    @ObservationIgnored let uploader: BackgroundUploader
    @ObservationIgnored let client: APIClient
    @ObservationIgnored private var recovery: Task<Void, Never>?
    @ObservationIgnored private var timer: Task<Void, Never>?

    init(queue: UploadQueue, uploader: BackgroundUploader, client: APIClient,
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.queue = queue
        self.uploader = uploader
        self.client = client
        self.now = now
        uploader.setOnSettle { [weak self] in
            Task { @MainActor in await self?.refresh() }
        }
    }

    /// The phone's queue: in the App Group container, so the share extension
    /// (spec §7.8) can leave its drops in `uploads/incoming/` beside it.
    static func live(client: APIClient) -> UploadCenter {
        let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? URL.applicationSupportDirectory
        let queue = UploadQueue(dir: base.appending(path: "uploads", directoryHint: .isDirectory))
        let center = UploadCenter(queue: queue, uploader: BackgroundUploader(queue: queue, client: client), client: client)
        center.watchNetwork()
        return center
    }

    var summary: QueueSummary { QueueSummary(items: items, now: now()) }

    /// Watch the network path, for the offline state. The live app only: a
    /// fixture run says offline itself (`setOffline`).
    func watchNetwork() {
        guard pathMonitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let offline = path.status != .satisfied
            Task { @MainActor in
                guard let self, self.isOffline != offline else { return }
                self.isOffline = offline
                // Back online: whatever waited for the connection goes now.
                if !offline { await self.drain() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "verder.network"))
        pathMonitor = monitor
    }

    func setOffline(_ offline: Bool) { isOffline = offline }

    /// Newest sent item: the one the debug resend sends again.
    var lastSent: UploadItem? {
        items.filter { $0.state == .sent }.max { ($0.sentAt ?? .distantPast) < ($1.sentAt ?? .distantPast) }
    }

    /// Once per process, recover BEFORE any drain: a drain racing `recover`
    /// could see its own fresh uploads reset to pending and sent twice. Every
    /// caller (launch, activation, both at once) awaits the same recovery.
    ///
    /// Runs on launch AND every time the app comes to the front, which is when
    /// the share extension's drops are taken into the queue
    /// (`UploadQueue.importIncoming`, idempotent): the extension never writes
    /// queue.json itself.
    func start() async {
        await recovered()
        await queue.importIncoming()
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
        everEnqueued = await queue.everEnqueued
        scheduleNextAttempt()
    }

    /// Clean, pack, enqueue — off the main thread, so the camera is back at
    /// once — then send. Held open as a background task: a letter snapped just
    /// before the phone is pocketed must still reach the queue.
    func capture(_ pages: [UIImage], source: String = "phone-scan") {
        guard !pages.isEmpty else { return }
        let capturedAt = now()
        let pageCount = pages.count
        let background = UIApplication.shared.beginBackgroundTask(withName: "verder.scan")
        preparing += 1
        message = nil
        Task {
            let pdf = await Task.detached(priority: .userInitiated) {
                PDFAssembler.makePDF(pages: pages.map { PageCleaner.clean($0) })
            }.value
            do {
                guard !pdf.isEmpty else { throw CocoaError(.fileWriteUnknown) }
                try await queue.enqueue(pdf: pdf, capturedAt: capturedAt, source: source, pages: pageCount)
                enqueuedCount += 1
            } catch {
                message = Copy.saveFailed
            }
            preparing -= 1
            await refresh()
            UIApplication.shared.endBackgroundTask(background)
            await drain()
        }
    }

    func retry(_ id: UUID) async {
        await queue.retry(id)
        await refresh()
        await drain()
    }

    func setNote(_ id: UUID, _ note: String?) async {
        await queue.setNote(id, note)
        await refresh()
    }

    func remove(_ id: UUID) async {
        await queue.remove(id)
        await refresh()
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
    struct ResendAnswer: Equatable, Sendable {
        let duplicate: Bool
        let at: Date
    }

    #if DEBUG
    /// A fixture run's answered upload test (`FixtureEnvironment`).
    func seedFixtureResend(duplicate: Bool, at: Date) {
        resendAnswer = ResendAnswer(duplicate: duplicate, at: at)
    }
    #endif

    func resendLastSent() async {
        guard let item = lastSent, !isResending else { return }
        isResending = true
        defer { isResending = false }
        do {
            let answer = try await ResendProbe.resend(item, client: client)
            resendResult = "duplicate: \(answer.duplicate) · id \(answer.id) · clientId \(item.clientId)"
            resendAnswer = ResendAnswer(duplicate: answer.duplicate, at: now())
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
