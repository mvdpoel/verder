import AVFoundation

/// Whether verder may use the camera, asked at first use and never on launch
/// (brief R25: a pre-prompt screen with one button, then iOS's own alert).
enum CameraAuthorization: Equatable, Sendable {
    case notDetermined, authorized, denied
}

protocol CameraAccess: Sendable {
    func status() -> CameraAuthorization
    /// iOS's alert. True when Martin allowed it.
    func request() async -> Bool
}

struct LiveCameraAccess: CameraAccess {
    func status() -> CameraAuthorization {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .notDetermined: .notDetermined
        case .authorized: .authorized
        default: .denied
        }
    }

    func request() async -> Bool { await AVCaptureDevice.requestAccess(for: .video) }
}
