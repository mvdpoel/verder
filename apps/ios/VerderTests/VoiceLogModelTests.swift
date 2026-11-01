import Testing
import Foundation
import Synchronization
@testable import Verder

/// The voice quick-log as state (plan 3 Task 25): hold to record, transcribe
/// ON the phone, edit, pick a party, send as a log-entry SUGGESTION. No audio
/// leaves the phone unless Martin keeps the recording.
@MainActor
struct VoiceLogModelTests {
    nonisolated static let lindehof = "00000000-f1c5-4000-8000-600000000001"
    nonisolated static let noordkust = "00000000-f1c5-4000-8000-600000000002"
    nonisolated static let parties = Data("""
    [{"id":"\(lindehof)","kind":"organization","name":"Woonstichting Lindehof","organization":null,"lastContactAt":"2026-10-31T13:40:00.000Z"},
     {"id":"\(noordkust)","kind":"organization","name":"Bewindkantoor Noordkust","organization":null,"lastContactAt":null}]
    """.utf8)
    nonisolated static let answer = Data(#"{"suggestionId":"00000000-f1c5-4000-8000-700000000007","audioDocumentId":null,"duplicate":false}"#.utf8)
    nonisolated static let audioBytes = Data("FAKE-M4A-AUDIO-BYTES".utf8)

    let t0 = Date(timeIntervalSince1970: 1_793_540_000) // 2026-11-01T…Z

    /// A server that answers the parties list and the voice POST.
    func server(voiceStatus: Int = 200) -> StubServer {
        let s = StubServer()
        s.on { req in
            switch (req.httpMethod, req.url?.path()) {
            case ("GET", "/api/mobile/v1/parties"): .status(200, body: Self.parties)
            case ("POST", "/api/mobile/v1/entries/voice"):
                voiceStatus == 200 ? .status(200, body: Self.answer) : .status(voiceStatus)
            default: .status(404)
            }
        }
        return s
    }

    func model(_ s: StubServer, transcriber: FakeTranscriber = FakeTranscriber(text: "Gebeld met Lindehof."),
               recorder: FakeRecorder = FakeRecorder(), dir: URL? = nil,
               onUnauthorized: @escaping @MainActor () -> Void = {}) throws -> VoiceLogModel {
        var clock = t0
        let dir = try dir ?? scratchDir()
        return VoiceLogModel(client: s.client(), recorder: recorder, transcriber: transcriber, dir: dir,
                             now: { defer { clock += 5 }; return clock }, onUnauthorized: onUnauthorized)
    }

    func posted(_ s: StubServer) throws -> String {
        let req = try #require(s.requests.last { $0.httpMethod == "POST" })
        return String(decoding: try #require(req.httpBody), as: UTF8.self)
    }

    func field(_ name: String, _ value: String) -> String {
        "Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n"
    }

    /// Record, release, transcribe — the whole hold gesture.
    func record(_ m: VoiceLogModel) async {
        await m.startRecording()
        await m.stopRecording()
    }

    // MARK: - The three the plan names

    @Test func transcriptIsEditableBeforeSend() async throws {
        let s = server()
        let m = try model(s)
        await m.prepare()
        await record(m)

        #expect(m.phase == .editing)
        #expect(m.transcript == "Gebeld met Lindehof.")
        m.transcript = "Gebeld met Lindehof: akkoord met vijftig euro per maand."
        await m.send()

        #expect(m.phase == .sent(duplicate: false))
        let body = try posted(s)
        #expect(body.contains(field("transcript", "Gebeld met Lindehof: akkoord met vijftig euro per maand.")))
        #expect(!body.contains(field("transcript", "Gebeld met Lindehof.")))
    }

    @Test func audioDeletedUnlessKept() async throws {
        // Not kept: never uploaded, and gone from the phone once sent.
        let s1 = server()
        let dir1 = try scratchDir()
        let m1 = try model(s1, dir: dir1)
        await m1.prepare()
        await record(m1)
        #expect(m1.hasRecording)
        #expect(try audioFiles(dir1).count == 1)
        await m1.send()
        #expect(!(try posted(s1)).contains("name=\"audio\""))
        #expect(try audioFiles(dir1).isEmpty)
        #expect(!m1.hasRecording)

        // Kept: uploaded with the suggestion — and then not kept on the
        // phone either, because it now lives in the vault.
        let s2 = server()
        let dir2 = try scratchDir()
        let m2 = try model(s2, dir: dir2)
        await m2.prepare()
        await record(m2)
        m2.keepRecording = true
        await m2.send()
        let body = try #require(s2.requests.last { $0.httpMethod == "POST" }?.httpBody)
        #expect(String(decoding: body, as: UTF8.self).contains(
            "Content-Disposition: form-data; name=\"audio\"; filename=\"Gesprek 2026-11-01.m4a\"\r\nContent-Type: audio/mp4\r\n"))
        #expect(body.range(of: Self.audioBytes) != nil)
        #expect(try audioFiles(dir2).isEmpty)

        // Discarded: gone, nothing sent.
        let s3 = server()
        let dir3 = try scratchDir()
        let m3 = try model(s3, dir: dir3)
        await m3.prepare()
        await record(m3)
        #expect(try audioFiles(dir3).count == 1)
        m3.discard()
        #expect(try audioFiles(dir3).isEmpty)
        #expect(s3.requests.allSatisfy { $0.httpMethod != "POST" })
    }

    @Test func sendBuildsMultipartWithoutAudioByDefault() async throws {
        let s = server()
        let m = try model(s)
        await m.prepare()
        await record(m)
        #expect(m.channel == .call)
        #expect(!m.keepRecording)
        await m.send()

        let req = try #require(s.requests.last { $0.httpMethod == "POST" })
        #expect(req.url?.path() == "/api/mobile/v1/entries/voice")
        #expect(req.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary=") == true)
        let body = try posted(s)
        #expect(body.contains(field("clientId", m.clientId.uuidString.lowercased())))
        #expect(body.contains(field("occurredAt", "2026-11-01T13:33:20Z")))
        #expect(body.contains(field("partyId", Self.lindehof)))
        #expect(body.contains(field("channel", "call")))
        #expect(body.contains(field("transcript", "Gebeld met Lindehof.")))
        #expect(!body.contains("name=\"audio\""))
        #expect(!body.contains("filename="))
    }

    // MARK: - The rest of the flow

    /// The picker shows the server's order (most recent contact first) and
    /// preselects the top one, so a call just made is one tap from sent.
    @Test func partiesComeMostRecentFirstAndTheFirstIsPicked() async throws {
        let s = server()
        let m = try model(s)
        await m.prepare()
        #expect(s.requests.first { $0.url?.path() == "/api/mobile/v1/parties" }?.url?.query() == "recent=1")
        #expect(m.parties.map(\.name) == ["Woonstichting Lindehof", "Bewindkantoor Noordkust"])
        #expect(m.partyId == Self.lindehof)
    }

    /// A retry after a failure keeps the clientId, so the server stores ONE
    /// suggestion (and one recording) however often the phone asks.
    @Test func aFailedSendKeepsTheTextAndRetriesWithTheSameClientId() async throws {
        let s = server(voiceStatus: 503)
        let m = try model(s)
        await m.prepare()
        await record(m)
        m.transcript = "Bewerkt."
        await m.send()
        #expect(m.phase == .editing)
        #expect(m.transcript == "Bewerkt.")
        #expect(m.notice == VoiceLogModel.Copy.serverFailed)
        #expect(m.hasRecording)

        let first = try posted(s)
        await m.send()
        let second = try posted(s)
        #expect(first.contains(field("clientId", m.clientId.uuidString.lowercased())))
        #expect(second.contains(field("clientId", m.clientId.uuidString.lowercased())))
    }

    @Test func unauthorizedAsksForSignIn() async throws {
        let s = server(voiceStatus: 401)
        var rejected = 0
        let m = try model(s, onUnauthorized: { rejected += 1 })
        await m.prepare()
        await record(m)
        await m.send()
        #expect(rejected == 1)
        #expect(m.notice == VoiceLogModel.Copy.signedOut)
        #expect(m.phase == .editing)
    }

    /// iOS without Dutch speech: a clear Dutch state, the recorder hidden,
    /// and typing still works — never a failure screen.
    @Test func dutchNotSupportedIsAStateNotAFailure() async throws {
        let s = server()
        let m = try model(s, transcriber: FakeTranscriber(availability: .unsupported))
        await m.prepare()
        #expect(m.speech == .unavailable(VoiceLogModel.Copy.unsupported))
        #expect(!m.canRecord)

        m.typeInstead()
        #expect(m.phase == .editing)
        m.transcript = "Gebeld, zelf getypt."
        await m.send()
        #expect(m.phase == .sent(duplicate: false))
    }

    @Test func assetsNotInstalledAreDownloadedFirst() async throws {
        let s = server()
        let ok = FakeTranscriber(availability: .needsDownload)
        let m = try model(s, transcriber: ok)
        await m.prepare()
        #expect(ok.installs.withLock { $0 } == 1)
        #expect(m.speech == .ready)

        let failing = FakeTranscriber(availability: .needsDownload, installFails: true)
        let m2 = try model(server(), transcriber: failing)
        await m2.prepare()
        #expect(m2.speech == .unavailable(VoiceLogModel.Copy.assetsMissing))
        #expect(m2.canRecord == false)
        m2.typeInstead()
        #expect(m2.phase == .editing)
    }

    /// A transcription that fails after recording leaves the recording and an
    /// empty editor, with the reason in Dutch.
    @Test func aTranscriptionErrorOpensTheEditorWithTheReason() async throws {
        let m = try model(server(), transcriber: FakeTranscriber(failure: .nothingHeard))
        await m.prepare()
        await record(m)
        #expect(m.phase == .editing)
        #expect(m.transcript.isEmpty)
        #expect(m.notice == VoiceLogModel.Copy.nothingHeard)
        #expect(m.hasRecording)
        #expect(!m.canSend)
    }

    @Test func aTapIsNotARecording() async throws {
        let dir = try scratchDir()
        let recorder = FakeRecorder(duration: 0.2)
        let m = try model(server(), recorder: recorder, dir: dir)
        await m.prepare()
        await record(m)
        #expect(m.phase == .idle)
        #expect(m.notice == VoiceLogModel.Copy.holdLonger)
        #expect(try audioFiles(dir).isEmpty)
    }

    @Test func microphoneDeniedSaysWhereToFixIt() async throws {
        let m = try model(server(), recorder: FakeRecorder(allowed: false))
        await m.prepare()
        await m.startRecording()
        #expect(m.phase == .idle)
        #expect(m.notice == VoiceLogModel.Copy.micDenied)
        #expect(m.micDenied)
    }

    @Test func nothingIsSentWithoutPartyOrText() async throws {
        let s = server()
        let m = try model(s)
        await m.prepare()
        m.typeInstead()
        m.transcript = "   \n"
        #expect(!m.canSend)
        await m.send()
        #expect(s.requests.allSatisfy { $0.httpMethod != "POST" })
        m.transcript = "Iets."
        m.partyId = nil
        #expect(!m.canSend)
        m.partyId = Self.noordkust
        #expect(m.canSend)
    }

    /// A crash mid-flow leaves a recording behind; the next voice log clears
    /// it, so no audio piles up on the phone.
    @Test func leftoverRecordingsAreClearedOnOpen() async throws {
        let dir = try scratchDir()
        try Data("old".utf8).write(to: dir.appending(path: "old.m4a"))
        _ = try model(server(), dir: dir)
        #expect(try audioFiles(dir).isEmpty)
    }

    @Test func channelsAreTheServersWithDutchLabels() {
        #expect(VoiceChannel.allCases.map(\.rawValue) == ["call", "meeting", "voicemail", "whatsapp", "other"])
        #expect(VoiceChannel.call.label == "Telefoon")
        #expect(VoiceChannel.meeting.label == "Gesprek")
    }

    @Test func theAnswerAndPartiesDecode() throws {
        let a: VoiceEntryAnswer = try APIClient.decode(Self.answer)
        #expect(a == VoiceEntryAnswer(suggestionId: "00000000-f1c5-4000-8000-700000000007", audioDocumentId: nil, duplicate: false))
        let p: [PartyDTO] = try APIClient.decode(Self.parties)
        #expect(p[1].lastContactAt == nil)
    }

    func audioFiles(_ dir: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: dir.path(percentEncoded: false))
    }
}

/// Writes fake bytes where the real recorder would write the m4a.
@MainActor
final class FakeRecorder: VoiceRecording {
    let allowed: Bool
    let duration: TimeInterval
    private var url: URL?

    init(allowed: Bool = true, duration: TimeInterval = 4) {
        self.allowed = allowed
        self.duration = duration
    }

    func requestPermission() async -> Bool { allowed }

    func start(to url: URL) throws {
        try VoiceLogModelTests.audioBytes.write(to: url)
        self.url = url
    }

    func stop() -> TimeInterval { duration }

    func cancel() { url = nil }
}

final class FakeTranscriber: Transcribing {
    let availabilityValue: SpeechAvailability
    let installFails: Bool
    let result: Result<String, TranscriptionError>
    let installs = Mutex(0)

    init(text: String = "Gebeld met Lindehof.", availability: SpeechAvailability = .ready,
         installFails: Bool = false, failure: TranscriptionError? = nil) {
        availabilityValue = availability
        self.installFails = installFails
        result = failure.map { .failure($0) } ?? .success(text)
    }

    func availability() async -> SpeechAvailability { availabilityValue }

    func install() async throws(TranscriptionError) {
        installs.withLock { $0 += 1 }
        if installFails { throw .assetsUnavailable }
    }

    func transcribe(_ audio: URL) async throws(TranscriptionError) -> String {
        try result.get()
    }
}
