import Foundation
import UIKit

/// One thing the share sheet handed over, as the extension loaded it.
enum SharedInput {
    case image(UIImage)
    /// Bytes already in memory (small, or made here).
    case file(data: Data, fileName: String, mime: String)
    /// A file copied into the extension's own staging folder, never read into
    /// memory: `ShareStaging.stage` measured it before copying.
    case staged(url: URL, fileName: String, mime: String, bytes: Int)
    /// Over `ShareModel.maxFileBytes`, refused on its size alone: nothing was
    /// read or copied, so a 200 MB video cannot push the extension past its
    /// memory limit before it is refused.
    case tooLarge(fileName: String)
    /// Handed over, but nothing could be read from it. Kept as an input rather
    /// than dropped, so the screen can say that it did not go.
    case unreadable
}

/// One drop to write: its content, the name the dossier first sees, its media type.
struct PreparedShare: Equatable, Sendable {
    enum Content: Equatable, Sendable {
        case data(Data)
        /// A staged file, copied into the drop on Versturen without being read.
        case file(URL)
    }

    let content: Content
    let byteCount: Int
    let fileName: String
    let mime: String

    init(data: Data, fileName: String, mime: String) {
        content = .data(data)
        byteCount = data.count
        self.fileName = fileName
        self.mime = mime
    }

    init(fileAt url: URL, bytes: Int, fileName: String, mime: String) {
        content = .file(url)
        byteCount = bytes
        self.fileName = fileName
        self.mime = mime
    }

    /// The bytes, when they are in memory (a photo PDF, a small file).
    var data: Data? {
        if case .data(let data) = content { data } else { nil }
    }
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
        /// Files refused on their size before being read.
        var tooLarge = 0
    }

    /// Loads every item the share sheet handed over, in order, and accounts
    /// for each one: an item whose load fails becomes `.unreadable` in its
    /// place, never a gap. The view controller passes its `NSItemProvider`
    /// loader; the suite passes a stub.
    static func collect(count: Int, isolation: isolated (any Actor)? = #isolation,
                        load: (Int) async -> SharedInput?) async -> [SharedInput] {
        var inputs: [SharedInput] = []
        inputs.reserveCapacity(count)
        for index in 0..<count {
            inputs.append(await load(index) ?? .unreadable)
        }
        return inputs
    }

    static func prepare(_ inputs: [SharedInput], capturedAt: Date) -> Result {
        var images: [UIImage] = []
        var result = Result()
        for input in inputs {
            switch input {
            case .image(let image): images.append(image)
            case .file(let data, let fileName, let mime):
                result.files.append(PreparedShare(data: data, fileName: fileName, mime: mime))
            case .staged(let url, let fileName, let mime, let bytes):
                result.files.append(PreparedShare(fileAt: url, bytes: bytes, fileName: fileName, mime: mime))
            case .tooLarge: result.tooLarge += 1
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

/// How the share extension takes a file it was handed: MEASURED first, then
/// copied, never read into memory. An extension is killed somewhere around
/// 120 MB, so `Data(contentsOf:)` on a shared video would end the extension
/// before it could refuse the file.
enum ShareStaging {
    /// The extension's own folder for this share, removed when it closes.
    static func makeDirectory() -> URL? {
        let dir = FileManager.default.temporaryDirectory
            .appending(path: "share-\(UUID().uuidString)", directoryHint: .isDirectory)
        return (try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)) != nil ? dir : nil
    }

    /// The file at `source` as an input: `.tooLarge` over `maxBytes` (nothing
    /// copied), `.staged` once copied into `dir`, `.unreadable` when it cannot
    /// be measured or copied. Called inside `loadFileRepresentation`'s handler,
    /// because the system deletes its file when the handler returns.
    static func stage(_ source: URL, fileName: String, mime: String, into dir: URL,
                      maxBytes: Int = ShareModel.maxFileBytes) -> SharedInput {
        guard let size = byteCount(source) else { return .unreadable }
        guard size <= maxBytes else { return .tooLarge(fileName: fileName) }
        let ext = (fileName as NSString).pathExtension
        let target = dir.appending(path: ext.isEmpty ? UUID().uuidString : "\(UUID().uuidString).\(ext)")
        do {
            try FileManager.default.copyItem(at: source, to: target)
        } catch {
            return .unreadable
        }
        // The copy is what goes, so its size is the one reported; a file that
        // grew past the limit while being copied is still refused, by
        // `ShareModel.loaded`, which checks every prepared size.
        guard let copied = byteCount(target) else {
            try? FileManager.default.removeItem(at: target)
            return .unreadable
        }
        return .staged(url: target, fileName: fileName, mime: mime, bytes: copied)
    }

    /// The file's size from its metadata, without opening it.
    static func byteCount(_ url: URL) -> Int? {
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]),
              values.isRegularFile == true
        else { return nil }
        return values.fileSize
    }
}
