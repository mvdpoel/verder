import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// One capture session → one PDF (spec §7.1), sized for 4G: every page is
/// downscaled to `maxLongEdge` pixels, JPEG-encoded at `jpegQuality`, and the
/// JPEG is embedded AS IS (`CGImage(jpegDataProviderSource:)` makes Quartz
/// write a DCTDecode stream instead of re-encoding the pixels as Flate, which
/// would be several times larger).
///
/// A page with no real colour is encoded as one-channel grayscale: black text
/// on slightly tinted paper does not need three channels. A coloured
/// letterhead, stamp or highlighter keeps the page in colour.
enum PDFAssembler {
    /// The PDF page width in points; the height follows the image's aspect.
    /// A4 is 595 pt wide, so a full-page scan prints at its natural size.
    static let pageWidthPoints: CGFloat = 595

    static func makePDF(pages: [UIImage], maxLongEdge: CGFloat = 2200, jpegQuality: CGFloat = 0.6) -> Data {
        guard !pages.isEmpty else { return Data() }
        let out = NSMutableData()
        guard let consumer = CGDataConsumer(data: out as CFMutableData),
              let pdf = CGContext(consumer: consumer, mediaBox: nil, nil)
        else { return Data() }
        for page in pages {
            guard let jpeg = encodePage(page, maxLongEdge: maxLongEdge, jpegQuality: jpegQuality),
                  let provider = CGDataProvider(data: jpeg as CFData),
                  let image = CGImage(jpegDataProviderSource: provider, decode: nil,
                                      shouldInterpolate: true, intent: .defaultIntent)
            else { continue }
            var box = CGRect(x: 0, y: 0, width: pageWidthPoints,
                             height: pageWidthPoints * CGFloat(image.height) / CGFloat(image.width))
            let info = [kCGPDFContextMediaBox as String: Data(bytes: &box, count: MemoryLayout<CGRect>.size)]
            pdf.beginPDFPage(info as CFDictionary)
            pdf.draw(image, in: box)
            pdf.endPDFPage()
        }
        pdf.closePDF()
        return out as Data
    }

    /// Downscale + orientation + colour decision + JPEG, in one Core Image pass.
    static func encodePage(_ page: UIImage, maxLongEdge: CGFloat, jpegQuality: CGFloat) -> Data? {
        guard let input = PageCleaner.ciImage(page) else { return nil }
        let target = targetPixelSize(for: input.extent.size, maxLongEdge: maxLongEdge)
        var scaled = input
        if target != input.extent.size {
            let scale = CIFilter.lanczosScaleTransform()
            scale.inputImage = input
            scale.scale = Float(target.height / input.extent.height)
            scale.aspectRatio = Float((target.width / input.extent.width) / (target.height / input.extent.height))
            scaled = scale.outputImage ?? input
        }
        let rect = CGRect(origin: scaled.extent.origin, size: target).integral
        let context = PageCleaner.context

        guard let rgb = context.createCGImage(scaled, from: rect) else { return nil }
        let image: CGImage
        if isEffectivelyGray(rgb),
           let grayCS = CGColorSpace(name: CGColorSpace.genericGrayGamma2_2),
           let gray = context.createCGImage(scaled, from: rect, format: .L8, colorSpace: grayCS) {
            image = gray
        } else {
            image = rgb
        }

        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: jpegQuality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }

    /// The pixel size a page is encoded at: the long edge capped at
    /// `maxLongEdge`, aspect kept, never upscaled.
    static func targetPixelSize(for size: CGSize, maxLongEdge: CGFloat) -> CGSize {
        let long = max(size.width, size.height)
        guard long > maxLongEdge else { return size }
        let s = maxLongEdge / long
        return CGSize(width: (size.width * s).rounded(), height: (size.height * s).rounded())
    }

    /// True when no meaningful share of the page carries colour. Judged on a
    /// 256 x 256 thumbnail: a pixel is "coloured" when its channels spread by
    /// more than 48/255 (paper tint and white-balance casts stay well under
    /// that; the downscale averages sensor noise away), and the page is colour
    /// once 0.05% of pixels are (33 of 65 536). A small logo or a 1 cm stamp
    /// is enough, because losing a red stamp loses information. Measured: a
    /// 64 x 64 thumbnail with a 0.5% bar called the fixture's 6 cm letterhead
    /// mark gray (it covers ~0.3% of the page).
    static func isEffectivelyGray(_ image: CGImage) -> Bool {
        let side = 256
        guard let ctx = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return false }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        guard let data = ctx.data else { return false }
        let px = data.bindMemory(to: UInt8.self, capacity: side * side * 4)
        var coloured = 0
        for i in 0..<(side * side) {
            let r = Int(px[i * 4]), g = Int(px[i * 4 + 1]), b = Int(px[i * 4 + 2])
            if max(r, g, b) - min(r, g, b) > 48 { coloured += 1 }
        }
        return Double(coloured) / Double(side * side) < 0.0005
    }
}
