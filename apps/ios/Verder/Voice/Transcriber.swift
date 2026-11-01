import AVFoundation
import Foundation
import Speech

/// Whether this phone can turn Dutch speech into text right now.
enum SpeechAvailability: Equatable, Sendable {
    case ready
    /// Dutch is supported, but its on-device model is not installed yet.
    case needsDownload
    /// No Dutch on-device transcription on this iOS (or this device).
    case unsupported
}

/// Every way an on-device transcription can end without text. The model
/// turns each into a Dutch sentence; none of them is a dead end, because
/// Martin can always type what was said.
enum TranscriptionError: Error, Equatable, Sendable {
    case languageUnsupported
    /// The locale's model could not be downloaded or installed (offline, no
    /// space, or the system refused).
    case assetsUnavailable
    /// The recording held no speech the model could read.
    case nothingHeard
    case failed(String)
}

/// Speech to text, ON the phone (spec §7.4: no audio leaves the phone unless
/// Martin keeps the recording). A protocol so the flow is testable without a
/// microphone or a speech model.
protocol Transcribing: Sendable {
    func availability() async -> SpeechAvailability
    /// Installs the locale's model. Called before the first recording, so the
    /// download never happens while Martin is waiting on a transcript.
    func install() async throws(TranscriptionError)
    func transcribe(_ audio: URL) async throws(TranscriptionError) -> String
}

/// `SpeechAnalyzer` + `SpeechTranscriber` in Dutch (iOS 26+), with the model
/// installed through `AssetInventory` on first use.
///
/// NOT MEASURED ON THE PHONE YET (plan 3 Task 25 step 1): whether iOS 27.2
/// lists `nl_NL` and installs its asset. If it does not, `availability()`
/// answers `.unsupported` and the screen says so in Dutch and offers typing;
/// it never falls back to a server — that needs Martin's say-so.
struct OnDeviceTranscriber: Transcribing {
    static let locale = Locale(identifier: "nl_NL")

    func availability() async -> SpeechAvailability {
        guard SpeechTranscriber.isAvailable,
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Self.locale)
        else { return .unsupported }
        switch await AssetInventory.status(forModules: [Self.module(locale)]) {
        case .installed: return .ready
        case .supported, .downloading: return .needsDownload
        case .unsupported: return .unsupported
        @unknown default: return .unsupported
        }
    }

    func install() async throws(TranscriptionError) {
        let locale = try await Self.dutch()
        do {
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [Self.module(locale)]) {
                try await request.downloadAndInstall()
            }
        } catch {
            throw .assetsUnavailable
        }
        guard await AssetInventory.status(forModules: [Self.module(locale)]) == .installed else {
            throw .assetsUnavailable
        }
    }

    func transcribe(_ audio: URL) async throws(TranscriptionError) -> String {
        if await availability() == .needsDownload { try await install() }
        let locale = try await Self.dutch()
        let transcriber = Self.module(locale)
        let text: String
        do {
            let file = try AVAudioFile(forReading: audio)
            // The WWDC25 file recipe: collect results while the analyzer reads
            // the file, then finalize through its last sample.
            async let collected = transcriber.results.reduce(into: "") { text, result in
                text += String(result.text.characters)
            }
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            if let last = try await analyzer.analyzeSequence(from: file) {
                try await analyzer.finalizeAndFinish(through: last)
            } else {
                await analyzer.cancelAndFinishNow()
            }
            text = try await collected
        } catch {
            throw .failed(String(describing: error))
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw .nothingHeard }
        return trimmed
    }

    private static func dutch() async throws(TranscriptionError) -> Locale {
        guard SpeechTranscriber.isAvailable,
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Self.locale)
        else { throw .languageUnsupported }
        return locale
    }

    private static func module(_ locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(locale: locale, preset: .transcription)
    }
}
