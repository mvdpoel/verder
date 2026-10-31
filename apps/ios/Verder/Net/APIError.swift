import Foundation

/// Every way a call to verder can fail, as the app needs to tell them apart.
enum APIError: Error, Equatable, Sendable {
    /// 401, OR ANY 3xx. The client never follows a redirect: an expired session
    /// on a page route answers 307 → /login and /login answers 200, so a
    /// followed redirect reads as success and would mark a scan sent that never
    /// arrived. A redirect from verder's API therefore means "not signed in".
    case unauthorized
    /// 429 — better-auth's own limit or the Cloudflare WAF rule on /api/auth/*
    /// (10/min/IP). Never retried in a loop: every retry re-arms the limit.
    case rateLimited
    /// ≥ 500. Worth retrying later.
    case server(Int)
    /// Any other 4xx (400, 403, 413, …). The request itself was refused, so
    /// sending the same bytes again will not help.
    case rejected(Int)
    /// No HTTP answer at all: offline, DNS, TLS, timeout.
    case transport(String)

    /// nil for 2xx.
    static func from(status: Int) -> APIError? {
        switch status {
        case 200..<300: nil
        case 300..<400, 401: .unauthorized
        case 429: .rateLimited
        case 500...: .server(status)
        default: .rejected(status)
        }
    }
}
