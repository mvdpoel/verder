import Foundation
import Observation

/// "Gesprek vastleggen" as state (plan 3 Task 25, spec §7.4).
///
/// The flow: hold to record → release → the recording is transcribed ON the
/// phone → the transcript is shown, editable → a party (most recent first,
/// the top one preselected) and a channel (`call` by default) → "Verstuur als
/// voorstel", which creates a PENDING log-entry suggestion that Martin
/// approves in Voor jou like any other. Nothing here writes the logbook.
///
/// THE AUDIO: it is uploaded only when Martin turns on "bewaar opname". Either
/// way the local file is deleted once the send succeeds (kept, it now lives in
/// the vault), on "Weggooien", and — for a crash mid-flow — when the next voice
/// log opens. A failed send keeps it, with the text, for the retry.
///
/// ONE clientId per voice log, reused on every retry: the server makes the
/// suggestion (and a kept recording) idempotent on it, so a lost response
/// never stores the call twice.
@MainActor
@Observable
final class VoiceLogModel {
    enum Phase: Equatable {
        case idle
        case recording
        case transcribing
        case editing
        case sending
        case sent(duplicate: Bool)
    }

    enum Speech: Equatable {
        case checking
        /// The Dutch model is downloading (first use only).
        case installing
        case ready
        /// No transcription; the reason, in Dutch. Typing still works.
        case unavailable(String)
    }

    enum Copy {
        static let unsupported = "Nederlandse spraakherkenning is niet beschikbaar op deze iPhone. Typ zelf wat er besproken is."
        static let assetsMissing = "Het Nederlandse spraakmodel is nog niet op je telefoon. Probeer het opnieuw met internet, of typ zelf wat er besproken is."
        static let nothingHeard = "Er is niets verstaan. Neem opnieuw op, of typ zelf wat er besproken is."
        static let transcribeFailed = "Omzetten naar tekst lukte niet. Typ zelf wat er besproken is; de opname blijft bewaard tot je verstuurt."
        static let holdLonger = "Houd de knop ingedrukt zolang je praat."
        static let micDenied = "verder mag de microfoon niet gebruiken. Zet het aan in Instellingen."
        static let recordFailed = "Opnemen lukte niet. Probeer het nog eens."
        static let partiesFailed = "De partijen konden niet worden geladen."
        static let offline = "Geen verbinding. Je tekst blijft staan; probeer het zo opnieuw."
        static let serverFailed = "verder kon het nu niet aannemen. Je tekst blijft staan; probeer het zo opnieuw."
        static let signedOut = "Je sessie is verlopen. Log opnieuw in; je tekst blijft staan."
        static let rejected = "verder weigerde dit voorstel. Controleer de tekst en de partij."
        static let tooLong = "De tekst is te lang om te versturen."
        static let audioTooLarge = "De opname is te groot om te bewaren. Zet 'bewaar opname' uit en verstuur alleen de tekst."
        static let audioMissing = "De opname is niet meer op je telefoon. Zet 'bewaar opname' uit en verstuur alleen de tekst."
    }

    /// Shorter than this is a tap, not a recording.
    static let minimumDuration: TimeInterval = 0.6

    private(set) var phase: Phase = .idle
    private(set) var speech: Speech = .checking
    var transcript = ""
    private(set) var parties: [PartyDTO] = []
    private(set) var partiesFailed = false
    var partyId: String?
    var channel: VoiceChannel = .call
    var keepRecording = false
    /// When the call is recorded as having happened: the moment recording
    /// started (or typing began).
    private(set) var occurredAt: Date?
    private(set) var notice: String?
    private(set) var micDenied = false
    private(set) var clientId = UUID()

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let recorder: any VoiceRecording
    @ObservationIgnored private let transcriber: any Transcribing
    @ObservationIgnored private let dir: URL
    @ObservationIgnored private let now: @MainActor () -> Date
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void
    @ObservationIgnored private var recordingURL: URL?
    /// The finger lifted while the start was still waiting on permission.
    @ObservationIgnored private var startPending = false
    @ObservationIgnored private var releasedEarly = false

    init(client: APIClient, recorder: any VoiceRecording, transcriber: any Transcribing, dir: URL,
         now: @escaping @MainActor () -> Date = { Date() },
         onUnauthorized: @escaping @MainActor () -> Void = {}) {
        self.client = client
        self.recorder = recorder
        self.transcriber = transcriber
        self.dir = dir
        self.now = now
        self.onUnauthorized = onUnauthorized
        Self.clear(dir)
    }

    /// The live folder: temporary, and emptied every time a voice log opens.
    static var liveDirectory: URL {
        URL.temporaryDirectory.appending(path: "voice", directoryHint: .isDirectory)
    }

    var hasRecording: Bool {
        recordingURL.map { FileManager.default.fileExists(atPath: $0.path(percentEncoded: false)) } ?? false
    }

    var canRecord: Bool { speech == .ready && phase == .idle }

    var trimmedTranscript: String { transcript.trimmingCharacters(in: .whitespacesAndNewlines) }

    var canSend: Bool {
        phase == .editing && partyId != nil && !trimmedTranscript.isEmpty
            && trimmedTranscript.count <= VoiceDraft.transcriptMax
    }

    var selectedParty: PartyDTO? { parties.first { $0.id == partyId } }

    // MARK: - Opening

    /// Parties first (the picker should be ready the moment the transcript
    /// is), then the speech model, which may download once.
    func prepare() async {
        await loadParties()
        await prepareSpeech()
    }

    func loadParties() async {
        do {
            let rows: [PartyDTO] = try await client.getJSON("/api/mobile/v1/parties?recent=1")
            parties = rows
            partiesFailed = false
            if partyId == nil || !rows.contains(where: { $0.id == partyId }) { partyId = rows.first?.id }
        } catch {
            if APIError.isCancellation(error) { return }
            partiesFailed = true
            if (error as? APIError) == .unauthorized { onUnauthorized() }
        }
    }

    func prepareSpeech() async {
        speech = .checking
        switch await transcriber.availability() {
        case .ready:
            speech = .ready
        case .unsupported:
            speech = .unavailable(Copy.unsupported)
        case .needsDownload:
            speech = .installing
            do throws(TranscriptionError) {
                try await transcriber.install()
                speech = .ready
            } catch .languageUnsupported {
                speech = .unavailable(Copy.unsupported)
            } catch {
                speech = .unavailable(Copy.assetsMissing)
            }
        }
    }

    // MARK: - Hold to record

    /// The finger went down.
    func startRecording() async {
        guard canRecord, !startPending else { return }
        startPending = true
        releasedEarly = false
        defer { startPending = false }
        notice = nil
        guard await recorder.requestPermission() else {
            micDenied = true
            notice = Copy.micDenied
            return
        }
        micDenied = false
        // Lifted while the permission alert was up: that was not a recording.
        guard !releasedEarly, phase == .idle else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appending(path: "\(clientId.uuidString.lowercased()).m4a")
        do {
            try recorder.start(to: url)
        } catch {
            try? FileManager.default.removeItem(at: url)
            notice = Copy.recordFailed
            return
        }
        recordingURL = url
        occurredAt = now()
        phase = .recording
    }

    /// The finger came up: stop, then transcribe on the phone.
    func stopRecording() async {
        guard phase == .recording else {
            if startPending { releasedEarly = true }
            return
        }
        let duration = recorder.stop()
        guard duration >= Self.minimumDuration, let url = recordingURL else {
            deleteRecording()
            occurredAt = nil
            phase = .idle
            notice = Copy.holdLonger
            return
        }
        phase = .transcribing
        do throws(TranscriptionError) {
            transcript = try await transcriber.transcribe(url)
            notice = nil
        } catch {
            notice = switch error {
            case .languageUnsupported: Copy.unsupported
            case .assetsUnavailable: Copy.assetsMissing
            case .nothingHeard: Copy.nothingHeard
            case .failed: Copy.transcribeFailed
            }
            if error == .languageUnsupported { speech = .unavailable(Copy.unsupported) }
        }
        phase = .editing
    }

    /// No speech (or no wish to talk): type the note instead.
    func typeInstead() {
        guard phase == .idle else { return }
        occurredAt = occurredAt ?? now()
        notice = nil
        phase = .editing
    }

    // MARK: - Sending

    func send() async {
        guard canSend, let partyId, let occurredAt else { return }
        var audio: Data?
        if keepRecording {
            guard let url = recordingURL, let data = try? Data(contentsOf: url) else {
                notice = Copy.audioMissing
                return
            }
            guard data.count <= VoiceDraft.audioMaxBytes else {
                notice = Copy.audioTooLarge
                return
            }
            audio = data
        }
        let draft = VoiceDraft(clientId: clientId, occurredAt: occurredAt, partyId: partyId, channel: channel,
                               transcript: trimmedTranscript, audio: audio)
        phase = .sending
        notice = nil
        do {
            let (data, _) = try await client.send(draft.request(client))
            let answer: VoiceEntryAnswer = try APIClient.decode(data)
            deleteRecording()
            phase = .sent(duplicate: answer.duplicate)
        } catch {
            phase = .editing
            notice = Self.copy(for: error)
            if (error as? APIError) == .unauthorized { onUnauthorized() }
        }
    }

    /// Throw the whole voice log away: the recording is deleted, nothing sent.
    func discard() {
        if phase == .recording { recorder.cancel() }
        deleteRecording()
        reset()
    }

    /// After a send: a fresh log, with a NEW clientId.
    func startOver() {
        deleteRecording()
        reset()
    }

    private func reset() {
        phase = .idle
        transcript = ""
        keepRecording = false
        channel = .call
        occurredAt = nil
        notice = nil
        clientId = UUID()
        partyId = parties.first?.id
    }

    private func deleteRecording() {
        if let url = recordingURL { try? FileManager.default.removeItem(at: url) }
        recordingURL = nil
    }

    private static func clear(_ dir: URL) {
        let fm = FileManager.default
        for name in (try? fm.contentsOfDirectory(atPath: dir.path(percentEncoded: false))) ?? [] {
            try? fm.removeItem(at: dir.appending(path: name))
        }
    }

    static func copy(for error: any Error) -> String {
        switch error as? APIError {
        case .unauthorized?: Copy.signedOut
        case .transport?: Copy.offline
        case .rejected?: Copy.rejected
        case .rateLimited?, .server?, nil: Copy.serverFailed
        }
    }
}

// MARK: - Words the screen shows (kept here, so the view stays layout only)

extension VoiceLogModel {
    /// The line under the title about speech itself; nil when all is well.
    var speechLine: String? {
        switch speech {
        case .checking: "spraakherkenning controleren…"
        case .installing: "Nederlands spraakmodel wordt geïnstalleerd…"
        case .ready: nil
        case .unavailable(let reason): reason
        }
    }

    var phaseLine: String {
        switch phase {
        case .idle: canRecord ? "Houd ingedrukt en vertel wat er besproken is." : "Typ wat er besproken is."
        case .recording: "Opnemen — laat los om te stoppen."
        case .transcribing: "Omzetten naar tekst, op je telefoon…"
        case .editing: "Controleer de tekst. Er gaat niets naar het logboek tot jij het goedkeurt in Voor jou."
        case .sending: "Versturen…"
        case .sent(let duplicate):
            duplicate ? "Dit gesprek was al verstuurd. Je vindt het in Voor jou."
                : "Verstuurd als voorstel. Keur het goed in Voor jou."
        }
    }

    /// "zo 1 nov · 14:33", Amsterdam's clock.
    var occurredLabel: String? {
        occurredAt.map {
            $0.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened,
                                          locale: Locale(identifier: "nl_NL"),
                                          timeZone: TimeZone(identifier: "Europe/Amsterdam")!))
        }
    }
}
