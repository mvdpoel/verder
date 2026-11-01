import Foundation
import UIKit

/// One thing the share sheet handed over, as the extension loaded it.
enum SharedInput {
    case image(UIImage)
    case file(data: Data, fileName: String, mime: String)
}

/// One drop to write: bytes, the name the dossier first sees, its media type.
struct PreparedShare: Equatable, Sendable {
    let data: Data
    let fileName: String
    let mime: String
}

/// What the share extension turns a share into, kept out of the view
/// controller so it is tested on the simulator like the rest of the queue.
///
/// - Every image in one share becomes ONE PDF, through the same
///   `PDFAssembler.makePDF` a scan uses (downscaled for 4G, grayscale when the
///   page has no colour). Two photos of a two-page letter are one letter.
///   No `PageCleaner` pass: a shared photo is not necessarily a page.
/// - PDFs and every other file pass through byte for byte, with their own
///   name and mime; the server stores whatever type it is given.
enum SharePreparation {
    static func prepare(_ inputs: [SharedInput], capturedAt: Date) -> [PreparedShare] {
        var images: [UIImage] = []
        var files: [PreparedShare] = []
        for input in inputs {
            switch input {
            case .image(let image): images.append(image)
            case .file(let data, let fileName, let mime): files.append(PreparedShare(data: data, fileName: fileName, mime: mime))
            }
        }
        guard !images.isEmpty else { return files }
        let pdf = PDFAssembler.makePDF(pages: images)
        guard !pdf.isEmpty else { return files }
        return [PreparedShare(data: pdf, fileName: photosTitle(capturedAt: capturedAt), mime: "application/pdf")] + files
    }

    /// `Foto's 2026-11-01 14.05.pdf`, on the Amsterdam clock like a scan's
    /// name. Auto-name renames it once the text is read.
    static func photosTitle(capturedAt: Date) -> String {
        "Foto's " + ScanNaming.title(capturedAt: capturedAt).dropFirst("Scan ".count)
    }
}
