import Testing
import Foundation
import Synchronization
@testable import Verder

/// A call RECORDING into the voice quick-log (Added 2026-11-03, Martin: "it
/// would be perfect if i can also record phone calls and transcribe them").
///
/// verder cannot record a call itself: iOS gives no third-party app the call
/// audio. The Phone app can (More → "Gesprek opnemen", saved to Notes as an
/// audio attachment, region and language dependent). So the recording comes
/// IN: shared from Notes (the share extension leaves an audio drop and does
/// NOT upload it), or picked in the voice sheet ("Opname kiezen"). It is
/// transcribed on the phone, edited, and sent as a SUGGESTION through the
/// same `POST /entries/voice` — never an entry. The audio leaves the phone
/// only when "bewaar opname" is on; otherwise verder's copy is deleted after
/// sending or cancelling.
@MainActor
struct CallRecordingImportTests {
    nonisolated static let lindehof = VoiceLogModelTests.lindehof
    nonisolated static let noordkust = VoiceLogModelTests.noordkust
    nonisolated static let callBytes = Data("FAKE-CALL-RECORDING-FROM-NOTES".utf8)
    nonisolated static let transcript = "Met Bewindkantoor Noordkust gesproken over de stukken."

    let t0 = Date(timeIntervalSince1970: 1_793_540_000)

    func group() throws -> URL { try scratchDir() }

    func incoming(_ group: URL) -> URL { IncomingDrop.directory(groupDir: group) }

    func files(_ dir: URL) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: dir.path(percentEncoded: false))) ?? []).sorted()
    }

    func server(voiceStatus: Int = 200) -> StubServer {
        let s = StubServer()
        s.on { req in
            switch (req.httpMethod, req.url?.path()) {
            case ("GET", "/api/mobile/v1/parties"): .status(200, body: VoiceLogModelTests.parties)
            case ("POST", "/api/mobile/v1/entries/voice"):
                voiceStatus == 200 ? .status(200, body: VoiceLogModelTests.answer) : .status(voiceStatus)
            default: .status(404)
            }
        }
        return s
    }

    func model(_ s: StubServer, transcriber: any Transcribing = ProgressTranscriber(text: transcript),
               dir: URL? = nil, recentCall: @escaping @MainActor () -> VoicePrefill? = { nil }) throws -> VoiceLogModel {
        var clock = t0
        return VoiceLogModel(client: s.client(), recorder: FakeRecorder(), transcriber: transcriber,
                             dir: try dir ?? scratchDir(), now: { defer { clock += 5 }; return clock },
                             recentCall: recentCall)
    }

    func posted(_ s: StubServer) throws -> String {
        let req = try #require(s.requests.last { $0.httpMethod == "POST" })
        return String(decoding: try #require(req.httpBody), as: UTF8.self)
    }

    /// A recording shared from Notes, as the extension leaves it.
    func audioDrop(_ group: URL, name: String = "Gesprek met Noordkust.m4a", mime: String = "audio/x-m4a",
                   at: Date? = nil) throws -> IncomingDrop {
        let id = try IncomingDrop.write(file: Self.callBytes, fileName: name, mime: mime, kind: .audio,
                                        capturedAt: at ?? t0, to: group)
        return try #require(IncomingDrop.read(IncomingDrop.jsonURL(id, in: incoming(group))))
    }

    // MARK: - The drop

    @Test func audioIsRecognisedByTypeOrExtension() {
        #expect(IncomingDrop.isAudio(fileName: "Opname.m4a", mime: "application/octet-stream"))
        #expect(IncomingDrop.isAudio(fileName: "Opname.AAC", mime: "application/octet-stream"))
        #expect(IncomingDrop.isAudio(fileName: "Opname.wav", mime: "application/octet-stream"))
        #expect(IncomingDrop.isAudio(fileName: "Opname.caf", mime: "application/octet-stream"))
        #expect(IncomingDrop.isAudio(fileName: "Nieuwe opname", mime: "audio/mp4"))
        #expect(!IncomingDrop.isAudio(fileName: "Brief.pdf", mime: "application/pdf"))
        #expect(!IncomingDrop.isAudio(fileName: "Video.mov", mime: "video/quicktime"))
    }

    @Test func aDropRemembersItIsAudio() throws {
        let group = try group()
        let drop = try audioDrop(group)
        #expect(drop.kind == .audio)
        #expect(drop.fileName == "Gesprek met Noordkust.m4a")
        #expect(drop.fileExtension == "m4a")
    }

    /// A drop written before this feature has no `kind`: it is a document.
    @Test func aDropWithoutAKindIsADocument() throws {
        let json = Data(#"{"capturedAt":"2026-11-01T09:41:00Z","fileExtension":"pdf","fileName":"Brief.pdf","id":"5B0C7C47-1D0E-4E8B-9A57-3C3F3D0F2A11","mime":"application/pdf"}"#.utf8)
        let drop = try IncomingDrop.decoder.decode(IncomingDrop.self, from: json)
        #expect(drop.kind == .document)
    }

    /// THE ROUTING: an audio drop never becomes an upload. It waits in the
    /// App Group for the voice log, which transcribes it on the phone.
    @Test func audioDropsAreNotImportedIntoTheUploadQueue() async throws {
        let group = try group()
        let queue = UploadQueue(dir: group.appending(path: "uploads", directoryHint: .isDirectory))
        let doc = try IncomingDrop.write(file: Data("%PDF brief".utf8), fileName: "Brief.pdf", mime: "application/pdf",
                                         capturedAt: t0, to: group)
        let audio = try audioDrop(group, at: t0 + 1)

        let imported = await queue.importIncoming()

        #expect(imported.map(\.id) == [doc])
        #expect(await queue.items().map(\.id) == [doc])
        #expect(files(incoming(group)) == ["\(audio.id.uuidString).bin", "\(audio.id.uuidString).json"])
        #expect(IncomingDrop.pendingAudio(groupDir: group).map(\.id) == [audio.id])
        // Imported again (every foreground): still not an upload.
        await queue.importIncoming(now: t0 + 2 * UploadQueue.orphanAge)
        #expect(await queue.items().map(\.id) == [doc])
        #expect(IncomingDrop.pendingAudio(groupDir: group).map(\.id) == [audio.id])
    }

    @Test func pendingAudioIsOldestFirstAndIgnoresDocuments() throws {
        let group = try group()
        let newer = try audioDrop(group, name: "b.m4a", at: t0 + 60)
        let older = try audioDrop(group, name: "a.wav", mime: "audio/wav", at: t0)
        try IncomingDrop.write(file: Data("%PDF".utf8), fileName: "Brief.pdf", mime: "application/pdf",
                               capturedAt: t0 - 60, to: group)
        #expect(IncomingDrop.pendingAudio(groupDir: group).map(\.id) == [older.id, newer.id])
    }

    // MARK: - The share extension

    @Test func sharingARecordingLeavesAnAudioDropAndUploadsNothing() async throws {
        let group = try group()
        let sends = Mutex(0)
        let share = ShareModel(groupDir: group, now: { Date(timeIntervalSince1970: 1_793_540_000) }) { ids, _ in
            sends.withLock { $0 += 1 }
            return ids
        }
        share.loaded([.file(data: Self.callBytes, fileName: "Nieuwe opname.m4a", mime: "audio/x-m4a")])
        #expect(share.phase == .ready)
        #expect(share.isAudio)

        await share.commit()

        #expect(share.phase == .handedToApp)
        #expect(share.message == ShareModel.Copy.openToTranscribe)
        #expect(ShareModel.Copy.openToTranscribe == "Open verder om het gesprek uit te schrijven.")
        #expect(sends.withLock { $0 } == 0)
        #expect(!share.canCancel)
        #expect(!share.closesByItself)  // Martin reads what to do next
        let drops = IncomingDrop.pendingAudio(groupDir: group)
        #expect(drops.count == 1)
        #expect(drops.first?.fileName == "Nieuwe opname.m4a")
    }

    @Test func aRecordingIsSharedAlone() {
        let share = ShareModel(groupDir: nil) { ids, _ in ids }
        share.loaded([.file(data: Self.callBytes, fileName: "Opname.m4a", mime: "audio/x-m4a"),
                      .file(data: Data("%PDF".utf8), fileName: "Brief.pdf", mime: "application/pdf")])
        #expect(share.phase == .refused(ShareModel.Copy.audioAlone))

        let two = ShareModel(groupDir: nil) { ids, _ in ids }
        two.loaded([.file(data: Self.callBytes, fileName: "a.m4a", mime: "audio/x-m4a"),
                    .file(data: Self.callBytes, fileName: "b.wav", mime: "audio/wav")])
        #expect(two.phase == .refused(ShareModel.Copy.audioAlone))
    }

    /// A call recording is longer than a scan is large: it is transcribed on
    /// the phone, so it may pass the document limit (only "bewaar opname"
    /// then meets the server's 50 MB, and says so).
    @Test func aRecordingMayBeLargerThanADocument() throws {
        let dir = try scratchDir()
        let src = dir.appending(path: "lang.m4a")
        try Data(count: 64).write(to: src)
        #expect(ShareModel.maxAudioBytes > ShareModel.maxFileBytes)
        let staged = ShareStaging.stage(src, fileName: "lang.m4a", mime: "audio/x-m4a", into: dir,
                                        maxBytes: ShareModel.limit(fileName: "lang.m4a", mime: "audio/x-m4a"))
        guard case .staged = staged else { Issue.record("not staged: \(staged)"); return }
        #expect(ShareModel.limit(fileName: "Brief.pdf", mime: "application/pdf") == ShareModel.maxFileBytes)
        #expect(ShareModel.limit(fileName: "lang.m4a", mime: "audio/x-m4a") == ShareModel.maxAudioBytes)
    }

    // MARK: - The app opens the voice log for it

    @Test func thePendingRecordingOpensTheVoiceLogInImportMode() async throws {
        let group = try group()
        let drop = try audioDrop(group)
        let s = server()
        let session = VoiceLogSession(factory: VoiceLogFactory { try! model(s) }, groupDir: group)

        let task = session.openPendingRecording()
        await task?.value

        let m = try #require(session.model)
        #expect(session.isPresented)
        #expect(m.mode == .importRecording)
        #expect(m.title == "Opname uitschrijven")
        #expect(m.importedDrop == drop.id)
        #expect(m.phase == .editing)
        #expect(m.transcript == Self.transcript)
        #expect(m.hasRecording)
        // The drop stays until the log is sent or cancelled.
        #expect(IncomingDrop.pendingAudio(groupDir: group).map(\.id) == [drop.id])

        // Every foreground asks again: the same drop is not opened twice.
        #expect(session.openPendingRecording() == nil)
        #expect(session.model === m)
    }

    @Test func nothingPendingOpensNothing() throws {
        let session = VoiceLogSession(factory: VoiceLogFactory { try! model(server()) }, groupDir: try group())
        #expect(session.openPendingRecording() == nil)
        #expect(session.model == nil)
        #expect(!session.isPresented)
    }

    /// A voice log Martin is working on is never replaced by a recording;
    /// the drop waits for the next time.
    @Test func aRecordingNeverReplacesWorkInProgress() async throws {
        let group = try group()
        _ = try audioDrop(group)
        let session = VoiceLogSession(factory: VoiceLogFactory { try! model(server()) }, groupDir: group)
        session.open()
        let m = try #require(session.model)
        m.typeInstead()
        m.transcript = "Eigen aantekening"

        #expect(session.openPendingRecording() == nil)
        #expect(session.model === m)
        #expect(m.mode == .dictate)
        #expect(IncomingDrop.pendingAudio(groupDir: group).count == 1)
    }

    // MARK: - A drop that cannot be written out (review finding, 2026-11-03)

    /// A copy that throws (a full disk; here a voice folder that is a file)
    /// still belongs to this log: the same foreground does not reopen it, and
    /// closing the sheet deletes it — or the sheet came back with "kon niet
    /// worden geopend" on every launch, forever.
    @Test func aDropWhoseCopyFailsIsClosedForGood() async throws {
        let group = try group()
        let drop = try audioDrop(group)
        let notADir = try scratchDir().appending(path: "voice-is-a-file")
        try Data("x".utf8).write(to: notADir)
        let s = server()
        let session = VoiceLogSession(factory: VoiceLogFactory { try! model(s, dir: notADir) }, groupDir: group)

        await session.openPendingRecording()?.value
        let m = try #require(session.model)
        #expect(m.notice == VoiceLogModel.Copy.importFailed)
        #expect(!m.hasRecording)
        #expect(m.importedDrop == drop.id)
        // Opened twice: the second foreground sees it as already open.
        #expect(session.openPendingRecording() == nil)
        #expect(session.model === m)

        session.close()
        #expect(IncomingDrop.pendingAudio(groupDir: group).isEmpty)
        #expect(files(incoming(group)).isEmpty)
        #expect(session.openPendingRecording() == nil)
        #expect(session.model == nil)
    }

    /// The same through a swipe: an empty failed log is closed, and its drop with it.
    @Test func swipingAwayAFailedDropDeletesIt() async throws {
        let group = try group()
        _ = try audioDrop(group)
        let notADir = try scratchDir().appending(path: "voice-is-a-file")
        try Data("x".utf8).write(to: notADir)
        let session = VoiceLogSession(factory: VoiceLogFactory { try! model(server(), dir: notADir) }, groupDir: group)
        await session.openPendingRecording()?.value
        session.presentationChanged(false)
        #expect(files(incoming(group)).isEmpty)
        #expect(session.openPendingRecording() == nil)
    }

    /// A description whose bytes are gone can never be written out: it is not
    /// pending, and it is removed (the extension writes the `.bin` FIRST, so a
    /// `.json` without one is never a drop still being written).
    @Test func aDropWithoutItsBytesIsNotPendingAndIsRemoved() throws {
        let group = try group()
        let drop = try audioDrop(group)
        try FileManager.default.removeItem(at: IncomingDrop.binURL(drop.id, in: incoming(group)))

        #expect(IncomingDrop.pendingAudio(groupDir: group).isEmpty)
        #expect(files(incoming(group)).isEmpty)

        let session = VoiceLogSession(factory: VoiceLogFactory { try! model(server()) }, groupDir: group)
        #expect(session.openPendingRecording() == nil)
        #expect(session.model == nil)
    }

    /// A drop that has waited longer than `IncomingDrop.audioMaxAge` ages out
    /// (its original is still in Notes); a younger one stays.
    @Test func anOldAudioDropAgesOut() throws {
        let group = try group()
        let old = try audioDrop(group)
        let young = try audioDrop(group, name: "Nieuw.m4a", at: t0 + 1)
        let now = Date()
        for url in [IncomingDrop.jsonURL(old.id, in: incoming(group)), IncomingDrop.binURL(old.id, in: incoming(group))] {
            try FileManager.default.setAttributes([.modificationDate: now - IncomingDrop.audioMaxAge - 60],
                                                  ofItemAtPath: url.path())
        }

        #expect(IncomingDrop.pendingAudio(groupDir: group, now: now).map(\.id) == [young.id])
        #expect(files(incoming(group)) == ["\(young.id.uuidString).bin", "\(young.id.uuidString).json"])
    }

    // MARK: - Transcribing a file

    @Test func longRecordingsShowProgressThenAnEditableTranscript() async throws {
        let group = try group()
        let drop = try audioDrop(group)
        let gate = ProgressTranscriber(text: Self.transcript, steps: [0.25, 0.5], hold: true)
        let m = try model(server(), transcriber: gate)
        await m.prepare()
        let task = Task { await m.importRecording(.drop(drop, groupDir: group)) }

        await gate.waitUntilHeld()
        #expect(m.phase == .transcribing)
        // The callbacks hop to the main actor; give them a turn.
        for _ in 0..<500 where m.transcriptionProgress != 0.5 { await Task.yield() }
        #expect(m.transcriptionProgress == 0.5)
        #expect(m.phaseLine == "Opname uitschrijven, op je telefoon… 50%")

        gate.release()
        await task.value
        #expect(m.phase == .editing)
        #expect(m.transcriptionProgress == nil)
        m.transcript = Self.transcript + " Ze sturen de bevestiging maandag."
        #expect(m.canSend)
        #expect(!m.canRecordAgain)  // an imported call is not re-recorded
    }

    @Test func theTranscriberReadsVerdersOwnCopyNeverTheOriginal() async throws {
        let group = try group()
        let drop = try audioDrop(group)
        let t = ProgressTranscriber(text: Self.transcript)
        let dir = try scratchDir()
        let m = try model(server(), transcriber: t, dir: dir)
        await m.importRecording(.drop(drop, groupDir: group))

        let read = try #require(t.read.withLock { $0.first })
        #expect(read.deletingLastPathComponent().standardizedFileURL == dir.standardizedFileURL)
        #expect(read.pathExtension == "m4a")  // AVAudioFile needs a real extension, not `.bin`
        #expect(try Data(contentsOf: read) == Self.callBytes)
    }

    @Test(arguments: [
        (TranscriptionError.nothingHeard, VoiceLogModel.Copy.nothingHeard),
        (TranscriptionError.failed("x"), VoiceLogModel.Copy.transcribeFailed),
        (TranscriptionError.languageUnsupported, VoiceLogModel.Copy.unsupported),
    ])
    func transcriptionErrorsMapToTheDutchStates(_ error: TranscriptionError, _ notice: String) async throws {
        let group = try group()
        let drop = try audioDrop(group)
        let m = try model(server(), transcriber: ProgressTranscriber(failure: error))
        await m.prepare()
        await m.importRecording(.drop(drop, groupDir: group))

        #expect(m.phase == .editing)
        #expect(m.notice == notice)
        #expect(m.hasRecording)  // typing what was said still works, the recording stays
        #expect(m.transcriptionProgress == nil)
        if error == .languageUnsupported { #expect(m.speech == .unavailable(VoiceLogModel.Copy.unsupported)) }
    }

    @Test func missingAssetsSayItOnceAndOfferAnotherTry() async throws {
        let group = try group()
        let drop = try audioDrop(group)
        let t = ProgressTranscriber(failure: .assetsUnavailable)
        let m = try model(server(), transcriber: t)
        await m.prepare()
        await m.importRecording(.drop(drop, groupDir: group))

        #expect(m.notice == nil)  // the speech line says it, with its retry
        #expect(m.speech == .unavailable(VoiceLogModel.Copy.assetsMissing))
        #expect(m.canRetryTranscription)

        t.result.withLock { $0 = .success(Self.transcript) }
        await m.retryTranscription()
        #expect(m.transcript == Self.transcript)
        #expect(m.speech == .ready)
        #expect(!m.canRetryTranscription)
    }

    // MARK: - Sending: the audio only when kept, the drop deleted either way

    @Test func sentWithoutKeepingTheMultipartHasNoAudioAndTheDropIsDeleted() async throws {
        let group = try group()
        let drop = try audioDrop(group)
        let s = server()
        let dir = try scratchDir()
        let m = try model(s, dir: dir)
        await m.prepare()
        await m.importRecording(.drop(drop, groupDir: group))
        await m.send()

        #expect(m.phase == .sent(duplicate: false))
        let body = try posted(s)
        #expect(!body.contains("name=\"audio\""))
        #expect(!body.contains(String(decoding: Self.callBytes, as: UTF8.self)))
        #expect(body.contains("name=\"transcript\"\r\n\r\n\(Self.transcript)\r\n"))
        #expect(files(incoming(group)).isEmpty)
        #expect(files(dir).isEmpty)
        let uploads = s.requests.filter { req in req.url?.path() == "/api/mobile/v1/documents" }
        #expect(uploads.isEmpty)
    }

    @Test func keptTheRecordingTravelsAsAudioWithItsOwnType() async throws {
        let group = try group()
        let drop = try audioDrop(group, name: "Opname.caf", mime: "application/octet-stream")
        let s = server()
        let m = try model(s)
        await m.prepare()
        await m.importRecording(.drop(drop, groupDir: group))
        m.keepRecording = true
        await m.send()

        let body = try posted(s)
        #expect(body.contains("Content-Disposition: form-data; name=\"audio\"; filename=\"Gesprek 2026-11-01.caf\""))
        #expect(body.contains("Content-Type: audio/x-caf"))
        #expect(body.contains(String(decoding: Self.callBytes, as: UTF8.self)))
        #expect(files(incoming(group)).isEmpty)
    }

    @Test func aFailedSendKeepsTheDropForTheRetry() async throws {
        let group = try group()
        let drop = try audioDrop(group)
        let m = try model(server(voiceStatus: 503))
        await m.prepare()
        await m.importRecording(.drop(drop, groupDir: group))
        await m.send()

        #expect(m.phase == .editing)
        #expect(m.notice == VoiceLogModel.Copy.serverFailed)
        #expect(IncomingDrop.pendingAudio(groupDir: group).map(\.id) == [drop.id])
        #expect(m.hasRecording)
    }

    @Test func cancellingDeletesTheDropAndVerdersCopy() async throws {
        let group = try group()
        let drop = try audioDrop(group)
        let dir = try scratchDir()
        let session = VoiceLogSession(factory: VoiceLogFactory { try! model(server(), dir: dir) }, groupDir: group)
        await session.openPendingRecording()?.value
        #expect(session.model?.hasRecording == true)

        session.close()

        #expect(files(incoming(group)).isEmpty)
        #expect(files(dir).isEmpty)
        _ = drop
    }

    /// The sign-in screen or a relock takes the sheet, not the work: the drop
    /// stays, so even a killed app offers the recording again.
    @Test func aSessionEndKeepsTheDrop() async throws {
        let group = try group()
        _ = try audioDrop(group)
        let session = VoiceLogSession(factory: VoiceLogFactory { try! model(server()) }, groupDir: group)
        await session.openPendingRecording()?.value
        session.sessionEnded()
        #expect(session.model != nil)
        #expect(IncomingDrop.pendingAudio(groupDir: group).count == 1)
    }

    // MARK: - "Opname kiezen"

    @Test func aPickedRecordingIsCopiedAndTheOriginalIsNeverTouched() async throws {
        let picked = try scratchDir().appending(path: "Uit Bestanden.wav")
        try Self.callBytes.write(to: picked)
        let s = server()
        let m = try model(s)
        await m.prepare()
        await m.importPicked(picked)

        #expect(m.mode == .importRecording)
        #expect(m.importedDrop == nil)
        #expect(m.transcript == Self.transcript)
        m.keepRecording = true
        await m.send()
        let body = try posted(s)
        #expect(body.contains("filename=\"Gesprek 2026-11-01.wav\""))
        #expect(body.contains("Content-Type: audio/wav"))
        #expect(FileManager.default.fileExists(atPath: picked.path(percentEncoded: false)))
        #expect(try Data(contentsOf: picked) == Self.callBytes)
    }

    @Test func anUnreadablePickLeavesTypingOpen() async throws {
        let m = try model(server())
        await m.prepare()
        await m.importPicked(URL(filePath: "/nonexistent/opname.m4a"))
        #expect(m.phase == .idle)
        #expect(m.notice == VoiceLogModel.Copy.importFailed)
        #expect(!m.hasRecording)
    }

    // MARK: - The call sheet's ticked points

    @Test func aRecentCallSheetsTickedPointsArePrefilled() async throws {
        let group = try group()
        let drop = try audioDrop(group)
        let callStart = t0 - 600
        let recent = VoicePrefill(partyId: Self.noordkust, text: "Besproken:\n- Loonstrook 2026-10", occurredAt: callStart)
        let s = server()
        let m = try model(s, recentCall: { recent })
        await m.prepare()
        await m.importRecording(.drop(drop, groupDir: group))

        #expect(m.partyId == Self.noordkust)
        #expect(m.transcript == "Besproken:\n- Loonstrook 2026-10\n\n\(Self.transcript)")
        #expect(m.occurredAt == callStart)
    }

    @Test func withNoRecentCallTheRecordingIsDatedWhenItWasShared() async throws {
        let group = try group()
        let shared = t0 - 300
        let drop = try audioDrop(group, at: shared)
        let m = try model(server())
        await m.prepare()
        await m.importRecording(.drop(drop, groupDir: group))
        #expect(m.prefill == nil)
        #expect(m.partyId == Self.lindehof)  // the most recent party, as for any voice log
        #expect(m.occurredAt == shared)
    }

    @Test func theRecentSheetCountsForAnHourOnly() {
        let recent = RecentCallSheet()
        let at = t0
        recent.record(partyId: Self.noordkust, text: "Besproken:\n- a", startedAt: at - 120, at: at)
        #expect(recent.prefill(now: at + 3599) == VoicePrefill(partyId: Self.noordkust, text: "Besproken:\n- a",
                                                                   occurredAt: at - 120))
        #expect(recent.prefill(now: at + 3601) == nil)
        recent.record(partyId: Self.noordkust, text: "", startedAt: nil, at: at)
        recent.forget()
        #expect(recent.prefill(now: at) == nil)
    }
}

extension CallPrepTests {
    /// The call sheet tells `RecentCallSheet` what was ticked while it was
    /// active, so a recording imported afterwards starts from those points.
    @Test func theCallSheetRecordsItsTickedPointsForAnImport() async throws {
        let r = try rig()
        let recent = r.session.recent
        await r.session.open(partyId: Self.noordkust, name: nil)
        let m = try #require(r.session.model)
        r.session.toggle(m.checklist.points[0].id)
        r.session.close()
        r.session.finish()

        let p = try #require(recent.prefill(now: now))
        #expect(p.partyId == Self.noordkust)
        #expect(p.text == "Besproken:\n- \(m.checklist.points[0].text)")

        r.epoch.end()
        #expect(recent.prefill(now: now) == nil)  // signed out: forgotten
    }
}

/// A transcriber for files: reports progress, can be held mid-file, and
/// remembers which file it was given.
final class ProgressTranscriber: Transcribing {
    let result: Mutex<Result<String, TranscriptionError>>
    let steps: [Double]
    let read = Mutex<[URL]>([])
    private let holding: Bool
    private let held = Mutex<CheckedContinuation<Void, Never>?>(nil)
    private let reached = Mutex(false)

    init(text: String = CallRecordingImportTests.transcript, failure: TranscriptionError? = nil,
         steps: [Double] = [], hold: Bool = false) {
        result = Mutex(failure.map { .failure($0) } ?? .success(text))
        self.steps = steps
        holding = hold
    }

    func availability() async -> SpeechAvailability { .ready }
    func install() async throws(TranscriptionError) {}

    func transcribe(_ audio: URL) async throws(TranscriptionError) -> String {
        try await transcribe(audio, progress: { _ in })
    }

    func transcribe(_ audio: URL, progress: @escaping @Sendable (Double) -> Void) async throws(TranscriptionError) -> String {
        read.withLock { $0.append(audio) }
        for step in steps { progress(step) }
        if holding {
            await withCheckedContinuation { c in
                held.withLock { $0 = c }
                reached.withLock { $0 = true }
            }
        }
        return try result.withLock { $0 }.get()
    }

    func waitUntilHeld() async {
        while !reached.withLock({ $0 }) { await Task.yield() }
    }

    func release() {
        held.withLock { $0?.resume(); $0 = nil }
    }
}
