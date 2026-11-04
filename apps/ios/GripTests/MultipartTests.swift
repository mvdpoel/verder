import Testing
import Foundation
@testable import Verder

struct MultipartTests {
    @Test func multipartContainsClientIdSourceAndFile() throws {
        let pdf = Data("%PDF-1.4 fake".utf8)
        let body = multipartBody(
            boundary: "B0UNDARY",
            fields: [("clientId", "6f1c2b9e-0d7a-4c3e-9a51-2f8b7c6d5e4f"), ("source", "phone-scan"),
                     ("capturedAt", "2026-10-28T13:05:00Z")],
            file: (name: "file", fileName: "Scan 2026-10-28 14.05.pdf", mime: "application/pdf", data: pdf))
        let text = try #require(String(data: body, encoding: .utf8))

        #expect(text.hasPrefix("--B0UNDARY\r\n"))
        #expect(text.hasSuffix("\r\n--B0UNDARY--\r\n"))
        #expect(text.contains("Content-Disposition: form-data; name=\"clientId\"\r\n\r\n6f1c2b9e-0d7a-4c3e-9a51-2f8b7c6d5e4f\r\n"))
        #expect(text.contains("Content-Disposition: form-data; name=\"source\"\r\n\r\nphone-scan\r\n"))
        #expect(text.contains("Content-Disposition: form-data; name=\"capturedAt\"\r\n\r\n2026-10-28T13:05:00Z\r\n"))
        #expect(text.contains("Content-Disposition: form-data; name=\"file\"; filename=\"Scan 2026-10-28 14.05.pdf\"\r\n"
            + "Content-Type: application/pdf\r\n\r\n%PDF-1.4 fake\r\n"))
    }

    /// The file part carries raw bytes, not text: nothing may be re-encoded.
    @Test func fileBytesAreEmbeddedVerbatim() {
        let bytes = Data([0x00, 0xff, 0x0d, 0x0a, 0x25, 0x80])
        let body = multipartBody(boundary: "b", fields: [],
                                 file: (name: "file", fileName: "x.pdf", mime: "application/pdf", data: bytes))
        #expect(body.range(of: bytes) != nil)
    }

    /// A quote or a line break in a name must not end the header early and
    /// smuggle a header or a part in.
    @Test func headerValuesCannotBreakOut() throws {
        let body = multipartBody(boundary: "b", fields: [],
                                 file: (name: "file", fileName: "a\"b\r\nX-Evil: 1.pdf", mime: "application/pdf", data: Data()))
        let text = try #require(String(data: body, encoding: .utf8))
        #expect(!text.contains("\r\nX-Evil"))
        #expect(text.contains("filename=\"a%22b%0D%0AX-Evil: 1.pdf\""))
    }

    @Test func boundaryIsFreshAndSafe() {
        let a = Multipart.makeBoundary(), b = Multipart.makeBoundary()
        #expect(a != b)
        #expect(a.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" })
        #expect(Multipart.contentType(boundary: "xyz") == "multipart/form-data; boundary=xyz")
    }
}
