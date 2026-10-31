import Foundation
import Synchronization
@testable import Verder

/// A URLProtocol that answers from a per-HOST table, so Swift Testing can run
/// the network tests in parallel: every test invents its own host
/// (`StubServer()` hands out `https://<uuid>.stub`) and only ever sees its own
/// requests.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    enum Reply: Sendable {
        case status(Int, headers: [String: String] = [:], body: Data = Data())
        /// A real redirect, delivered the way a server's would be: the loading
        /// system asks the session's delegate whether to follow it.
        case redirect(Int, location: String)
        case failure(URLError.Code)
    }

    typealias Handler = @Sendable (URLRequest) -> Reply

    private static let routes = Mutex<[String: Handler]>([:])
    private static let log = Mutex<[String: [URLRequest]]>([:])

    static func register(host: String, _ handler: @escaping Handler) {
        routes.withLock { $0[host] = handler }
    }

    static func requests(host: String) -> [URLRequest] {
        log.withLock { $0[host] ?? [] }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let host = url.host() else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        var seen = request
        // URLSession moves an upload body into a stream; read it back so the
        // test can look at what was sent.
        if seen.httpBody == nil, let stream = seen.httpBodyStream {
            seen.httpBody = Self.drain(stream)
        }
        Self.log.withLock { $0[host, default: []].append(seen) }
        let handler = Self.routes.withLock { $0[host] }
        let reply = handler?(seen) ?? .status(404)

        switch reply {
        case .status(let code, let headers, let body):
            let response = HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        case .redirect(let code, let location):
            let target = URL(string: location, relativeTo: url)!.absoluteURL
            let response = HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1",
                                           headerFields: ["Location": target.absoluteString])!
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: target), redirectResponse: response)
            // When the delegate refuses the redirect, the 3xx IS the final
            // response; when it follows, this instance has already been stopped
            // and these calls are ignored.
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
        case .failure(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        }
    }

    override func stopLoading() {}

    private static func drain(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}

/// One isolated fake server per test.
struct StubServer {
    let host = "\(UUID().uuidString.lowercased()).stub"
    var base: URL { URL(string: "https://\(host)")! }

    func on(_ handler: @escaping StubProtocol.Handler) {
        StubProtocol.register(host: host, handler)
    }

    var requests: [URLRequest] { StubProtocol.requests(host: host) }

    /// The app's own session configuration, with the stub in front of it — so
    /// the tests exercise the real no-cookie, no-redirect settings.
    func client(store: any SessionStore = InMemorySessionStore()) -> APIClient {
        let config = APIClient.sessionConfiguration()
        config.protocolClasses = [StubProtocol.self]
        return APIClient(base: base, session: APIClient.makeSession(configuration: config), store: store)
    }
}
