import Foundation
import AuthenticationServices
import UIKit

// WHAT THE SERVER EXPECTS — read from @better-auth/passkey 1.7.0
// (node_modules/.pnpm/@better-auth+passkey@1.7.0_…/node_modules/@better-auth/passkey/dist/index.mjs)
// and better-auth 1.7.0 / better-call 1.4.0, 2026-10-31. packages/auth configures
// the plugin with rpID = PASSKEY_RP_ID, rpName "Verder", origin = APP_URL.
// All paths sit under better-auth's /api/auth mount.
//
// Sign in (no session needed):
//   1. GET  /api/auth/passkey/generate-authenticate-options       (no query, no body)
//      → 200 PublicKeyCredentialRequestOptionsJSON
//        { rpId, challenge, timeout, userVerification: "preferred", allowCredentials? }
//        allowCredentials is present only when the request already carries a
//        session; without one the list is empty and iOS offers every passkey
//        it holds for the RP (discoverable credentials).
//      + Set-Cookie: <challenge cookie>=<token>.<HMAC>; Max-Age=300; HttpOnly; SameSite=Lax
//   2. POST /api/auth/passkey/verify-authentication
//      body { "response": AuthenticationResponseJSON }   (zod: z.record)
//      Cookie: <challenge cookie> from step 1 — REQUIRED, or 400 CHALLENGE_NOT_FOUND.
//      → 200 { session, user } + Set-Cookie: the session cookie (setSessionCookie).
//      The session row goes through packages/auth's databaseHooks.session.create,
//      so x-verder-trust-device: 1 (APIClient sends it) gives the 30-day session.
//      better-auth rate-limits this path at 10/min (packages/auth customRules).
//
// Register (session REQUIRED, and FRESH — freshSessionMiddleware: the session
// must be younger than session.freshAge, better-auth's default 1 day, which
// packages/auth does not override; else 403 SESSION_NOT_FRESH):
//   3. GET  /api/auth/passkey/generate-register-options?authenticatorAttachment=platform
//      Optional query `name` would REPLACE the WebAuthn user.name — the account
//      label in iOS's passkey picker — so the app does not send it there.
//      → 200 PublicKeyCredentialCreationOptionsJSON
//        { challenge, rp{name,id}, user{id(base64url),name,displayName},
//          pubKeyCredParams, excludeCredentials, authenticatorSelection, attestation: "none" }
//      + Set-Cookie: <challenge cookie>, as in step 1.
//   4. POST /api/auth/passkey/verify-registration
//      body { "response": RegistrationResponseJSON, "name"?: String, "createSession"?: Bool }
//      Cookie: the session cookie AND the challenge cookie from step 3.
//      → 200 the new passkey row. No new session unless createSession: true.
//
// HOW THE CHALLENGE TRAVELS: not in the body. Step 1/3 stores
// { expectedChallenge, type, userData } server-side under a random 32-char
// token and sets that token as a SIGNED cookie (better-call
// serializeSignedCookie: "<token>.<base64 HMAC-SHA256>", URL-encoded). Step 2/4
// reads it back with getSignedCookie and CONSUMES the verification row, so a
// challenge is single-use and lives 300 s. The cookie is
// `createAuthCookie("better-auth-passkey")` = cookiePrefix "better-auth" + "." +
// the name, with "__Secure-" in front whenever baseURL is https. APIClient's
// URLSession keeps NO cookies (by design: the Keychain is the only place a
// session lives), so this file carries the cookie from response 1 into
// request 2 by hand. Its value is forwarded byte-for-byte, never decoded.
//
// Origin: verify-* compare clientDataJSON.origin against the plugin's `origin`
// option (APP_URL), NOT the request's Origin header. For a native app with the
// `webcredentials:` associated domain, iOS writes "https://<rpId>" there, so
// APP_URL must be exactly https://verder.vanderpoel.pro (no trailing slash).

/// Every way a passkey ceremony ends short of a session.
enum PasskeyError: Error, Equatable, Sendable {
    /// Martin closed the Face ID sheet. Not an error to show him.
    case cancelled
    /// The options answer set no challenge cookie; request 2 could never match.
    case noChallengeCookie
    /// Verified, but the answer set no session cookie.
    case noSessionCookie
    /// Options JSON missing a field or with a challenge that is not base64url.
    case badOptions
    /// Registering needs a session.
    case notSignedIn
    /// iOS returned a registration without an attestation object.
    case noAttestation
    /// AuthenticationServices refused: no passkey for this RP, the associated
    /// domain does not validate, Face ID failed, …
    case failed(String)
}

/// The Face ID step, abstracted so the HTTP half is testable.
@MainActor
protocol PasskeyAuthenticator {
    func assert(_ options: AssertionOptions) async throws -> AssertionValues
    func register(_ options: RegistrationOptions) async throws -> RegistrationValues
}

@MainActor
final class PasskeyAuth {
    enum Endpoint {
        static let authenticateOptions = "/api/auth/passkey/generate-authenticate-options"
        static let verifyAuthentication = "/api/auth/passkey/verify-authentication"
        static let registerOptions = "/api/auth/passkey/generate-register-options"
        static let verifyRegistration = "/api/auth/passkey/verify-registration"
        static let listPasskeys = "/api/auth/passkey/list-user-passkeys"
    }

    /// In order of preference, as `SessionCookie.names`: production is https.
    static let challengeCookieNames = ["__Secure-better-auth.better-auth-passkey", "better-auth.better-auth-passkey"]

    let client: APIClient
    let store: any SessionStore
    let authenticator: any PasskeyAuthenticator

    init(client: APIClient, store: any SessionStore, authenticator: any PasskeyAuthenticator) {
        self.client = client
        self.store = store
        self.authenticator = authenticator
    }

    /// Steps 1–2. On success the session is in the store.
    func signIn() async throws {
        var optionsReq = client.request(Endpoint.authenticateOptions, method: "GET", body: nil, contentType: nil)
        // Whatever the store still holds is not a session we are signing in with.
        optionsReq.setValue(nil, forHTTPHeaderField: "Cookie")
        let (optionsBody, optionsResponse) = try await client.send(optionsReq)
        let challenge = try challengeCookie(optionsResponse, optionsReq)
        let options = try AssertionOptions.decode(optionsBody)

        let assertion = try await authenticator.assert(options)

        guard let json = authenticationJSON(assertion) else { throw PasskeyError.failed("assertion without signature") }
        let body = try JSONSerialization.data(withJSONObject: ["response": json])
        var verifyReq = client.request(Endpoint.verifyAuthentication, method: "POST", body: body, contentType: "application/json")
        verifyReq.setValue(challenge.pair, forHTTPHeaderField: "Cookie")
        let (_, verifyResponse) = try await client.send(verifyReq)
        guard let session = sessionCookie(from: verifyResponse, url: verifyResponse.url ?? verifyReq.url!) else {
            throw PasskeyError.noSessionCookie
        }
        try store.save(session)
    }

    /// Steps 3–4, for the signed-in user. `name` labels the passkey in
    /// /settings/security.
    func register(name: String) async throws {
        guard let session = store.load(), session.isLive() else { throw PasskeyError.notSignedIn }

        var components = URLComponents()
        components.path = Endpoint.registerOptions
        components.queryItems = [URLQueryItem(name: "authenticatorAttachment", value: "platform")]
        let optionsReq = client.request(components.string!, method: "GET", body: nil, contentType: nil)
        let (optionsBody, optionsResponse) = try await client.send(optionsReq)
        let challenge = try challengeCookie(optionsResponse, optionsReq)
        let options = try RegistrationOptions.decode(optionsBody)

        let registration = try await authenticator.register(options)
        guard let json = registrationJSON(registration) else { throw PasskeyError.noAttestation }

        let body = try JSONSerialization.data(withJSONObject: ["response": json, "name": name] as [String: Any])
        var verifyReq = client.request(Endpoint.verifyRegistration, method: "POST", body: body, contentType: "application/json")
        verifyReq.setValue("\(session.name)=\(session.value); \(challenge.pair)", forHTTPHeaderField: "Cookie")
        _ = try await client.send(verifyReq)
    }

    /// Whether the signed-in user has any passkey at all (web or phone).
    func hasAnyPasskey() async throws -> Bool {
        let req = client.request(Endpoint.listPasskeys, method: "GET", body: nil, contentType: nil)
        let (data, _) = try await client.send(req)
        // Anything but an array is an answer we do not understand — "unknown",
        // never "none".
        guard let list = try JSONSerialization.jsonObject(with: data) as? [Any] else { throw PasskeyError.badOptions }
        return !list.isEmpty
    }

    private func challengeCookie(_ response: HTTPURLResponse, _ req: URLRequest) throws -> SessionCookie {
        guard let c = responseCookie(named: Self.challengeCookieNames, from: response, url: response.url ?? req.url!) else {
            throw PasskeyError.noChallengeCookie
        }
        return c
    }
}

private extension SessionCookie {
    var pair: String { "\(name)=\(value)" }
}

// MARK: - The real Face ID step

/// AuthenticationServices behind `PasskeyAuthenticator`. One ceremony at a
/// time; the controller's delegate callbacks resume the waiting call.
@MainActor
final class PlatformPasskeyAuthenticator: NSObject, PasskeyAuthenticator,
    ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {

    private var continuation: CheckedContinuation<ASAuthorization, any Error>?
    private var controller: ASAuthorizationController?

    func assert(_ options: AssertionOptions) async throws -> AssertionValues {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: options.rpID)
        let request = provider.createCredentialAssertionRequest(challenge: options.challenge)
        request.userVerificationPreference = .preferred
        request.allowedCredentials = options.allowCredentialIDs.map {
            ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
        }
        let authorization = try await perform(request)
        guard let c = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            throw PasskeyError.failed("unexpected credential \(type(of: authorization.credential))")
        }
        return AssertionValues(c)
    }

    func register(_ options: RegistrationOptions) async throws -> RegistrationValues {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: options.rpID)
        let request = provider.createCredentialRegistrationRequest(
            challenge: options.challenge, name: options.userName, userID: options.userID)
        request.userVerificationPreference = .preferred
        request.excludedCredentials = options.excludeCredentialIDs.map {
            ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
        }
        let authorization = try await perform(request)
        guard let c = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
            throw PasskeyError.failed("unexpected credential \(type(of: authorization.credential))")
        }
        return RegistrationValues(c)
    }

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        guard continuation == nil else { throw PasskeyError.failed("a passkey request is already open") }
        return try await withCheckedThrowingContinuation { cont in
            continuation = cont
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.controller = controller
            controller.performRequests()
        }
    }

    private func finish(_ result: Result<ASAuthorization, any Error>) {
        let cont = continuation
        continuation = nil
        controller = nil
        cont?.resume(with: result)
    }

    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithAuthorization authorization: ASAuthorization) {
        finish(.success(authorization))
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: any Error) {
        if let e = error as? ASAuthorizationError, e.code == .canceled {
            finish(.failure(PasskeyError.cancelled))
        } else {
            let ns = error as NSError
            finish(.failure(PasskeyError.failed("\(ns.domain) \(ns.code): \(ns.localizedDescription)")))
        }
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let key = scenes.flatMap(\.windows).first(where: \.isKeyWindow) { return key }
        if let any = scenes.first?.windows.first { return any }
        // A ceremony is only ever started by a tap, so a scene exists.
        guard let scene = scenes.first else { preconditionFailure("passkey ceremony without a window scene") }
        return ASPresentationAnchor(windowScene: scene)
    }
}
