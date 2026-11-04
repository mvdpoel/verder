import Foundation
import Observation

/// "Spraaknotitie" as state (plan 3 Task 25, spec §7.4, Figma "Voice
/// quick-log · final").
///
/// The flow: hold to record — or tap once to start and again to stop →
/// the recording is transcribed ON the phone → the transcript is shown,
/// editable, with the party and channel it names already picked (never a
/// party the dossier does not hold) → "Verstuur als voorstel", which creates
/// a PENDING log-entry suggestion that Martin approves in Voor jou like any
/// other. Nothing here writes the logbook.
///
/// THE AUDIO: it is uploaded only when Martin turns on "bewaar opname". Either
/// way the local file is deleted once the send succeeds (kept, it now lives in
/// the vault), on "Weggooien", on a cancelled take, and — for a crash mid-flow
/// — when the next voice log opens. A failed send keeps it, with the text,
/// for the retry.
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
///
/// The few presentation flags the frames need driven (the picker sheet, the
/// time wheel, the close confirmation, the text field's focus) live here too,
/// so the view stays layout only and the fixtures can put the screen in any
/// state the frames draw.
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
        /// Speech recognition is switched off for verder in Settings.
        case denied
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

    /// Where the chosen party (or channel) came from: the frames say it under
    /// the row ("UIT JE TEKST", "LAATST GESPROKEN").
    enum Source: Equatable { case lastSpoken, fromText, chosen }

    /// A take that gave no text: its own sheet-filling state.
    enum TakeProblem: Equatable { case nothingHeard, failed }

    /// Why the last send did not arrive, with its one next step.
    enum SendFailure: Equatable {
        case offline, server, rejected, signedOut, audioTooLarge, audioMissing
    }

    enum Copy {
        static let title = "Spraaknotitie"
        static let unsupported = "Nederlandse spraakherkenning is niet beschikbaar op deze iPhone. Typ zelf wat er besproken is."
        static let assetsMissing = "Het Nederlandse spraakmodel is nog niet op je telefoon. Probeer het opnieuw met internet, of typ zelf wat er besproken is."
        static let nothingHeard = "Te zacht of te kort? Houd de knop vast terwijl je praat, of tik één keer om te starten."
        static let transcribeFailed = "Typ zelf wat er besproken is; de opname blijft op je iPhone tot je verstuurt."
        static let holdLonger = "Dat was te kort. Houd de knop vast terwijl je praat, of tik één keer om te starten."
        static let micDenied = "verder hoort je alleen terwijl je opneemt. Zet Microfoon aan in Instellingen → verder."
        static let speechDenied = "verder zet je stem op je iPhone om in tekst. Zet Spraakherkenning aan in Instellingen → verder."
        static let recordFailed = "Opnemen lukte niet. Probeer het nog eens."
        static let partiesFailed = "De partijen konden niet worden geladen. Controleer je verbinding en probeer het opnieuw; je notitie blijft staan."
        static let partiesLoading = "Partijen laden…"
        /// A voice log is always ABOUT someone (the suggestion's participant),
        /// so with no parties there is nothing to send it with; it says so.
        static let noParties = "Een gesprek leg je vast bij een partij, dus versturen kan pas als er een is. Voeg die toe in verder en probeer het opnieuw. Je notitie blijft staan."
        static let retry = "Opnieuw proberen"
        static let recordAgain = "Opnieuw opnemen"
        static let typeNote = "Typ je notitie"
        static let openSettings = "Open Instellingen"
        static let occurredAt = "Gesprek was om"
        static let offline = "Geen verbinding. Je tekst blijft staan; probeer het zo opnieuw."
        static let serverFailed = "verder kon het nu niet aannemen. Je tekst blijft staan; probeer het zo opnieuw."
        static let signedOut = "Je sessie is verlopen. Log opnieuw in; je tekst blijft staan."
        static let rejected = "verder weigerde dit voorstel. Controleer de tekst en de partij."
        static let tooLong = "De tekst is te lang om te versturen. Kort hem in tot 20.000 tekens."
        static let audioTooLarge = "De opname is te groot om mee te sturen. Verstuur alleen de tekst; de opname blijft op je iPhone."
        static let audioMissing = "De opname is niet meer op je telefoon. Verstuur alleen de tekst."
        static let send = "Verstuur als voorstel"
        static let sending = "Versturen…"
        static let sendWithout = "Verstuur zonder opname"
        static let signIn = "Log opnieuw in"
        static let unlock = "Ontgrendel met Face ID"
        static let discardEllipsis = "Weggooien…"
        static let footnote = "Komt als suggestie in Voor jou. Na jouw akkoord staat het in je logboek."
        static let writeFirst = "Schrijf eerst wat er besproken is."
        static let waitForParties = "Versturen kan zodra de partijen geladen zijn. Je tekst blijft staan."
        static let needParty = "Versturen kan pas als er een partij in je dossier staat. Je tekst blijft staan."
        static let lockedFootnote = "Je notitie blijft staan. Na ontgrendelen kun je hem meteen versturen."
        static let idlePrompt = "Vertel met wie je sprak en wat jullie afspraken."
        static let privacy = "Je stem wordt op je iPhone omgezet. De opname gaat niet mee, tenzij je hem bewaart."
        static let onPhone = "Dit gebeurt op je iPhone. Er gaat niets naar verder tot je verstuurt."
        static let confirmTitle = "Deze notitie is nog niet verstuurd."
        static let keepEditing = "Verder bewerken"
        static let discard = "Weggooien"
        static let placeholder = "Wat is er besproken?"
        static let recordAgainTitle = "Je aanpassingen gaan verloren."
    }

    /// Shorter than this is a tap: it starts a hands-free recording (and a
    /// recording stopped within it held nothing worth keeping).
    static let minimumDuration: TimeInterval = 0.6

    private(set) var phase: Phase = .idle
    private(set) var speech: Speech = .checking
    /// The download of the Dutch model, while it runs and where it stopped.
    private(set) var installProgress: InstallProgress?
    /// The phone has no network (the app's path monitor, set by the sheet).
    var networkOffline = false
    var transcript = ""
    /// What the speech model heard, before Martin's edits ("AANGEPAST").
    private(set) var recognizedTranscript = ""
    /// The words so far while recording, and while the take is transcribed.
    private(set) var live = LiveText.empty
    private(set) var parties: [PartyDTO] = []
    private(set) var partiesState: PartiesState = .loading
    private(set) var partyId: String?
    private(set) var partySource: Source = .lastSpoken
    private(set) var channel: VoiceChannel = .call
    private(set) var channelSource: Source = .lastSpoken
    var keepRecording = false
    /// When the call is recorded as having happened: the moment recording
    /// started (or typing began), unless Martin set it ("Gesprek was om …").
    private(set) var occurredAt: Date?
    /// Martin set the time himself: a new take does not move it.
    private(set) var occurredAtSetByHand = false
    /// A send was tried under this clientId (whatever came back): from then on
    /// the server may hold it, so no re-record (see the type's doc).
    private(set) var sendAttempted = false
    /// A short line under the record button (a press too short, a recorder
    /// that would not start).
    private(set) var notice: String?
    private(set) var takeProblem: TakeProblem?
    private(set) var sendFailure: SendFailure?
    /// Bumped on every failed send: the sheet's `.error` haptic.
    private(set) var sendFailures = 0
    private(set) var micDenied = false
    /// The microphone was never asked: the pre-prompt shows first, and iOS's
    /// alert only after its "Ga verder" (brief R25).
    private(set) var micPrePrompt = false
    private(set) var clientId = UUID()

    // The recording gesture.
    /// A finger is on the button.
    private(set) var pressing = false
    /// The finger slid off the button: releasing now cancels.
    private(set) var pressOutside = false
    /// A tap started this recording: it runs until the next tap (or Stop).
    private(set) var handsFree = false
    private(set) var recordingStartedAt: Date?

    // After a send.
    private(set) var sentSuggestionId: String?
    private(set) var sentSummary = ""
    private(set) var sentKeptRecording = false

    // Presentation the frames drive.
    var pickerOpen = false
    var pickerQuery = ""
    var timeOpen = false
    var confirmingClose = false
    var confirmingRecordAgain = false
    var textFocused = false

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let recorder: any VoiceRecording
    @ObservationIgnored private let transcriber: any Transcribing
    @ObservationIgnored private let dir: URL
    @ObservationIgnored let now: @MainActor () -> Date
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void
    @ObservationIgnored private let protect: @MainActor (URL) throws -> Void
    @ObservationIgnored private let audioMaxBytes: Int
    @ObservationIgnored private var recordingURL: URL?
    /// The finger lifted while the start was still waiting on permission.
    @ObservationIgnored private var startPending = false
    @ObservationIgnored private var releasedEarly = false
    /// The press that began on a hands-free recording ends it on release.
    @ObservationIgnored private var stopOnRelease = false
    @ObservationIgnored private var liveTask: Task<Void, Never>?

    init(client: APIClient, recorder: any VoiceRecording, transcriber: any Transcribing, dir: URL,
         now: @escaping @MainActor () -> Date = { Date() },
         protect: @escaping @MainActor (URL) throws -> Void = VoiceLogModel.protectRecording,
         audioMaxBytes: Int = VoiceDraft.audioMaxBytes,
         onUnauthorized: @escaping @MainActor () -> Void = {}) {
        self.client = client
        self.recorder = recorder
        self.transcriber = transcriber
        self.dir = dir
        self.now = now
        self.protect = protect
        self.audioMaxBytes = audioMaxBytes
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

    /// Martin changed what the speech model heard ("WAT JE ZEI · AANGEPAST").
    var isEdited: Bool {
        !recognizedTranscript.isEmpty
            && trimmedTranscript != recognizedTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// "Opnieuw opnemen": after a take (with text or without), never once a
    /// send was attempted, and only while Dutch speech is ready.
    var canRecordAgain: Bool {
        phase == .editing && speech == .ready && !sendAttempted && (hasRecording || takeProblem != nil)
    }

    /// The latest time "Gesprek was om" may say: now. A call is never in the
    /// future.
    var latestOccurredAt: Date { now() }

    var canRetryParties: Bool { partiesState == .empty || partiesState == .failed }

    /// The Dutch model could not be installed: worth asking again (a missing
    /// language is not, nothing can be downloaded for it).
    var canRetrySpeech: Bool { speech == .unavailable(Copy.assetsMissing) }

    var selectedParty: PartyDTO? { parties.first { $0.id == partyId } }

    /// A swipe must not throw away a recording or typed text by accident —
    /// except a hands-free recording, which keeps running with the sheet
    /// pulled down (frame "opname · blad omlaag").
    var holdsUnsentWork: Bool {
        switch phase {
        case .recording, .transcribing, .sending: true
        case .editing: !trimmedTranscript.isEmpty || hasRecording
        case .idle, .sent: false
        }
    }

    var blocksSwipe: Bool { holdsUnsentWork && !(phase == .recording && handsFree) }

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
            if partyId == nil || !rows.contains(where: { $0.id == partyId }) {
                partyId = rows.first?.id
                partySource = .lastSpoken
            }
            if !transcript.isEmpty { applyReading() }
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

    /// "Opnieuw proberen" on "Nederlandse spraak laden lukt niet": checks
    /// again and, when still missing, requests the install.
    func retrySpeech() async {
        guard canRetrySpeech else { return }
        await prepareSpeech()
    }

    /// The network came back: a download that stopped for want of it goes on
    /// by itself ("Het laden gaat vanzelf verder zodra je weer online bent").
    func networkChanged(offline: Bool) async {
        let wasOffline = networkOffline
        networkOffline = offline
        if wasOffline && !offline && canRetrySpeech { await prepareSpeech() }
    }

    /// "Ga verder" on the microphone pre-prompt: now iOS asks.
    func acceptMicPrePrompt() async {
        micPrePrompt = false
        let allowed = await SystemPrompts.around { await recorder.requestPermission() }
        micDenied = !allowed
    }

    func prepareSpeech() async {
        speech = .checking
        switch await transcriber.availability() {
        case .ready:
            speech = .ready
        case .unsupported:
            speech = .unavailable(Copy.unsupported)
        case .denied:
            speech = .denied
        case .needsDownload:
            speech = .installing
            do throws(TranscriptionError) {
                try await transcriber.install(progress: { [weak self] p in
                    Task { @MainActor in
                        guard let self, self.speech == .installing else { return }
                        self.installProgress = p
                    }
                })
                speech = .ready
                installProgress = nil
            } catch .languageUnsupported {
                speech = .unavailable(Copy.unsupported)
            } catch {
                speech = .unavailable(Copy.assetsMissing)
            }
        }
    }

    // MARK: - The record button

    /// A finger went down on the button. On a hands-free recording, this is
    /// the tap that will stop it (on release).
    func press() async {
        pressing = true
        pressOutside = false
        if phase == .recording {
            stopOnRelease = handsFree
            return
        }
        stopOnRelease = false
        await startRecording()
    }

    /// The finger moved: off the button means a release now cancels.
    func drag(outside: Bool) {
        guard pressing, phase == .recording, !handsFree else { return }
        pressOutside = outside
    }

    /// The finger came up after `heldFor` seconds. A short press is a tap:
    /// it leaves the recording running, hands-free, until the next tap.
    func release(heldFor: TimeInterval) async {
        let outside = pressOutside
        pressing = false
        pressOutside = false
        guard phase == .recording else {
            if startPending { releasedEarly = true }
            return
        }
        if outside && !handsFree { cancelRecording(); return }
        if stopOnRelease {
            stopOnRelease = false
            await stopRecording()
        } else if heldFor < Self.minimumDuration {
            handsFree = true
        } else {
            await stopRecording()
        }
    }

    /// VoiceOver and Switch Control: one activation starts a hands-free
    /// recording, the next stops it.
    func toggleRecording() async {
        if phase == .recording {
            await stopRecording()
        } else {
            await startRecording()
            if phase == .recording { handsFree = true }
        }
    }

    /// Starts a recording.
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
        let start = now()
        recordingStartedAt = start
        if !occurredAtSetByHand { occurredAt = start }
        live = .empty
        handsFree = false
        phase = .recording
        let stream = transcriber.live(url)
        liveTask = Task { [weak self] in
            for await text in stream {
                guard let self, self.phase == .recording else { return }
                self.live = text
            }
        }
    }

    /// The recording's running time, for "0:14".
    var elapsed: TimeInterval { recordingStartedAt.map { max(0, now().timeIntervalSince($0)) } ?? 0 }

    /// Stop, then transcribe on the phone.
    func stopRecording() async {
        guard phase == .recording else {
            if startPending { releasedEarly = true }
            return
        }
        liveTask?.cancel()
        liveTask = nil
        handsFree = false
        pressing = false
        let duration = recorder.stop()
        guard duration >= Self.minimumDuration, let url = recordingURL else {
            deleteRecording()
            if !occurredAtSetByHand { occurredAt = nil }
            live = .empty
            phase = .idle
            notice = Copy.holdLonger
            return
        }
        phase = .transcribing
        do throws(TranscriptionError) {
            let text = try await transcriber.transcribe(url)
            transcript = text
            recognizedTranscript = text
            takeProblem = nil
            applyReading()
        } catch {
            switch error {
            case .nothingHeard: takeProblem = .nothingHeard
            case .languageUnsupported:
                speech = .unavailable(Copy.unsupported)
                takeProblem = .failed
            case .assetsUnavailable:
                speech = .unavailable(Copy.assetsMissing)
                takeProblem = .failed
            case .failed: takeProblem = .failed
            }
        }
        live = .empty
        phase = .editing
    }

    /// "Annuleer", or a finger slid off the button: the take is deleted,
    /// never transcribed and never sent. The clientId stays.
    func cancelRecording() {
        guard phase == .recording else { return }
        liveTask?.cancel()
        liveTask = nil
        recorder.cancel()
        deleteRecording()
        handsFree = false
        pressing = false
        pressOutside = false
        live = .empty
        recordingStartedAt = nil
        if !occurredAtSetByHand { occurredAt = nil }
        phase = .idle
    }

    /// "Opnieuw opnemen": back to the recorder, this take deleted. Over text
    /// Martin edited it asks first (`needsRecordAgainConfirmation`). The
    /// clientId stays (see the type's doc for why that is safe only before a
    /// send attempt); a time Martin set by hand stays too.
    func recordAgain() {
        guard canRecordAgain else { return }
        confirmingRecordAgain = false
        deleteRecording()
        transcript = ""
        recognizedTranscript = ""
        takeProblem = nil
        keepRecording = false
        notice = nil
        textFocused = false
        timeOpen = false
        phase = .idle
    }

    var needsRecordAgainConfirmation: Bool { isEdited || (recognizedTranscript.isEmpty && !trimmedTranscript.isEmpty) }

    /// "Gesprek was om …": Martin's own time for the call, never later than now.
    func setOccurredAt(_ date: Date) {
        occurredAt = min(date, now())
        occurredAtSetByHand = true
    }

    /// The time wheel's days: up to today, labelled "Vandaag" (frame "tijd
    /// wijzigen").
    var wheelDays: [VoiceText.WheelDay] { VoiceText.wheelDays(now: now()) }

    /// The wheel's position: the day (its start), hour and minute shown.
    var wheelParts: (day: Date, hour: Int, minute: Int) { VoiceText.wheelParts(occurredAt ?? now()) }

    /// One wheel turned: the time it names, never later than now.
    func setOccurred(day: Date? = nil, hour: Int? = nil, minute: Int? = nil) {
        let at = wheelParts
        setOccurredAt(VoiceText.wheelDate(day: day ?? at.day, hour: hour ?? at.hour, minute: minute ?? at.minute))
    }

    /// "Typ je notitie": the editor, empty or with the take's state left.
    func typeInstead() {
        switch phase {
        case .idle:
            occurredAt = occurredAt ?? now()
        case .editing where takeProblem != nil:
            break
        default:
            return
        }
        takeProblem = nil
        notice = nil
        phase = .editing
        textFocused = true
    }

    func choose(party id: String) {
        guard parties.contains(where: { $0.id == id }) else { return }
        partyId = id
        partySource = .chosen
        pickerOpen = false
        pickerQuery = ""
    }

    func choose(channel: VoiceChannel) {
        self.channel = channel
        channelSource = .chosen
    }

    /// The party row's tap: the picker, and a retry when the list failed.
    func openPicker() async {
        pickerOpen = true
        if partiesState == .failed { await retryParties() }
    }

    /// The transcript names a party in the dossier, or how the call went:
    /// both are picked, unless Martin already chose one himself.
    private func applyReading() {
        let reading = VoiceText.read(transcript, parties: parties)
        if partySource != .chosen, let id = reading.partyId {
            partyId = id
            partySource = .fromText
        }
        if channelSource != .chosen, let c = reading.channel {
            channel = c
            channelSource = .fromText
        }
    }

    /// The words to mark in the transcript: the party and the channel word
    /// that were READ from it (dotted, in signal).
    /// None while the parties are not loaded (frame "voorbeeld · partijen
    /// laden lukt niet"): nothing could be matched, so nothing is marked —
    /// not even the channel word, or the text would claim a reading the
    /// Gesprek card cannot show.
    var marks: [Range<String.Index>] {
        guard partiesState == .loaded else { return [] }
        var out: [Range<String.Index>] = []
        if partySource == .fromText, let p = selectedParty {
            let r = VoiceText.read(transcript, parties: [p])
            if let range = r.partyRange { out.append(range) }
        }
        if channelSource == .fromText {
            let r = VoiceText.read(transcript, parties: [])
            if r.channel == channel, let range = r.channelRange { out.append(range) }
        }
        return out.sorted { $0.lowerBound < $1.lowerBound }
    }

    // MARK: - Closing

    /// ✕ or "Weggooien…": a note holding work asks first; true when the
    /// caller may close straight away.
    func requestClose() -> Bool {
        guard holdsUnsentWork, phase != .sending else { return phase != .sending }
        textFocused = false
        confirmingClose = true
        return false
    }

    // MARK: - Sending

    func send() async {
        guard canSend, let partyId, let chosen = occurredAt else { return }
        let occurredAt = min(chosen, now())
        confirmingClose = false
        textFocused = false
        timeOpen = false
        var audio: Data?
        if keepRecording {
            guard let url = recordingURL, let data = try? Data(contentsOf: url) else {
                fail(.audioMissing)
                return
            }
            guard data.count <= audioMaxBytes else {
                fail(.audioTooLarge)
                return
            }
            audio = data
        }
        let draft = VoiceDraft(clientId: clientId, occurredAt: occurredAt, partyId: partyId, channel: channel,
                               transcript: trimmedTranscript, audio: audio)
        phase = .sending
        sendFailure = nil
        sendAttempted = true
        do {
            let (data, _) = try await client.send(draft.request(client))
            let answer: VoiceEntryAnswer = try APIClient.decode(data)
            deleteRecording()
            sentSuggestionId = answer.suggestionId
            sentSummary = VoiceText.summary(trimmedTranscript)
            sentKeptRecording = answer.audioDocumentId != nil
            phase = .sent(duplicate: answer.duplicate)
        } catch {
            phase = .editing
            fail(Self.failure(for: error, keptAudio: audio != nil))
        }
    }

    /// "Verstuur zonder opname": the recording stays on the phone, the text goes.
    func sendWithoutRecording() async {
        keepRecording = false
        await send()
    }

    /// "Log opnieuw in" in the sheet: the app's sign-in; the note waits for it
    /// (`VoiceLogSession.sessionEnded`).
    func signInAgain() { onUnauthorized() }

    private func fail(_ failure: SendFailure) {
        sendFailure = failure
        sendFailures += 1
    }

    /// Throw the whole voice log away: the recording is deleted, nothing sent.
    func discard() {
        if phase == .recording {
            liveTask?.cancel()
            recorder.cancel()
        }
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
        recognizedTranscript = ""
        live = .empty
        keepRecording = false
        channel = .call
        channelSource = .lastSpoken
        occurredAt = nil
        occurredAtSetByHand = false
        sendAttempted = false
        notice = nil
        takeProblem = nil
        sendFailure = nil
        handsFree = false
        pressing = false
        recordingStartedAt = nil
        sentSuggestionId = nil
        confirmingClose = false
        pickerOpen = false
        timeOpen = false
        textFocused = false
        clientId = UUID()
        partyId = parties.first?.id
        partySource = .lastSpoken
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

    static func failure(for error: any Error, keptAudio: Bool = false) -> SendFailure {
        switch error as? APIError {
        case .unauthorized?: .signedOut
        case .transport?: .offline
        case .rejected(413)? where keptAudio: .audioTooLarge
        case .rejected?: .rejected
        case .rateLimited?, .server?, nil: .server
        }
    }

    #if DEBUG
    /// A capture's "0:14": the recording began this long ago.
    func fixtureBackdateRecording(by seconds: TimeInterval) {
        guard let start = recordingStartedAt else { return }
        recordingStartedAt = start.addingTimeInterval(-seconds)
    }

    /// A capture's held finger (frame "opname": "Laat los om te stoppen").
    func fixtureHold() {
        pressing = true
        handsFree = false
    }

    func fixtureHandsFree() {
        pressing = false
        handsFree = true
    }

    func fixtureSetTranscript(_ text: String) { transcript = text }
    #endif
}

// MARK: - Words the screen shows (kept here, so the view stays layout only)

extension VoiceLogModel {
    /// What fills the sheet.
    enum Screen: Equatable {
        case prePrompt
        case state(StatePage)
        case capture
        case transcribing
        case editor
        case sent
    }

    /// The one next step a button takes.
    enum Action: Equatable {
        case openSettings, typeNote, recordAgain, retrySpeech

        var label: String {
            switch self {
            case .openSettings: Copy.openSettings
            case .typeNote: Copy.typeNote
            case .recordAgain: Copy.recordAgain
            case .retrySpeech: Copy.retry
            }
        }
    }

    /// A sheet-filling state: a symbol, a title, one sentence, and the next
    /// step (frames "microfoon uit", "niets gehoord", "spraak laden", …).
    struct StatePage: Equatable {
        enum Kind: Equatable { case micOff, speechOff, loading, loadingFailed, unsupported, nothingHeard, transcribeFailed }
        let kind: Kind
        let symbol: String
        let title: String
        let text: String
        /// A mono line under the text ("GESTOPT BIJ 38 VAN 61 MB").
        var meta: String? = nil
        /// The download bar (spraak laden).
        var progress: InstallProgress? = nil
        var note: String? = nil
        var primary: Action? = nil
        var secondary: Action? = .typeNote
    }

    var screen: Screen {
        if micPrePrompt { return .prePrompt }
        switch phase {
        case .idle:
            if micDenied {
                return .state(StatePage(kind: .micOff, symbol: "mic.slash", title: "Microfoon staat uit",
                                        text: Copy.micDenied, primary: .openSettings))
            }
            switch speech {
            case .denied:
                return .state(StatePage(kind: .speechOff, symbol: "text.bubble", title: "Spraakherkenning staat uit",
                                        text: Copy.speechDenied, primary: .openSettings))
            case .installing:
                return .state(StatePage(kind: .loading, symbol: "waveform", title: "Nederlandse spraak laden",
                                        text: "Dit gebeurt één keer. Daarna werkt inspreken ook zonder internet.",
                                        progress: installProgress ?? InstallProgress(fraction: 0),
                                        note: "Inspreken kan zodra het geladen is."))
            case .unavailable(let reason) where reason == Copy.assetsMissing:
                return .state(StatePage(kind: .loadingFailed, symbol: "wifi.slash",
                                        title: "Nederlandse spraak laden lukt niet",
                                        text: networkOffline
                                            ? "Geen internet. Het laden gaat vanzelf verder zodra je weer online bent."
                                            : "Het laden is gestopt. Probeer het opnieuw, of typ je notitie.",
                                        meta: installProgress.map { "Gestopt bij \(Self.amount($0))".uppercased() },
                                        primary: .retrySpeech))
            case .unavailable(let reason):
                return .state(StatePage(kind: .unsupported, symbol: "waveform.slash",
                                        title: "Inspreken werkt niet op deze iPhone",
                                        text: reason, primary: .typeNote, secondary: nil))
            case .checking, .ready:
                return .capture
            }
        case .recording: return .capture
        case .transcribing: return .transcribing
        case .editing, .sending:
            switch takeProblem {
            case .nothingHeard?:
                return .state(StatePage(kind: .nothingHeard, symbol: "waveform.slash", title: "Niets gehoord",
                                        text: Copy.nothingHeard,
                                        primary: canRecordAgain ? .recordAgain : .typeNote,
                                        secondary: canRecordAgain ? .typeNote : nil))
            case .failed?:
                return .state(StatePage(kind: .transcribeFailed, symbol: "exclamationmark.bubble",
                                        title: "Omzetten lukte niet", text: Copy.transcribeFailed,
                                        primary: .typeNote, secondary: canRecordAgain ? .recordAgain : nil))
            case nil:
                return .editor
            }
        case .sent: return .sent
        }
    }

    /// "38 VAN 61 MB", or "62%" when the system reports no bytes.
    static func amount(_ p: InstallProgress) -> String {
        if let done = p.completedBytes, let total = p.totalBytes, total > 0 {
            return VoiceText.megabytes(done: done, total: total)
        }
        return "\(Int((p.fraction * 100).rounded()))%"
    }

    /// The bar's right-hand figure ("38 VAN 61 MB").
    var installAmount: String? { installProgress.map { Self.amount($0) } }

    // MARK: Recording

    /// The big line under the button.
    var pressTitle: String {
        if phase != .recording { return "Houd vast om te praten" }
        if pressOutside { return "Laat los om te annuleren" }
        return handsFree ? "Tik om te stoppen" : "Laat los om te stoppen"
    }

    /// The small line under it.
    var pressHint: String {
        if phase != .recording {
            return speech == .checking ? "Spraakherkenning controleren…" : "of tik één keer om te starten en weer om te stoppen"
        }
        if pressOutside { return "Schuif terug naar de knop om door te gaan." }
        return handsFree ? "Trek het blad omlaag; de opname loopt door." : "Schuif van de knop af om te annuleren."
    }

    var elapsedText: String { VoiceText.elapsed(elapsed) }

    // MARK: Editor

    struct RowText: Equatable {
        let title: String
        let meta: String
    }

    /// The "Met wie" row.
    func partyRow(locked: Bool) -> RowText {
        if locked { return RowText(title: "Ontgrendel om partijen te laden", meta: "MET WIE · NA FACE ID") }
        switch partiesState {
        case .loading: return RowText(title: Copy.partiesLoading, meta: "MET WIE")
        case .failed: return RowText(title: "Partijen laden lukt niet", meta: "MET WIE · OPNIEUW LADEN")
        case .empty: return RowText(title: "Nog geen partijen", meta: "MET WIE · VOEG ER EEN TOE IN VERDER")
        case .loaded:
            let source = switch partySource {
            case .fromText: "MET WIE · UIT JE TEKST"
            case .lastSpoken: "MET WIE · LAATST GESPROKEN"
            case .chosen: "MET WIE"
            }
            return RowText(title: selectedParty?.name ?? "Kies een partij", meta: source)
        }
    }

    /// "Gesprek was om 14:20" / "VANDAAG · TIK OM TE WIJZIGEN".
    var timeRow: RowText {
        let at = occurredAt ?? now()
        return RowText(title: "\(Copy.occurredAt) \(VoiceText.time(at))",
                       meta: "\(VoiceText.day(at, now: now())) · TIK OM TE WIJZIGEN")
    }

    /// The channel as one row (the accessibility sizes, where three segments
    /// do not fit): "Telefoon" / "HOE · TIK OM TE KIEZEN".
    var channelRow: RowText { RowText(title: channel.label, meta: "HOE · TIK OM TE KIEZEN") }

    var keepRow: RowText {
        RowText(title: "Bewaar opname", meta: keepRecording ? "GAAT MEE NAAR JE DOSSIER" : "ANDERS GEWIST NA VERSTUREN")
    }

    /// "WAT JE ZEI", "WAT JE ZEI · AANGEPAST".
    var textLabel: String { isEdited ? "WAT JE ZEI · AANGEPAST" : "WAT JE ZEI" }

    /// The primary button of the editor's footer.
    struct Primary: Equatable {
        enum Does: Equatable { case send, sendWithout, signIn, unlock }
        let title: String
        let does: Does
        let enabled: Bool
    }

    func primary(locked: Bool) -> Primary {
        if locked { return Primary(title: Copy.unlock, does: .unlock, enabled: true) }
        if phase == .sending { return Primary(title: Copy.sending, does: .send, enabled: false) }
        switch sendFailure {
        case .signedOut?: return Primary(title: Copy.signIn, does: .signIn, enabled: true)
        case .audioTooLarge?, .audioMissing?: return Primary(title: Copy.sendWithout, does: .sendWithout, enabled: canSend)
        case .offline?, .server?, .rejected?: return Primary(title: Copy.retry, does: .send, enabled: canSend)
        case nil: return Primary(title: Copy.send, does: .send, enabled: canSend)
        }
    }

    /// The line under the button: what sending does, or why it cannot yet
    /// (brief §2.4 — never a silently disabled button). Nil while a failure
    /// shows its own banner and "Weggooien…" takes the place.
    func footnote(locked: Bool) -> String? {
        if locked { return Copy.lockedFootnote }
        if sendFailure != nil { return nil }
        if trimmedTranscript.isEmpty { return Copy.writeFirst }
        if trimmedTranscript.count > VoiceDraft.transcriptMax { return Copy.tooLong }
        switch partiesState {
        case .loading, .failed: return Copy.waitForParties
        case .empty: return Copy.needParty
        case .loaded: return partyId == nil ? Copy.needParty : Copy.footnote
        }
    }

    /// The banner at the top of the editor after a failed send.
    struct Banner: Equatable {
        let symbol: String
        let title: String
        let text: String
    }

    var banner: Banner? {
        switch sendFailure {
        case nil: nil
        case .offline?: Banner(symbol: "wifi.slash", title: "Niet verstuurd", text: Copy.offline)
        case .server?: Banner(symbol: "exclamationmark.circle", title: "Niet verstuurd", text: Copy.serverFailed)
        case .rejected?: Banner(symbol: "exclamationmark.circle", title: "Niet verstuurd", text: Copy.rejected)
        case .signedOut?: Banner(symbol: "rectangle.portrait.and.arrow.right", title: "Je bent uitgelogd", text: Copy.signedOut)
        case .audioTooLarge?: Banner(symbol: "exclamationmark.circle", title: "Niet verstuurd · opname te groot", text: Copy.audioTooLarge)
        case .audioMissing?: Banner(symbol: "exclamationmark.circle", title: "Niet verstuurd · opname weg", text: Copy.audioMissing)
        }
    }

    // MARK: Sent

    var sentTitle: String { phase == .sent(duplicate: true) ? "Al in Voor jou" : "Staat in Voor jou" }

    var sentText: String {
        phase == .sent(duplicate: true)
            ? "Dit gesprek was al verstuurd. Je vindt het in Voor jou."
            : "Het staat als suggestie in Voor jou. Keur het goed, dan komt het in je logboek."
    }

    /// What became of the recording.
    var sentRecordingLine: String {
        sentKeptRecording ? "OPNAME BEWAARD · IN JE DOSSIER" : "OPNAME GEWIST · ALLEEN DE TEKST IS VERSTUURD"
    }
}
