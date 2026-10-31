import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import UIKit

/// Lighting and shadow cleanup of one captured page, on the phone, before the
/// PDF is built (spec §7.1).
///
/// Three variants, selectable so they can be MEASURED against each other on
/// real letters (plan Task 10 step 3: shoot 5 letters, one crumpled, upload
/// each variant, compare the server's OCR character counts) before one is
/// chosen. Unreadable output is worse than wrinkled output.
///
/// There is deliberately no `dewarp` case. The plan asked to try "the iOS
/// 26/27 Vision document APIs for dewarping"; the iOS 27.2 SDK has none
/// (measured against Vision's swiftinterface and headers, 2026-10-31): its
/// document APIs are `DetectDocumentSegmentationRequest` (a quadrilateral —
/// perspective, which VNDocumentCameraViewController already corrects) and
/// `RecognizeDocumentsRequest` (text structure), and nothing in Vision,
/// VisionKit or Core Image flattens curl or wrinkles. The closest built-in
/// document step is Core Image's `CIDocumentEnhancer` (shadow removal,
/// background whitening, contrast), which is the third variant.
enum PageCleaner {
    enum Variant: String, CaseIterable, Sendable {
        /// The camera's image, untouched.
        case raw
        /// `CIHighlightShadowAdjust` + a mild `CIColorControls` contrast.
        case baseline
        /// Core Image's `CIDocumentEnhancer`.
        case documentEnhancer

        /// Until the measurement says otherwise.
        static let `default`: Variant = .baseline

        /// `UserDefaults` key; a launch argument `-pageCleaner <variant>`
        /// lands in the argument domain, so a measurement build needs no UI.
        static let defaultsKey = "pageCleaner"

        static func current(_ defaults: UserDefaults = .standard) -> Variant {
            defaults.string(forKey: defaultsKey).flatMap(Variant.init(rawValue:)) ?? .default
        }
    }

    static func clean(_ image: UIImage) -> UIImage {
        clean(image, variant: .current())
    }

    static func clean(_ image: UIImage, variant: Variant) -> UIImage {
        guard variant != .raw, let input = ciImage(image) else { return image }
        let output: CIImage?
        switch variant {
        case .raw:
            return image
        case .baseline:
            let shadows = CIFilter.highlightShadowAdjust()
            shadows.inputImage = input
            shadows.shadowAmount = 0.6     // lift the shadow side of the page
            shadows.highlightAmount = 1.0  // 1 = leave highlights alone
            shadows.radius = 0
            let contrast = CIFilter.colorControls()
            contrast.inputImage = shadows.outputImage
            contrast.contrast = 1.12
            contrast.brightness = 0.02
            contrast.saturation = 1.0
            output = contrast.outputImage
        case .documentEnhancer:
            let enhancer = CIFilter.documentEnhancer()
            enhancer.inputImage = input
            enhancer.amount = 1.0
            output = enhancer.outputImage
        }
        guard let output,
              let cg = context.createCGImage(output.cropped(to: input.extent), from: input.extent)
        else { return image }  // a failed filter must never lose the page
        return UIImage(cgImage: cg, scale: 1, orientation: .up)
    }

    /// One context for the process: creating a `CIContext` is expensive and
    /// the context itself is thread-safe.
    static let context = CIContext(options: [.cacheIntermediates: false])

    /// The page with its EXIF orientation applied, so every variant returns an
    /// `.up` image and the PDF never draws a page sideways.
    static func ciImage(_ image: UIImage) -> CIImage? {
        guard let cg = image.cgImage else { return nil }
        return CIImage(cgImage: cg).oriented(CGImagePropertyOrientation(image.imageOrientation))
    }
}

extension CGImagePropertyOrientation {
    init(_ o: UIImage.Orientation) {
        switch o {
        case .up: self = .up
        case .down: self = .down
        case .left: self = .left
        case .right: self = .right
        case .upMirrored: self = .upMirrored
        case .downMirrored: self = .downMirrored
        case .leftMirrored: self = .leftMirrored
        case .rightMirrored: self = .rightMirrored
        @unknown default: self = .up
        }
    }
}
