import Testing
import Foundation
@testable import Verder

/// The uploader end to end against a stub server. A background URLSession
/// refuses custom URLProtocols, so these run the SAME uploader and delegate
/// on a foreground session built from the stub configuration; only the
/// session's configuration differs from the phone's.
struct BackgroundUploaderTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    let session = SessionCookie(name: "__Secure-better-auth.session_token", value: "tok.sig", expires: nil)

    func uploader(_ server: StubServer, dir: URL) -> (UploadQueue, BackgroundUploader) {
        let queue = UploadQueue(dir: dir)
        let config = APIClient.sessionConfiguration()
        config.protocolClasses = [StubProtocol.self]
        let client = APIClient(base: server.base, session: APIClient.makeSession(), store: InMemorySessionStore(session))
        let t = t0
        return (queue, BackgroundUploader(queue: queue, client: client, configuration: config, now: { t }))
    }

    @Test func uploadSendsMultipartWithCookieAndMarksSent() async throws {
        let server = StubServer()
        server.on { _ in .status(200, headers: ["Content-Type": "application/json"],
                                 body: Data(#"{"id":"doc-1","duplicate":false}"#.utf8)) }
        let dir = try scratchDir()
        let (queue, up) = uploader(server, dir: dir)
        let item = try await queue.enqueue(pdf: Data("%PDF-1.4 hello".utf8), capturedAt: t0, source: "phone-scan")

        await up.drain()

        let req = try #require(server.requests.first)
        #expect(server.requests.count == 1)
        #expect(req.httpMethod == "POST")
        #expect(req.url?.path() == "/api/mobile/v1/documents")
        #expect(req.value(forHTTPHeaderField: "Cookie") == "__Secure-better-auth.session_token=tok.sig")
        #expect(req.value(forHTTPHeaderField: "x-verder-trust-device") == "1")
        let type = try #require(req.value(forHTTPHeaderField: "Content-Type"))
        #expect(type.hasPrefix("multipart/form-data; boundary="))
        // The server answers 411 without it (vault-upload.ts).
        let body = try #require(req.httpBody)
        #expect(req.value(forHTTPHeaderField: "Content-Length") == String(body.count))
        let text = String(decoding: body, as: UTF8.self)
        // The server's UUID_V4 check is case-insensitive, but sourceRef is the
        // lower-cased id; send it lower-cased so the two spellings agree.
        #expect(text.contains("name=\"clientId\"\r\n\r\n\(item.id.uuidString.lowercased())\r\n"))
        #expect(text.contains("name=\"source\"\r\n\r\nphone-scan\r\n"))
        #expect(text.contains("name=\"capturedAt\"\r\n\r\n2027-01-15T08:00:00Z\r\n"))
        #expect(text.contains("filename=\"Scan 2027-01-15 09.00.pdf\"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 hello"))

        let after = try #require(await queue.items().first)
        #expect(after.state == .sent)
        #expect(!FileManager.default.fileExists(atPath: queue.pdfURL(item.id).path()))
        // The temporary body file is gone too.
        let left = try FileManager.default.contentsOfDirectory(atPath: dir.path())
        #expect(left.filter { $0.hasSuffix(".body") }.isEmpty)
    }

    /// Review focus 2, through the network: a 401 leaves the scan pending and
    /// asks for sign-in; it is never marked failed.
    @Test func unauthorizedKeepsPendingAndAsksForSignIn() async throws {
        let server = StubServer()
        server.on { _ in .status(401) }
        let (queue, up) = uploader(server, dir: try scratchDir())
        _ = try await queue.enqueue(pdf: Data("%PDF".utf8), capturedAt: t0, source: "phone-scan")

        await up.drain()

        #expect(await queue.items().first?.state == .pending)
        #expect(await queue.signInRequired)
        // Draining again sends nothing until Martin signs in.
        await up.drain()
        #expect(server.requests.count == 1)
    }

    /// A redirect means "not signed in" (APIError), never success — and it is
    /// never followed, so /login is never asked for.
    @Test func redirectKeepsPendingAndAsksForSignIn() async throws {
        let server = StubServer()
        server.on { req in
            req.url?.path() == "/login" ? .status(200, body: Data("<html>login</html>".utf8))
                                        : .redirect(307, location: "/login")
        }
        let (queue, up) = uploader(server, dir: try scratchDir())
        _ = try await queue.enqueue(pdf: Data("%PDF".utf8), capturedAt: t0, source: "phone-scan")

        await up.drain()

        #expect(await queue.items().first?.state == .pending)
        #expect(await queue.signInRequired)
        #expect(server.requests.allSatisfy { $0.url?.path() != "/login" })
    }

    @Test func serverErrorBacksOff() async throws {
        let server = StubServer()
        server.on { _ in .status(503) }
        let (queue, up) = uploader(server, dir: try scratchDir())
        _ = try await queue.enqueue(pdf: Data("%PDF".utf8), capturedAt: t0, source: "phone-scan")

        await up.drain()

        let after = try #require(await queue.items().first)
        #expect(after.state == .pending)
        #expect(after.attempts == 1)
        #expect(after.nextAttemptAt == t0.addingTimeInterval(30))
    }

    @Test func offlineBacksOff() async throws {
        let server = StubServer()
        server.on { _ in .failure(.notConnectedToInternet) }
        let (queue, up) = uploader(server, dir: try scratchDir())
        _ = try await queue.enqueue(pdf: Data("%PDF".utf8), capturedAt: t0, source: "phone-scan")

        await up.drain()

        let after = try #require(await queue.items().first)
        #expect(after.state == .pending)
        #expect(after.attempts == 1)
    }

    // MARK: - Judging an answer

    let sentTo = URL(string: "https://verder.vanderpoel.pro/api/mobile/v1/documents")!

    func response(_ status: Int, url: URL? = nil) -> HTTPURLResponse {
        HTTPURLResponse(url: url ?? sentTo, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:])!
    }

    @Test func okWithTheServersJsonIsSent() {
        let r = UploadOutcome.judge(sentTo: sentTo, response: response(200),
                                    body: Data(#"{"id":"doc-1","duplicate":true}"#.utf8), error: nil)
        #expect(r == .success(UploadResponse(id: "doc-1", duplicate: true)))
    }

    /// A background session FOLLOWS redirects by itself (its delegate is not
    /// asked), so a 307 → /login → 200 arrives as a 200 from another URL.
    /// That is a sign-in page, not a stored scan.
    @Test func a200FromAnotherUrlIsUnauthorized() {
        let login = URL(string: "https://verder.vanderpoel.pro/login")!
        let r = UploadOutcome.judge(sentTo: sentTo, response: response(200, url: login),
                                    body: Data("<html>login</html>".utf8), error: nil)
        #expect(r == .failure(.unauthorized))
    }

    /// A 2xx that is not the endpoint's answer is no proof the scan arrived.
    /// It is retried (the clientId makes a retry safe), never marked sent.
    @Test func a200WithoutTheJsonIsRetried() {
        let r = UploadOutcome.judge(sentTo: sentTo, response: response(200), body: Data("<html/>".utf8), error: nil)
        #expect(r == .failure(.server(200)))
    }

    @Test func statusesMapLikeTheApiClient() {
        #expect(UploadOutcome.judge(sentTo: sentTo, response: response(401), body: Data(), error: nil) == .failure(.unauthorized))
        #expect(UploadOutcome.judge(sentTo: sentTo, response: response(413), body: Data(), error: nil) == .failure(.rejected(413)))
        #expect(UploadOutcome.judge(sentTo: sentTo, response: response(429), body: Data(), error: nil) == .failure(.rateLimited))
        #expect(UploadOutcome.judge(sentTo: sentTo, response: response(500), body: Data(), error: nil) == .failure(.server(500)))
        #expect(UploadOutcome.judge(sentTo: sentTo, response: nil, body: Data(), error: URLError(.timedOut))
                == .failure(.transport("URLError \(URLError.Code.timedOut.rawValue)")))
    }

    // MARK: - Task 12 step 3: the same clientId again

    @Test func resendUsesTheSameClientIdAndReadsDuplicate() async throws {
        let server = StubServer()
        server.on { _ in .status(200, body: Data(#"{"id":"doc-1","duplicate":true}"#.utf8)) }
        let client = server.client(store: InMemorySessionStore(session))
        let id = UUID()
        let item = UploadItem(id: id, fileName: "Scan 2027-01-15 09.00.pdf", capturedAt: t0, source: "phone-scan",
                              state: .sent, attempts: 0, nextAttemptAt: nil, sentAt: t0)

        let answer = try await ResendProbe.resend(item, client: client)

        #expect(answer == UploadResponse(id: "doc-1", duplicate: true))
        let text = String(decoding: try #require(server.requests.first?.httpBody), as: UTF8.self)
        #expect(text.contains("name=\"clientId\"\r\n\r\n\(id.uuidString.lowercased())\r\n"))
        #expect(text.contains("name=\"capturedAt\"\r\n\r\n2027-01-15T08:00:00Z\r\n"))
        #expect(text.contains("%PDF"))
    }
}
