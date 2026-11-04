import Foundation
import Observation

/// Dictation into the compose sheet: recorded and transcribed ON THE PHONE by
/// the voice log's own recorder and `Transcriber` (no sound goes to Grip).
///
/// NOT LIVE. The frames draw the words arriving while Martin speaks, with the
/// uncertain tail underlined; `Transcribing.live` is not built yet (see
/// Transcriber.swift), so the words arrive when he taps stop. The meter is a
/// steady pulse rather than the sound's level, because `VoiceRecording` does
/// not expose one. Both are recorded as differences in the capture report.
@MainActor
@Observable
final class RequestDictation {
    enum Phase: Equatable {
        case idle
        case recording(since: Date)
        case transcribing
        /// Dutch, with a way on: typing always works.
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    /// Counted for the light haptic at stop.
    private(set) var stops = 0

    @ObservationIgnored private let recorder: any VoiceRecording
    @ObservationIgnored private let transcriber: any Transcribing
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var file: URL?

    init(recorder: any VoiceRecording, transcriber: any Transcribing, now: @escaping @Sendable () -> Date = Date.init) {
        self.recorder = recorder
        self.transcriber = transcriber
        self.now = now
    }

    var isRecording: Bool { if case .recording = phase { true } else { false } }

    func start() async {
        guard phase == .idle || isFailed else { return }
        if recorder.permission() != .granted {
            guard await recorder.requestPermission() else {
                phase = .failed("Grip mag de microfoon niet gebruiken. Zet hem aan in Instellingen, of typ je vraag.")
                return
            }
        }
        switch await transcriber.availability() {
        case .ready: break
        case .needsDownload:
            do { try await transcriber.install(progress: { _ in }) } catch {
                phase = .failed("Dicteren in het Nederlands is nog niet klaar op deze iPhone. Typ je vraag.")
                return
            }
        case .unsupported:
            phase = .failed("Dicteren in het Nederlands kan niet op deze iPhone. Typ je vraag.")
            return
        case .denied:
            phase = .failed("Spraakherkenning staat uit voor Grip. Typ je vraag.")
            return
        }
        let url = URL.temporaryDirectory.appending(path: "vraag-\(UUID().uuidString).m4a")
        do {
            try recorder.start(to: url)
            file = url
            phase = .recording(since: now())
        } catch {
            phase = .failed("De opname kon niet beginnen. Typ je vraag.")
        }
    }

    /// Stops and returns the words; nil when nothing came of it (the phase
    /// then says why).
    func stop() async -> String? {
        guard isRecording, let url = file else { return nil }
        _ = recorder.stop()
        stops += 1
        phase = .transcribing
        defer { try? FileManager.default.removeItem(at: url); file = nil }
        do {
            let text = try await transcriber.transcribe(url).trimmingCharacters(in: .whitespacesAndNewlines)
            phase = .idle
            return text.isEmpty ? nil : text
        } catch .nothingHeard {
            phase = .failed("Grip hoorde niets. Probeer het nog eens, of typ je vraag.")
        } catch {
            phase = .failed("Omzetten lukte niet. Typ je vraag, of probeer het nog eens.")
        }
        return nil
    }

    func cancel() {
        if isRecording { recorder.cancel() }
        if let file { try? FileManager.default.removeItem(at: file) }
        file = nil
        phase = .idle
    }

    private var isFailed: Bool { if case .failed = phase { true } else { false } }

    #if DEBUG
    /// The frame "opstellen · dicteren": recording for nine seconds.
    func fixtureRecording(since: Date) { phase = .recording(since: since) }
    #endif
}

/// Elapsed recording time as the frame reads it: "0:09".
enum DictationClock {
    static func text(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        return "\(s / 60):\(String(format: "%02d", s % 60))"
    }
}
