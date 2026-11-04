import Testing
import Foundation
import ImageIO
import PDFKit
import UIKit
import Synchronization
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

    /// `prepare`'s DEFAULT loader is `PhotoPage`, the downscaling one. The
    /// page size cannot tell (PDFAssembler caps the long edge at 2200 either
    /// way, so a full-size decode would make the same PDF while costing ~96 MB),
    /// so the suite watches `PhotoPage.page` being called for the photo.
    @Test func prepareMakesPhotoPagesThroughTheDownscalingLoaderByDefault() throws {
        let seen = Mutex<[URL]>([])
        let url = Fixture.rotatedPhotoURL
        let result = PhotoPage.$observer.withValue({ decoded in seen.withLock { $0.append(decoded) } }) {
            SharePreparation.prepare([.photo(url: url)], capturedAt: Date(timeIntervalSince1970: 1_800_000_000))
        }
        #expect(result.photoPages == 1)
        #expect(seen.withLock { $0 } == [url])
    }

    // MARK: - Orientation

    /// An iPhone held upright stores its photo SIDEWAYS with EXIF Orientation
    /// 6. The page in the PDF must be upright: portrait, the fixture's dark
    /// band at the top, its grey block on the left (not mirrored). Fixture:
    /// `scripts/make-rotated-photo-fixture.swift`.
    @Test func aSidewaysStoredPhotoBecomesAnUprightPage() throws {
        let raw = try #require(CGImageSourceCreateWithURL(Fixture.rotatedPhotoURL as CFURL, nil))
        let props = try #require(CGImageSourceCopyPropertiesAtIndex(raw, 0, nil) as? [CFString: Any])
        #expect(props[kCGImagePropertyOrientation] as? Int == 6)
        #expect((props[kCGImagePropertyPixelWidth] as? Int ?? 0) > (props[kCGImagePropertyPixelHeight] as? Int ?? 0))

        let result = SharePreparation.prepare([.photo(url: Fixture.rotatedPhotoURL)],
                                              capturedAt: Date(timeIntervalSince1970: 1_800_000_000))
        let data = try #require(result.files.first?.data)
        let page = try #require(PDFDocument(data: data)?.page(at: 0))
        let box = page.bounds(for: .mediaBox)
        #expect(box.height > box.width)                         // portrait
        #expect(abs(box.height / box.width - 4.0 / 3.0) < 0.01) // 2400 x 3200 upright

        let gray = try RenderedPage(page, width: 300)
        #expect(gray.mean(top: 0.00, bottom: 0.08, left: 0.0, right: 1.0) < 60)   // band at the top
        #expect(gray.mean(top: 0.92, bottom: 1.00, left: 0.0, right: 1.0) > 200)  // paper at the bottom
        #expect(gray.mean(top: 0.00, bottom: 1.00, left: 0.0, right: 0.05) > 150) // no band down a side
        let block = gray.mean(top: 0.18, bottom: 0.32, left: 0.02, right: 0.28)
        #expect(block > 80 && block < 160)                                        // grey block on the left
        #expect(gray.mean(top: 0.18, bottom: 0.32, left: 0.72, right: 0.98) > 200) // not mirrored
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

/// A PDF page drawn into an 8-bit gray bitmap, read with row 0 at the TOP
/// of the page (a bitmap context's memory runs top-down).
private struct RenderedPage {
    let width: Int
    let height: Int
    let pixels: [UInt8]

    init(_ page: PDFPage, width: Int) throws {
        let box = page.bounds(for: .mediaBox)
        let height = Int((CGFloat(width) * box.height / box.width).rounded())
        let ctx = try #require(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                         bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(),
                                         bitmapInfo: CGImageAlphaInfo.none.rawValue))
        ctx.setFillColor(gray: 1, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.scaleBy(x: CGFloat(width) / box.width, y: CGFloat(height) / box.height)
        ctx.translateBy(x: -box.minX, y: -box.minY)
        ctx.drawPDFPage(try #require(page.pageRef))
        let base = try #require(ctx.data).bindMemory(to: UInt8.self, capacity: width * height)
        self.width = width
        self.height = height
        pixels = Array(UnsafeBufferPointer(start: base, count: width * height))
    }

    /// Mean gray (0 black ... 255 white) over a region given as fractions of
    /// the page, measured from the top-left.
    func mean(top: Double, bottom: Double, left: Double, right: Double) -> Double {
        let r0 = Int(top * Double(height)), r1 = max(r0 + 1, Int(bottom * Double(height)))
        let c0 = Int(left * Double(width)), c1 = max(c0 + 1, Int(right * Double(width)))
        var sum = 0
        for row in r0..<min(r1, height) {
            for col in c0..<min(c1, width) { sum += Int(pixels[row * width + col]) }
        }
        return Double(sum) / Double((min(r1, height) - r0) * (min(c1, width) - c0))
    }
}

