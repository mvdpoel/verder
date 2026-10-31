import Foundation

/// verder's HTTP client. Sign-in is better-auth's ordinary session cookie, kept
/// in the Keychain and attached here by hand — no bearer plugin, no change to
/// the server's session handling, and the session shows up in
/// /settings/security as one more device that can be revoked there.
///
/// THE KEYCHAIN IS THE ONLY PLACE A SESSION LIVES: the URLSession has no cookie
/// storage and does not set cookies, so a Set-Cookie can only become a session
/// by passing through `sessionCookie(from:url:)` and a `SessionStore`.
struct APIClient: Sendable {
    static let production = URL(string: "https://verder.vanderpoel.pro")!

    /// `TRUST_HEADER` in packages/auth/src/session-trust.ts. Exactly "1" gives a
    /// 30-day session instead of 12 hours; the phone is a trusted device.
    static let trustHeader = "x-verder-trust-device"

    let base: URL
    let session: URLSession
    let store: any SessionStore

    init(base: URL = APIClient.production, session: URLSession, store: any SessionStore) {
        self.base = base
        self.session = session
        self.store = store
    }

    /// The configuration every verder session starts from.
    static func sessionConfiguration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return config
    }

    static func makeSession(configuration: URLSessionConfiguration = sessionConfiguration()) -> URLSession {
        URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }

    /// `scheme://host[:port]` of the base — better-auth checks Origin on every
    /// state-changing auth call and rejects a missing one.
    var origin: String {
        var parts = URLComponents()
        parts.scheme = base.scheme
        parts.host = base.host()
        parts.port = base.port
        return parts.string ?? base.absoluteString
    }

    func request(_ path: String, method: String, body: Data?, contentType: String?) -> URLRequest {
        let url = URL(string: path, relativeTo: base)!.absoluteURL
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.httpBody = body
        req.httpShouldHandleCookies = false
        req.setValue(origin, forHTTPHeaderField: "Origin")
        req.setValue("1", forHTTPHeaderField: Self.trustHeader)
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let cookie = store.load() {
            req.setValue("\(cookie.name)=\(cookie.value)", forHTTPHeaderField: "Cookie")
        }
        return req
    }

    /// Returns only on 2xx; every other answer throws its `APIError`.
    func send(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let data: Data
        let response: URLResponse
        do {
            // The per-task delegate repeats the session's refusal, so a caller
            // that hands in some other URLSession still never follows a redirect.
            (data, response) = try await session.data(for: req, delegate: NoRedirects())
        } catch let error as URLError {
            throw APIError.transport("URLError \(error.code.rawValue)")
        } catch {
            throw APIError.transport(String(describing: error))
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("not an HTTP response")
        }
        if let error = APIError.from(status: http.statusCode) { throw error }
        return (data, http)
    }
}

/// Refuses every redirect. With nil, the 3xx itself becomes the task's final
/// response, which `APIError.from(status:)` maps to `.unauthorized`.
final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? {
        nil
    }
}

/// The better-auth session cookie in a response, or nil.
///
/// packages/auth sets no `cookiePrefix`, so the name is better-auth's default
/// `better-auth.session_token`, with the `__Secure-` prefix whenever the base
/// URL is https (production). The secure name wins when both are present.
/// An empty value is a deletion (sign-out sends Max-Age=0), never a session.
func sessionCookie(from response: HTTPURLResponse, url: URL) -> SessionCookie? {
    let headers = response.allHeaderFields.reduce(into: [String: String]()) { out, pair in
        if let k = pair.key as? String, let v = pair.value as? String { out[k] = v }
    }
    let cookies = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
    for name in SessionCookie.names {
        if let c = cookies.first(where: { $0.name == name }), !c.value.isEmpty {
            if let expires = c.expiresDate, expires <= Date() { return nil }
            return SessionCookie(name: c.name, value: c.value, expires: c.expiresDate)
        }
    }
    return nil
}
