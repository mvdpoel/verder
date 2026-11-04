import Testing
import UIKit
@testable import Grip

/// The document viewer's images zoom the way PDFKit's PDFs do: they open
/// fitted, a pinch reads the small print (the counter, a letter held up to
/// someone), and a double tap zooms in where it lands and back out again.
@MainActor
struct ImageZoomTests {
    /// A synthetic portrait page: 1200 x 1800 of plain grey.
    static func page() -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 1200, height: 1800),
                                format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }())
            .image { ctx in
                UIColor.gray.setFill()
                ctx.fill(CGRect(x: 0, y: 0, width: 1200, height: 1800))
            }
    }

    @Test func fitIsTheSmallerRatioAndZoomGoesWellPastIt() {
        let fit = ImageZoom.fitScale(image: CGSize(width: 1200, height: 1800), in: CGSize(width: 400, height: 800))
        #expect(fit == CGFloat(400) / 1200)
        #expect(ImageZoom.maxScale(fit: fit) >= fit * 4)
        // A tiny image may grow to fit, and can still be zoomed past that.
        let tiny = ImageZoom.fitScale(image: CGSize(width: 100, height: 100), in: CGSize(width: 400, height: 800))
        #expect(tiny == 4)
        #expect(ImageZoom.maxScale(fit: tiny) > tiny)
        #expect(ImageZoom.fitScale(image: .zero, in: CGSize(width: 400, height: 800)) == 1)
    }

    @Test func aDoubleTapZoomsInAroundThePointAndOutAgain() {
        let fit: CGFloat = 0.25
        let target = ImageZoom.doubleTapScale(current: fit, fit: fit, max: ImageZoom.maxScale(fit: fit))
        #expect(target > fit)
        #expect(ImageZoom.doubleTapScale(current: target, fit: fit, max: ImageZoom.maxScale(fit: fit)) == fit)
        // The rect to zoom to is centred on the tapped point, in image space.
        let rect = ImageZoom.zoomRect(around: CGPoint(x: 600, y: 900), scale: 1, viewport: CGSize(width: 400, height: 800))
        #expect(rect == CGRect(x: 400, y: 500, width: 400, height: 800))
    }

    /// The real view: opens fitted, pinch is live (UIScrollView only makes
    /// one when the zoom range is not empty), the image is the zooming view,
    /// and a double tap actually changes the zoom.
    @Test func theImageViewOpensFittedPinchesAndDoubleTaps() {
        let view = ZoomingImageScrollView(image: Self.page())
        view.frame = CGRect(x: 0, y: 0, width: 400, height: 800)
        view.layoutIfNeeded()
        #expect(abs(view.minimumZoomScale - CGFloat(400) / 1200) < 0.0001)
        #expect(view.zoomScale == view.minimumZoomScale)
        #expect(view.maximumZoomScale > view.minimumZoomScale)
        #expect(view.pinchGestureRecognizer != nil)
        #expect(view.viewForZooming(in: view) === view.imageView)
        #expect(view.gestureRecognizers?.contains { ($0 as? UITapGestureRecognizer)?.numberOfTapsRequired == 2 } == true)
        view.toggleZoom(at: CGPoint(x: 600, y: 900), animated: false)
        #expect(view.zoomScale > view.minimumZoomScale)
        view.toggleZoom(at: CGPoint(x: 600, y: 900), animated: false)
        #expect(view.zoomScale == view.minimumZoomScale)
    }

    /// A fitted image sits in the middle of the screen, not in the corner.
    @Test func aFittedImageIsCentred() {
        let view = ZoomingImageScrollView(image: Self.page())
        view.frame = CGRect(x: 0, y: 0, width: 400, height: 800)
        view.layoutIfNeeded()
        // 1200 x 1800 at 1/3 is 400 x 600: 100 pt above and below.
        #expect(abs(view.contentInset.top - 100) < 0.5)
        #expect(abs(view.contentInset.bottom - 100) < 0.5)
        #expect(abs(view.contentInset.left) < 0.5)
    }
}
