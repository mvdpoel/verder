import Testing
import Foundation
@testable import Verder

/// Who owns a voice log, and when it is thrown away (review of plan 3 Task 25).
///
/// The copy promises "je tekst blijft staan" after a 401, an offline send and
/// a server failure. A model held as `@State` inside the lock-gated sheet died
/// with the sheet — on a sign-in screen (401) or a relock — and its
/// `.onDisappear` discarded the recording and the text. So the model lives in
/// `VoiceLogSession`, above the gate, and ONLY an explicit close throws it
/// away.
@MainActor
struct VoiceLogSessionTests {
    func session(_ s: StubServer, dir: URL) -> VoiceLogSession {
        VoiceLogSession(factory: VoiceLogFactory {
            VoiceLogModel(client: s.client(), recorder: FakeRecorder(),
                          transcriber: FakeTranscriber(text: "Gebeld met Lindehof."), dir: dir)
        })
    }

    func server(voiceStatus: Int) -> StubServer {
        VoiceLogModelTests().server(voiceStatus: voiceStatus)
    }

    func files(_ dir: URL) throws -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: dir.path(percentEncoded: false))) ?? []
    }

    /// Record and edit on the session's model, then a send the server answers 401.
    func unsentAfter401(_ v: VoiceLogSession) async throws -> VoiceLogModel {
        v.open()
        let m = try #require(v.model)
        await m.prepare()
        await m.startRecording()
        await m.stopRecording()
        m.transcript = "Gebeld met Lindehof: akkoord."
        await m.send()
        #expect(m.notice == VoiceLogModel.Copy.signedOut)
        return m
    }

    @Test func openingTwiceIsTheSameLog() throws {
        let v = session(server(voiceStatus: 200), dir: try scratchDir())
        v.open()
        let first = try #require(v.model)
        v.open()
        #expect(v.model === first)
        #expect(v.isPresented)
    }

    /// The 401 path: the sign-in screen replaces the tabs and with them the
    /// sheet. The text and the recording survive, and the sheet comes back
    /// with them after signing in — "je tekst blijft staan" is true.
    @Test func aSignInKeepsTheTextAndTheRecording() async throws {
        let dir = try scratchDir()
        let v = session(server(voiceStatus: 401), dir: dir)
        let m = try await unsentAfter401(v)

        v.sessionEnded()
        // SwiftUI writes `false` into the binding as the sheet goes; then the
        // sheet's content disappears. Neither may discard.
        v.presentationChanged(false)
        v.sheetDisappeared()
        #expect(!v.isPresented)
        #expect(v.model === m)
        #expect(m.transcript == "Gebeld met Lindehof: akkoord.")
        #expect(m.hasRecording)
        #expect(try files(dir).count == 1)

        v.sessionStarted()
        #expect(v.isPresented)
        #expect(v.model === m)
    }

    /// The relock path: the lock screen replaces the sheet's content. Nothing
    /// is lost, and the "Gesprek vastleggen" entry reopens the same log.
    @Test func aRelockKeepsTheLog() async throws {
        let dir = try scratchDir()
        let v = session(server(voiceStatus: 503), dir: dir)
        v.open()
        let m = try #require(v.model)
        await m.prepare()
        await m.startRecording()
        await m.stopRecording()
        await m.send()
        #expect(m.notice == VoiceLogModel.Copy.serverFailed)

        v.sheetDisappeared()
        // The lock screen has no `interactiveDismissDisabled`: a swipe there
        // must not throw the work away either.
        v.presentationChanged(false)
        #expect(v.model === m)
        #expect(m.hasRecording)
        v.open()
        #expect(v.model === m)
        #expect(m.transcript == "Gebeld met Lindehof.")
    }

    /// Torn down mid-recording (the app went away under the finger): the
    /// recording is stopped and transcribed, not left running or thrown away.
    @Test func aTeardownWhileRecordingStopsAndKeeps() async throws {
        let v = session(server(voiceStatus: 200), dir: try scratchDir())
        v.open()
        let m = try #require(v.model)
        await m.prepare()
        await m.startRecording()
        #expect(m.phase == .recording)
        await v.sheetDisappeared()?.value
        #expect(m.phase == .editing)
        #expect(m.transcript == "Gebeld met Lindehof.")
        #expect(m.hasRecording)
    }

    /// Only an explicit close (Sluiten, Klaar, Weggooien-and-swipe) discards:
    /// recording deleted, and the next opening is a NEW log.
    @Test func anExplicitCloseDiscards() async throws {
        let dir = try scratchDir()
        let v = session(server(voiceStatus: 401), dir: dir)
        let m = try await unsentAfter401(v)
        let id = m.clientId
        v.close()
        #expect(v.model == nil)
        #expect(!v.isPresented)
        #expect(try files(dir).isEmpty)
        v.open()
        #expect(v.model !== m)
        #expect(v.model?.clientId != id)
    }

    /// A swipe on a log holding nothing is a close.
    @Test func aSwipeOnAnEmptyLogCloses() throws {
        let v = session(server(voiceStatus: 200), dir: try scratchDir())
        v.open()
        v.presentationChanged(false)
        #expect(v.model == nil)
    }

    /// Signed out with nothing unsent: no empty sheet pops up after the next
    /// sign-in.
    @Test func noEmptySheetAfterSignIn() throws {
        let v = session(server(voiceStatus: 200), dir: try scratchDir())
        v.open()
        v.sessionEnded()
        v.presentationChanged(false)
        v.sessionStarted()
        #expect(!v.isPresented)
        #expect(v.model == nil)
    }
}
