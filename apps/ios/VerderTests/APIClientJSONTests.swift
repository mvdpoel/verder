import Testing
import Foundation
@testable import Verder

struct APIClientJSONTests {
    struct Echo: Codable, Equatable { let name: String; let at: Date }
    struct Body: Encodable { let revision: Int }

    static let cookie = SessionCookie(name: "__Secure-better-auth.session_token", value: "tok.sig", expires: nil)

    /// Next's `NextResponse.json` serialises a Date with milliseconds
    /// (`toISOString()`); the default `.iso8601` strategy refuses that.
    @Test func getJSONDecodesDatesWithAndWithoutFractionalSeconds() async throws {
        let server = StubServer()
        server.on { req in
            let body = req.url?.path() == "/ms"
                ? #"{"name":"a","at":"2026-10-30T09:20:01.123Z"}"#
                : #"{"name":"b","at":"2026-10-30T09:20:01Z"}"#
            return .status(200, headers: ["Content-Type": "application/json"], body: Data(body.utf8))
        }
        let client = server.client(store: InMemorySessionStore(Self.cookie))
        let a: Echo = try await client.getJSON("/ms")
        let b: Echo = try await client.getJSON("/plain")
        #expect(a.name == "a")
        #expect(abs(a.at.timeIntervalSince1970 - 1_793_352_001.123) < 0.001)
        #expect(b.at.timeIntervalSince1970 == 1_793_352_001)
        let req = try #require(server.requests.first)
        #expect(req.httpMethod == "GET")
        #expect(req.value(forHTTPHeaderField: "Accept") == "application/json")
        #expect(req.value(forHTTPHeaderField: "Cookie") == "__Secure-better-auth.session_token=tok.sig")
    }

    @Test func getJSONMaps401ToUnauthorized() async {
        let server = StubServer()
        server.on { _ in .status(401, body: Data(#"{"error":"unauthorized"}"#.utf8)) }
        let client = server.client()
        await #expect(throws: APIError.unauthorized) {
            let _: Echo = try await client.getJSON("/api/mobile/v1/proposals")
        }
    }

    @Test func postJSONSendsAJSONBody() async throws {
        let server = StubServer()
        server.on { _ in .status(200, body: Data(#"{"name":"ok","at":"2026-10-30T09:20:01.000Z"}"#.utf8)) }
        let client = server.client()
        let _: Echo = try await client.postJSON("/api/mobile/v1/x", Body(revision: 3))
        let req = try #require(server.requests.first)
        #expect(req.httpMethod == "POST")
        #expect(req.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let body = try #require(req.httpBody)
        let sent = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        #expect(sent?["revision"] as? Int == 3)
    }

    @Test func postJSONMaps409ToRejected() async {
        let server = StubServer()
        server.on { _ in .status(409, body: Data(#"{"error":"proposal is at revision 2, not 1"}"#.utf8)) }
        let client = server.client()
        await #expect(throws: APIError.rejected(409)) {
            let _: Echo = try await client.postJSON("/api/mobile/v1/x", Body(revision: 1))
        }
    }

    /// A 200 whose body is not the expected shape is not a success.
    @Test func undecodableBodyIsATransportError() async throws {
        let server = StubServer()
        server.on { _ in .status(200, body: Data("<html>".utf8)) }
        let client = server.client()
        do {
            let _: Echo = try await client.getJSON("/x")
            Issue.record("expected an error")
        } catch let error as APIError {
            guard case .transport = error else { Issue.record("got \(error)"); return }
        }
    }
}
