import Foundation
import ImageIO
import PDFKit
import UIKit
import UniformTypeIdentifiers

/// One thing the share sheet handed over, as the extension loaded it.
enum SharedInput {
    /// A photo, staged on disk and NEVER decoded at full size: it becomes a
    /// page of the photo PDF through `PhotoPage`, one at a time. A 24 MP photo
    /// is ~96 MB decoded and an extension is killed around 120 MB, so holding
    /// photos as `UIImage`s ended the share at the second one.
    case photo(url: URL)
    /// Bytes already in memory (small, or made here).
    case file(data: Data, fileName: String, mime: String)
    /// A file copied into the extension's own staging folder, never read into
    /// memory: `ShareStaging.stage` measured it before copying.
    case staged(url: URL, fileName: String, mime: String, bytes: Int)
    /// Over `ShareModel.maxFileBytes`, left out on its size alone: nothing was
    /// read or copied, so a 200 MB video cannot push the extension past its
    /// memory limit before it is refused. `bytes` is its measured size (for
    /// "62 MB, max. 48 MB"); `thumbnail` a small PNG of a PDF's first page,
    /// drawn lazily by PDFKit without reading the file whole.
    case tooLarge(fileName: String, bytes: Int? = nil, thumbnail: Data? = nil)
    /// A web link, not a file: Grip keeps files only, and the screen says
    /// so with the link itself ("Hier zit geen bestand in").
    case link(String)
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
///   `PDFAssembler` a scan uses (downscaled for 4G, grayscale when the page
///   has no colour), each page decoded already downscaled and released before
///   the next (`PhotoPage`). Two photos of a two-page letter are one letter.
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
        /// Files left out on their size before being read, each with the
        /// place it held among `files` so the screen lists it where it was.
        var tooLargeFiles: [TooLargeFile] = []
        /// Links handed over: never a file, never sent.
        var links: [String] = []
        /// Photos handed over (decodable or not), for "foto 11–14".
        var photosHandedOver = 0
        /// The photos still to combine, when `prepare` was told not to
        /// (`combinePhotos: false`); `combined(_:into:capturedAt:)` adds the PDF.
        var pendingPhotos: [URL] = []

        var tooLarge: Int { tooLargeFiles.count }
    }

    /// A file over `ShareModel.maxFileBytes`: named, measured, not sent.
    struct TooLargeFile: Equatable, Sendable {
        let fileName: String
        let bytes: Int?
        let thumbnail: Data?
        /// How many of `Result.files` come before it.
        let position: Int
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

    /// How a staged photo becomes a page: downscaled by ImageIO as it is
    /// decoded (`PhotoPage`). Injectable so the suite can watch the pages go
    /// by one at a time.
    static func photoPageLoader(_ url: URL) -> UIImage? { PhotoPage.page(at: url) }

    /// `combinePhotos: false` leaves the photos in `pendingPhotos` for the
    /// caller to combine a page at a time (`ShareModel`, which says which
    /// photo it is on); `true` combines them here, in one go.
    static func prepare(_ inputs: [SharedInput], capturedAt: Date, combinePhotos: Bool = true,
                        photoPage: (URL) -> UIImage? = photoPageLoader(_:)) -> Result {
        var photos: [URL] = []
        var result = Result()
        for input in inputs {
            switch input {
            case .photo(let url): photos.append(url)
            case .file(let data, let fileName, let mime):
                result.files.append(PreparedShare(data: data, fileName: fileName, mime: mime))
            case .staged(let url, let fileName, let mime, let bytes):
                result.files.append(PreparedShare(fileAt: url, bytes: bytes, fileName: fileName, mime: mime))
            case .tooLarge(let fileName, let bytes, let thumbnail):
                result.tooLargeFiles.append(TooLargeFile(fileName: fileName, bytes: bytes, thumbnail: thumbnail,
                                                         position: result.files.count))
            case .link(let url): result.links.append(url)
            case .unreadable: result.leftOut += 1
            }
        }
        result.photosHandedOver = photos.count
        guard !photos.isEmpty else { return result }
        guard combinePhotos else {
            result.pendingPhotos = photos
            return result
        }
        let pdf = PDFAssembler.assemble(pageCount: photos.count) { photoPage(photos[$0]) }
        return combined(pdf, into: result, photos: photos.count, capturedAt: capturedAt)
    }

    /// `result` with the photo PDF of `photos` photos in it: first in the
    /// list, every too-large file one place down, the photos the PDF could
    /// not encode counted out. A PDF with no page adds nothing.
    static func combined(_ pdf: (data: Data, pageCount: Int), into result: Result, photos: Int,
                         capturedAt: Date) -> Result {
        var result = result
        result.pendingPhotos = []
        result.leftOut += photos - pdf.pageCount
        guard pdf.pageCount > 0 else { return result }
        result.photoPages = pdf.pageCount
        result.files.insert(PreparedShare(data: pdf.data, fileName: photosTitle(capturedAt: capturedAt),
                                          mime: "application/pdf"), at: 0)
        // The photo PDF leads the list, so every too-large file moves one down.
        result.tooLargeFiles = result.tooLargeFiles.map {
            TooLargeFile(fileName: $0.fileName, bytes: $0.bytes, thumbnail: $0.thumbnail, position: $0.position + 1)
        }
        return result
    }

    /// `Gedeeld 1 nov 14.02.pdf`: the word the dossier files it under
    /// ("Gedeeld"), then the Amsterdam day and clock, like a scan's name.
    /// Auto-name renames it once the text is read.
    static func photosTitle(capturedAt: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
        let c = calendar.dateComponents([.day, .month, .hour, .minute], from: capturedAt)
        let month = dutchMonths[(c.month ?? 1) - 1]
        return String(format: "Gedeeld %d %@ %02d.%02d.pdf", c.day ?? 1, month, c.hour ?? 0, c.minute ?? 0)
    }

    /// Dutch short months, spelled out rather than taken from a locale whose
    /// ICU version decides whether "nov" carries a full stop.
    static let dutchMonths = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"]
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
        guard size <= maxBytes else {
            return .tooLarge(fileName: fileName, bytes: size,
                             thumbnail: mime == "application/pdf" ? ShareStaging.firstPageThumbnail(source) : nil)
        }
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

    /// A shared photo: measured and copied like any file, then kept as a
    /// `.photo` when `PhotoPage` can make a page of it without a full-size
    /// decode. One it cannot (a huge PNG, TIFF, ...) goes as the FILE it is,
    /// with its own name and mime, rather than through a decode that would
    /// end the extension.
    static func stagePhoto(_ source: URL, fileName: String, mime: String, into dir: URL,
                           maxBytes: Int = ShareModel.maxFileBytes,
                           maxFullDecodePixels: Int = PhotoPage.maxFullDecodePixels) -> SharedInput {
        let staged = stage(source, fileName: fileName, mime: mime, into: dir, maxBytes: maxBytes)
        guard case .staged(let url, _, _, _) = staged,
              PhotoPage.decodesCheaply(url, maxFullDecodePixels: maxFullDecodePixels)
        else { return staged }
        return .photo(url: url)
    }

    /// A small PNG of a PDF's first page. PDFKit opens a document lazily and
    /// renders one page, so a 62 MB scan costs one page, not 62 MB.
    static func firstPageThumbnail(_ url: URL) -> Data? {
        PDFDocument(url: url)?.page(at: 0)?
            .thumbnail(of: CGSize(width: 112, height: 158), for: .mediaBox).pngData()
    }

    /// The file's size from its metadata, without opening it.
    static func byteCount(_ url: URL) -> Int? {
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]),
              values.isRegularFile == true
        else { return nil }
        return values.fileSize
    }
}

/// A shared photo as one page of the photo PDF, decoded ALREADY DOWNSCALED.
///
/// `UIImage(data:)` plus Core Image renders the whole bitmap before scaling:
/// ~96 MB for a 24 MP photo, ~192 MB for 48 MP, in an extension killed around
/// 120 MB. ImageIO's thumbnail path decodes JPEG and HEIC subsampled straight
/// to `maxPixelSize`, with EXIF orientation applied and nothing cached on the
/// source, so the full-size bitmap never exists.
enum PhotoPage {
    /// The photo PDF's long edge (`PDFAssembler`'s `maxLongEdge`).
    static let maxPixelSize = 2200

    /// For formats ImageIO cannot decode subsampled, the largest image it may
    /// decode whole to make a page: 16 MP is 64 MB of RGBA, well under the
    /// extension's limit with the PDF beside it.
    static let maxFullDecodePixels = 16_000_000

    /// Told every URL `page(at:)` is asked for, within a task that set it; nil
    /// everywhere else. The suite's only way to see that `SharePreparation`'s
    /// DEFAULT loader is this one: a full-size decode would produce the same
    /// PDF (PDFAssembler caps the long edge too) while costing ~96 MB.
    @TaskLocal static var observer: (@Sendable (URL) -> Void)?

    /// The page, or nil when the file is not an image ImageIO can read.
    static func page(at url: URL, maxPixelSize: Int = maxPixelSize) -> UIImage? {
        observer?(url)
        let noCache = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithURL(url as CFURL, noCache) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            kCGImageSourceShouldCache: false,
            kCGImageSourceShouldCacheImmediately: false,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image, scale: 1, orientation: .up)
    }

    /// True when making a page of this file cannot decode a bitmap past the
    /// budget: JPEG and HEIC/HEIF are decoded subsampled whatever their size;
    /// anything else only when its declared pixel count is within
    /// `maxFullDecodePixels`. Read from the header, never decoded.
    static func decodesCheaply(_ url: URL, maxFullDecodePixels: Int = maxFullDecodePixels) -> Bool {
        let noCache = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithURL(url as CFURL, noCache),
              let typeID = CGImageSourceGetType(source) as String?,
              let type = UTType(typeID)
        else { return false }
        if type.conforms(to: .jpeg) || type.conforms(to: .heic) || type.conforms(to: .heif) { return true }
        guard let props = CGImageSourceCopyPropertiesAtIndex(source, 0, noCache) as? [CFString: Any],
              let width = props[kCGImagePropertyPixelWidth] as? Int,
              let height = props[kCGImagePropertyPixelHeight] as? Int
        else { return false }
        return width * height <= maxFullDecodePixels
    }
}
