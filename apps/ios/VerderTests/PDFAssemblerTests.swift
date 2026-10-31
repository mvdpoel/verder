import Testing
import Foundation
import PDFKit
import UIKit
@testable import Verder

/// The fixture: a 3024 x 4032 synthetic photographed page (uneven light,
/// shadow, fold, sensor noise). How it is made: `apps/ios/scripts/make-letter-fixture.swift`.
enum Fixture {
    static let letterPage: UIImage = {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/letter-page.jpg")
        guard let image = UIImage(contentsOfFile: url.path) else {
            fatalError("missing fixture \(url.path)")
        }
        return image
    }()
}

struct PDFAssemblerTests {
    @Test func fixtureIsAFullSizePhoto() {
        let cg = Fixture.letterPage.cgImage!
        #expect(cg.width * cg.height >= 12_000_000)
    }

    @Test func threePagePDFHasThreePages() {
        let page = Fixture.letterPage
        let data = PDFAssembler.makePDF(pages: [page, page, page])
        #expect(PDFDocument(data: data)?.pageCount == 3)
    }

    @Test func emptyCaptureMakesNoPages() {
        #expect(PDFAssembler.makePDF(pages: []).isEmpty)
    }

    /// Spec §7.1 / plan Global Constraints: under 1.5 MB per page.
    @Test func pageStaysUnder1_5MB() {
        let data = PDFAssembler.makePDF(pages: [PageCleaner.clean(Fixture.letterPage)])
        print("PDF size, one cleaned page: \(data.count) bytes")
        #expect(data.count < 1_572_864)
        #expect(data.count > 50_000, "suspiciously small — is the page there at all?")
    }

    @Test func rawPageAlsoStaysUnder1_5MB() {
        let data = PDFAssembler.makePDF(pages: [Fixture.letterPage])
        print("PDF size, one raw page: \(data.count) bytes")
        #expect(data.count < 1_572_864)
    }

    /// Review Focus 4: a long letter stays well under MAX_UPLOAD_BYTES (50 MB).
    ///
    /// Twenty DISTINCT pages: Quartz writes one image object for byte-identical
    /// page images, so twenty copies of one page measured 392 KB in total and
    /// proved nothing. Each page here is cropped by a different number of rows.
    @Test("twenty pages stay under 30 MB") func twentyPagesStayUnder30MB() {
        let cleaned = PageCleaner.clean(Fixture.letterPage).cgImage!
        let pages = (0..<20).map { i in
            UIImage(cgImage: cleaned.cropping(to: CGRect(x: 0, y: i * 7, width: cleaned.width,
                                                         height: cleaned.height - i * 7))!)
        }
        let data = PDFAssembler.makePDF(pages: pages)
        print("PDF size, twenty cleaned pages: \(data.count) bytes")
        #expect(PDFDocument(data: data)?.pageCount == 20)
        #expect(data.count < 30 * 1_048_576)
        #expect(data.count > 20 * 100_000, "twenty distinct pages cannot be this small — deduplicated?")
    }

    /// The long edge is capped and the aspect ratio kept: the PDF page is
    /// sized from the image, so a portrait page stays portrait.
    @Test func pageKeepsPortraitAspect() throws {
        let data = PDFAssembler.makePDF(pages: [Fixture.letterPage])
        let page = try #require(PDFDocument(data: data)?.page(at: 0))
        let box = page.bounds(for: .mediaBox)
        #expect(abs(box.height / box.width - 4032.0 / 3024.0) < 0.01)
    }

    /// The size budget rests on the JPEG going into the PDF as-is (DCTDecode).
    /// Were Quartz to re-encode the pixels (Flate), a page would be several
    /// times larger and `pageStaysUnder1_5MB` would be the first to say so;
    /// this says WHY.
    @Test func pagesAreEmbeddedAsJPEG() {
        let data = PDFAssembler.makePDF(pages: [Fixture.letterPage])
        #expect(data.range(of: Data("/DCTDecode".utf8)) != nil)
    }

    @Test func downscaleCapsTheLongEdge() {
        let size = PDFAssembler.targetPixelSize(for: CGSize(width: 3024, height: 4032), maxLongEdge: 2200)
        #expect(size.height == 2200)
        #expect(size.width == 1650)
        let small = PDFAssembler.targetPixelSize(for: CGSize(width: 800, height: 1000), maxLongEdge: 2200)
        #expect(small == CGSize(width: 800, height: 1000), "never upscales")
    }

    /// "Grayscale or colour by page content" (spec §7.1): a page with a
    /// coloured letterhead keeps its colour, a page of black text on paper
    /// does not need three channels.
    @Test func colourIsKeptOnlyWhenThePageHasColour() {
        #expect(!PDFAssembler.isEffectivelyGray(Fixture.letterPage.cgImage!), "the fixture has a blue letterhead")
        #expect(PDFAssembler.isEffectivelyGray(Self.solid(r: 0.96, g: 0.95, b: 0.93)), "paper tint is not colour")
        #expect(!PDFAssembler.isEffectivelyGray(Self.solid(r: 0.9, g: 0.1, b: 0.1)))
    }

    static func solid(r: CGFloat, g: CGFloat, b: CGFloat) -> CGImage {
        let ctx = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 256,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(CGColor(srgbRed: r, green: g, blue: b, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        return ctx.makeImage()!
    }
}
