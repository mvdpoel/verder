import Testing
import Foundation
import Synchronization
@testable import Grip

/// "Gesprek voorbereiden" (Added 2026-11-03, Martin): the talking points for
/// one party, ticked off during the call, mirrored as COUNTS on the lock
/// screen, and — when iOS says the call ended — handed to the voice quick-log
/// as "Besproken: …" with the party preselected.
///
/// What iOS does NOT allow, and so what none of this pretends to do: a
/// third-party app cannot record or hear a phone call, and `CXCallObserver`
/// says only THAT a call started or ended, never with whom.
@MainActor
struct CallPrepTests {
    nonisolated static let noordkust = "00000000-f1c5-4000-8000-600000000002"
    nonisolated static let kade = "00000000-f1c5-4000-8000-600000000003"

    static func fixture(_ party: String = noordkust) throws -> Data {
        try #require(try FixtureTests.body("call", "parties/\(party)/talking-points"))
    }

    static func dto(_ party: String = noordkust) throws -> TalkingPointsDTO {
        try APIClient.jsonDecoder.decode(TalkingPointsDTO.self, from: fixture(party))
    }

    static func tempDir() -> URL {
        URL.temporaryDirectory.appending(path: "calls-\(UUID().uuidString)", directoryHint: .isDirectory)
    }

    /// 09:41 on the synthetic case's Sunday.
    let now = FixtureEnvironment.today

    // MARK: - The DTO

    @Test func theFixtureIsTheRoutesDTO() throws {
        let n = try Self.dto()
        #expect(n.party.name == "Bewindkantoor Noordkust")
        #expect(n.party.phone == "06 0000 0002")
        #expect(n.tell.count == 3)
        #expect(n.ask.count == 2)
        #expect(n.summary?.ai == true)
        let k = try Self.dto(Self.kade)
        #expect(k.party.phone == nil)
        #expect(k.summary == nil)
        #expect(k.tell.isEmpty)
    }

    /// An older server that does not send `phone` still decodes.
    @Test func aPartyWithoutAPhoneFieldDecodes() throws {
        let json = #"{"party":{"id":"x","name":"Y"},"tell":[],"ask":[],"summary":null}"#
        let d = try APIClient.jsonDecoder.decode(TalkingPointsDTO.self, from: Data(json.utf8))
        #expect(d.party.phone == nil)
    }

    // MARK: - Ordering, ticking, progress

    @Test func pointsAreTellThenAskInTheServersOrder() throws {
        let c = CallChecklist(try Self.dto())
        #expect(c.items(.tell).map(\.text) == [
            "Opgestuurd op 30 okt: Loonstrook 2026-10",
            "Opgestuurd op 30 okt: Loonstrook 2026-09",
            "Gemaild op 30 okt: Loonstroken september en oktober",
        ])
        #expect(c.items(.ask).map(\.text) == [
            "Nog geen antwoord op je mail van 20 okt: Vraag over leefgeld november",
            "Bespreek: Stukken aanleveren bij Team Startdossier",
        ])
        #expect(c.points.map(\.list) == [.tell, .tell, .tell, .ask, .ask])
        #expect(c.nextOpen?.text == "Opgestuurd op 30 okt: Loonstrook 2026-10")
        #expect(c.progressText == "0 van 5 besproken")
        #expect(CallList.tell.title == "Vertellen")
        #expect(CallList.ask.title == "Vragen")
    }

    @Test func tickingMovesTheNextPointAndTheCount() throws {
        var c = CallChecklist(try Self.dto())
        let ids = c.points.map(\.id)
        c.toggle(ids[0])
        c.toggle(ids[3])
        #expect(c.discussed == 2)
        #expect(c.progressText == "2 van 5 besproken")
        #expect(c.nextOpen?.id == ids[1])
        c.toggle(ids[0]) // untick
        #expect(c.progressText == "1 van 5 besproken")
        #expect(c.nextOpen?.id == ids[0])
        for id in ids where !c.isTicked(id) { c.toggle(id) }
        #expect(c.nextOpen == nil)
        #expect(c.progressText == "5 van 5 besproken")
        c.toggle("not-a-point")
        #expect(c.discussed == 5)
    }

    /// A refresh keeps the ticks of the points that are still there (ids are
    /// stable on the server) and drops the rest.
    @Test func aRefreshKeepsTicksOnPointsThatRemain() throws {
        let dto = try Self.dto()
        var c = CallChecklist(dto)
        c.toggle(dto.tell[0].id)
        c.toggle(dto.ask[1].id)
        let fewer = TalkingPointsDTO(party: dto.party, tell: Array(dto.tell.dropFirst()), ask: dto.ask, summary: nil)
        c.replace(with: fewer)
        #expect(c.discussed == 1)
        #expect(c.isTicked(dto.ask[1].id))
        #expect(c.total == 4)
    }

    @Test func noPointsAtAllIsSaidPlainly() {
        let empty = TalkingPointsDTO(party: .init(id: "p", name: "X", phone: nil), tell: [], ask: [], summary: nil)
        let c = CallChecklist(empty)
        #expect(c.progressText == "Geen gesprekspunten")
        #expect(CallList.tell.emptyText == "Niets om te vertellen.")
        #expect(CallList.ask.emptyText == "Niets om te vragen.")
    }

    // MARK: - The AI line

    @Test func theAISummaryIsLabelledWithItsDate() throws {
        let s = try #require(try Self.dto().summary)
        #expect(CallCopy.summaryLabel(s) == "AI-samenvatting · 30 okt")
        // Its sources open the dossier (a mail has no screen of its own).
        #expect(CallCopy.sources(s).map(\.label) == ["Mail", "Mail"])
        #expect(CallCopy.sources(s).allSatisfy { DeepLink.parse($0.link) == .dossier })
    }

    @Test func aSourceLinksToItsScreen() {
        #expect(CallCopy.link(type: "task", id: "6f9619ff-8b86-d011-b42d-00c04fc964ff")
                == "grip://task/6f9619ff-8b86-d011-b42d-00c04fc964ff")
        #expect(CallCopy.link(type: "debt", id: "x") == "grip://dossier")
        #expect(CallCopy.link(type: "stop", id: "x") == "grip://timeline")
        #expect(CallCopy.link(type: "unknown", id: "x") == "grip://dossier")
    }

    // MARK: - The Live Activity: counts only where anyone can see it

    @Test func theLockScreenAndCompactFacesShowCountsOnly() throws {
        let dto = try Self.dto()
        var c = CallChecklist(dto)
        c.toggle(dto.tell[0].id)
        c.toggle(dto.tell[1].id)
        let state = c.activityState
        #expect(state.discussed == 2)
        #expect(state.total == 5)
        #expect(state.nextPoint == "Gemaild op 30 okt: Loonstroken september en oktober")

        let lock = CallActivityFaces.lockScreen(state)
        let compact = CallActivityFaces.compact(state)
        let minimal = CallActivityFaces.minimal(state)
        #expect(lock.progress == "2 van 5 besproken")
        #expect(compact.trailing == "2/5")
        #expect(minimal == "2/5")
        let shown = [lock.title, lock.progress, lock.detail, compact.leading, compact.trailing, minimal]
            .joined(separator: " | ")
        // Never the party, never a point.
        #expect(!shown.contains("Noordkust"))
        #expect(!shown.contains(dto.party.name))
        for p in dto.tell + dto.ask { #expect(!shown.contains(p.text), "\(p.text)") }
        #expect(!shown.contains("Loonstro"))
        // The attributes carry nothing that names the call at all.
        let attributes = String(describing: CallActivityAttributes())
        #expect(!attributes.contains("Noordkust"))
    }

    @Test func theExpandedIslandMayShowTheNextPointMarkedSensitive() throws {
        let dto = try Self.dto()
        let state = CallChecklist(dto).activityState
        let e = CallActivityFaces.expanded(state)
        #expect(e.progress == "0 van 5 besproken")
        #expect(e.nextPoint == dto.tell[0].text)
        #expect(e.nextPointIsPrivacySensitive)
        // Never the party, even here.
        #expect(!(e.nextLabel + e.progress).contains(dto.party.name))
        var all = CallChecklist(dto)
        for p in all.points { all.toggle(p.id) }
        #expect(CallActivityFaces.expanded(all.activityState).nextPoint == nil)
        #expect(CallActivityFaces.expanded(all.activityState).nextLabel == "Alles besproken")
    }

    @Test func aLongPointIsShortenedForTheIsland() {
        let long = String(repeating: "a", count: 300)
        let dto = TalkingPointsDTO(party: .init(id: "p", name: "X", phone: nil),
                                   tell: [.init(id: "t", text: long, source: .init(type: "task", id: "t", link: "grip://dossier"))],
                                   ask: [], summary: nil)
        let next = CallChecklist(dto).activityState.nextPoint ?? ""
        #expect(next.count <= CallActivityFaces.nextPointMax)
        #expect(next.hasSuffix("…"))
    }

    // MARK: - Prefill for the voice quick-log

    @Test func thePrefillListsTheTickedPointsInOrder() throws {
        let dto = try Self.dto()
        var c = CallChecklist(dto)
        c.toggle(dto.ask[0].id)
        c.toggle(dto.tell[0].id)
        #expect(c.prefillText == """
        Besproken:
        - Opgestuurd op 30 okt: Loonstrook 2026-10
        - Nog geen antwoord op je mail van 20 okt: Vraag over leefgeld november
        """)
        #expect(CallChecklist(dto).prefillText == "")
    }

    // MARK: - Bel

    @Test func belDialsTheNumberAsATelLink() {
        #expect(CallCopy.dialURL("06 0000 0002")?.absoluteString == "tel:0600000002")
        #expect(CallCopy.dialURL("+31 (0)6-0000 0002")?.absoluteString == "tel:+310600000002")
        #expect(CallCopy.dialURL("  ") == nil)
        #expect(CallCopy.dialURL(nil) == nil)
        // Anything but digits, + and separators: no link, never a guess.
        #expect(CallCopy.dialURL("06 0000 0002; ext=1") == nil)
        #expect(CallCopy.dialURL("12") == nil)
    }

    // MARK: - The model: load, offline with age

    func server(_ body: Data? = nil, status: Int = 200) -> StubServer {
        let s = StubServer()
        s.on { req in
            if let body, req.url?.path().hasSuffix("/talking-points") == true { return .status(status, body: body) }
            return .status(status == 200 ? 404 : status)
        }
        return s
    }

    @Test func theModelLoadsThePointsAndCachesThemCompleteProtection() async throws {
        let body = try Self.fixture()
        let s = server(body)
        let writes = Mutex<[Data.WritingOptions]>([])
        let cache = CallCache(dir: Self.tempDir(), write: { data, url, options in
            writes.withLock { $0.append(options) }
            try CallCache.defaultWriter(data, url, options)
        })
        let m = CallPrepModel(partyId: Self.noordkust, name: nil, client: s.client(), cache: cache, now: { self.now })
        await m.load()
        #expect(m.partyName == "Bewindkantoor Noordkust")
        #expect(m.checklist.total == 5)
        #expect(m.offline == false)
        #expect(s.requests.map { $0.url?.path() } == ["/api/mobile/v1/parties/\(Self.noordkust)/talking-points"])
        #expect(writes.withLock { $0 }.allSatisfy { $0.contains(.completeFileProtection) && $0.contains(.atomic) })
        #expect(writes.withLock { $0.count } == 1)
    }

    @Test func offlineShowsTheLastFetchedPointsWithTheirAge() async throws {
        let dir = Self.tempDir()
        let first = CallPrepModel(partyId: Self.noordkust, name: nil, client: server(try Self.fixture()).client(),
                                  cache: CallCache(dir: dir), now: { self.now })
        await first.load()

        let offline = StubServer()
        offline.on { _ in .failure(.notConnectedToInternet) }
        let later = now.addingTimeInterval(3600)
        let m = CallPrepModel(partyId: Self.noordkust, name: "Bewindkantoor Noordkust", client: offline.client(),
                              cache: CallCache(dir: dir), now: { later })
        await m.load()
        #expect(m.offline)
        #expect(m.checklist.total == 5)
        #expect(m.freshness == "offline · bijgewerkt 09:41")
        #expect(m.screen == .points)
    }

    @Test func offlineWithNothingCachedSaysSo() async {
        let offline = StubServer()
        offline.on { _ in .failure(.notConnectedToInternet) }
        let m = CallPrepModel(partyId: Self.noordkust, name: "X", client: offline.client(),
                              cache: CallCache(dir: Self.tempDir()), now: { self.now })
        await m.load()
        #expect(m.screen == .offlineNothingCached)
        #expect(CallCopy.offlineNothing == "Geen verbinding, en deze punten staan nog niet op je telefoon.")
    }

    @Test func aRefreshKeepsWhatWasTicked() async throws {
        let body = try Self.fixture()
        let m = CallPrepModel(partyId: Self.noordkust, name: nil, client: server(body).client(),
                              cache: CallCache(dir: Self.tempDir()), now: { self.now })
        await m.load()
        let first = try #require(m.checklist.points.first)
        m.toggle(first.id)
        await m.load()
        #expect(m.checklist.isTicked(first.id))
    }

    // MARK: - The session: Bel, the Live Activity, the call ending

    final class FakeActivities: CallActivityControlling {
        var allowed = true
        private(set) var states: [CallActivityAttributes.ContentState] = []
        private(set) var starts = 0
        private(set) var ends = 0
        private(set) var isRunning = false

        func start(_ state: CallActivityAttributes.ContentState) -> Bool {
            guard allowed else { return false }
            starts += 1
            isRunning = true
            states.append(state)
            return true
        }
        func update(_ state: CallActivityAttributes.ContentState) {
            guard isRunning else { return }
            states.append(state)
        }
        func end() {
            if isRunning { ends += 1 }
            isRunning = false
        }
    }

    final class FakeObserver: CallObserving {
        private var handler: (@MainActor (CallEvent) -> Void)?
        /// What `CXCallObserver.calls` would say: id → hasEnded.
        var live: [UUID: Bool] = [:]
        func observe(_ handler: @escaping @MainActor (CallEvent) -> Void) { self.handler = handler }
        func currentCalls() -> [UUID: Bool] { live }
        func send(_ e: CallEvent) { handler?(e) }
    }

    struct Rig {
        let session: CallSession
        let activities: FakeActivities
        let observer: FakeObserver
        let dialed: Box<[URL]>
        let voice: Box<[VoicePrefill]>
        let epoch: SessionEpoch
    }

    final class Box<T> {
        var value: T
        init(_ value: T) { self.value = value }
    }

    func rig(body: Data? = nil) throws -> Rig {
        let activities = FakeActivities()
        let observer = FakeObserver()
        let dialed = Box<[URL]>([])
        let voice = Box<[VoicePrefill]>([])
        let epoch = SessionEpoch()
        let clock = now
        let session = CallSession(client: server(try body ?? Self.fixture()).client(), cache: CallCache(dir: Self.tempDir()),
                                  activities: activities, observer: observer, epoch: epoch, now: { clock },
                                  dial: { dialed.value.append($0) }, openVoice: { voice.value.append($0) })
        return Rig(session: session, activities: activities, observer: observer, dialed: dialed, voice: voice, epoch: epoch)
    }

    @Test func belStartsTheLiveActivityAndOpensTheDialer() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: "Bewindkantoor Noordkust")
        #expect(r.session.isPresented)
        r.session.bel()
        #expect(r.dialed.value.map(\.absoluteString) == ["tel:0600000002"])
        #expect(r.activities.starts == 1)
        #expect(r.activities.states.last == .init(discussed: 0, total: 5, nextPoint: "Opgestuurd op 30 okt: Loonstrook 2026-10"))
    }

    @Test func tickingInTheAppUpdatesTheLiveActivity() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.startActivity() // the manual start, no dialer
        #expect(r.dialed.value.isEmpty)
        let m = try #require(r.session.model)
        r.session.toggle(m.checklist.points[0].id)
        r.session.toggle(m.checklist.points[1].id)
        #expect(r.activities.states.last?.discussed == 2)
        #expect(r.activities.states.last?.nextPoint == "Gemaild op 30 okt: Loonstroken september en oktober")
        #expect(CallActivityFaces.lockScreen(try #require(r.activities.states.last)).progress == "2 van 5 besproken")
    }

    @Test func noNumberMeansNoDialerButTheActivityCanStillStart() async throws {
        let r = try rig(body: Self.fixture(Self.kade))
        await r.session.open(partyId: Self.kade, name: nil)
        #expect(r.session.model?.dialURL == nil)
        r.session.bel()
        #expect(r.dialed.value.isEmpty)
        #expect(r.activities.starts == 0)
        r.session.startActivity()
        #expect(r.activities.starts == 1)
    }

    @Test func whenTheCallEndsTheActivityEndsAndTheLogIsOfferedPrefilled() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.bel()
        let m = try #require(r.session.model)
        let a = m.checklist.points[0], b = m.checklist.points[3]
        r.session.toggle(b.id)
        r.session.toggle(a.id)
        let call = UUID()
        r.observer.send(.started(call))
        r.observer.send(.ended(call))
        #expect(r.activities.isRunning == false)
        #expect(r.activities.ends == 1)
        #expect(r.session.callEnded)
        #expect(r.session.isPresented)

        r.session.logCall()
        // The call sheet goes first; the voice log opens when it has (onDismiss).
        #expect(r.session.isPresented == false)
        r.session.sheetDismissed()
        let prefill = try #require(r.voice.value.first)
        #expect(prefill.partyId == Self.noordkust)
        #expect(prefill.text == "Besproken:\n- \(a.text)\n- \(b.text)")
        #expect(prefill.occurredAt == now)
        #expect(r.voice.value.count == 1)
        #expect(r.session.model == nil)
        // A second dismissal opens nothing more.
        r.session.sheetDismissed()
        #expect(r.voice.value.count == 1)
    }

    @Test func aCallEndingWithNoCallSheetActiveDoesNothing() async throws {
        let r = try rig()
        let call = UUID()
        r.observer.send(.started(call))
        r.observer.send(.ended(call))
        #expect(r.session.callEnded == false)
        #expect(r.session.isPresented == false)

        // Prepared, then closed with no Live Activity running: no longer active.
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.close()
        r.observer.send(.ended(UUID()))
        #expect(r.session.callEnded == false)
        #expect(r.session.isPresented == false)
    }

    @Test func aClosedSheetWithItsActivityRunningStillCatchesTheEnd() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.startActivity()
        r.session.close()
        r.observer.send(.ended(UUID()))
        #expect(r.session.callEnded)
        #expect(r.activities.isRunning == false)
        #expect(r.session.isPresented) // brought back with "Gesprek vastleggen"
    }

    @Test func oneCallEndsOnce() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.startActivity()
        let call = UUID()
        r.observer.send(.ended(call))
        r.session.dismissEnded()
        r.observer.send(.ended(call))
        #expect(r.session.callEnded == false)
    }

    @Test func theCallsStartTimeBecomesTheLogsTime() async throws {
        var clock = now
        let activities = FakeActivities(), observer = FakeObserver()
        let voice = Box<[VoicePrefill]>([])
        let session = CallSession(client: server(try Self.fixture()).client(), cache: CallCache(dir: Self.tempDir()),
                                  activities: activities, observer: observer, epoch: SessionEpoch(),
                                  now: { clock }, dial: { _ in }, openVoice: { voice.value.append($0) })
        await session.open(partyId: Self.noordkust, name: nil)
        session.startActivity()
        let call = UUID()
        observer.send(.started(call))
        let started = clock
        clock = clock.addingTimeInterval(600)
        observer.send(.started(call)) // connected: the same call, not a new start
        observer.send(.ended(call))
        session.logCall()
        session.sheetDismissed()
        #expect(voice.value.first?.occurredAt == started)
    }

    @Test func openingAnotherPartyEndsTheRunningActivity() async throws {
        let body = try Self.fixture()
        let r = try rig(body: body)
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.startActivity()
        await r.session.open(partyId: Self.noordkust, name: nil)
        #expect(r.activities.isRunning, "the same party keeps its call")
        let m = try #require(r.session.model)
        #expect(m.partyId == Self.noordkust)
        await r.session.open(partyId: Self.kade, name: nil)
        #expect(r.activities.isRunning == false)
        #expect(r.session.model?.partyId == Self.kade)
    }

    @Test func theSessionEndingForgetsTheCallAndEndsTheActivity() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.startActivity()
        r.epoch.end()
        #expect(r.session.model == nil)
        #expect(r.session.isPresented == false)
        #expect(r.activities.isRunning == false)
    }

    /// A sign-out (or a 401 anywhere) while the talking points are still on
    /// their way: the reply that lands after the wipe must not write the
    /// party's name, number and points back to disk (review, 2026-11-03).
    @Test func aReplyLandingAfterTheSessionEndedIsNotWrittenBack() async throws {
        let body = try Self.fixture()
        let gate = DossierModelTests.Gate()
        let s = StubServer()
        s.on { req in
            guard req.url?.path().hasSuffix("/talking-points") == true else { return .status(404) }
            gate.wait()
            return .status(200, body: body)
        }
        let dir = Self.tempDir()
        let cache = CallCache(dir: dir)
        let epoch = SessionEpoch()
        let session = CallSession(client: s.client(), cache: cache, activities: FakeActivities(),
                                  observer: FakeObserver(), epoch: epoch, now: { self.now },
                                  dial: { _ in }, openVoice: { _ in })
        let opening = Task { await session.open(partyId: Self.noordkust, name: "Bewindkantoor Noordkust") }
        await DossierModelTests.waitUntil { gate.arrived.withLock { $0 } }
        epoch.end()
        gate.open()
        await opening.value
        #expect(cache.load(Self.noordkust) == nil)
        #expect(FileManager.default.fileExists(atPath: dir.path()) == false)
        #expect(session.model == nil)
    }

    /// The model on its own, held by whoever opened it: the ended epoch
    /// leaves it showing nothing new either.
    @Test func theModelIgnoresAReplyFromAnEndedSession() async throws {
        let body = try Self.fixture()
        let gate = DossierModelTests.Gate()
        let s = StubServer()
        s.on { _ in gate.wait(); return .status(200, body: body) }
        let dir = Self.tempDir()
        let epoch = SessionEpoch()
        let m = CallPrepModel(partyId: Self.noordkust, name: "X", client: s.client(), cache: CallCache(dir: dir),
                              epoch: epoch, now: { self.now })
        let loading = Task { await m.load() }
        await DossierModelTests.waitUntil { gate.arrived.withLock { $0 } }
        epoch.end()
        gate.open()
        await loading.value
        #expect(m.dto == nil)
        #expect(FileManager.default.fileExists(atPath: dir.path()) == false)
    }

    // MARK: - Coming back from the Phone app

    /// "Bel" hands the call to the Phone app and iOS suspends Grip for the
    /// whole call, so the `.ended` callback may never arrive. Coming back to
    /// the foreground compares with `CXCallObserver.calls`: a call this
    /// session saw start that is no longer live has ended (review, 2026-11-03).
    @Test func comingBackWithNoLiveCallEndsTheCallTheEndOfWhichWasMissed() async throws {
        var clock = now
        let activities = FakeActivities(), observer = FakeObserver()
        let voice = Box<[VoicePrefill]>([])
        let session = CallSession(client: server(try Self.fixture()).client(), cache: CallCache(dir: Self.tempDir()),
                                  activities: activities, observer: observer, epoch: SessionEpoch(),
                                  now: { clock }, dial: { _ in }, openVoice: { voice.value.append($0) })
        await session.open(partyId: Self.noordkust, name: nil)
        session.bel()
        let call = UUID()
        observer.live = [call: false]
        observer.send(.started(call))
        let started = clock
        // No `.ended` is delivered. Twenty minutes later Grip is back.
        clock = clock.addingTimeInterval(1200)
        observer.live = [:]
        session.reconcile()
        #expect(activities.isRunning == false)
        #expect(activities.ends == 1)
        #expect(session.callEnded)
        #expect(session.isPresented)
        session.logCall()
        session.sheetDismissed()
        #expect(voice.value.first?.occurredAt == started)
        // A late `.ended` for the same call is not a second end.
        session.dismissEnded()
        observer.send(.ended(call))
        #expect(session.callEnded == false)
    }

    /// CallKit still lists the call, but as ended: the same.
    @Test func aCallListedAsEndedIsEnded() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.bel()
        let call = UUID()
        r.observer.send(.started(call))
        r.observer.live = [call: true]
        r.session.reconcile()
        #expect(r.session.callEnded)
        #expect(r.activities.isRunning == false)
    }

    /// Still on the phone (Martin switched back to read the points): nothing ends.
    @Test func comingBackDuringTheCallEndsNothing() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.bel()
        let call = UUID()
        r.observer.send(.started(call))
        r.observer.live = [call: false]
        r.session.reconcile()
        #expect(r.session.callEnded == false)
        #expect(r.activities.isRunning)
        // A Live Activity started by hand, with no call seen at all: kept too.
        let other = try rig()
        await other.session.open(partyId: Self.noordkust, name: nil)
        other.session.startActivity()
        other.session.reconcile()
        #expect(other.activities.isRunning)
        #expect(other.session.callEnded == false)
    }

    /// A call seen start while no sheet was active is forgotten on return, so
    /// a LATER call sheet never takes its end (or its start time) for its own.
    @Test func aStaleCallFromBeforeTheSheetIsNotTakenForThisOne() async throws {
        var clock = now
        let activities = FakeActivities(), observer = FakeObserver()
        let voice = Box<[VoicePrefill]>([])
        let session = CallSession(client: server(try Self.fixture()).client(), cache: CallCache(dir: Self.tempDir()),
                                  activities: activities, observer: observer, epoch: SessionEpoch(),
                                  now: { clock }, dial: { _ in }, openVoice: { voice.value.append($0) })
        let old = UUID()
        observer.send(.started(old)) // an unrelated call, no sheet open
        observer.live = [:]
        session.reconcile()           // its end was never delivered
        clock = clock.addingTimeInterval(3600)
        await session.open(partyId: Self.noordkust, name: nil)
        session.bel()
        let call = UUID()
        observer.send(.started(call))
        let started = clock
        observer.send(.ended(old))    // a late echo of the old call
        #expect(session.callEnded == false)
        observer.send(.ended(call))
        session.logCall()
        session.sheetDismissed()
        #expect(voice.value.first?.occurredAt == started)
    }

    /// "Bel", then Grip is suspended before CallKit's `.started` reaches it:
    /// on return `startedCalls` is empty AND `CXCallObserver.calls` lists
    /// nothing. The session dialled and went to the background, so the call
    /// is over — the dial time stands in for the start (review, 2026-11-03).
    @Test func aDialledCallWhoseStartWasNeverSeenEndsOnReturn() async throws {
        var clock = now
        let activities = FakeActivities(), observer = FakeObserver()
        let voice = Box<[VoicePrefill]>([])
        let session = CallSession(client: server(try Self.fixture()).client(), cache: CallCache(dir: Self.tempDir()),
                                  activities: activities, observer: observer, epoch: SessionEpoch(),
                                  now: { clock }, dial: { _ in }, openVoice: { voice.value.append($0) })
        await session.open(partyId: Self.noordkust, name: nil)
        let dialled = clock
        session.bel()
        session.sceneEnteredBackground()
        clock = clock.addingTimeInterval(900)
        observer.live = [:]
        session.reconcile()
        #expect(session.callEnded)
        #expect(session.isPresented)
        #expect(activities.isRunning == false)
        #expect(activities.ends == 1)
        session.logCall()
        session.sheetDismissed()
        #expect(voice.value.first?.occurredAt == dialled)
    }

    /// Still on that call (it is live, its `.started` simply never arrived):
    /// nothing ends.
    @Test func aDialledCallStillLiveIsKeptEvenUnseen() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.bel()
        r.session.sceneEnteredBackground()
        r.observer.live = [UUID(): false]
        r.session.reconcile()
        #expect(r.session.callEnded == false)
        #expect(r.activities.isRunning)
    }

    /// iOS asks "Bel …?" over the app before dialling; that alert makes the
    /// scene inactive, never background. Cancelling it brings Grip back
    /// with no call — and that is no call to log.
    @Test func aCancelledDialPromptEndsNothing() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.bel()
        r.observer.live = [:]
        r.session.reconcile()
        #expect(r.session.callEnded == false)
        #expect(r.activities.isRunning)
    }

    /// A cancelled prompt spends the dial. Without that, the dial stayed armed
    /// until some LATER trip to the background (locking the phone, looking
    /// something up in another app) and the return after it "ended" a call
    /// that never took place, dated at the cancelled dial (review, 2026-11-03).
    @Test func aCancelledDialPromptStaysEndedNothingAfterALaterBackground() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.bel()
        r.observer.live = [:]
        r.session.reconcile()            // the prompt was cancelled
        r.session.sceneEnteredBackground() // later: the phone is locked
        r.session.reconcile()
        #expect(r.session.callEnded == false)
        #expect(r.activities.isRunning)
    }

    /// Back while the call is live but Grip never reached the background
    /// (the in-call UI only made it inactive): that is no cancelled prompt,
    /// so the dial stays armed for the return after the call.
    @Test func aReturnDuringALiveDialledCallKeepsTheDial() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.bel()
        r.observer.live = [UUID(): false]
        r.session.reconcile()
        #expect(r.session.callEnded == false)
        r.session.sceneEnteredBackground()
        r.observer.live = [:]
        r.session.reconcile()
        #expect(r.session.callEnded)
    }

    /// A suspended app's queued CallKit callbacks arrive on resume, in an
    /// order relative to `scenePhase == .active` nobody has measured. When
    /// they land AFTER the dial path ended the call, they are that same call:
    /// an offer dismissed with "Niet nu" does not come back, and a late
    /// `.started` left without its `.ended` cannot end the next sheet
    /// (review, 2026-11-03).
    @Test func lateCallKitEventsAfterADialPathEndAreThatSameCall() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.bel()
        r.session.sceneEnteredBackground()
        r.observer.live = [:]
        r.session.reconcile()
        #expect(r.session.callEnded)
        r.session.dismissEnded()
        let call = UUID()
        r.observer.send(.started(call))
        r.observer.send(.ended(call))
        #expect(r.session.callEnded == false)
        #expect(r.activities.ends == 1)
        // Only the late `.started` arrives: the next sheet is not ended by it.
        let other = try rig()
        await other.session.open(partyId: Self.noordkust, name: nil)
        other.session.bel()
        other.session.sceneEnteredBackground()
        other.observer.live = [:]
        other.session.reconcile()
        other.session.dismissEnded()
        other.observer.send(.started(UUID()))
        await other.session.open(partyId: Self.kade, name: nil)
        other.session.startActivity()
        other.session.reconcile()
        #expect(other.session.callEnded == false)
        #expect(other.activities.isRunning)
    }

    /// The calls CallKit still lists at a dial-path end (ended ones) are that
    /// call's too: their late `.ended` is no second end.
    @Test func callsListedAtADialPathEndAreSpent() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.bel()
        r.session.sceneEnteredBackground()
        let call = UUID()
        r.observer.live = [call: true]
        r.session.reconcile()
        #expect(r.session.callEnded)
        r.session.dismissEnded()
        r.observer.send(.started(call))
        r.observer.send(.ended(call))
        #expect(r.session.callEnded == false)
    }

    /// A LONE late `.ended` after a dial-path end — no `.started` ever seen,
    /// the id not listed at `reconcile` — is that same call's echo, exactly
    /// like a lone `.started`: it does not end the call a second time or
    /// bring back the offer Martin dismissed (review, 2026-11-03).
    @Test func aLoneLateEndedAfterADialPathEndIsThatSameCall() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.bel()
        r.session.sceneEnteredBackground()
        r.observer.live = [:]
        r.session.reconcile()
        #expect(r.session.callEnded)
        r.session.dismissEnded()
        r.observer.send(.ended(UUID()))
        #expect(r.session.callEnded == false)
        #expect(r.activities.ends == 1)
    }

    /// Opening ANOTHER party inside the echo window is a new call to follow:
    /// its own `.started`/`.ended` are not swallowed as the old call's echo.
    @Test func aNewPartyInsideTheEchoWindowFollowsItsCall() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.bel()
        r.session.sceneEnteredBackground()
        r.observer.live = [:]
        r.session.reconcile()
        r.session.dismissEnded()
        await r.session.open(partyId: Self.kade, name: nil)
        let call = UUID()
        r.observer.send(.started(call))
        r.observer.send(.ended(call))
        #expect(r.session.callEnded)
    }

    /// "Toon tijdens het gesprek" on the same sheet inside the echo window
    /// starts a new call to follow, too.
    @Test func aStartedActivityInsideTheEchoWindowFollowsItsCall() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.bel()
        r.session.sceneEnteredBackground()
        r.observer.live = [:]
        r.session.reconcile()
        r.session.dismissEnded()
        r.session.startActivity()
        let call = UUID()
        r.observer.send(.started(call))
        r.observer.send(.ended(call))
        #expect(r.session.callEnded)
        #expect(r.activities.ends == 2)
    }

    /// The dial is consumed by its end: a second return to the app (or a
    /// later "Toon tijdens het gesprek" on the same sheet) is not a second end.
    @Test func aDialEndsOnlyOnce() async throws {
        let r = try rig()
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.bel()
        r.session.sceneEnteredBackground()
        r.session.reconcile()
        #expect(r.session.callEnded)
        r.session.dismissEnded()
        r.session.startActivity()
        r.session.sceneEnteredBackground()
        r.session.reconcile()
        #expect(r.session.callEnded == false)
        #expect(r.activities.isRunning)
    }

    @Test func activitiesOffInSettingsIsSaid() async throws {
        let r = try rig()
        r.activities.allowed = false
        await r.session.open(partyId: Self.noordkust, name: nil)
        r.session.startActivity()
        #expect(r.session.notice == CallCopy.activitiesOff)
    }

    // MARK: - Fixture route

    @Test func theCallRouteOpensTheSheetForAParty() throws {
        #expect(try FixtureLaunch.parseRoute("call:\(Self.noordkust)") == .call(Self.noordkust))
        #expect(throws: FixtureLaunch.ParseError.unknownRoute("call:nope")) { try FixtureLaunch.parseRoute("call:nope") }
        let l = try #require(try FixtureLaunch.parse(["Grip", "-fixtures", "call", "-route", "call:\(Self.kade)"]))
        #expect(l.route == .call(Self.kade))
    }

    /// The Live Activity's tap reopens the call sheet.
    @Test func theCallLinkReopensTheSheet() {
        #expect(DeepLink.parse("grip://call") == .call)
        #expect(DeepLink.parse("grip://call/x") == DeepLink.none)
        #expect(DeepLink.call.destination == .init(tab: nil, stack: nil, opensCall: true))
        #expect(DeepLink.parse(CallActivityFaces.url.absoluteString).destination?.opensCall == true)
    }
}

/// The voice quick-log opened from a finished call: "Besproken: …" from the
/// ticked points goes on top of whatever Martin then dictates, the party is
/// preselected and the time is the call's own. It is still only a SUGGESTION:
/// nothing reaches the logbook until he approves it in Voor jou.
@MainActor
struct VoicePrefillTests {
    let base = VoiceLogModelTests()

    func prefill(at date: Date) -> VoicePrefill {
        VoicePrefill(partyId: VoiceLogModelTests.noordkust, text: "Besproken:\n- Loonstrook 2026-10", occurredAt: date)
    }

    @Test func dictationGoesUnderThePrefill() async throws {
        let s = base.server()
        let m = try base.model(s, transcriber: FakeTranscriber(text: "Ze bellen terug."))
        m.apply(prefill(at: base.t0.addingTimeInterval(-600)))
        await m.prepare()
        // Noordkust is the SECOND recent party: the prefill's party wins over the top one.
        #expect(m.partyId == VoiceLogModelTests.noordkust)
        #expect(m.prefill == "Besproken:\n- Loonstrook 2026-10")
        await base.record(m)
        #expect(m.transcript == "Besproken:\n- Loonstrook 2026-10\n\nZe bellen terug.")
        // The call's time, not the recording's.
        #expect(m.occurredAt == base.t0.addingTimeInterval(-600))
        await m.send()
        #expect(try base.posted(s).contains(base.field("partyId", VoiceLogModelTests.noordkust)))
    }

    @Test func typingStartsFromThePrefill() async throws {
        let m = try base.model(base.server())
        m.apply(prefill(at: base.t0))
        m.typeInstead()
        #expect(m.phase == .editing)
        #expect(m.transcript == "Besproken:\n- Loonstrook 2026-10")
    }

    @Test func nothingHeardLeavesThePrefillToEdit() async throws {
        let m = try base.model(base.server(), transcriber: FakeTranscriber(failure: .nothingHeard))
        m.apply(prefill(at: base.t0))
        await m.prepare()
        await base.record(m)
        #expect(m.transcript == "Besproken:\n- Loonstrook 2026-10")
        // Only the prefill is there: another take is still offered.
        #expect(m.canRecordAgain)
    }

    @Test func aPrefillNeverOverwritesWorkInProgress() async throws {
        let m = try base.model(base.server())
        await m.prepare()
        m.typeInstead()
        m.transcript = "Mijn eigen tekst"
        m.apply(prefill(at: base.t0))
        #expect(m.transcript == "Mijn eigen tekst")
        #expect(m.prefill == nil)
    }

    @Test func startOverForgetsThePrefill() async throws {
        let m = try base.model(base.server())
        m.apply(prefill(at: base.t0))
        m.startOver()
        #expect(m.prefill == nil)
        #expect(m.occurredAt == nil)
    }

    @Test func theSessionAppliesAPrefillToAFreshLog() throws {
        let made = CallPrepTests.Box<[VoiceLogModel]>([])
        let base = base
        let session = VoiceLogSession(factory: VoiceLogFactory {
            let m = try! base.model(base.server())
            made.value.append(m)
            return m
        })
        session.open(prefill: prefill(at: base.t0))
        #expect(session.isPresented)
        #expect(session.model?.prefill == "Besproken:\n- Loonstrook 2026-10")
    }
}
