import Testing
import Foundation
@testable import Verder

/// The two-request ceremonies against a stub server, with the Face ID step
/// replaced by a fake. What these pin is the part the server cannot forgive:
/// the challenge cookie from request 1 has to arrive on request 2, by hand,
/// because the app's URLSession keeps no cookies.
@MainActor
struct PasskeyAuthTests {
    nonisolated static let challengeSetCookie =
        "__Secure-better-auth.better-auth-passkey=vtok.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmUtc2lnbmF0dXI%3D; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Lax"
    nonisolated static let challengeCookiePair =
        "__Secure-better-auth.better-auth-passkey=vtok.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmUtc2lnbmF0dXI%3D"
    nonisolated static let sessionSetCookie =
        "__Secure-better-auth.session_token=stok.sig; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax"
    nonisolated static let authOptions = Data(#"{"rpId":"verder.vanderpoel.pro","challenge":"Zm9v","userVerification":"preferred"}"#.utf8)
    nonisolated static let registerOptions = Data(#"""
    {"challenge":"Zm9v","rp":{"name":"Verder","id":"verder.vanderpoel.pro"},
     "user":{"id":"Zg","name":"martin@vanderpoel.pro","displayName":"martin@vanderpoel.pro"},
     "excludeCredentials":[]}
    """#.utf8)

    @MainActor
    final class FakeAuthenticator: PasskeyAuthenticator {
        var assertions: [AssertionOptions] = []
        var registrations: [RegistrationOptions] = []
        var failWith: PasskeyError?

        func assert(_ options: AssertionOptions) async throws -> AssertionValues {
            assertions.append(options)
            if let failWith { throw failWith }
            return AssertionValues(credentialID: Data([1, 2, 3]), rawClientDataJSON: Data("{}".utf8),
                                   rawAuthenticatorData: Data([4]), signature: Data([5]), userID: Data([6]))
        }

        func register(_ options: RegistrationOptions) async throws -> RegistrationValues {
            registrations.append(options)
            if let failWith { throw failWith }
            return RegistrationValues(credentialID: Data([7, 8]), rawClientDataJSON: Data("{}".utf8),
                                      rawAttestationObject: Data([9]))
        }
    }

    static func json(_ req: URLRequest) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: req.httpBody ?? Data()) as? [String: Any])
    }

    @Test func signInCarriesTheChallengeCookieAndKeepsTheSession() async throws {
        let server = StubServer()
        server.on { req in
            switch req.url?.path() {
            case PasskeyAuth.Endpoint.authenticateOptions:
                .status(200, headers: ["Set-Cookie": Self.challengeSetCookie, "Content-Type": "application/json"],
                        body: Self.authOptions)
            case PasskeyAuth.Endpoint.verifyAuthentication:
                .status(200, headers: ["Set-Cookie": Self.sessionSetCookie], body: Data(#"{"session":{},"user":{}}"#.utf8))
            default: .status(404)
            }
        }
        let store = InMemorySessionStore()
        let fake = FakeAuthenticator()
        let passkeys = PasskeyAuth(client: server.client(store: store), store: store, authenticator: fake)

        try await passkeys.signIn()

        let reqs = server.requests
        #expect(reqs.count == 2)
        #expect(reqs[0].httpMethod == "GET")
        #expect(reqs[0].url?.path() == "/api/auth/passkey/generate-authenticate-options")
        #expect(reqs[1].httpMethod == "POST")
        #expect(reqs[1].url?.path() == "/api/auth/passkey/verify-authentication")
        #expect(reqs[1].value(forHTTPHeaderField: "Cookie") == Self.challengeCookiePair)
        #expect(reqs[1].value(forHTTPHeaderField: "Origin") == server.base.absoluteString)
        #expect(reqs[1].value(forHTTPHeaderField: "x-verder-trust-device") == "1")
        let body = try Self.json(reqs[1])
        let response = try #require(body["response"] as? [String: Any])
        #expect(response["id"] as? String == "AQID")
        #expect(response["type"] as? String == "public-key")

        #expect(fake.assertions.first?.challenge == Data("foo".utf8))
        #expect(fake.assertions.first?.rpID == "verder.vanderpoel.pro")
        #expect(store.load()?.value == "stok.sig")
    }

    /// No challenge cookie means the server could never match request 2 to
    /// request 1 — so Face ID is not even asked.
    @Test func signInWithoutChallengeCookieStopsBeforeFaceID() async {
        let server = StubServer()
        server.on { _ in .status(200, body: Self.authOptions) }
        let store = InMemorySessionStore()
        let fake = FakeAuthenticator()
        let passkeys = PasskeyAuth(client: server.client(store: store), store: store, authenticator: fake)

        await #expect(throws: PasskeyError.noChallengeCookie) { try await passkeys.signIn() }
        #expect(fake.assertions.isEmpty)
        #expect(server.requests.count == 1)
    }

    @Test func cancelledFaceIDPostsNothing() async {
        let server = StubServer()
        server.on { _ in .status(200, headers: ["Set-Cookie": Self.challengeSetCookie], body: Self.authOptions) }
        let store = InMemorySessionStore()
        let fake = FakeAuthenticator()
        fake.failWith = .cancelled
        let passkeys = PasskeyAuth(client: server.client(store: store), store: store, authenticator: fake)

        await #expect(throws: PasskeyError.cancelled) { try await passkeys.signIn() }
        #expect(server.requests.count == 1)
        #expect(store.load() == nil)
    }

    /// A verified passkey whose answer sets no session cookie is not a sign-in.
    @Test func verifiedWithoutSessionCookieIsNotSignedIn() async {
        let server = StubServer()
        server.on { req in
            req.url?.path() == PasskeyAuth.Endpoint.authenticateOptions
                ? .status(200, headers: ["Set-Cookie": Self.challengeSetCookie], body: Self.authOptions)
                : .status(200, body: Data("{}".utf8))
        }
        let store = InMemorySessionStore()
        let passkeys = PasskeyAuth(client: server.client(store: store), store: store, authenticator: FakeAuthenticator())

        await #expect(throws: PasskeyError.noSessionCookie) { try await passkeys.signIn() }
        #expect(store.load() == nil)
    }

    @Test func registerSendsSessionAndChallengeCookies() async throws {
        let server = StubServer()
        server.on { req in
            switch req.url?.path() {
            case PasskeyAuth.Endpoint.registerOptions:
                .status(200, headers: ["Set-Cookie": Self.challengeSetCookie], body: Self.registerOptions)
            case PasskeyAuth.Endpoint.verifyRegistration:
                .status(200, body: Data(#"{"id":"pk1","name":"iPhone"}"#.utf8))
            default: .status(404)
            }
        }
        let session = SessionCookie(name: "__Secure-better-auth.session_token", value: "stok.sig", expires: nil)
        let store = InMemorySessionStore(session)
        let fake = FakeAuthenticator()
        let passkeys = PasskeyAuth(client: server.client(store: store), store: store, authenticator: fake)

        try await passkeys.register(name: "verder op iPhone")

        let reqs = server.requests
        #expect(reqs.count == 2)
        #expect(reqs[0].httpMethod == "GET")
        #expect(reqs[0].url?.path() == "/api/auth/passkey/generate-register-options")
        // `name` stays OUT of the options query: there it would replace the
        // WebAuthn userName, and the iOS passkey picker would list "verder op
        // iPhone" where Martin's e-mail address belongs.
        #expect(reqs[0].url?.query()?.contains("name=") != true)
        #expect(reqs[0].url?.query()?.contains("authenticatorAttachment=platform") == true)
        #expect(reqs[0].value(forHTTPHeaderField: "Cookie") == "__Secure-better-auth.session_token=stok.sig")

        #expect(reqs[1].httpMethod == "POST")
        #expect(reqs[1].url?.path() == "/api/auth/passkey/verify-registration")
        #expect(reqs[1].value(forHTTPHeaderField: "Cookie")
                == "__Secure-better-auth.session_token=stok.sig; \(Self.challengeCookiePair)")
        let body = try Self.json(reqs[1])
        #expect(body["name"] as? String == "verder op iPhone")
        let response = try #require(body["response"] as? [String: Any])
        #expect((response["response"] as? [String: Any])?["attestationObject"] as? String == "CQ")

        #expect(fake.registrations.first?.userName == "martin@vanderpoel.pro")
        #expect(store.load() == session)
    }

    @Test func registerWithoutSessionAsksNothing() async {
        let server = StubServer()
        let fake = FakeAuthenticator()
        let store = InMemorySessionStore()
        let passkeys = PasskeyAuth(client: server.client(store: store), store: store, authenticator: fake)

        await #expect(throws: PasskeyError.notSignedIn) { try await passkeys.register(name: "x") }
        #expect(server.requests.isEmpty)
        #expect(fake.registrations.isEmpty)
    }

    /// better-auth's freshSessionMiddleware: registering needs a session
    /// younger than a day, and answers 403 SESSION_NOT_FRESH otherwise.
    @Test func staleSessionSurfacesAs403() async {
        let server = StubServer()
        server.on { _ in .status(403, body: Data(#"{"code":"SESSION_NOT_FRESH"}"#.utf8)) }
        let store = InMemorySessionStore(SessionCookie(name: "better-auth.session_token", value: "old", expires: nil))
        let fake = FakeAuthenticator()
        let passkeys = PasskeyAuth(client: server.client(store: store), store: store, authenticator: fake)

        await #expect(throws: APIError.rejected(403)) { try await passkeys.register(name: "x") }
        #expect(fake.registrations.isEmpty)
    }
}

@MainActor
struct AuthModelPasskeyTests {
    static func defaults() -> UserDefaults {
        UserDefaults(suiteName: "verder.tests.\(UUID().uuidString)")!
    }

    @Test func passkeySignInSignsIn() async {
        let server = StubServer()
        server.on { req in
            req.url?.path() == PasskeyAuth.Endpoint.authenticateOptions
                ? .status(200, headers: ["Set-Cookie": PasskeyAuthTests.challengeSetCookie], body: PasskeyAuthTests.authOptions)
                : .status(200, headers: ["Set-Cookie": PasskeyAuthTests.sessionSetCookie], body: Data("{}".utf8))
        }
        let store = InMemorySessionStore()
        let client = server.client(store: store)
        let model = AuthModel(client: client, store: store,
                              passkeys: PasskeyAuth(client: client, store: store, authenticator: PasskeyAuthTests.FakeAuthenticator()),
                              defaults: Self.defaults())

        await model.signInWithPasskey()

        #expect(model.isSignedIn)
        #expect(model.errorMessage == nil)
        // A passkey sign-in never offers a passkey.
        #expect(!model.passkeyOfferPending)
    }

    /// Martin pressing Cancel on Face ID is not an error to show him.
    @Test func cancelledPasskeyShowsNothing() async {
        let server = StubServer()
        server.on { _ in .status(200, headers: ["Set-Cookie": PasskeyAuthTests.challengeSetCookie], body: PasskeyAuthTests.authOptions) }
        let store = InMemorySessionStore()
        let client = server.client(store: store)
        let fake = PasskeyAuthTests.FakeAuthenticator()
        fake.failWith = .cancelled
        let model = AuthModel(client: client, store: store,
                              passkeys: PasskeyAuth(client: client, store: store, authenticator: fake),
                              defaults: Self.defaults())

        await model.signInWithPasskey()

        #expect(!model.isSignedIn)
        #expect(model.errorMessage == nil)
    }

    @Test func passwordSignInOffersAPasskeyOnceWhenNoneExists() async {
        let server = StubServer()
        server.on { req in
            req.url?.path() == PasskeyAuth.Endpoint.listPasskeys
                ? .status(200, body: Data("[]".utf8))
                : .status(200, headers: ["Set-Cookie": AuthModelTests.setCookie], body: Data("{}".utf8))
        }
        let store = InMemorySessionStore()
        let client = server.client(store: store)
        let defaults = Self.defaults()
        let model = AuthModel(client: client, store: store,
                              passkeys: PasskeyAuth(client: client, store: store, authenticator: PasskeyAuthTests.FakeAuthenticator()),
                              defaults: defaults)

        await model.signInWithPassword(email: "martin@vanderpoel.pro", password: "devpassdevpass")
        #expect(model.passkeyOfferPending)
        model.dismissPasskeyOffer()
        #expect(!model.passkeyOfferPending)

        // Signed out and in again: the offer was made once and is not repeated.
        let again = AuthModel(client: client, store: store,
                              passkeys: PasskeyAuth(client: client, store: store, authenticator: PasskeyAuthTests.FakeAuthenticator()),
                              defaults: defaults)
        await again.signInWithPassword(email: "martin@vanderpoel.pro", password: "devpassdevpass")
        #expect(!again.passkeyOfferPending)
    }

    @Test func noOfferWhenAPasskeyExists() async {
        let server = StubServer()
        server.on { req in
            req.url?.path() == PasskeyAuth.Endpoint.listPasskeys
                ? .status(200, body: Data(#"[{"id":"pk1"}]"#.utf8))
                : .status(200, headers: ["Set-Cookie": AuthModelTests.setCookie], body: Data("{}".utf8))
        }
        let store = InMemorySessionStore()
        let client = server.client(store: store)
        let model = AuthModel(client: client, store: store,
                              passkeys: PasskeyAuth(client: client, store: store, authenticator: PasskeyAuthTests.FakeAuthenticator()),
                              defaults: Self.defaults())

        await model.signInWithPassword(email: "martin@vanderpoel.pro", password: "devpassdevpass")
        #expect(model.isSignedIn)
        #expect(!model.passkeyOfferPending)
    }

    @Test func staleSessionAsksToSignInAgainBeforeAddingAPasskey() async {
        let server = StubServer()
        server.on { _ in .status(403, body: Data(#"{"code":"SESSION_NOT_FRESH"}"#.utf8)) }
        let store = InMemorySessionStore(SessionCookie(name: "better-auth.session_token", value: "old", expires: nil))
        let client = server.client(store: store)
        let model = AuthModel(client: client, store: store,
                              passkeys: PasskeyAuth(client: client, store: store, authenticator: PasskeyAuthTests.FakeAuthenticator()),
                              defaults: Self.defaults())

        await model.addPasskey()

        #expect(model.passkeyMessage == AuthModel.Copy.passkeyNeedsFreshSignIn)
        #expect(model.isSignedIn)
    }

    @Test func signOutForgetsTheSession() async {
        let server = StubServer()
        server.on { _ in .status(200, body: Data(#"{"success":true}"#.utf8)) }
        let store = InMemorySessionStore(SessionCookie(name: "better-auth.session_token", value: "tok", expires: nil))
        let client = server.client(store: store)
        let model = AuthModel(client: client, store: store,
                              passkeys: PasskeyAuth(client: client, store: store, authenticator: PasskeyAuthTests.FakeAuthenticator()),
                              defaults: Self.defaults())
        #expect(model.isSignedIn)

        await model.signOut()

        #expect(!model.isSignedIn)
        #expect(store.load() == nil)
        #expect(server.requests.first?.url?.path() == "/api/auth/sign-out")
    }

    /// Offline at sign-out still signs out locally: the phone must never be
    /// stuck holding a session Martin asked it to drop.
    @Test func signOutOfflineStillForgets() async {
        let server = StubServer()
        server.on { _ in .failure(.notConnectedToInternet) }
        let store = InMemorySessionStore(SessionCookie(name: "better-auth.session_token", value: "tok", expires: nil))
        let client = server.client(store: store)
        let model = AuthModel(client: client, store: store,
                              passkeys: PasskeyAuth(client: client, store: store, authenticator: PasskeyAuthTests.FakeAuthenticator()),
                              defaults: Self.defaults())

        await model.signOut()

        #expect(!model.isSignedIn)
        #expect(store.load() == nil)
    }
}
