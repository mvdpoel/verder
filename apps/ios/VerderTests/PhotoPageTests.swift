import Testing
import Foundation
import ImageIO
import PDFKit
import UIKit
import UniformTypeIdentifiers
@testable import Verder

/// A file whose name says photo and whose bytes are not one.
func notAnImage() throws -> URL {
    let url = try scratchDir().appending(path: "kapot.jpg")
    try Data("not an image".utf8).write(to: url)
    return url
}

/// A shared photo becomes a page WITHOUT being decoded at full size: an
/// extension is killed around 120 MB and a 24 MP photo is ~96 MB decoded.
/// (Review fix, plan 3 Task 22.)
struct PhotoPageTests {
    /// The fixture is 3024 x 4032 on disk; the page comes out of ImageIO's
    /// thumbnail path already at the PDF's long edge, never as the full bitmap.
    @Test func aLargePhotoArrivesAtTheLongEdgeWithoutAFullDecode() throws {
        let page = try #require(PhotoPage.page(at: Fixture.letterPageURL))
        let cg = try #require(page.cgImage)
        #expect(max(cg.width, cg.height) == PhotoPage.maxPixelSize)
        #expect(cg.height > cg.width)           // portrait kept
        #expect(page.imageOrientation == .up)   // EXIF applied by the thumbnail
        #expect(PhotoPage.maxPixelSize == 2200)
    }

    @Test func aFileThatIsNotAnImageGivesNoPage() throws {
        #expect(PhotoPage.page(at: try notAnImage()) == nil)
    }

    /// The photo PDF asks for ONE page at a time, and the page before it has
    /// been released by then: holding every decoded photo at once is what
    /// pushed the extension past its memory limit.
    @Test func photoPagesAreLoadedOneAtATimeAndReleased() throws {
        final class Spy {
            weak var previous: UIImage?
            var calls: [URL] = []
            var previousStillAlive = 0
        }
        let spy = Spy()
        let a = Fixture.letterPageURL
        let b = try scratchDir().appending(path: "b.jpg")
        try FileManager.default.copyItem(at: a, to: b)
        let result = SharePreparation.prepare([.photo(url: a), .photo(url: b), .photo(url: a)],
                                              capturedAt: Date(timeIntervalSince1970: 1_800_000_000)) { url in
            if spy.previous != nil { spy.previousStillAlive += 1 }
            spy.calls.append(url)
            let page = PhotoPage.page(at: url)
            spy.previous = page
            return page
        }
        #expect(spy.calls == [a, b, a])
        #expect(spy.previousStillAlive == 0)
        #expect(result.photoPages == 3)
    }

    /// The default loader is the downscaled one: every page in the photo PDF
    /// is at most the long edge.
    @Test func thePhotoPDFIsBuiltFromDownscaledPages() throws {
        let result = SharePreparation.prepare([.photo(url: Fixture.letterPageURL)],
                                              capturedAt: Date(timeIntervalSince1970: 1_800_000_000))
        let data = try #require(result.files.first?.data)
        let doc = try #require(PDFDocument(data: data))
        #expect(doc.pageCount == 1)
        #expect(SharePreparation.photoPageLoader(Fixture.letterPageURL)?.cgImage.map { max($0.width, $0.height) } == 2200)
    }

    @Test func assembleStreamsPagesFromAClosure() {
        var asked: [Int] = []
        let out = PDFAssembler.assemble(pageCount: 2) { index in
            asked.append(index)
            return index == 0 ? Fixture.letterPage : nil
        }
        #expect(asked == [0, 1])
        #expect(out.pageCount == 1)
        #expect(PDFDocument(data: out.data)?.pageCount == 1)
    }

    // MARK: - Staging a shared photo

    /// A JPEG is staged on disk and kept as a photo; nothing is decoded here.
    @Test func aSharedJPEGIsStagedAsAPhoto() throws {
        let staging = try scratchDir()
        let input = ShareStaging.stagePhoto(Fixture.letterPageURL, fileName: "IMG_0001.jpg", mime: "image/jpeg",
                                            into: staging)
        guard case .photo(let url) = input else {
            Issue.record("expected .photo, got \(input)"); return
        }
        #expect(url.deletingLastPathComponent().standardizedFileURL == staging.standardizedFileURL)
        #expect(FileManager.default.contentsEqual(atPath: url.path, andPath: Fixture.letterPageURL.path))
    }

    /// A format ImageIO cannot thumbnail without decoding the whole bitmap
    /// (PNG, TIFF, ...) above the pixel budget goes as the FILE it is, never
    /// through a decode that would end the extension.
    @Test func aPNGOverThePixelBudgetIsSharedAsAFile() throws {
        let staging = try scratchDir()
        let png = try scratchDir().appending(path: "scherm.png")
        try pngData(width: 40, height: 30).write(to: png)

        let input = ShareStaging.stagePhoto(png, fileName: "scherm.png", mime: "image/png", into: staging,
                                            maxFullDecodePixels: 1_000)
        guard case .staged(_, let fileName, let mime, _) = input else {
            Issue.record("expected .staged, got \(input)"); return
        }
        #expect(fileName == "scherm.png")
        #expect(mime == "image/png")

        let small = ShareStaging.stagePhoto(png, fileName: "scherm.png", mime: "image/png", into: staging,
                                            maxFullDecodePixels: 10_000)
        guard case .photo = small else { Issue.record("expected .photo, got \(small)"); return }
    }

    /// JPEG and HEIC are decoded subsampled by ImageIO, so no pixel budget
    /// applies to them: a 48 MP camera photo is still a page.
    @Test func jpegIsAlwaysCheapToDownscale() {
        #expect(PhotoPage.decodesCheaply(Fixture.letterPageURL, maxFullDecodePixels: 1))
    }

    @Test func aPhotoOverTheFileLimitIsRefusedUnread() throws {
        let staging = try scratchDir()
        let input = ShareStaging.stagePhoto(Fixture.letterPageURL, fileName: "groot.jpg", mime: "image/jpeg",
                                            into: staging, maxBytes: 10)
        guard case .tooLarge = input else { Issue.record("expected .tooLarge, got \(input)"); return }
        #expect(try FileManager.default.contentsOfDirectory(atPath: staging.path).isEmpty)
    }

    private func pngData(width: Int, height: Int) throws -> Data {
        let ctx = try #require(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                         bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                         bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        ctx.setFillColor(UIColor.white.cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try #require(ctx.makeImage())
        let data = NSMutableData()
        let dest = try #require(CGImageDestinationCreateWithData(data as CFMutableData, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(dest, image, nil)
        #expect(CGImageDestinationFinalize(dest))
        return data as Data
    }
}
