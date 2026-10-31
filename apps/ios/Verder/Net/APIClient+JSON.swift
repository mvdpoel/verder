import Foundation

/// JSON over verder's mobile routes, on top of `send`: the same cookie, Origin
/// and trust header, and the same `APIError` mapping (401 and any 3xx →
/// `.unauthorized`, 409 → `.rejected(409)`, …).
extension APIClient {
    func getJSON<T: Decodable>(_ path: String) async throws -> T {
        var req = request(path, method: "GET", body: nil, contentType: nil)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, _) = try await send(req)
        return try Self.decode(data)
    }

    func postJSON<B: Encodable, T: Decodable>(_ path: String, _ body: B) async throws -> T {
        let encoded: Data
        do { encoded = try Self.jsonEncoder.encode(body) } catch {
            throw APIError.transport("could not encode the request: \(error)")
        }
        var req = request(path, method: "POST", body: encoded, contentType: "application/json")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, _) = try await send(req)
        return try Self.decode(data)
    }

    /// A 2xx whose body is not the expected shape did not answer the question,
    /// so it is not a success. Reported as `.transport` (no usable answer),
    /// never as a decoded default.
    static func decode<T: Decodable>(_ data: Data) throws -> T {
        do { return try jsonDecoder.decode(T.self, from: data) } catch {
            throw APIError.transport("unexpected response: \(error)")
        }
    }

    static var jsonEncoder: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }

    /// ISO 8601, with OR without fractional seconds: Next's `NextResponse.json`
    /// writes a Date through `toISOString()` (always milliseconds), which the
    /// stock `.iso8601` strategy refuses.
    static var jsonDecoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            let s = try c.decode(String.self)
            if let date = parseISODate(s) { return date }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "not an ISO 8601 date: \(s)")
        }
        return d
    }
}

/// ISO 8601 with or without fractional seconds; nil for anything else.
func parseISODate(_ s: String) -> Date? {
    let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    if let d = try? fractional.parse(s) { return d }
    return try? Date.ISO8601FormatStyle().parse(s)
}
