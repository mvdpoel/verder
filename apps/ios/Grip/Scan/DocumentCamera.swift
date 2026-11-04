import SwiftUI
import VisionKit

/// VisionKit's document camera: multi-page capture, automatic edge detection
/// and perspective correction (spec §7.1). It hands back one `UIImage` per
/// page; cleanup and the PDF happen after (`PageCleaner`, `PDFAssembler`).
///
/// A capture that FAILS is reported as a cancel: the camera has nothing to
/// hand over either way, and the Scan tab's answer to both is to show the
/// camera again.
///
/// The failure callback is spelled `didFailWithError:` on purpose. The SDK's
/// apinotes advertise `didFailWith:`, but in this SDK (27.2) the compiler only
/// matches the Objective-C spelling, and the near-miss compiled to a method
/// the camera never calls (measured: "nearly matches optional requirement").
struct DocumentCamera: UIViewControllerRepresentable {
    let onFinish: ([UIImage]) -> Void
    let onCancel: () -> Void

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish, onCancel: onCancel) }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let onFinish: ([UIImage]) -> Void
        let onCancel: () -> Void

        init(onFinish: @escaping ([UIImage]) -> Void, onCancel: @escaping () -> Void) {
            self.onFinish = onFinish
            self.onCancel = onCancel
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                          didFinishWith scan: VNDocumentCameraScan) {
            onFinish((0..<scan.pageCount).map { scan.imageOfPage(at: $0) })
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            onCancel()
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                          didFailWithError error: any Error) {
            onCancel()
        }
    }
}
