import Foundation

/// `multipart/form-data` (RFC 7578) for the phone's upload, built by hand: one
/// body, a few text fields and one file. Foundation has no encoder for it, and
/// a dependency for forty lines would be the wrong trade.
enum Multipart {
    /// Letters, digits and dashes only, and unique per request, so it can never
    /// occur inside a field value or (with overwhelming odds) the PDF bytes.
    static func makeBoundary() -> String {
        "verder-\(UUID().uuidString)"
    }

    static func contentType(boundary: String) -> String {
        "multipart/form-data; boundary=\(boundary)"
    }

    /// A quoted header parameter cannot contain `"`, CR or LF without ending
    /// the header (and letting the rest of the value write headers or parts of
    /// its own). They are percent-encoded, which is what browsers send
    /// (WHATWG's multipart/form-data encoding), and undici's parser decodes.
    static func quoted(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\"", with: "%22")
            .replacingOccurrences(of: "\r", with: "%0D")
            .replacingOccurrences(of: "\n", with: "%0A")
    }
}

func multipartBody(boundary: String, fields: [(String, String)],
                   file: (name: String, fileName: String, mime: String, data: Data)) -> Data {
    var body = Data()
    func line(_ s: String) { body.append(Data((s + "\r\n").utf8)) }
    for (name, value) in fields {
        line("--\(boundary)")
        line("Content-Disposition: form-data; name=\"\(Multipart.quoted(name))\"")
        line("")
        line(value)
    }
    line("--\(boundary)")
    line("Content-Disposition: form-data; name=\"\(Multipart.quoted(file.name))\"; filename=\"\(Multipart.quoted(file.fileName))\"")
    line("Content-Type: \(file.mime)")
    line("")
    body.append(file.data)
    line("")
    line("--\(boundary)--")
    return body
}
