import Foundation
import Observation
import WidgetKit

/// Whether the app holds a session, and how it gets one.
@MainActor
@Observable
final class AuthModel {
    enum Copy {
        static let rateLimited = "Even wachten — te veel pogingen. Probeer het over een minuut opnieuw."
        static let wrongCredentials = "Dat werkte niet — controleer je e-mailadres en wachtwoord en probeer het nog eens."
        static let offline = "Geen verbinding met verder. Controleer je internet en probeer het opnieuw."
        static let generic = "Inloggen lukte niet. Probeer het over een moment opnieuw."
        // The UI says "toegangssleutel", never the English "passkey" (design brief).
        static let passkeyFailed = "Inloggen met toegangssleutel lukte niet. Probeer het opnieuw, of log in met je wachtwoord."
        static let passkeyAlreadyOnDevice = "Er staat al een toegangssleutel voor verder op deze iPhone, via je iCloud-sleutelhanger. Je kunt er meteen mee inloggen."
        static let passkeyAdded = "Toegangssleutel toegevoegd. Voortaan log je in met Face ID."
        static let passkeyAddFailed = "Toegangssleutel toevoegen lukte niet. Probeer het over een moment opnieuw."
        /// better-auth registers a passkey only on a session younger than a day.
        static let passkeyNeedsFreshSignIn = "Log eerst opnieuw in; daarna kun je een toegangssleutel toevoegen."
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
    /// The server ended the session (a 401), as opposed to Martin signing out
    /// or a first launch: the sign-in screen then says "Je sessie is verlopen."
    /// Cleared by the next sign-in and by an explicit sign-out.
    private(set) var sessionExpired = false
    /// After a password sign-in with no passkey on the account yet: offer one,
    /// once per install.
    private(set) var passkeyOfferPending = false
    /// The outcome of adding a passkey, for the signed-in screen.
    private(set) var passkeyMessage: String?
    /// Bumped when a toegangssleutel was registered: the `.success` haptic.
    private(set) var passkeyAddedCount = 0
    /// A sign-out that reached no server: its session is still alive there
    /// and is revoked the moment the phone reaches verder again
    /// (`retryPendingSignOut`). Meer's offline sheet promises exactly that.
    private(set) var signOutPending: Bool

    @ObservationIgnored let client: APIClient
    @ObservationIgnored let store: any SessionStore
    @ObservationIgnored let passkeys: PasskeyAuth
    @ObservationIgnored let defaults: UserDefaults
    /// Moved by every way out (`forgetLocally`); every store holding case
    /// content checks it after each await (`SessionEpoch`).
    @ObservationIgnored let epoch: SessionEpoch
    /// The App Group dir holding the widget's snapshot (the top five titles
    /// and the map headline). Erased on sign-out and on a rejected session.
    @ObservationIgnored private let widgetSnapshotDir: URL?
    @ObservationIgnored private let reloadWidgets: @MainActor () -> Void
    /// Where the cookie of an offline sign-out waits to be revoked. Its own
    /// Keychain item in the live app, so a new sign-in never overwrites it.
    @ObservationIgnored let pendingSignOut: any SessionStore

    init(client: APIClient, store: any SessionStore, passkeys: PasskeyAuth? = nil, defaults: UserDefaults = .standard,
         widgetSnapshotDir: URL? = nil,
         reloadWidgets: @escaping @MainActor () -> Void = { WidgetCenter.shared.reloadAllTimelines() },
         epoch: SessionEpoch = SessionEpoch(),
         pendingSignOut: any SessionStore = InMemorySessionStore()) {
        self.client = client
        self.pendingSignOut = pendingSignOut
        self.signOutPending = pendingSignOut.load() != nil
        self.epoch = epoch
        self.store = store
        self.passkeys = passkeys ?? PasskeyAuth(client: client, store: store, authenticator: PlatformPasskeyAuthenticator())
        self.defaults = defaults
        self.widgetSnapshotDir = widgetSnapshotDir
        self.reloadWidgets = reloadWidgets
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
            sessionExpired = false
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
            sessionExpired = false
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
            passkeyAddedCount += 1
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
    ///
    /// When NO HTTP answer came back (offline), the cookie is kept aside in
    /// `pendingSignOut` and the sign-out is sent again by
    /// `retryPendingSignOut` once verder answers — until then the session
    /// lives on the server and its pushes still arrive, which is what the
    /// offline sheet says. Any HTTP answer (even an error) ends the wait: the
    /// server either revoked it or never knew it.
    func signOut() async {
        let cookie = store.load()
        let req = client.request("/api/auth/sign-out", method: "POST", body: Data("{}".utf8), contentType: "application/json")
        do {
            _ = try await client.send(req)
        } catch APIError.transport {
            if let cookie {
                try? pendingSignOut.save(cookie)
                signOutPending = true
            }
        } catch {}
        sessionExpired = false
        forgetLocally()
    }

    /// The offline sign-out's second half: revoke the kept session with its
    /// own cookie. Called when the app comes to the front and when the network
    /// returns; a repeat while one is running is harmless (sign-out is
    /// idempotent on the server).
    func retryPendingSignOut() async {
        guard let cookie = pendingSignOut.load() else { signOutPending = false; return }
        let revoker = APIClient(base: client.base, session: client.session, store: InMemorySessionStore(cookie))
        let req = revoker.request("/api/auth/sign-out", method: "POST", body: Data("{}".utf8),
                                  contentType: "application/json")
        do {
            _ = try await revoker.send(req)
        } catch APIError.transport {
            return
        } catch {}
        // Only the cookie this attempt sent: a newer offline sign-out that
        // landed meanwhile keeps waiting.
        if pendingSignOut.load() == cookie {
            pendingSignOut.clear()
            signOutPending = false
        }
    }

    /// The server answered 401 to a call that needs the session (the push
    /// registration): forget it here and show sign-in. No sign-out request —
    /// the server already holds no such session.
    func sessionRejected() {
        if isSignedIn { sessionExpired = true }
        forgetLocally()
    }

    /// Both ways out end here. The widget's snapshot goes with the session:
    /// the home-screen widget draws titles and the headline from it, and a
    /// phone signed out (or revoked after it was lost) must stop showing the
    /// case — the same reason the pocket dossier is wiped.
    ///
    /// Ending the epoch is what makes that stick: every store forgets its
    /// case content in its `whenEnded` (inbox, summary and badge 0; money;
    /// the dossier with its query and server hits), and a refresh still
    /// waiting on the network finds the epoch moved and writes nothing back.
    private func forgetLocally() {
        store.clear()
        isSignedIn = false
        passkeyOfferPending = false
        passkeyMessage = nil
        epoch.end()
        if let widgetSnapshotDir {
            WidgetSnapshot.erase(in: widgetSnapshotDir)
            reloadWidgets()
        }
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
