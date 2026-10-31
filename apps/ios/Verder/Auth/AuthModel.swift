import Foundation
import Observation

/// Whether the app holds a session, and how it gets one.
@MainActor
@Observable
final class AuthModel {
    enum Copy {
        static let rateLimited = "Even wachten — te veel pogingen. Probeer het over een minuut opnieuw."
        static let wrongCredentials = "Dat werkte niet — controleer je e-mailadres en wachtwoord en probeer het nog eens."
        static let offline = "Geen verbinding met verder. Controleer je internet en probeer het opnieuw."
        static let generic = "Inloggen lukte niet. Probeer het over een moment opnieuw."
        static let passkeyFailed = "Inloggen met passkey lukte niet. Probeer het opnieuw, of log in met je wachtwoord."
        static let passkeyAlreadyOnDevice = "Er staat al een passkey voor verder op deze iPhone, via je iCloud-sleutelhanger. Je kunt er meteen mee inloggen."
        static let passkeyAdded = "Passkey toegevoegd. Voortaan log je in met Face ID."
        static let passkeyAddFailed = "Passkey toevoegen lukte niet. Probeer het over een moment opnieuw."
        /// better-auth registers a passkey only on a session younger than a day.
        static let passkeyNeedsFreshSignIn = "Log eerst opnieuw in; daarna kun je een passkey toevoegen."
    }

    /// Default label for a passkey registered on the phone, as
    /// /settings/security lists it.
    static let passkeyName = "verder op iPhone"
    private static let offerShownKey = "passkeyOfferShown"

    private(set) var isSignedIn: Bool
    /// Bumped by every successful sign-in. `isSignedIn` cannot say "a NEW
    /// session just arrived": when the server rejects a stored session (an
    /// upload answered 401), the app still holds it, so Martin re-signs in
    /// from the Scan tab while `isSignedIn` stays true. The upload queue
    /// resumes on this changing.
    private(set) var sessionGeneration = 0
    private(set) var isBusy = false
    private(set) var errorMessage: String?
    /// After a password sign-in with no passkey on the account yet: offer one,
    /// once per install.
    private(set) var passkeyOfferPending = false
    /// The outcome of adding a passkey, for the signed-in screen.
    private(set) var passkeyMessage: String?

    @ObservationIgnored let client: APIClient
    @ObservationIgnored let store: any SessionStore
    @ObservationIgnored let passkeys: PasskeyAuth
    @ObservationIgnored let defaults: UserDefaults

    init(client: APIClient, store: any SessionStore, passkeys: PasskeyAuth? = nil, defaults: UserDefaults = .standard) {
        self.client = client
        self.store = store
        self.passkeys = passkeys ?? PasskeyAuth(client: client, store: store, authenticator: PlatformPasskeyAuthenticator())
        self.defaults = defaults
        self.isSignedIn = store.load()?.isLive() ?? false
    }

    private struct PasswordBody: Encodable {
        let email: String
        let password: String
        /// The session's length is decided by the trust header the client sends
        /// (30 days); rememberMe keeps better-auth from also marking the cookie
        /// as a browser-session cookie with no expiry.
        let rememberMe = true
    }

    /// POST /api/auth/sign-in/email. One attempt per tap, never retried: the
    /// endpoint sits behind a 5/min better-auth rule and a 10/min/IP WAF rule.
    func signInWithPassword(email: String, password: String) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }

        do {
            let body = try JSONEncoder().encode(PasswordBody(email: email, password: password))
            let req = client.request("/api/auth/sign-in/email", method: "POST", body: body, contentType: "application/json")
            let (_, response) = try await client.send(req)
            guard let cookie = sessionCookie(from: response, url: response.url ?? req.url!) else {
                errorMessage = Copy.generic
                return
            }
            try store.save(cookie)
            isSignedIn = true
            sessionGeneration += 1
        } catch let error as APIError {
            errorMessage = Self.message(for: error)
            return
        } catch {
            errorMessage = Copy.generic
            return
        }
        await offerPasskeyIfNone()
    }

    /// Face ID, then the session. One attempt per tap, like the password.
    func signInWithPasskey() async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }

        do {
            try await passkeys.signIn()
            isSignedIn = true
            sessionGeneration += 1
        } catch PasskeyError.cancelled {
            // Martin closed the sheet; nothing to say.
        } catch let error as APIError {
            errorMessage = error == .unauthorized ? Copy.passkeyFailed : Self.message(for: error)
        } catch {
            errorMessage = Copy.passkeyFailed + "\n" + Self.diagnostic(error)
        }
    }

    /// Registers a passkey for the signed-in user.
    func addPasskey() async {
        guard !isBusy else { return }
        isBusy = true
        passkeyMessage = nil
        defer { isBusy = false }

        do {
            try await passkeys.register(name: Self.passkeyName)
            passkeyOfferPending = false
            passkeyMessage = Copy.passkeyAdded
        } catch PasskeyError.cancelled {
            // Martin closed the sheet; nothing to say.
        } catch PasskeyError.alreadyOnDevice {
            passkeyOfferPending = false
            passkeyMessage = Copy.passkeyAlreadyOnDevice
        } catch APIError.rejected(403), APIError.unauthorized, PasskeyError.notSignedIn {
            passkeyMessage = Copy.passkeyNeedsFreshSignIn
        } catch APIError.rateLimited {
            passkeyMessage = Copy.rateLimited
        } catch APIError.transport {
            passkeyMessage = Copy.offline
        } catch {
            passkeyMessage = Copy.passkeyAddFailed + "\n" + Self.diagnostic(error)
        }
    }

    /// A short, secret-free cause under a generic failure, e.g.
    /// `ASAuthorizationError 1004` or `PasskeyError.noChallengeCookie`. Without it
    /// "lukte niet" is all the phone can tell anyone, and nothing logs on the
    /// server side (measured 2026-10-31: the first real passkey attempt failed
    /// and left no trace anywhere).
    static func diagnostic(_ error: any Error) -> String {
        if error is PasskeyError || error is APIError {
            return "(\(String(describing: type(of: error))).\(error))"
        }
        let ns = error as NSError
        let domain = ns.domain.split(separator: ".").last.map(String.init) ?? ns.domain
        return "(\(domain) \(ns.code))"
    }

    func dismissPasskeyOffer() {
        passkeyOfferPending = false
    }

    /// Ends the session on the server when it can, and ALWAYS forgets it here:
    /// a phone that could not reach verder must still drop what Martin asked
    /// it to drop. A session left alive server-side expires on its own and
    /// can be revoked from /settings/security.
    func signOut() async {
        let req = client.request("/api/auth/sign-out", method: "POST", body: Data("{}".utf8), contentType: "application/json")
        _ = try? await client.send(req)
        store.clear()
        isSignedIn = false
        passkeyOfferPending = false
        passkeyMessage = nil
    }

    /// The server answered 401 to a call that needs the session (the push
    /// registration): forget it here and show sign-in. No sign-out request —
    /// the server already holds no such session.
    func sessionRejected() {
        store.clear()
        isSignedIn = false
        passkeyOfferPending = false
        passkeyMessage = nil
    }

    /// The offer is made at most once per install, and only when the account
    /// has no passkey at all — one made in Safari on this phone already works
    /// here. A failed lookup offers nothing: an offer is never worth an error.
    private func offerPasskeyIfNone() async {
        guard !defaults.bool(forKey: Self.offerShownKey) else { return }
        guard let has = try? await passkeys.hasAnyPasskey(), !has else { return }
        defaults.set(true, forKey: Self.offerShownKey)
        passkeyOfferPending = true
    }

    static func message(for error: APIError) -> String {
        switch error {
        case .rateLimited: Copy.rateLimited
        case .unauthorized: Copy.wrongCredentials
        case .transport: Copy.offline
        case .server, .rejected: Copy.generic
        }
    }
}
