import Foundation
import Synchronization
import UIKit

/// Sends the queue with a background `URLSession`, so an upload carries on
/// while the app is suspended and is handed back to the app (relaunched if
/// need be, `sessionSendsLaunchEvents`) when it ends.
///
/// - A background upload must come from a FILE, so each item's multipart body
///   is written next to its file for the duration of the upload, then removed.
/// - The cookie is attached per request from the Keychain (`APIClient.request`);
///   the session itself stores and sends no cookies.
/// - There is ONE background session per identifier per process, so the app
///   makes exactly one `BackgroundUploader` at launch (`UploadCenter.live`).
///
/// Tests run the same class on a foreground configuration (a background
/// session refuses custom URLProtocols).
final class BackgroundUploader: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let identifier = "pro.vanderpoel.verder.upload"

    let queue: UploadQueue
    let client: APIClient
    private let now: @Sendable () -> Date
    /// Assigned once in `init`, before any task can call back.
    private(set) var session: URLSession!

    private struct State {
        var bodies: [Int: Data] = [:]
        /// Items a `drain` started and will wait for.
        var expecting: Set<UUID> = []
        var settled: Set<UUID> = []
        var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]
        var settling: [Task<Void, Never>] = []
        var eventsFinished = false
        var eventsWaiter: CheckedContinuation<Void, Never>?
        var onSettle: @Sendable () -> Void = {}
    }
    private let state = Mutex(State())

    static func backgroundConfiguration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.background(withIdentifier: identifier)
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.urlCache = nil
        return config
    }

    init(queue: UploadQueue, client: APIClient,
         configuration: URLSessionConfiguration = BackgroundUploader.backgroundConfiguration(),
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.queue = queue
        self.client = client
        self.now = now
        super.init()
        self.session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    /// Called after every change an upload makes to the queue.
    func setOnSettle(_ f: @escaping @Sendable () -> Void) {
        state.withLock { $0.onSettle = f }
    }

    /// On launch, BEFORE the first drain: anything left `sending` by a killed
    /// process that the session no longer owns goes back to pending.
    func recover() async {
        let live = Set(await session.allTasks.compactMap { $0.taskDescription.flatMap(UUID.init(uuidString:)) })
        await queue.resetSending(except: live)
    }

    /// Starts every due item and returns once each of them has settled.
    func drain() async {
        let items = await queue.claimDue(now: now())
        guard !items.isEmpty else { return }
        state.withLock { $0.onSettle }()
        var started: [UUID] = []
        for item in items {
            do {
                let file = try Data(contentsOf: queue.fileURL(item))
                let (req, body) = UploadRequest.build(item, file: file, client: client)
                let bodyFile = queue.bodyURL(item.id)
                try body.write(to: bodyFile, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                state.withLock { _ = $0.expecting.insert(item.id) }
                let task = session.uploadTask(with: req, fromFile: bodyFile)
                task.taskDescription = item.id.uuidString
                task.resume()
                started.append(item.id)
            } catch {
                await queue.markFailure(item.id, error: .transport(String(describing: error)), now: now())
            }
        }
        for id in started { await waitSettled(id) }
    }

    /// For `.backgroundTask(.urlSession(…))`: returns once the system has
    /// delivered every event it relaunched the app for and the queue has
    /// recorded them.
    func finishBackgroundEvents() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let resumeNow = state.withLock { s -> Bool in
                if s.eventsFinished { s.eventsFinished = false; return true }
                s.eventsWaiter = c
                return false
            }
            if resumeNow { c.resume() }
        }
        let pending = state.withLock { s -> [Task<Void, Never>] in
            defer { s.settling = [] }
            return s.settling
        }
        for t in pending { await t.value }
    }

    private func waitSettled(_ id: UUID) async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let done = state.withLock { s -> Bool in
                if s.settled.remove(id) != nil { return true }
                s.waiters[id] = c
                return false
            }
            if done { c.resume() }
        }
    }

    private func settle(_ id: UUID, _ outcome: Result<UploadResponse, APIError>) async {
        switch outcome {
        case .success: await queue.markSent(id, now: now())
        case .failure(let error): await queue.markFailure(id, error: error, now: now())
        }
        try? FileManager.default.removeItem(at: queue.bodyURL(id))
        let (waiter, onSettle) = state.withLock { s -> (CheckedContinuation<Void, Never>?, @Sendable () -> Void) in
            let w = s.waiters.removeValue(forKey: id)
            if w == nil, s.expecting.contains(id) { s.settled.insert(id) }
            s.expecting.remove(id)
            return (w, s.onSettle)
        }
        onSettle()
        waiter?.resume()
    }

    // MARK: - URLSessionDataDelegate

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        state.withLock { $0.bodies[dataTask.taskIdentifier, default: Data()].append(data) }
    }

    /// Asked only for foreground sessions (tests); a background session follows
    /// by itself, which `UploadOutcome.judge` catches by the final URL.
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        let body = state.withLock { $0.bodies.removeValue(forKey: task.taskIdentifier) } ?? Data()
        guard let id = task.taskDescription.flatMap(UUID.init(uuidString:)) else { return }
        let outcome = UploadOutcome.judge(sentTo: task.originalRequest?.url, response: task.response,
                                          body: body, error: error)
        let t = Task { await self.settle(id, outcome) }
        state.withLock { $0.settling.append(t) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let waiter = state.withLock { s -> CheckedContinuation<Void, Never>? in
            guard let w = s.eventsWaiter else { s.eventsFinished = true; return nil }
            s.eventsWaiter = nil
            return w
        }
        waiter?.resume()
    }
}

/// Task 12 step 3's debug action: send an already-sent item AGAIN with the
/// same clientId, and report what the server says. Expected: `duplicate: true`
/// and no new document.
///
/// The bytes are a fresh one-page PDF, deliberately NOT the original scan
/// (which `markSent` deleted): identical bytes would be caught by the vault's
/// sha256 dedup too, so only different bytes prove the CLIENTID is what makes
/// a retry safe — the case of a retry whose PDF was re-encoded in between.
enum ResendProbe {
    static func resend(_ item: UploadItem, client: APIClient) async throws -> UploadResponse {
        let (req, body) = UploadRequest.build(item, file: probePDF(item), mime: "application/pdf", client: client)
        var withBody = req
        withBody.httpBody = body
        let (data, response) = try await client.send(withBody)
        guard let answer = try? JSONDecoder().decode(UploadResponse.self, from: data) else {
            throw APIError.server(response.statusCode)
        }
        return answer
    }

    static func probePDF(_ item: UploadItem) -> Data {
        let size = CGSize(width: 600, height: 848)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let page = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            let text = "verder — herhaalde verzending\nclientId \(item.clientId)"
            text.draw(in: CGRect(x: 40, y: 40, width: 520, height: 200),
                      withAttributes: [.font: UIFont.systemFont(ofSize: 16), .foregroundColor: UIColor.black])
        }
        return PDFAssembler.makePDF(pages: [page])
    }
}
