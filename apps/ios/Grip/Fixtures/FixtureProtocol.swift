#if DEBUG
import Foundation
import Synchronization

/// The URLProtocol the fixture session answers through. Installed ONLY on the
/// URLSession `FixtureEnvironment` builds (its `protocolClasses`), never
/// registered globally, so nothing else in the process is intercepted.
///
/// The fixture's name rides in the host (`<name>.fixtures.grip.invalid`), so
/// the protocol holds no state and parallel tests on different fixtures never
/// see each other. `.invalid` is reserved (RFC 2606): a request that somehow
/// escaped the protocol could not resolve to anything real.
final class FixtureProtocol: URLProtocol, @unchecked Sendable {
    static let hostSuffix = ".fixtures.grip.invalid"
    /// "<fixture>|<path>" for every path answered once — the only state, and
    /// only `thenFail` fixtures act on it (`FixtureServer.reply(answeredBefore:)`).
    private static let answered = Mutex<Set<String>>([])
    /// Whether a repeat has been failed (`thenFail`) in this process: the
    /// moment a kept stand becomes a kept stand (`FixtureEnvironment.clock(keptAt:)`).
    private static let failedRepeat = Mutex(false)
    static var hasFailedRepeat: Bool { failedRepeat.withLock { $0 } }

    static func base(for fixture: String) -> URL {
        URL(string: "https://\(fixture)\(hostSuffix)")!
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host()?.hasSuffix(hostSuffix) ?? false
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let host = url.host(), host.hasSuffix(Self.hostSuffix),
              let root = FixtureServer.bundledRoot,
              let server = FixtureServer(name: String(host.dropLast(Self.hostSuffix.count)), root: root) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        let path = url.path(percentEncoded: false)
        let key = "\(server.name)|\(path)"
        let before = Self.answered.withLock { !$0.insert(key).inserted }
        let reply = server.reply(method: request.httpMethod ?? "GET", path: path,
                                 query: url.query(percentEncoded: false), answeredBefore: before)
        if before, server.manifest.thenFail != nil, reply == .transportFailure || reply.isError {
            Self.failedRepeat.withLock { $0 = true }
        }
        switch reply {
        case .never:
            break
        case .transportFailure:
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
        case .json(let status, let body):
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json",
                                                          "Cache-Control": "no-store"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        case .file(let type, let body):
            if let delay = server.manifest.fileDelay, delay > 0 {
                DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [self] in
                    Self.deliver(self, client: self.client, url: url, type: type, body: body)
                }
                return
            }
            Self.deliver(self, client: client, url: url, type: type, body: body)
        }
    }

    private static func deliver(_ proto: URLProtocol, client: (any URLProtocolClient)?, url: URL, type: String, body: Data) {
        do {
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": type, "Cache-Control": "no-store",
                                                          "X-Content-Type-Options": "nosniff"])!
            client?.urlProtocol(proto, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(proto, didLoad: body)
            client?.urlProtocolDidFinishLoading(proto)
        }
    }

    override func stopLoading() {}
}
#endif
