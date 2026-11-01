import Foundation
import UIKit

/// One thing the share sheet handed over, as the extension loaded it.
enum SharedInput {
    case image(UIImage)
    case file(data: Data, fileName: String, mime: String)
    /// Handed over, but nothing could be read from it. Kept as an input rather
    /// than dropped, so the screen can say that it did not go.
    case unreadable
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
    /// What a share became, and how much of it did not make it.
    struct Result: Equatable {
        var files: [PreparedShare] = []
        /// Pages actually IN the photo PDF (not images handed over).
        var photoPages = 0
        /// Inputs that went nowhere: unreadable items and images the PDF
        /// could not encode. Never silent: the screen says so.
        var leftOut = 0
    }

    static func prepare(_ inputs: [SharedInput], capturedAt: Date) -> Result {
        var images: [UIImage] = []
        var result = Result()
        for input in inputs {
            switch input {
            case .image(let image): images.append(image)
            case .file(let data, let fileName, let mime):
                result.files.append(PreparedShare(data: data, fileName: fileName, mime: mime))
            case .unreadable: result.leftOut += 1
            }
        }
        guard !images.isEmpty else { return result }
        let pdf = PDFAssembler.assemble(pages: images)
        result.leftOut += images.count - pdf.pageCount
        guard pdf.pageCount > 0 else { return result }
        result.photoPages = pdf.pageCount
        result.files.insert(PreparedShare(data: pdf.data, fileName: photosTitle(capturedAt: capturedAt),
                                          mime: "application/pdf"), at: 0)
        return result
    }

    /// `Foto's 2026-11-01 14.05.pdf`, on the Amsterdam clock like a scan's
    /// name. Auto-name renames it once the text is read.
    static func photosTitle(capturedAt: Date) -> String {
        "Foto's " + ScanNaming.title(capturedAt: capturedAt).dropFirst("Scan ".count)
    }
}
