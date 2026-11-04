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
/// never stores the call twice. "Opnieuw opnemen" KEEPS it too, and is only
/// offered BEFORE any send was attempted: until then the server has never seen
/// the id, so the new take is simply this same voice log. After an attempt the
/// server may already hold the id (the response can be lost after it stored
/// the suggestion) — a different take under it would be answered `duplicate`
/// and silently dropped, and a fresh id could store the call twice — so then
/// the text is edited instead and no re-record is offered.
///
/// THE RECORDING is NSFileProtectionComplete (unreadable while the phone is
/// locked): its folder gets the class before the recorder writes a byte, so
/// the file inherits it, and the file is set again once it exists.
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

    /// The party picker's state. "Loading" is only ever the state before the
    /// first answer: an empty dossier and a failed load each say so, with a
    /// retry, so the sheet never shows "Partijen laden…" forever.
    enum PartiesState: Equatable {
        case loading
        case loaded
        /// The server answered with no parties at all.
        case empty
        case failed
    }

    enum Copy {
        static let unsupported = "Nederlandse spraakherkenning is niet beschikbaar op deze iPhone. Typ zelf wat er besproken is."
        static let assetsMissing = "Het Nederlandse spraakmodel is nog niet op je telefoon. Probeer het opnieuw met internet, of typ zelf wat er besproken is."
        static let nothingHeard = "Er is niets verstaan. Neem opnieuw op, of typ zelf wat er besproken is."
        static let transcribeFailed = "Omzetten naar tekst lukte niet. Typ zelf wat er besproken is; de opname blijft bewaard tot je verstuurt."
        static let holdLonger = "Houd de knop ingedrukt zolang je praat."
        static let micDenied = "verder mag de microfoon niet gebruiken. Zet hem aan in Instellingen."
        static let recordFailed = "Opnemen lukte niet. Probeer het nog eens."
        static let partiesFailed = "De partijen konden niet worden geladen."
        static let partiesLoading = "Partijen laden…"
        /// A voice log is always ABOUT someone (the suggestion's participant),
        /// so with no parties there is nothing to send it with; it says so.
        static let noParties = "Nog geen partijen in je dossier. Een gesprek leg je vast bij een partij, dus versturen kan pas als er een is. Voeg die toe in verder en probeer het opnieuw."
        static let retry = "Opnieuw proberen"
        static let recordAgain = "Opnieuw opnemen"
        static let occurredAt = "Gesprek was om"
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
    private(set) var partiesState: PartiesState = .loading
    var partyId: String?
    var channel: VoiceChannel = .call
    var keepRecording = false
    /// When the call is recorded as having happened: the moment recording
    /// started (or typing began), unless Martin set it ("Gesprek was om …").
    private(set) var occurredAt: Date?
    /// Martin set the time himself: a new take does not move it.
    private(set) var occurredAtSetByHand = false
    /// A send was tried under this clientId (whatever came back): from then on
    /// the server may hold it, so no re-record (see the type's doc).
    private(set) var sendAttempted = false
    private(set) var notice: String?
    private(set) var micDenied = false
    /// The microphone was never asked: the pre-prompt shows first, and iOS's
    /// alert only after its "Ga verder" (brief R25).
    private(set) var micPrePrompt = false
    private(set) var clientId = UUID()

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let recorder: any VoiceRecording
    @ObservationIgnored private let transcriber: any Transcribing
    @ObservationIgnored private let dir: URL
    @ObservationIgnored private let now: @MainActor () -> Date
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void
    @ObservationIgnored private let protect: @MainActor (URL) throws -> Void
    @ObservationIgnored private var recordingURL: URL?
    /// The finger lifted while the start was still waiting on permission.
    @ObservationIgnored private var startPending = false
    @ObservationIgnored private var releasedEarly = false

    init(client: APIClient, recorder: any VoiceRecording, transcriber: any Transcribing, dir: URL,
         now: @escaping @MainActor () -> Date = { Date() },
         protect: @escaping @MainActor (URL) throws -> Void = VoiceLogModel.protectRecording,
         onUnauthorized: @escaping @MainActor () -> Void = {}) {
        self.client = client
        self.recorder = recorder
        self.transcriber = transcriber
        self.dir = dir
        self.now = now
        self.protect = protect
        self.onUnauthorized = onUnauthorized
        Self.clear(dir)
    }

    /// NSFileProtectionComplete: a recording of a call about Martin's case is
    /// unreadable while the phone is locked.
    static let recordingAttributes: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.complete]

    /// Sets the recording's class on the folder or the file at `url`.
    static func protectRecording(_ url: URL) throws {
        try FileManager.default.setAttributes(recordingAttributes, ofItemAtPath: url.path(percentEncoded: false))
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

    /// "Opnieuw opnemen": after a take that gave no text (niets verstaan, or
    /// the transcription failed), never over text Martin has, never once a
    /// send was attempted, and only while Dutch speech is ready.
    var canRecordAgain: Bool {
        phase == .editing && speech == .ready && trimmedTranscript.isEmpty && !sendAttempted
    }

    /// The latest time "Gesprek was om" may say: now. A call is never in the
    /// future.
    var latestOccurredAt: Date { now() }

    /// The parties line under "Met wie", or nil when the picker shows.
    var partiesLine: String? {
        switch partiesState {
        case .loading: Copy.partiesLoading
        case .loaded: nil
        case .empty: Copy.noParties
        case .failed: Copy.partiesFailed
        }
    }

    var canRetryParties: Bool { partiesState == .empty || partiesState == .failed }

    /// The Dutch model could not be installed: worth asking again (a missing
    /// language is not, nothing can be downloaded for it).
    var canRetrySpeech: Bool { speech == .unavailable(Copy.assetsMissing) }

    var selectedParty: PartyDTO? { parties.first { $0.id == partyId } }

    // MARK: - Opening

    /// Parties first (the picker should be ready the moment the transcript
    /// is), then the speech model, which may download once.
    func prepare() async {
        switch recorder.permission() {
        case .undetermined: micPrePrompt = true
        case .denied: micDenied = true
        case .granted: break
        }
        await loadParties()
        await prepareSpeech()
    }

    func loadParties() async {
        do {
            let rows: [PartyDTO] = try await client.getJSON("/api/mobile/v1/parties?recent=1")
            parties = rows
            partiesState = rows.isEmpty ? .empty : .loaded
            if partyId == nil || !rows.contains(where: { $0.id == partyId }) { partyId = rows.first?.id }
        } catch {
            if APIError.isCancellation(error) { return }
            partiesState = parties.isEmpty ? .failed : .loaded
            if (error as? APIError) == .unauthorized { onUnauthorized() }
        }
    }

    /// "Opnieuw proberen" under an empty or failed party list.
    func retryParties() async {
        guard canRetryParties else { return }
        partiesState = .loading
        await loadParties()
    }

    /// "Opnieuw proberen" under "het Nederlandse spraakmodel is nog niet op je
    /// telefoon": checks again and, when still missing, requests the install.
    func retrySpeech() async {
        guard canRetrySpeech else { return }
        await prepareSpeech()
    }

    /// "Ga verder" on the microphone pre-prompt: now iOS asks.
    func acceptMicPrePrompt() async {
        micPrePrompt = false
        let allowed = await SystemPrompts.around { await recorder.requestPermission() }
        micDenied = !allowed
        notice = allowed ? nil : Copy.micDenied
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
        if recorder.permission() == .undetermined {
            micPrePrompt = true
            return
        }
        guard await recorder.requestPermission() else {
            micDenied = true
            notice = Copy.micDenied
            return
        }
        micDenied = false
        // Lifted while the permission alert was up: that was not a recording.
        guard !releasedEarly, phase == .idle else { return }
        let url = dir.appending(path: "\(clientId.uuidString.lowercased()).m4a")
        var started = false
        do {
            // The class first, on the folder (an existing folder keeps its old
            // class through createDirectory, hence the explicit set), so the
            // file is born Complete; then on the file itself.
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                    attributes: Self.recordingAttributes)
            try protect(dir)
            try recorder.start(to: url)
            started = true
            try protect(url)
        } catch {
            if started { recorder.cancel() }
            try? FileManager.default.removeItem(at: url)
            notice = Copy.recordFailed
            return
        }
        recordingURL = url
        if !occurredAtSetByHand { occurredAt = now() }
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
            if !occurredAtSetByHand { occurredAt = nil }
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
            case .assetsUnavailable: nil // said once, with its retry, in the speech line
            case .nothingHeard: Copy.nothingHeard
            case .failed: Copy.transcribeFailed
            }
            if error == .languageUnsupported { speech = .unavailable(Copy.unsupported) }
            if error == .assetsUnavailable { speech = .unavailable(Copy.assetsMissing) }
        }
        phase = .editing
    }

    /// "Opnieuw opnemen": back to the recorder, the take that gave no text
    /// deleted. The clientId stays (see the type's doc for why that is safe
    /// only before a send attempt); a time Martin set by hand stays too.
    func recordAgain() {
        guard canRecordAgain else { return }
        deleteRecording()
        keepRecording = false
        notice = nil
        phase = .idle
    }

    /// "Gesprek was om …": Martin's own time for the call, never later than now.
    func setOccurredAt(_ date: Date) {
        occurredAt = min(date, now())
        occurredAtSetByHand = true
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
        guard canSend, let partyId, let chosen = occurredAt else { return }
        let occurredAt = min(chosen, now())
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
        sendAttempted = true
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
        occurredAtSetByHand = false
        sendAttempted = false
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
}
