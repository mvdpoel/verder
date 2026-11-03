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
/// AN IMPORTED CALL (Added 2026-11-03, `importRecording`): the same flow
/// from a FILE — a call the Phone app recorded and Martin shared from Notes
/// (an audio `IncomingDrop`), or one picked with "Opname kiezen". verder
/// copies it into its own folder (the copy is what is read and, kept, what
/// is sent; the picked original is never touched), transcribes it on the
/// phone with progress, and sends the edited text as the same suggestion.
/// The drop in the App Group is deleted after a successful send or a
/// cancel, and kept through a failed send, a relock or a sign-in, so even a
/// killed app offers it again. A call sheet active for a party within the
/// last hour (`RecentCallSheet`) preselects that party and puts its ticked
/// points on top, as "Gesprek vastleggen" after a call does.
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

    /// Dictating into the microphone, or writing out a recording that came in.
    enum Mode: Equatable {
        case dictate
        case importRecording
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
        static let micDenied = "verder mag de microfoon niet gebruiken. Zet het aan in Instellingen."
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
        static let title = "Gesprek vastleggen"
        static let importTitle = "Opname uitschrijven"
        static let pickRecording = "Opname kiezen"
        static let importFailed = "Deze opname kon niet worden geopend. Kies een andere, of typ zelf wat er besproken is."
        static let retryTranscription = "Opnieuw uitschrijven"
        /// The Phone app's own recording, said where Martin looks for it. "Als
        /// je iPhone het aanbiedt": Apple offers it per region and language,
        /// and whether it does in Dutch is not confirmed.
        static let phoneRecordingHint = "Een gesprek opgenomen met de Telefoon-app (tijdens het gesprek: Meer › Gesprek opnemen, als je iPhone het aanbiedt) staat in Notities. Deel de opname daar naar verder, of kies hem hier."
        static let keepRecordingHint = "Alleen dan gaat de opname naar verder. Anders wordt ze na het versturen gewist."
        static let keepImportHint = "Alleen dan gaat de opname naar verder. Anders wist verder zijn kopie na het versturen; het origineel blijft staan waar het stond."
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
    private(set) var clientId = UUID()
    /// "Besproken: …" from a finished call's ticked points (`CallSession`):
    /// shown above the recorder and put on top of whatever Martin then
    /// dictates or types. Nil for a voice log opened any other way.
    private(set) var prefill: String?
    private(set) var mode: Mode = .dictate
    /// How far the on-device model is through an imported recording, 0…1;
    /// nil when nothing is being written out.
    private(set) var transcriptionProgress: Double?
    /// The App Group drop this log is writing out, if it came from one.
    private(set) var importedDrop: UUID?

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
    @ObservationIgnored private let recentCall: @MainActor () -> VoicePrefill?
    @ObservationIgnored private var imported: RecordingImport?

    init(client: APIClient, recorder: any VoiceRecording, transcriber: any Transcribing, dir: URL,
         now: @escaping @MainActor () -> Date = { Date() },
         protect: @escaping @MainActor (URL) throws -> Void = VoiceLogModel.protectRecording,
         recentCall: @escaping @MainActor () -> VoicePrefill? = { nil },
         onUnauthorized: @escaping @MainActor () -> Void = {}) {
        self.recentCall = recentCall
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
        mode == .dictate && phase == .editing && speech == .ready && !sendAttempted && holdsNoOwnWords
    }

    /// "Opnieuw uitschrijven": an imported recording whose transcription gave
    /// no text, while the copy is still here and before any send — never over
    /// text Martin has, and never when Dutch is not on this phone at all.
    var canRetryTranscription: Bool {
        mode == .importRecording && phase == .editing && hasRecording && !sendAttempted && holdsNoOwnWords
            && speech != .unavailable(Copy.unsupported)
    }

    /// Nothing in the text beyond the call sheet's points.
    private var holdsNoOwnWords: Bool {
        trimmedTranscript.isEmpty || trimmedTranscript == prefill?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var title: String { mode == .importRecording ? Copy.importTitle : Copy.title }

    /// The toggle's explanation: an imported call has an original elsewhere.
    var keepRecordingHint: String { mode == .importRecording ? Copy.keepImportHint : Copy.keepRecordingHint }

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

    /// A voice log opened from a finished call: the ticked points, the party
    /// and the call's own time. Applied only to a FRESH log — never over a
    /// recording or text Martin already has (that work "blijft staan").
    func apply(_ p: VoicePrefill) {
        guard phase == .idle, trimmedTranscript.isEmpty, !hasRecording, !sendAttempted else { return }
        let text = p.text.trimmingCharacters(in: .whitespacesAndNewlines)
        prefill = text.isEmpty ? nil : text
        partyId = p.partyId
        if let at = p.occurredAt {
            occurredAt = min(at, now())
            occurredAtSetByHand = true
        }
    }

    /// The prefill on top, Martin's own words under it.
    private func withPrefill(_ words: String) -> String {
        guard let prefill else { return words }
        let own = words.trimmingCharacters(in: .whitespacesAndNewlines)
        return own.isEmpty ? prefill : prefill + "\n\n" + own
    }

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
            transcript = withPrefill(try await transcriber.transcribe(url))
            notice = nil
        } catch {
            transcriptionFailed(error)
        }
        phase = .editing
    }

    /// No text came back: the Dutch sentence for why, and the prefill (if
    /// any) as the text so typing starts under it. Shared by dictation and
    /// an imported recording, so both say the same thing for the same fault.
    private func transcriptionFailed(_ error: TranscriptionError) {
        if prefill != nil && trimmedTranscript.isEmpty { transcript = withPrefill("") }
        notice = switch error {
        case .languageUnsupported: Copy.unsupported
        case .assetsUnavailable: nil // said once, with its retry, in the speech line
        case .nothingHeard: Copy.nothingHeard
        case .failed: Copy.transcribeFailed
        }
        if error == .languageUnsupported { speech = .unavailable(Copy.unsupported) }
        if error == .assetsUnavailable { speech = .unavailable(Copy.assetsMissing) }
    }

    // MARK: - An imported recording

    /// Writes out a call recording that came in as a file. Only on a FRESH
    /// log (nothing recorded, typed or sent): work in progress is never
    /// replaced (`VoiceLogSession.openImport` checks this too).
    func importRecording(_ source: RecordingImport) async {
        guard phase == .idle, !hasRecording, !sendAttempted, holdsNoOwnWords else { return }
        if prefill == nil, let recent = recentCall() { apply(recent) }
        notice = nil
        let url = dir.appending(path: "\(clientId.uuidString.lowercased()).\(source.fileExtension)")
        do {
            // The same class as a dictated recording, set on the folder before
            // the copy lands and on the copy itself.
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                    attributes: Self.recordingAttributes)
            try protect(dir)
            try? FileManager.default.removeItem(at: url)
            try FileManager.default.copyItem(at: source.file, to: url)
            try protect(url)
        } catch {
            try? FileManager.default.removeItem(at: url)
            notice = Copy.importFailed
            return
        }
        mode = .importRecording
        imported = source
        importedDrop = source.drop
        recordingURL = url
        if !occurredAtSetByHand { occurredAt = min(source.capturedAt ?? now(), now()) }
        await transcribeImported()
    }

    /// "Opname kiezen": a file from the document picker. Read under its
    /// security scope and COPIED; the original stays where it was.
    func importPicked(_ url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let created = (try? url.resourceValues(forKeys: [.creationDateKey]))?.creationDate
        await importRecording(RecordingImport(file: url, fileName: url.lastPathComponent, mime: "",
                                              capturedAt: created, drop: nil, groupDir: nil))
    }

    /// "Opnieuw uitschrijven", after an import that gave no text.
    func retryTranscription() async {
        guard canRetryTranscription else { return }
        if case .unavailable = speech { await prepareSpeech() }
        await transcribeImported()
    }

    private func transcribeImported() async {
        guard let url = recordingURL else { return }
        phase = .transcribing
        transcriptionProgress = 0
        let report: @Sendable (Double) -> Void = { [weak self] fraction in
            Task { @MainActor in
                guard let self, self.phase == .transcribing, self.transcriptionProgress != nil else { return }
                self.transcriptionProgress = max(self.transcriptionProgress ?? 0, fraction)
            }
        }
        do throws(TranscriptionError) {
            let words = try await transcriber.transcribe(url, progress: report)
            transcript = withPrefill(words)
            notice = nil
        } catch {
            transcriptionFailed(error)
        }
        transcriptionProgress = nil
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
        if trimmedTranscript.isEmpty { transcript = withPrefill("") }
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
        var draft = VoiceDraft(clientId: clientId, occurredAt: occurredAt, partyId: partyId, channel: channel,
                               transcript: trimmedTranscript, audio: audio)
        if let imported {
            draft.audioMime = imported.audioMime
            draft.audioExtension = imported.fileExtension
        }
        phase = .sending
        notice = nil
        sendAttempted = true
        do {
            let (data, _) = try await client.send(draft.request(client))
            let answer: VoiceEntryAnswer = try APIClient.decode(data)
            deleteRecording()
            deleteImportedDrop()
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
        deleteImportedDrop()
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
        prefill = nil
        mode = .dictate
        transcriptionProgress = nil
        imported = nil
        importedDrop = nil
        clientId = UUID()
        partyId = parties.first?.id
    }

    private func deleteRecording() {
        if let url = recordingURL { try? FileManager.default.removeItem(at: url) }
        recordingURL = nil
    }

    /// The shared recording in the App Group: its job is done (sent) or
    /// called off (cancelled). A picked file has no drop and is never touched.
    private func deleteImportedDrop() {
        guard let imported, let id = imported.drop, let groupDir = imported.groupDir else { return }
        IncomingDrop.remove(id, groupDir: groupDir)
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
        case .transcribing:
            if mode == .importRecording, let p = transcriptionProgress {
                "Opname uitschrijven, op je telefoon… \(Int((p * 100).rounded(.down)))%"
            } else {
                "Omzetten naar tekst, op je telefoon…"
            }
        case .editing: "Controleer de tekst. Er gaat niets naar het logboek tot jij het goedkeurt in Voor jou."
        case .sending: "Versturen…"
        case .sent(let duplicate):
            duplicate ? "Dit gesprek was al verstuurd. Je vindt het in Voor jou."
                : "Verstuurd als voorstel. Keur het goed in Voor jou."
        }
    }
}
