import Testing
import Foundation
@testable import Verder

struct APIClientTests {
    // MARK: - Which cookie is the session

    /// better-auth prefixes its cookies with `__Secure-` whenever the base URL is
    /// https (no `cookiePrefix` or `useSecureCookies` is configured in
    /// packages/auth/src/index.ts, so the defaults decide).
    @Test func sessionCookiePrefersSecureName() throws {
        let url = URL(string: "https://verder.vanderpoel.pro/api/auth/sign-in/email")!
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Set-Cookie": "better-auth.session_token=plain.sig; Path=/; HttpOnly, "
                + "__Secure-better-auth.session_token=secure.sig; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax",
        ])!
        let cookie = try #require(sessionCookie(from: response, url: url))
        #expect(cookie.name == "__Secure-better-auth.session_token")
        #expect(cookie.value == "secure.sig")
    }

    @Test func sessionCookieFallsBackToPlainName() throws {
        let url = URL(string: "https://verder.vanderpoel.pro/api/auth/sign-in/email")!
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Set-Cookie": "better-auth.session_token=plain.sig; Max-Age=2592000; Path=/; HttpOnly",
        ])!
        let cookie = try #require(sessionCookie(from: response, url: url))
        #expect(cookie.name == "better-auth.session_token")
        #expect(cookie.value == "plain.sig")
        // Max-Age becomes an absolute expiry, about 30 days out.
        let expires = try #require(cookie.expires)
        #expect(abs(expires.timeIntervalSinceNow - 2_592_000) < 60)
    }

    /// Sign-out answers with the same cookie name, an empty value and Max-Age=0.
    /// That is a deletion, never a session.
    @Test func clearedCookieIsNoSession() {
        let url = URL(string: "https://verder.vanderpoel.pro/api/auth/sign-out")!
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Set-Cookie": "__Secure-better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; Secure",
        ])!
        #expect(sessionCookie(from: response, url: url) == nil)
    }

    @Test func otherCookiesAreNoSession() {
        let url = URL(string: "https://verder.vanderpoel.pro/api/auth/sign-in/email")!
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Set-Cookie": "__Secure-better-auth.dont_remember=x; Path=/",
        ])!
        #expect(sessionCookie(from: response, url: url) == nil)
    }

    // MARK: - What every request carries

    @Test func requestCarriesOriginTrustAndCookie() throws {
        let store = InMemorySessionStore(SessionCookie(name: "__Secure-better-auth.session_token", value: "tok.sig", expires: nil))
        let client = APIClient(session: APIClient.makeSession(), store: store)
        let req = client.request("/api/mobile/v1/ping", method: "GET", body: nil, contentType: nil)
        #expect(req.url?.absoluteString == "https://verder.vanderpoel.pro/api/mobile/v1/ping")
        #expect(req.httpMethod == "GET")
        #expect(req.value(forHTTPHeaderField: "Origin") == "https://verder.vanderpoel.pro")
        #expect(req.value(forHTTPHeaderField: "x-verder-trust-device") == "1")
        #expect(req.value(forHTTPHeaderField: "Cookie") == "__Secure-better-auth.session_token=tok.sig")
    }

    @Test func requestWithoutSessionSendsNoCookie() {
        let client = APIClient(session: APIClient.makeSession(), store: InMemorySessionStore())
        let req = client.request("/api/auth/sign-in/email", method: "POST", body: Data("{}".utf8), contentType: "application/json")
        #expect(req.value(forHTTPHeaderField: "Cookie") == nil)
        #expect(req.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(req.httpBody == Data("{}".utf8))
    }

    // MARK: - Status mapping

    @Test("429 maps to rateLimited") func rateLimited() async {
        let server = StubServer()
        server.on { _ in .status(429) }
        let client = server.client()
        await #expect(throws: APIError.rateLimited) {
            try await client.send(client.request("/api/auth/sign-in/email", method: "POST", body: nil, contentType: nil))
        }
    }

    @Test("401 maps to unauthorized") func unauthorized() async {
        let server = StubServer()
        server.on { _ in .status(401) }
        let client = server.client()
        await #expect(throws: APIError.unauthorized) {
            try await client.send(client.request("/api/mobile/v1/ping", method: "GET", body: nil, contentType: nil))
        }
    }

    @Test func serverErrorMapsToServer() async {
        let server = StubServer()
        server.on { _ in .status(502) }
        let client = server.client()
        await #expect(throws: APIError.server(502)) {
            try await client.send(client.request("/api/mobile/v1/ping", method: "GET", body: nil, contentType: nil))
        }
    }

    @Test func otherClientErrorMapsToRejected() async {
        let server = StubServer()
        server.on { _ in .status(413) }
        let client = server.client()
        await #expect(throws: APIError.rejected(413)) {
            try await client.send(client.request("/api/mobile/v1/documents", method: "POST", body: nil, contentType: nil))
        }
    }

    @Test func offlineMapsToTransport() async throws {
        let server = StubServer()
        server.on { _ in .failure(.notConnectedToInternet) }
        let client = server.client()
        do {
            _ = try await client.send(client.request("/api/mobile/v1/ping", method: "GET", body: nil, contentType: nil))
            Issue.record("expected a transport error")
        } catch let error as APIError {
            guard case .transport = error else { Issue.record("got \(error)"); return }
        }
    }

    @Test func successReturnsBody() async throws {
        let server = StubServer()
        server.on { _ in .status(200, body: Data("ok".utf8)) }
        let client = server.client()
        let (data, response) = try await client.send(client.request("/api/mobile/v1/ping", method: "GET", body: nil, contentType: nil))
        #expect(response.statusCode == 200)
        #expect(data == Data("ok".utf8))
    }

    /// THE REASON THE CLIENT NEVER FOLLOWS A REDIRECT: an expired session on a
    /// page route answers 307 → /login, and /login answers 200. Followed, that
    /// reads as success and would mark a scan sent that never arrived.
    @Test func redirectMapsToUnauthorized() async {
        let server = StubServer()
        server.on { req in
            req.url?.path() == "/login" ? .status(200, body: Data("<html>login</html>".utf8))
                                        : .redirect(307, location: "/login")
        }
        let client = server.client()
        await #expect(throws: APIError.unauthorized) {
            try await client.send(client.request("/api/mobile/v1/documents", method: "POST", body: nil, contentType: nil))
        }
        #expect(server.requests.allSatisfy { $0.url?.path() != "/login" }, "the redirect was followed")
    }

    @Test func noRedirectDelegateRefuses() async {
        let url = URL(string: "https://verder.vanderpoel.pro/x")!
        let response = HTTPURLResponse(url: url, statusCode: 302, httpVersion: nil, headerFields: ["Location": "/login"])!
        let task = URLSession.shared.dataTask(with: url)
        let next = await NoRedirects().urlSession(URLSession.shared, task: task,
                                                  willPerformHTTPRedirection: response,
                                                  newRequest: URLRequest(url: URL(string: "https://verder.vanderpoel.pro/login")!))
        #expect(next == nil)
    }

    // MARK: - The Keychain is the only place a session lives

    @Test func sessionConfigurationKeepsNoCookies() {
        let config = APIClient.sessionConfiguration()
        #expect(config.httpCookieStorage == nil)
        #expect(config.httpShouldSetCookies == false)
    }

    /// A Set-Cookie on one response must NOT ride along on the next request
    /// unless the store holds it.
    @Test func responseCookiesAreNotReplayed() async throws {
        let server = StubServer()
        server.on { _ in .status(200, headers: ["Set-Cookie": "__Secure-better-auth.session_token=leak; Path=/; Secure"]) }
        let client = server.client()
        _ = try await client.send(client.request("/a", method: "GET", body: nil, contentType: nil))
        _ = try await client.send(client.request("/b", method: "GET", body: nil, contentType: nil))
        let second = try #require(server.requests.last)
        #expect(second.value(forHTTPHeaderField: "Cookie") == nil)
    }
}
