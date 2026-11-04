import Testing
import Foundation
import Synchronization
@testable import Grip

/// The "Voice quick-log · final" frames as rules: tap or hold to record,
/// cancel by sliding off, the words read from the transcript, the picker's
/// sections, the reasons under a disabled send, the failed sends with their
/// one next step, the sent card, and the sheet's lock and close rules.
@MainActor
struct VoiceQuickLogTests {
    let base = VoiceLogModelTests()

    nonisolated static let heard = "Gebeld met Woonstichting Lindehof. Ze gaan akkoord met de regeling van vijftig euro per maand."

    func model(_ s: StubServer, transcriber: any Transcribing = FakeTranscriber(text: VoiceQuickLogTests.heard),
               recorder: FakeRecorder = FakeRecorder(), dir: URL? = nil, audioMaxBytes: Int = VoiceDraft.audioMaxBytes)
        throws -> VoiceLogModel {
        var clock = base.t0
        return VoiceLogModel(client: s.client(), recorder: recorder, transcriber: transcriber, dir: try dir ?? scratchDir(),
                             now: { defer { clock += 5 }; return clock }, audioMaxBytes: audioMaxBytes)
    }

    // MARK: - The button

    @Test func aTapStartsHandsFreeAndTheNextTapStops() async throws {
        let m = try model(base.server())
        await m.prepare()
        await m.press()
        #expect(m.phase == .recording)
        #expect(m.pressTitle == "Laat los om te stoppen")
        await m.release(heldFor: 0.2)
        #expect(m.phase == .recording)                   // still listening: a tap
        #expect(m.handsFree)
        #expect(m.pressTitle == "Tik om te stoppen")
        #expect(!m.blocksSwipe)                          // the sheet may go down
        await m.press()
        #expect(m.phase == .recording)                   // stops on the release, not the touch
        await m.release(heldFor: 0.1)
        #expect(m.phase == .editing)
        #expect(m.transcript == Self.heard)
    }

    @Test func aHoldStillStopsOnRelease() async throws {
        let m = try model(base.server())
        await m.prepare()
        await m.press()
        await m.release(heldFor: 3)
        #expect(m.phase == .editing)
        #expect(!m.handsFree)
    }

    @Test func slidingOffCancelsAndLeavesNothing() async throws {
        let dir = try scratchDir()
        let m = try model(base.server(), dir: dir)
        await m.prepare()
        let id = m.clientId
        await m.press()
        m.drag(outside: true)
        #expect(m.pressTitle == "Laat los om te annuleren")
        await m.release(heldFor: 3)
        #expect(m.phase == .idle)
        #expect(m.transcript.isEmpty)
        #expect(m.occurredAt == nil)
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path(percentEncoded: false)).isEmpty)
        #expect(m.clientId == id)
    }

    @Test func annuleerCancelsAHandsFreeRecording() async throws {
        let dir = try scratchDir()
        let m = try model(base.server(), dir: dir)
        await m.prepare()
        await m.press()
        await m.release(heldFor: 0.1)
        m.cancelRecording()
        #expect(m.phase == .idle)
        #expect(!m.hasRecording)
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path(percentEncoded: false)).isEmpty)
    }

    @Test func voiceOverTogglesHandsFree() async throws {
        let m = try model(base.server())
        await m.prepare()
        await m.toggleRecording()
        #expect(m.phase == .recording)
        #expect(m.handsFree)
        await m.toggleRecording()
        #expect(m.phase == .editing)
    }

    @Test func theTimerAndTheLiveWordsRunWhileRecording() async throws {
        let live = LiveFake(text: Self.heard, live: LiveText(settled: "Gebeld met", volatile: "Woonstichting"))
        let m = try model(base.server(), transcriber: live)
        await m.prepare()
        await m.press()
        for _ in 0..<20 where m.live.isEmpty { await Task.yield() }
        #expect(m.live == LiveText(settled: "Gebeld met", volatile: "Woonstichting"))
        #expect(m.elapsedText == "0:05")                 // the test clock moves 5 s per read
        await m.release(heldFor: 2)
        #expect(m.live.isEmpty)
        #expect(m.transcript == Self.heard)
    }

    // MARK: - Read from the text

    @Test func thePartyAndChannelAreReadFromTheText() async throws {
        let m = try model(base.server())
        await m.prepare()
        #expect(m.partySource == .lastSpoken)
        #expect(m.partyRow(locked: false).meta == "MET WIE · LAATST GESPROKEN")
        await m.press()
        await m.release(heldFor: 2)
        #expect(m.partyId == VoiceLogModelTests.lindehof)
        #expect(m.partySource == .fromText)
        #expect(m.partyRow(locked: false) == .init(title: "Woonstichting Lindehof", meta: "MET WIE · UIT JE TEKST"))
        #expect(m.channel == .call)
        #expect(m.channelSource == .fromText)
        #expect(m.marks.map { String(m.transcript[$0]) } == ["Gebeld", "Woonstichting Lindehof"])
    }

    @Test func aChoiceByHandIsNeverOverwrittenByTheText() async throws {
        let m = try model(base.server())
        await m.prepare()
        m.choose(party: VoiceLogModelTests.noordkust)
        m.choose(channel: .whatsapp)
        await m.press()
        await m.release(heldFor: 2)
        #expect(m.partyId == VoiceLogModelTests.noordkust)
        #expect(m.channel == .whatsapp)
        #expect(m.marks.isEmpty)
        #expect(m.partyRow(locked: false).meta == "MET WIE")
    }

    @Test func onlyAFullNameIsRecognised() {
        let parties = [PartyDTO(id: "a", kind: "organization", name: "Woonstichting Lindehof", organization: nil, lastContactAt: nil),
                       PartyDTO(id: "b", kind: "organization", name: "Lindehof Beheer", organization: nil, lastContactAt: nil)]
        #expect(VoiceText.read("Gebeld met Lindehof.", parties: parties).partyId == nil)
        #expect(VoiceText.read("met lindehof beheer gesproken", parties: parties).partyId == "b")
        #expect(VoiceText.read("WOONSTICHTING LINDEHOF belde", parties: parties).partyId == "a")
        // Never inside a longer word.
        #expect(VoiceText.read("Woonstichting Lindehofje", parties: parties).partyId == nil)
        #expect(VoiceText.read("Ze kwamen langs geweest, op bezoek.", parties: []).channel == .meeting)
        #expect(VoiceText.read("Ingesproken op de voicemail", parties: []).channel == .voicemail)
        #expect(VoiceText.read("Geen idee", parties: []).channel == nil)
    }

    @Test func anEditSaysAangepast() async throws {
        let m = try model(base.server())
        await m.prepare()
        await m.press()
        await m.release(heldFor: 2)
        #expect(m.textLabel == "WAT JE ZEI")
        m.transcript = Self.heard.replacingOccurrences(of: "vijftig euro", with: "€ 50")
        #expect(m.textLabel == "WAT JE ZEI · AANGEPAST")
        m.transcript = Self.heard + "  "
        #expect(m.textLabel == "WAT JE ZEI")
    }

    // MARK: - The summary and the picker

    @Test func theSummaryIsTheServersFirstSentence() {
        // A title: the closing full stop goes; "?" and an ellipsis stay.
        #expect(VoiceText.summary(Self.heard) == "Gebeld met Woonstichting Lindehof")
        #expect(VoiceText.summary("Belt CAK terug? Ze wist het niet.") == "Belt CAK terug?")
        #expect(VoiceText.summary("Gebeld...") == "Gebeld...")
        #expect(VoiceText.summary("  ") == "Gesprek (spraaknotitie)")
        #expect(VoiceText.summary("Betaald € 12.50 via www.cak.nl vandaag. Rest.") == "Betaald € 12.50 via www.cak.nl vandaag")
        let long = String(repeating: "woord ", count: 40) + "einde."
        let cut = VoiceText.summary(long)
        #expect(cut.count <= 120)
        #expect(cut.hasSuffix("woord…"))
    }

    /// "tijd wijzigen": today reads "Vandaag", earlier days "za 31 okt",
    /// and no day after today is offered — a call is never in the future.
    @Test func theTimeWheelEndsAtVandaag() throws {
        let now = try Date("2026-11-01T13:20:00Z", strategy: .iso8601)   // 14:20 in Amsterdam
        let days = VoiceText.wheelDays(now: now, back: 2)
        #expect(days.map(\.label) == ["vr 30 okt", "za 31 okt", "Vandaag"])
        let parts = VoiceText.wheelParts(now)
        #expect(parts.hour == 14 && parts.minute == 20)
        #expect(parts.day == days.last?.start)
        let yesterday = VoiceText.wheelDate(day: days[1].start, hour: 15, minute: 21)
        #expect(VoiceText.time(yesterday) == "15:21")
        #expect(VoiceText.day(yesterday, now: now) == "GISTEREN")
    }

    @Test func turningTheWheelNeverPassesNow() async throws {
        let m = try model(base.server())
        await m.prepare()
        m.typeInstead()
        let now = m.latestOccurredAt
        m.setOccurred(hour: 23, minute: 59)
        #expect(try #require(m.occurredAt) <= m.latestOccurredAt)
        #expect(m.occurredAt! >= now)
        let earlier = m.wheelDays.dropLast().last!
        m.setOccurred(day: earlier.start)
        #expect(VoiceText.calendar.isDate(m.occurredAt!, inSameDayAs: earlier.start))
    }

    @Test func thePickerSplitsRecentFromAToZAndSearches() {
        let d = Date(timeIntervalSince1970: 1_793_000_000)
        let ps = [PartyDTO(id: "1", kind: "o", name: "Woonstichting Lindehof", organization: nil, lastContactAt: d),
                  PartyDTO(id: "2", kind: "o", name: "Bewindkantoor Noordkust", organization: nil, lastContactAt: d),
                  PartyDTO(id: "3", kind: "o", name: "Zorgverzekeraar Duinzorg", organization: nil, lastContactAt: nil),
                  PartyDTO(id: "4", kind: "o", name: "Atelier Sterrenwacht", organization: nil, lastContactAt: nil)]
        let all = VoiceText.sections(ps, query: "")
        #expect(all.recent.map(\.id) == ["1", "2"])
        #expect(all.all.map(\.id) == ["4", "3"])
        let found = VoiceText.sections(ps, query: "noord")
        #expect(found.recent.map(\.id) == ["2"])
        #expect(found.all.isEmpty)
        #expect(VoiceText.sections(ps, query: "stêrrenwacht").all.map(\.id) == ["4"])
    }

    @Test func formatting() {
        let at = Date(timeIntervalSince1970: 1_793_539_200) // 1 nov 2026 13:20 UTC = 14:20 CET
        #expect(VoiceText.time(at) == "14:20")
        #expect(VoiceText.day(at, now: at) == "VANDAAG")
        #expect(VoiceText.day(at - 86_400, now: at) == "GISTEREN")
        #expect(VoiceText.day(at - 2 * 86_400, now: at) == "VR 30 OKT")
        #expect(VoiceText.lastContact(at - 86_400) == "LAATST 31 OKT")
        #expect(VoiceText.elapsed(14) == "0:14")
        #expect(VoiceText.elapsed(3725) == "1:02:05")
        #expect(VoiceText.megabytes(done: 38_000_000, total: 61_000_000) == "38 VAN 61 MB")
        #expect(PartyPickerSheet.meta(PartyDTO(id: "1", kind: "o", name: "X", organization: nil, lastContactAt: at - 86_400,
                                               role: "verhuurder"), recent: true) == "VERHUURDER · LAATST 31 OKT")
        #expect(PartyPickerSheet.meta(PartyDTO(id: "1", kind: "o", name: "X", organization: nil, lastContactAt: nil),
                                      recent: false) == nil)
    }

    // MARK: - Sending

    @Test func everyDisabledSendSaysWhy() async throws {
        let m = try model(base.server())
        await m.prepare()
        m.typeInstead()
        #expect(m.textFocused)
        #expect(m.footnote(locked: false) == "Schrijf eerst wat er besproken is.")
        #expect(!m.primary(locked: false).enabled)
        m.transcript = String(repeating: "a", count: VoiceDraft.transcriptMax + 1)
        #expect(m.footnote(locked: false) == VoiceLogModel.Copy.tooLong)
        m.transcript = "Gebeld."
        #expect(m.footnote(locked: false) == VoiceLogModel.Copy.footnote)
        #expect(m.primary(locked: false) == .init(title: "Verstuur als voorstel", does: .send, enabled: true))
        #expect(m.footnote(locked: true) == VoiceLogModel.Copy.lockedFootnote)
        #expect(m.primary(locked: true).does == .unlock)
        #expect(m.partyRow(locked: true) == .init(title: "Ontgrendel om partijen te laden", meta: "MET WIE · NA FACE ID"))
    }

    @Test func offlineSaysSoAndRetriesInPlace() async throws {
        let s = StubServer()
        s.on { req in
            req.httpMethod == "POST" ? .failure(.notConnectedToInternet)
                : .status(200, body: VoiceLogModelTests.parties)
        }
        let m = try model(s)
        await m.prepare()
        await m.press()
        await m.release(heldFor: 2)
        await m.send()
        #expect(m.sendFailure == .offline)
        #expect(m.sendFailures == 1)
        #expect(m.banner == .init(symbol: "wifi.slash", title: "Niet verstuurd", text: VoiceLogModel.Copy.offline))
        #expect(m.primary(locked: false).title == "Opnieuw proberen")
        #expect(m.footnote(locked: false) == nil)        // "Weggooien…" takes its place
        #expect(m.canRecordAgain)                        // no connection: nothing left the phone (frame "niet verstuurd")
    }

    @Test func aRecordingTooLargeIsSentWithoutIt() async throws {
        let s = base.server()
        let m = try model(s, audioMaxBytes: 4)
        await m.prepare()
        await m.press()
        await m.release(heldFor: 2)
        m.keepRecording = true
        await m.send()
        #expect(m.sendFailure == .audioTooLarge)
        #expect(m.banner?.title == "Niet verstuurd · opname te groot")
        #expect(m.primary(locked: false) == .init(title: "Verstuur zonder opname", does: .sendWithout, enabled: true))
        #expect(s.requests.allSatisfy { $0.httpMethod != "POST" })
        await m.sendWithoutRecording()
        #expect(m.phase == .sent(duplicate: false))
        let body = String(decoding: try #require(s.requests.last?.httpBody), as: UTF8.self)
        #expect(!body.contains("name=\"audio\""))
    }

    @Test func a413OnAKeptRecordingIsTheSameCase() {
        #expect(VoiceLogModel.failure(for: APIError.rejected(413), keptAudio: true) == .audioTooLarge)
        #expect(VoiceLogModel.failure(for: APIError.rejected(413), keptAudio: false) == .rejected)
        #expect(VoiceLogModel.failure(for: APIError.server(503)) == .server)
    }

    @Test func theSentCardIsTheSuggestionInVoorJou() async throws {
        let m = try model(base.server())
        await m.prepare()
        await m.press()
        await m.release(heldFor: 2)
        await m.send()
        #expect(m.screen == .sent)
        #expect(m.sentSuggestionId == "00000000-f1c5-4000-8000-700000000007")
        #expect(m.sentSummary == "Gebeld met Woonstichting Lindehof")
        #expect(m.sentTitle == "Staat in Voor jou")
        #expect(m.sentRecordingLine == "OPNAME GEWIST · ALLEEN DE TEKST IS VERSTUURD")
    }

    // MARK: - Closing

    @Test func closingANoteWithWorkAsksFirst() async throws {
        let m = try model(base.server())
        await m.prepare()
        #expect(m.requestClose())                        // nothing in it: straight away
        await m.press()
        await m.release(heldFor: 2)
        #expect(!m.requestClose())
        #expect(m.confirmingClose)
        #expect(m.phase == .editing)                     // "Verder bewerken" leaves it all
        #expect(m.hasRecording)
    }

    // MARK: - Speech states

    @Test func theDownloadShowsItsProgressAndWhereItStopped() async throws {
        let failing = FakeTranscriber(availability: .needsDownload, installFails: true)
        let m = try model(base.server(), transcriber: failing)
        await m.prepare()
        for _ in 0..<20 where m.installProgress == nil { await Task.yield() }
        #expect(m.installAmount == "30 VAN 60 MB")
        await m.networkChanged(offline: true)
        guard case .state(let page) = m.screen else { Issue.record("no state"); return }
        #expect(page.kind == .loadingFailed)
        #expect(page.meta == "GESTOPT BIJ 30 VAN 60 MB")
        #expect(page.text.hasPrefix("Geen internet."))
        #expect(page.primary == .retrySpeech)
        // Back online: it goes on by itself.
        failing.installFails.withLock { $0 = false }
        await m.networkChanged(offline: false)
        #expect(failing.installs.withLock { $0 } == 2)
        #expect(m.speech == .ready)
        #expect(m.screen == .capture)
    }

    @Test func speechSwitchedOffSaysWhereToTurnItOn() async throws {
        let m = try model(base.server(), transcriber: FakeTranscriber(availability: .denied))
        await m.prepare()
        guard case .state(let page) = m.screen else { Issue.record("no state"); return }
        #expect(page.title == "Spraakherkenning staat uit")
        #expect(page.primary == .openSettings)
        m.typeInstead()
        #expect(m.screen == .editor)
    }

    @Test func aFailedTranscriptionOffersTypingFirst() async throws {
        let m = try model(base.server(), transcriber: FakeTranscriber(failure: .failed("x")))
        await m.prepare()
        await m.press()
        await m.release(heldFor: 2)
        guard case .state(let page) = m.screen else { Issue.record("no state"); return }
        #expect(page.title == "Omzetten lukte niet")
        #expect(page.primary == .typeNote)
        #expect(page.secondary == .recordAgain)
        m.typeInstead()
        #expect(m.screen == .editor)
        #expect(m.hasRecording)                          // kept until the send
    }

    // MARK: - The session

    @Test func aHandsFreeRecordingSurvivesTheSheetGoingDown() async throws {
        let v = VoiceLogSession(factory: VoiceLogFactory { [base] in
            (try? self.model(base.server()))!
        })
        v.open()
        let m = try #require(v.model)
        await m.prepare()
        await m.press()
        await m.release(heldFor: 0.2)
        v.presentationChanged(false)
        #expect(v.sheetDisappeared() == nil)             // nothing stopped it
        #expect(m.phase == .recording)
        #expect(v.recordsInBackground)
        await v.stopInBackground()?.value
        #expect(v.isPresented)
        #expect(m.phase == .editing)
    }

    @Test func signingOutStopsEvenAHandsFreeRecording() async throws {
        let v = VoiceLogSession(factory: VoiceLogFactory { [base] in
            (try? self.model(base.server()))!
        })
        v.open()
        let m = try #require(v.model)
        await m.prepare()
        await m.press()
        await m.release(heldFor: 0.2)
        await v.sessionEnded()?.value
        #expect(m.phase == .editing)
        #expect(!v.isPresented)
    }
}

/// A transcriber that also streams words while recording.
final class LiveFake: Transcribing {
    let text: String
    let liveText: LiveText
    init(text: String, live: LiveText) {
        self.text = text
        liveText = live
    }
    func availability() async -> SpeechAvailability { .ready }
    func install(progress: @escaping @Sendable (InstallProgress) -> Void) async throws(TranscriptionError) {}
    func transcribe(_ audio: URL) async throws(TranscriptionError) -> String { text }
    func live(_ audio: URL) -> AsyncStream<LiveText> {
        let t = liveText
        return AsyncStream { c in c.yield(t) }
    }
}
