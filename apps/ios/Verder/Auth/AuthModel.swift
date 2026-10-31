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
    }

    private(set) var isSignedIn: Bool
    private(set) var isBusy = false
    private(set) var errorMessage: String?

    @ObservationIgnored let client: APIClient
    @ObservationIgnored let store: any SessionStore

    init(client: APIClient, store: any SessionStore) {
        self.client = client
        self.store = store
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
        } catch let error as APIError {
            errorMessage = Self.message(for: error)
        } catch {
            errorMessage = Copy.generic
        }
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
