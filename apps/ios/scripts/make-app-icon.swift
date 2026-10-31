// Renders the app icon (1024x1024, opaque) from the verder mark used in the
// web's nav rail (apps/web/src/components/nav-rail.tsx: a 26-unit viewBox with
// a circle r=11, a 45%-opacity vertical, and a curve), in `signal` on `void`.
//   swift scripts/make-app-icon.swift Verder/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png
import AppKit
import CoreGraphics

let size = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.png"
func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255, alpha: a)
}
let void = rgb(0x04070d), signal = rgb(0x63d3ea)

let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                    space: cs, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
ctx.setFillColor(void)
ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))

// A faint signal glow behind the mark (the icon is pressable; glow is allowed there).
let glow = CGGradient(colorsSpace: cs, colors: [rgb(0x63d3ea, 0.16), rgb(0x63d3ea, 0)] as CFArray, locations: [0, 1])!
let c = CGPoint(x: size / 2, y: size / 2)
ctx.drawRadialGradient(glow, startCenter: c, startRadius: 0, endCenter: c, endRadius: 470, options: [])

// Map the 26-unit viewBox to the icon, mark spanning ~62% of the width. SVG y runs down.
let scale: CGFloat = 640 / 22
ctx.translateBy(x: CGFloat(size) / 2 - 13 * scale, y: CGFloat(size) / 2 + 13 * scale)
ctx.scaleBy(x: scale, y: -scale)
ctx.setLineCap(.round)
ctx.setStrokeColor(signal)

ctx.setLineWidth(1.0)
ctx.strokeEllipse(in: CGRect(x: 2, y: 2, width: 22, height: 22))

ctx.setStrokeColor(rgb(0x63d3ea, 0.45))
ctx.move(to: CGPoint(x: 13, y: 3.2)); ctx.addLine(to: CGPoint(x: 13, y: 22.8)); ctx.strokePath()

ctx.setStrokeColor(signal)
ctx.setLineWidth(1.2)
ctx.move(to: CGPoint(x: 5.4, y: 8.4))
ctx.addCurve(to: CGPoint(x: 20.6, y: 8.4), control1: CGPoint(x: 10, y: 13), control2: CGPoint(x: 16, y: 13))
ctx.strokePath()

let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
