import Foundation

/// `POST /api/mobile/v1/documents`'s answer (apps/web/src/app/api/mobile/v1/documents/route.ts).
struct UploadResponse: Decodable, Equatable, Sendable {
    let id: String
    let duplicate: Bool
}

/// The phone upload request, shared by the queue's background uploads, the
/// Meer tab's same-clientId resend and the share extension's one foreground
/// attempt, so the three can never disagree about the form.
enum UploadRequest {
    static let path = "/api/mobile/v1/documents"

    /// The request (cookie, Origin, trust header, multipart Content-Type and an
    /// explicit Content-Length — the route answers 411 without one) and its body.
    ///
    /// The part carries the item's OWN mime (`resolvedMime`) and file name: a
    /// shared `.xlsx` labelled `application/pdf` would be stored as a PDF.
    /// `mime` overrides it only for the debug resend, which sends a fresh PDF.
    static func build(_ item: UploadItem, file: Data, mime: String? = nil,
                      client: APIClient) -> (URLRequest, Data) {
        let boundary = Multipart.makeBoundary()
        var fields = [("clientId", item.clientId), ("source", item.source),
                      ("capturedAt", item.capturedAt.formatted(.iso8601))]
        // Martin's "iets bijzonders?". The route does not read it yet; it
        // travels with the scan so nothing is lost when it does.
        if let note = item.note, !note.isEmpty { fields.append(("note", note)) }
        let body = multipartBody(
            boundary: boundary,
            fields: fields,
            file: (name: "file", fileName: item.fileName, mime: Multipart.safeMediaType(mime ?? item.resolvedMime), data: file))
        var req = client.request(path, method: "POST", body: nil, contentType: Multipart.contentType(boundary: boundary))
        req.setValue(String(body.count), forHTTPHeaderField: "Content-Length")
        return (req, body)
    }
}

/// What one upload's answer means for the queue.
enum UploadOutcome {
    /// Success only for a 2xx FROM THE URL THE SCAN WAS SENT TO, carrying the
    /// endpoint's JSON.
    ///
    /// A background URLSession follows redirects by itself — Apple documents
    /// that its delegate is never asked — so the `NoRedirects` refusal the
    /// APIClient relies on does not hold there, and a 307 → /login → 200 would
    /// arrive as a 200. That would mark a scan sent that never arrived. A
    /// final URL other than the one sent to is therefore "not signed in",
    /// exactly as a 3xx is in `APIError.from(status:)`. A 2xx without the JSON
    /// is not proof of arrival either; it is retried, which the clientId makes
    /// safe.
    static func judge(sentTo: URL?, response: URLResponse?, body: Data,
                      error: (any Error)?) -> Result<UploadResponse, APIError> {
        if let error {
            if let e = error as? URLError { return .failure(.transport("URLError \(e.code.rawValue)")) }
            return .failure(.transport(String(describing: error)))
        }
        guard let http = response as? HTTPURLResponse else { return .failure(.transport("not an HTTP response")) }
        if let sentTo, let final = http.url, final.host() != sentTo.host() || final.path() != sentTo.path() {
            return .failure(.unauthorized)
        }
        if let error = APIError.from(status: http.statusCode) { return .failure(error) }
        guard let answer = try? JSONDecoder().decode(UploadResponse.self, from: body) else {
            return .failure(.server(http.statusCode))
        }
        return .success(answer)
    }
}
