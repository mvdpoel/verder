// Generates apps/ios/GripTests/Fixtures/rotated-photo.jpg: a synthetic photo
// stored SIDEWAYS with EXIF Orientation = 6, the way an iPhone held upright
// writes it (the sensor reads landscape; the tag says "turn 90 degrees
// clockwise to show it"). The share extension must turn it upright.
//
// What makes "up" and "left" detectable, in the UPRIGHT image (2400 x 3200,
// portrait — long edge over PhotoPage.maxPixelSize, so the page is downscaled):
//   - a dark band across the top 10% (the up direction);
//   - a mid-grey block on the LEFT, just below the band (catches a mirror:
//     Orientation 5/7 would put it on the right);
//   - everything else light paper.
// Stored, the same pixels are rotated 90 degrees counter-clockwise: 3200 x 2400,
// band down the LEFT edge, block in the bottom rows.
//
// Synthetic shapes only; no text, no personal data. Deterministic. Run from the
// repo root:
//
//   swiftc -O apps/ios/scripts/make-rotated-photo-fixture.swift -o /tmp/make-rotated-photo-fixture \
//     && /tmp/make-rotated-photo-fixture apps/ios/GripTests/Fixtures/rotated-photo.jpg
//
// Kept out of every Xcode target: scripts/ is not a source path in project.yml.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let uprightWidth = 2400
let uprightHeight = 3200
// Stored landscape.
let width = uprightHeight
let height = uprightWidth
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "rotated-photo.jpg"

guard let ctx = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
) else { fatalError("no context") }

// Paper.
ctx.setFillColor(CGColor(srgbRed: 0.95, green: 0.95, blue: 0.95, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

// Orientation 6: stored column x is upright row x (from the top); stored row r
// (from the top) is upright column (uprightWidth - 1 - r). CoreGraphics is
// y-up, so stored row r from the top is y = height - 1 - r: upright column c
// sits at y = c.

// The band: upright rows 0..<10% → stored columns 0..<320, full height.
ctx.setFillColor(CGColor(srgbRed: 0.08, green: 0.08, blue: 0.08, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: uprightHeight / 10, height: height))

// The block: upright rows 15%..<35%, columns 0..<30% → stored x 480..<1120,
// y 0..<720 (upright column c is y = c).
ctx.setFillColor(CGColor(srgbRed: 0.45, green: 0.45, blue: 0.45, alpha: 1))
ctx.fill(CGRect(x: uprightHeight * 15 / 100, y: 0,
                width: uprightHeight * 20 / 100, height: uprightWidth * 30 / 100))

guard let image = ctx.makeImage() else { fatalError("no image") }
let url = URL(fileURLWithPath: out)
guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
else { fatalError("no destination") }
CGImageDestinationAddImage(dest, image, [
    // Measured: the top-level kCGImagePropertyOrientation alone writes NO tag
    // into a JPEG; the TIFF dictionary is what lands in IFD0.
    kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFOrientation: 6],
    kCGImageDestinationLossyCompressionQuality: 0.8,
] as CFDictionary)
guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(out)") }

// Read the tag back through ImageIO: `sips -g orientation` prints <nil> for
// this file although the tag is there, so it is no witness.
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      props[kCGImagePropertyOrientation] as? Int == 6
else { fatalError("\(out) does not carry Orientation 6") }
print("wrote \(out) (\(width) x \(height) stored, Orientation 6)")
