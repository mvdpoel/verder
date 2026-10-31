// Generates apps/ios/VerderTests/Fixtures/letter-page.jpg: a synthetic stand-in
// for one page as VNDocumentCameraViewController hands it over — already
// cropped and perspective-corrected, but still carrying what a phone photo of
// paper carries: uneven lighting, a soft shadow across one side, a fold line,
// sensor noise and slightly soft text. 3024 x 4032 (12.2 MP, the iPhone 16 Pro
// main camera's default output size).
//
// It is NOT a real letter and contains no personal data. It is a size and
// readability fixture: the PDF-size tests need a page whose JPEG entropy looks
// like a photographed page (noise and gradients are what make photos big),
// and a clean vector render would undersell the size by an order of magnitude.
//
// Deterministic (fixed-seed PRNG), so regenerating gives the same bytes on the
// same macOS. Run from the repo root:
//
//   swiftc -O apps/ios/scripts/make-letter-fixture.swift -o /tmp/make-letter-fixture \
//     && /tmp/make-letter-fixture apps/ios/VerderTests/Fixtures/letter-page.jpg
//
// Kept out of every Xcode target on purpose: scripts/ is not a source path in
// project.yml, so this file is never compiled into the app or the tests.

import AppKit
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

let width = 3024
let height = 4032
let out = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "letter-page.jpg"

// xorshift64* — fixed seed, so the fixture is reproducible.
var rngState: UInt64 = 0x9E37_79B9_7F4A_7C15
func nextRandom() -> Double {
    rngState ^= rngState >> 12
    rngState ^= rngState << 25
    rngState ^= rngState >> 27
    return Double((rngState &* 0x2545_F491_4F6C_DD1D) >> 11) / Double(1 << 53)
}
func gaussian() -> Double {
    let u1 = max(nextRandom(), 1e-12), u2 = nextRandom()
    return (-2 * log(u1)).squareRoot() * cos(2 * .pi * u2)
}

let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
guard let ctx = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
    space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("no context") }

// Paper.
ctx.setFillColor(CGColor(srgbRed: 0.965, green: 0.955, blue: 0.93, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

// CoreGraphics is y-up; lay text out top-down in a flipped frame.
let margin = 300.0
func draw(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular,
          color: NSColor = NSColor(srgbRed: 0.08, green: 0.08, blue: 0.1, alpha: 1),
          top: Double, left: Double = margin, right: Double = Double(width) - margin) -> Double {
    let font = NSFont.systemFont(ofSize: size, weight: weight)
    let para = NSMutableParagraphStyle()
    para.lineSpacing = size * 0.35
    let attr = NSAttributedString(string: text, attributes: [
        .font: font, .foregroundColor: color, .paragraphStyle: para,
    ])
    let setter = CTFramesetterCreateWithAttributedString(attr)
    let boxWidth = right - left
    let fit = CTFramesetterSuggestFrameSizeWithConstraints(
        setter, CFRange(location: 0, length: 0), nil,
        CGSize(width: boxWidth, height: .greatestFiniteMagnitude), nil)
    let rect = CGRect(x: left, y: Double(height) - top - fit.height, width: boxWidth, height: fit.height + 2)
    let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), CGPath(rect: rect, transform: nil), nil)
    CTFrameDraw(frame, ctx)
    return top + fit.height
}

// Letterhead: a coloured mark plus the sender block, as real letters have.
ctx.setFillColor(CGColor(srgbRed: 0.05, green: 0.36, blue: 0.62, alpha: 1))
ctx.fillEllipse(in: CGRect(x: margin, y: Double(height) - 260 - 180, width: 180, height: 180))
_ = draw("Gemeente Voorbeeldstad", size: 64, weight: .semibold,
         color: NSColor(srgbRed: 0.05, green: 0.36, blue: 0.62, alpha: 1), top: 280, left: margin + 230)
_ = draw("Afdeling Werk en Inkomen · Postbus 1234 · 9999 ZZ Voorbeeldstad", size: 38,
         color: NSColor(srgbRed: 0.3, green: 0.3, blue: 0.35, alpha: 1), top: 370, left: margin + 230)

var y = 620.0
y = draw("De heer M. Voorbeeld\nTeststraat 1\n9999 AA Voorbeeldstad", size: 46, top: y) + 120
y = draw("Datum: 28 oktober 2026\nOns kenmerk: WI/2026/0042817\nBetreft: Aanvullende gegevens bijzondere bijstand",
         size: 44, top: y) + 120
let body = """
Geachte heer Voorbeeld,

Op 14 oktober 2026 hebben wij uw aanvraag voor bijzondere bijstand ontvangen. Om uw aanvraag te kunnen beoordelen, hebben wij nog een aantal gegevens van u nodig. Wij vragen u de volgende stukken uiterlijk 11 november 2026 aan ons te sturen:

1. Een kopie van uw loonstroken over de maanden augustus, september en oktober 2026.
2. Een recent overzicht van uw bankrekening, waarop uw naam en rekeningnummer zichtbaar zijn.
3. De beschikking van de rechtbank waaruit blijkt dat uw goederen onder bewind zijn gesteld.
4. Een overzicht van uw vaste lasten, zoals huur, energie en verzekeringen.

U kunt de stukken uploaden via het digitale loket of per post sturen naar het adres bovenaan deze brief. Vermeld daarbij altijd het kenmerk WI/2026/0042817.

Ontvangen wij de gevraagde gegevens niet op tijd, dan kunnen wij uw aanvraag niet in behandeling nemen. Wij nemen dan een besluit op basis van de gegevens die wij al hebben. Heeft u vragen over deze brief? Bel dan op werkdagen tussen 9.00 en 12.00 uur met telefoonnummer 0123 456 789.

Met vriendelijke groet,

namens het college van burgemeester en wethouders,

J. de Vries
Consulent Werk en Inkomen
"""
_ = draw(body, size: 44, top: y)

// Pixel pass: lighting gradient (brighter top-left, darker bottom-right), a
// soft shadow band down the right edge (the phone's own shadow), a faint
// horizontal fold at two thirds, sensor noise, and a 3-tap blur on luminance
// so the text edges are camera-soft rather than vector-sharp.
guard let data = ctx.data else { fatalError("no data") }
let px = data.bindMemory(to: UInt8.self, capacity: width * height * 4)
let foldY = Double(height) * 2 / 3
for row in 0..<height {
    // CGContext memory is top row first.
    let fy = Double(row) / Double(height)
    for col in 0..<width {
        let fx = Double(col) / Double(width)
        var light = 1.0 - 0.16 * (fx * 0.6 + fy * 0.4)
        let shadow = max(0, (fx - 0.78) / 0.22)
        light -= 0.22 * shadow * shadow
        let d = abs(Double(row) - foldY)
        if d < 14 { light -= 0.05 * (1 - d / 14) } else if d < 30 { light += 0.02 * (1 - (d - 14) / 16) }
        let n = gaussian() * 5.5
        let i = (row * width + col) * 4
        for c in 0..<3 {
            let v = Double(px[i + c]) * light + n
            px[i + c] = UInt8(max(0, min(255, v.rounded())))
        }
    }
}
for row in 1..<(height - 1) {
    for col in 0..<width {
        let i = (row * width + col) * 4
        let up = i - width * 4, down = i + width * 4
        for c in 0..<3 {
            let v = (Int(px[up + c]) + 2 * Int(px[i + c]) + Int(px[down + c])) / 4
            px[i + c] = UInt8(v)
        }
    }
}

guard let image = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(
          URL(fileURLWithPath: out) as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
else { fatalError("could not create output") }
CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(out)") }
print("wrote \(out) (\(width)x\(height))")
