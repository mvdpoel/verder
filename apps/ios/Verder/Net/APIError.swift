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

    /// The `.transport` that `APIClient.send` throws for `URLError.cancelled`:
    /// the CALLER gave up (SwiftUI cancelled a view's `.task`), so it says
    /// nothing about the network and must never read as "offline".
    static let cancelled = APIError.transport(transportDescription(URLError(.cancelled)))

    /// The one spelling of a URLError inside `.transport`.
    static func transportDescription(_ error: URLError) -> String { "URLError \(error.code.rawValue)" }

    /// True for any way a call can end because its caller stopped waiting.
    static func isCancellation(_ error: any Error) -> Bool {
        error is CancellationError || (error as? APIError) == .cancelled || (error as? URLError)?.code == .cancelled
    }

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
