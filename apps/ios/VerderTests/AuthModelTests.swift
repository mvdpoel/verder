import Testing
import Foundation
@testable import Verder

@MainActor
struct AuthModelTests {
    nonisolated static let setCookie = "__Secure-better-auth.session_token=tok.sig; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax"

    @Test func passwordSignInPostsAndKeepsTheCookie() async throws {
        let server = StubServer()
        server.on { _ in .status(200, headers: ["Set-Cookie": Self.setCookie, "Content-Type": "application/json"],
                                 body: Data(#"{"redirect":false,"token":"tok"}"#.utf8)) }
        let store = InMemorySessionStore()
        let model = AuthModel(client: server.client(store: store), store: store)
        #expect(!model.isSignedIn)

        await model.signInWithPassword(email: "martin@vanderpoel.pro", password: "devpassdevpass")

        let req = try #require(server.requests.first)
        #expect(req.httpMethod == "POST")
        #expect(req.url?.path() == "/api/auth/sign-in/email")
        #expect(req.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(req.value(forHTTPHeaderField: "x-verder-trust-device") == "1")
        let body = try #require(try JSONSerialization.jsonObject(with: req.httpBody ?? Data()) as? [String: Any])
        #expect(body["email"] as? String == "martin@vanderpoel.pro")
        #expect(body["password"] as? String == "devpassdevpass")
        #expect(body["rememberMe"] as? Bool == true)

        #expect(store.load()?.name == "__Secure-better-auth.session_token")
        #expect(store.load()?.value == "tok.sig")
        #expect(model.isSignedIn)
        #expect(model.errorMessage == nil)
    }

    /// The upload queue resumes after a re-sign-in on THIS changing, because
    /// `isSignedIn` was already true while the server rejected the session.
    @Test func everySignInBumpsSessionGeneration() async {
        let server = StubServer()
        server.on { _ in .status(200, headers: ["Set-Cookie": Self.setCookie]) }
        let store = InMemorySessionStore(SessionCookie(name: "__Secure-better-auth.session_token", value: "dead", expires: nil))
        let model = AuthModel(client: server.client(store: store), store: store, defaults: UserDefaults(suiteName: UUID().uuidString)!)
        #expect(model.isSignedIn)
        #expect(model.sessionGeneration == 0)
        await model.signInWithPassword(email: "martin@vanderpoel.pro", password: "devpassdevpass")
        #expect(model.sessionGeneration == 1)
        #expect(store.load()?.value == "tok.sig")
    }

    @Test func failedSignInLeavesSessionGeneration() async {
        let server = StubServer()
        server.on { _ in .status(401) }
        let store = InMemorySessionStore()
        let model = AuthModel(client: server.client(store: store), store: store)
        await model.signInWithPassword(email: "martin@vanderpoel.pro", password: "x")
        #expect(model.sessionGeneration == 0)
    }

    /// Review focus 5: the WAF's 10/min/IP answers 429. One request, one
    /// message, no retry loop that would keep the limit armed.
    @Test func rateLimitedShowsWaitAndDoesNotRetry() async {
        let server = StubServer()
        server.on { _ in .status(429) }
        let store = InMemorySessionStore()
        let model = AuthModel(client: server.client(store: store), store: store)

        await model.signInWithPassword(email: "martin@vanderpoel.pro", password: "x")

        #expect(model.errorMessage == "Even wachten — te veel pogingen. Probeer het over een minuut opnieuw.")
        #expect(server.requests.count == 1)
        #expect(!model.isSignedIn)
        #expect(!model.isBusy)
    }

    @Test func wrongPasswordSaysSo() async {
        let server = StubServer()
        server.on { _ in .status(401, body: Data(#"{"code":"INVALID_EMAIL_OR_PASSWORD"}"#.utf8)) }
        let store = InMemorySessionStore()
        let model = AuthModel(client: server.client(store: store), store: store)

        await model.signInWithPassword(email: "martin@vanderpoel.pro", password: "wrong")

        #expect(model.errorMessage == AuthModel.Copy.wrongCredentials)
        #expect(store.load() == nil)
    }

    /// A 200 that sets no session cookie is not a sign-in.
    @Test func successWithoutCookieIsNotSignedIn() async {
        let server = StubServer()
        server.on { _ in .status(200, body: Data("{}".utf8)) }
        let store = InMemorySessionStore()
        let model = AuthModel(client: server.client(store: store), store: store)

        await model.signInWithPassword(email: "martin@vanderpoel.pro", password: "x")

        #expect(!model.isSignedIn)
        #expect(model.errorMessage == AuthModel.Copy.generic)
    }

    @Test func expiredStoredCookieIsSignedOut() {
        let store = InMemorySessionStore(SessionCookie(name: "__Secure-better-auth.session_token", value: "old",
                                                       expires: Date(timeIntervalSinceNow: -60)))
        let model = AuthModel(client: StubServer().client(store: store), store: store)
        #expect(!model.isSignedIn)
    }

    @Test func liveStoredCookieIsSignedIn() {
        let store = InMemorySessionStore(SessionCookie(name: "__Secure-better-auth.session_token", value: "live",
                                                       expires: Date(timeIntervalSinceNow: 3600)))
        let model = AuthModel(client: StubServer().client(store: store), store: store)
        #expect(model.isSignedIn)
    }
}
