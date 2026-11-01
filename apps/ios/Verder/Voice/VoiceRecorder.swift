import AVFoundation
import Foundation

/// The microphone, as the voice log needs it. A protocol so the flow runs in
/// tests (and in fixture captures) without one.
@MainActor
protocol VoiceRecording: AnyObject {
    /// Asks once (the system remembers); true when recording is allowed.
    func requestPermission() async -> Bool
    func start(to url: URL) throws
    /// Stops and returns the recorded duration in seconds.
    func stop() -> TimeInterval
    /// Stops without keeping anything meaningful; the caller deletes the file.
    func cancel()
}

/// AAC in an `.m4a`, mono, 16 kHz at 32 kbit/s: speech needs no more, and a
/// kept hour stays near 14 MB, far below the server's 50 MB upload cap.
@MainActor
final class AudioRecorder: VoiceRecording {
    static let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 16_000,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: 32_000,
        AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
    ]

    private var recorder: AVAudioRecorder?

    func requestPermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
    }

    func start(to url: URL) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .spokenAudio)
        try session.setActive(true)
        let recorder = try AVAudioRecorder(url: url, settings: Self.settings)
        guard recorder.record() else {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw CocoaError(.fileWriteUnknown)
        }
        self.recorder = recorder
    }

    func stop() -> TimeInterval {
        let duration = recorder?.currentTime ?? 0
        recorder?.stop()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return duration
    }

    func cancel() {
        _ = stop()
    }
}
