import Testing
import Foundation
@testable import Grip

/// What the proposal screen says (Figma "proposal · final"), its hold to
/// send, the marks on Martin's edits and the bar's state per moment.
struct ProposalTextTests {
    static let ams = TimeZone(identifier: "Europe/Amsterdam")!

    static func date(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }

    static let trigger = ProposalDetail.Trigger(type: "email", id: "e1", from: "Ilse <ilse@noordkust.example>",
                                                subject: "Loonstrook oktober", date: date("2026-11-02T08:14:00Z"),
                                                excerpt: nil)

    @Test func titleNamesThePartyShort() {
        #expect(ProposalText.title(kind: "reply", partyName: "Bewindkantoor Noordkust") == "Antwoord aan Noordkust")
        #expect(ProposalText.title(kind: "follow-up", partyName: "Gemeente Westerlaan") == "Opvolging aan Gemeente Westerlaan")
        #expect(ProposalText.title(kind: "reply", partyName: nil) == "Antwoord")
        #expect(ProposalText.title(kind: "question", partyName: "Incassobureau Kade & Partners") == "Vraag")
        #expect(ProposalText.eyebrow(kind: "reply") == "Voorstel · antwoord")
    }

    /// A draft that failed has a status of its own, steel (it waits on nobody).
    @Test func aFailedDraftHasItsOwnBadge() {
        #expect(ProposalText.badge(status: "draft-failed") == .draftFailed)
        #expect(ProposalText.badgeText(.draftFailed) == "Geen concept")
        #expect(ProposalText.copyLabel == "Kopieer concepttekst")
        #expect(ProposalText.copyMenuTitle.replacingOccurrences(of: "\u{2060}", with: "") == ProposalText.copyLabel)
        #expect(ProposalText.copyMenuTitle.split(separator: " ").count == 2)
    }

    @Test func stampIsTheClockTodayAndTheDayOtherwise() {
        let now = Self.date("2026-11-02T08:41:00Z")
        #expect(ProposalText.stamp(Self.date("2026-11-02T08:20:00Z"), now: now) == "09:20")
        #expect(ProposalText.stamp(Self.date("2026-11-01T08:20:00Z"), now: now) == "1 nov 09:20")
    }

    /// Amber goes on the one status waiting on Martin, and on nothing else.
    @Test func onlyPendingIsWaiting() {
        #expect(ProposalText.badge(status: "pending") == .waiting)
        for s in ["approved", "sending", "failed", "rejected", "superseded", "draft-failed"] {
            #expect(ProposalText.badge(status: s) != .waiting)
        }
        #expect(ProposalText.badge(status: "sent") == .sent)
        #expect(ProposalText.badge(status: "drafting") == .drafting)
    }

    @Test func badgeNoteSaysWhenOrWhyNot() {
        let now = Self.date("2026-11-02T08:41:00Z"), at = Self.date("2026-11-02T08:20:00Z")
        #expect(ProposalText.badgeNote(status: "pending", createdAt: at, now: now, offline: false) == "Opgesteld 09:20")
        #expect(ProposalText.badgeNote(status: "pending", createdAt: at, now: now, offline: true) == "Geen verbinding · 09:20")
        #expect(ProposalText.badgeNote(status: "drafting", createdAt: at, now: now, offline: false) == "Sinds 09:20")
        #expect(ProposalText.badgeNote(status: "sent", createdAt: at, now: now, offline: false) == nil)
    }

    @Test func triggerMetaNamesTheChannelAndTheMoment() {
        let now = Self.date("2026-11-02T08:41:00Z")
        #expect(ProposalText.triggerMeta(kind: "reply", trigger: Self.trigger, now: now) == "Aanleiding · Mail · 2 nov 09:14")
        let earlier = ProposalDetail.Trigger(type: "proposal", id: "p", from: "grip", subject: "Kopie beschikking",
                                             date: Self.date("2026-10-07T09:02:00Z"), excerpt: nil)
        #expect(ProposalText.triggerMeta(kind: "follow-up", trigger: earlier, now: now) == "Aanleiding · 26 dagen stil")
    }

    /// Silence is counted in Amsterdam calendar days: 23:30 UTC is already tomorrow there.
    @Test func daysSilentAreAmsterdamDays() {
        #expect(ProposalText.daysSilent(since: Self.date("2026-11-01T23:30:00Z"), now: Self.date("2026-11-02T08:00:00Z")) == 0)
        #expect(ProposalText.daysSilent(since: Self.date("2026-11-01T22:30:00Z"), now: Self.date("2026-11-02T08:00:00Z")) == 1)
        #expect(ProposalText.daysSilent(since: Self.date("2026-11-03T08:00:00Z"), now: Self.date("2026-11-02T08:00:00Z")) == nil)
    }

    /// The sender's name is bold only when the ask really starts with it; nothing is reworded.
    @Test func triggerLineBoldsTheSenderOnlyWhenTheAskStartsWithIt() {
        let line = ProposalText.triggerLine(kind: "reply", ask: "Ilse vraagt om je loonstrook van oktober",
                                            trigger: Self.trigger, partyName: nil)
        #expect(line?.lead == "Ilse")
        #expect(line?.rest == " vraagt om je loonstrook van oktober.")
        let other = ProposalText.triggerLine(kind: "reply", ask: "Loonstrook aanleveren?", trigger: Self.trigger, partyName: nil)
        #expect(other?.lead == nil)
        #expect(other?.rest == "Loonstrook aanleveren?")
        #expect(ProposalText.triggerLine(kind: "reply", ask: nil, trigger: Self.trigger, partyName: nil) == nil)
    }

    @Test func addressesAndNamesComeOutOfAFromHeader() {
        #expect(ProposalText.displayName("Ilse <ilse@noordkust.example>") == "Ilse")
        #expect(ProposalText.displayName("ilse@noordkust.example") == nil)
        #expect(ProposalText.address("Ilse <Ilse@Noordkust.example>") == "ilse@noordkust.example")
        #expect(ProposalText.recipientName(to: ["ilse@noordkust.example"], triggerFrom: Self.trigger.from) == "Ilse")
        #expect(ProposalText.recipientName(to: ["team@noordkust.example"], triggerFrom: Self.trigger.from) == "team@noordkust.example")
    }

    @Test func faceIDLineNamesWhoAndHowMuch() {
        #expect(ProposalText.faceIDLine(to: ["ilse@noordkust.example"], triggerFrom: Self.trigger.from, attachments: 1)
                == "Naar Ilse, 1 bijlage. Annuleren stuurt niets.")
        #expect(ProposalText.attachmentCount(0) == "geen bijlage")
        #expect(ProposalText.attachmentCount(6) == "6 bijlagen")
    }

    @Test func bytesAreDecimalWithADutchComma() {
        #expect(ProposalText.bytes(184_320) == "184 KB")
        #expect(ProposalText.bytes(1_100_000) == "1,1 MB")
        #expect(ProposalText.bytes(640) == "640 B")
    }

    @Test func attachmentsTotalFromThreeUp() {
        func a(_ n: Int) -> ProposalDetail.Attachment { .init(id: "\(n)", title: "x", sizeBytes: 1_400_000, unavailable: false) }
        #expect(ProposalText.attachmentsTotal([a(1), a(2)]) == nil)
        #expect(ProposalText.attachmentsTotal([a(1), a(2), a(3)]) == "3 bijlagen · 4,2 MB samen")
    }

    @Test func fileKindIsTheExtension() {
        #expect(ProposalText.fileKind("Loonstrook.2026-10.pdf") == "PDF")
        #expect(ProposalText.fileKind("Polis Duinzorg 2026") == nil)
        #expect(ProposalText.fileKind(".hidden") == nil)
    }

    @Test func theMailItAnswersReadsMailVanTheSender() {
        let mail = ProposalDetail.Citation(type: "email", id: "e1", label: "2 nov · Ilse <…> — Loonstrook", why: nil)
        let s = ProposalText.source(mail, trigger: Self.trigger)
        #expect(s.title == "Mail van Ilse")
        #expect(s.meta == "Mail · 2 nov 09:14")
        let stop = ProposalDetail.Citation(type: "stop", id: "s", label: "Stukken aanleveren", why: nil)
        #expect(ProposalText.source(stop, trigger: Self.trigger).meta == "Kaart · Halte")
    }

    @Test func sourceMetaNamesTheSoortAndTheState() {
        let doc = ProposalDetail.Citation(type: "document", id: "d", label: "Loonstrook 2026-10", why: nil, docType: "Loonstrook")
        #expect(ProposalText.source(doc, trigger: Self.trigger).meta == "Dossier · Loonstrook")
        let bare = ProposalDetail.Citation(type: "document", id: "d", label: "x", why: nil, docType: "  ")
        #expect(ProposalText.source(bare, trigger: Self.trigger).meta == "Dossier")
        let stop = ProposalDetail.Citation(type: "stop", id: "s", label: "Stukken", why: nil, state: "open")
        #expect(ProposalText.source(stop, trigger: Self.trigger).meta == "Kaart · Halte · Open")
        // A state this build does not know is never shown raw.
        let odd = ProposalDetail.Citation(type: "stop", id: "s", label: "Stukken", why: nil, state: "weird")
        #expect(ProposalText.source(odd, trigger: Self.trigger).meta == "Kaart · Halte")
    }

    @Test func triggerMetaWrapsBetweenGroupsOnly() {
        let now = Self.date("2026-11-02T08:41:00Z")
        let groups = ProposalText.triggerMetaGroups(kind: "reply", trigger: Self.trigger, now: now)
        #expect(groups == ["Aanleiding\u{00A0}·\u{00A0}Mail", "2\u{00A0}nov\u{00A0}09:14"])
        // A group never breaks inside: no ordinary space in it.
        #expect(groups.allSatisfy { !$0.contains(" ") })
        #expect(ProposalText.triggerMeta(kind: "reply", trigger: Self.trigger, now: now) == "Aanleiding · Mail · 2 nov 09:14")
    }

    @Test func conceptLabelNamesTheVersion() {
        #expect(ProposalText.conceptLabel(status: "pending", edited: false, version: 2) == "Concept · Versie 2")
        #expect(ProposalText.conceptLabel(status: "pending", edited: false, version: nil) == "Concept")
        #expect(ProposalText.conceptLabel(status: "pending", edited: true, version: 2) == "Concept · Aangepast door jou")
        #expect(ProposalText.conceptLabel(status: "sent", edited: false, version: 2) == "Verstuurd bericht")
        #expect(ProposalText.conceptLabel(status: "failed", edited: false, version: 2) == "Concept · Versie 2")
    }

    @Test func editSummaryKeepsVerdersVersion() {
        let o = ReplyDraft(to: ["a@b.nl"], cc: [], subject: "S", body: "Beste Ilse,\n\nGroet,", attachmentDocumentIds: [], entrySummary: "x")
        var c = o
        c.body = "Beste Ilse,\n\nExcuses.\n\nGroet,"
        let s = ProposalText.editSummary(DraftChanges(original: o, current: c), version: 2)
        #expect(s?.what == "1 zin toegevoegd door jou")
        #expect(s?.kept == "Versie 2 van verder bewaard")
        #expect(ProposalText.editSummary(DraftChanges(original: o, current: o), version: 2) == nil)
        #expect(ProposalText.editSummary(DraftChanges(original: o, current: c), version: nil)?.kept == "Het concept van verder blijft bewaard")
    }

    @Test func aFollowUpNamesThePersonTheDraftGreets() {
        let t = ProposalDetail.Trigger(type: "proposal", id: "p", from: "grip", subject: "Kopie", date: Self.date("2026-10-07T09:02:00Z"), excerpt: nil)
        let line = ProposalText.triggerLine(kind: "follow-up", ask: nil, trigger: t, partyName: "Bewindkantoor Noordkust",
                                            draftBody: "Beste Ilse,\n\nOp 7 oktober…")
        #expect(line?.lead == "Jouw vraag van 7 okt")
        #expect(line?.rest == " staat nog open bij Ilse.")
        let formal = ProposalText.triggerLine(kind: "follow-up", ask: nil, trigger: t, partyName: "Bewindkantoor Noordkust",
                                              draftBody: "Geachte heer De Vries,\n\n…")
        #expect(formal?.rest == " staat nog open bij Noordkust.")
        #expect(ProposalText.greetedName("Beste allen,") == nil)
        #expect(ProposalText.greetedName("Beste Ilse") == "Ilse")
    }

    @Test func failureNeverClaimsNothingWentWhenItMayHave() {
        let f = ProposalText.failure("Gmail weigerde het bericht met een tijdelijke fout (421).")
        #expect(f.title == SendCopy.failedNothingSent)
        #expect(f.detail == "Gmail weigerde het bericht met een tijdelijke fout.")
        let unsure = ProposalText.failure("meerdere kandidaten in Verzonden")
        #expect(unsure.title == SendCopy.failed)
        #expect(unsure.detail == "Meerdere kandidaten in Verzonden.")
        #expect(ProposalText.failure(nil).title == SendCopy.failed)
    }

    @Test func softBreaksOnlyAfterAtAndDots() {
        #expect(ProposalText.softBreaks("ilse@noordkust.example") == "ilse@\u{200B}noordkust.\u{200B}example")
        #expect(ProposalText.softBreaks("a.") == "a.")
        #expect(ProposalText.softBreaks("Loonstrook").contains("\u{200B}") == false)
    }

    @Test func threadNameDropsReplyPrefixes() {
        #expect(ProposalText.threadName("Re: RE: Loonstrook oktober") == "Loonstrook oktober")
        #expect(ProposalText.sentLine(subject: "Re: Loonstrook oktober") == "Staat in je logboek en in de draad Loonstrook oktober.")
        #expect(ProposalText.sentLine(subject: nil) == "Staat in je logboek.")
    }

    @Test func rejectReasonJoinsTheChoiceAndTheWords() {
        #expect(ProposalText.rejectReason(choice: nil, free: "  ") == nil)
        #expect(ProposalText.rejectReason(choice: "Ik regel het zelf", free: "") == "Ik regel het zelf")
        #expect(ProposalText.rejectReason(choice: nil, free: " al gebeld ") == "al gebeld")
        #expect(ProposalText.rejectReason(choice: "Toon past niet", free: "te formeel") == "Toon past niet. te formeel")
    }

    @Test func copyTextIsSubjectThenBody() {
        let d = ReplyDraft(to: [], cc: [], subject: "Re: X", body: "Beste Ilse,\n\nHier.\n", attachmentDocumentIds: [], entrySummary: "")
        #expect(ProposalText.copyText(d) == "Re: X\n\nBeste Ilse,\n\nHier.")
    }
}

struct DraftChangesTests {
    static let original = ReplyDraft(to: ["ilse@noordkust.example"], cc: [], subject: "Re: Loonstrook oktober",
                                      body: "Beste Ilse,\n\nHierbij ontvangt u mijn loonstrook.\n\nMet vriendelijke groet,\n",
                                      attachmentDocumentIds: ["a1"], entrySummary: "Loonstrook gestuurd.")

    @Test func unchangedIsEmpty() {
        let c = DraftChanges(original: Self.original, current: Self.original)
        #expect(c.isEmpty)
        #expect(c.summary == nil)
        #expect(c.lines.allSatisfy { if case .same = $0 { true } else { false } })
    }

    @Test func anAddedSentenceIsMarkedWhereItStands() {
        var cur = Self.original
        cur.body = "Beste Ilse,\n\nHierbij ontvangt u mijn loonstrook.\n\nExcuses dat het iets later is.\n\nMet vriendelijke groet,\n"
        let c = DraftChanges(original: Self.original, current: cur)
        #expect(c.addedCount == 1)
        #expect(c.removedCount == 0)
        #expect(c.lines[2] == .added("Excuses dat het iets later is."))
        #expect(c.summary == "1 zin toegevoegd")
    }

    @Test func everyKindOfChangeIsNamed() {
        var cur = Self.original
        cur.body = "Beste Ilse,\n\nMet vriendelijke groet,"
        cur.subject = "Re: Loonstrook"
        cur.cc = ["team@noordkust.example"]
        cur.attachmentDocumentIds = ["a2", "a3"]
        cur.entrySummary = "Anders."
        let c = DraftChanges(original: Self.original, current: cur)
        #expect(c.summary == "1 zin weggehaald · onderwerp gewijzigd · ontvangers gewijzigd · 2 bijlagen erbij · 1 bijlage weg · logboekregel gewijzigd")
    }

    /// Whitespace at a paragraph's end is not an edit.
    @Test func trailingWhitespaceIsNotAChange() {
        var cur = Self.original
        cur.body = "Beste Ilse,  \n\nHierbij ontvangt u mijn loonstrook.\n\n\nMet vriendelijke groet,"
        #expect(DraftChanges(original: Self.original, current: cur).isEmpty)
    }
}

struct SendHoldTests {
    let t0 = Date(timeIntervalSince1970: 1_000)

    /// Letting go before the hold is complete never completes it: nothing is sent.
    @Test func anEarlyReleaseNeverCompletes() {
        var h = SendHold()
        h.press(at: t0)
        #expect(h.isHolding)
        let r1 = h.complete(at: t0.addingTimeInterval(0.3))
        #expect(!r1)
        let r2 = h.release()
        #expect(r2 == false)
        #expect(!h.isHolding)
        // A late timer after the release cannot complete it either.
        let r3 = h.complete(at: t0.addingTimeInterval(1))
        #expect(!r3)
    }

    @Test func aFullHoldCompletesOnce() {
        var h = SendHold()
        h.press(at: t0)
        #expect(abs(h.progress(at: t0.addingTimeInterval(0.3)) - 0.5) < 0.001)
        let r4 = h.complete(at: t0.addingTimeInterval(SendHold.duration))
        #expect(r4)
        let r5 = h.complete(at: t0.addingTimeInterval(SendHold.duration + 0.1))
        #expect(!r5)
        let r6 = h.release()
        #expect(r6 == true)
    }

    @Test func aSecondPressDoesNotRestartTheClock() {
        var h = SendHold()
        h.press(at: t0)
        h.press(at: t0.addingTimeInterval(0.5))
        let r7 = h.complete(at: t0.addingTimeInterval(SendHold.duration))
        #expect(r7)
    }

    @Test func ticksFallInsideTheHold() {
        #expect(SendHold.ticks.allSatisfy { $0 > 0 && $0 < SendHold.duration })
        #expect(SendHold.ticks == SendHold.ticks.sorted())
    }
}

@MainActor
struct ProposalBarTests {
    func model(_ server: ProposalServer, auth: any DeviceOwnerAuthenticator = StubOwnerAuth(.success(()))) -> ProposalModel {
        let client = server.stub.client(store: InMemorySessionStore(ProposalModelTests.cookie))
        return ProposalModel(client: client, gate: ApprovalGate(authenticator: auth))
    }

    func loaded(status: String = "pending", error: String = "null") async -> ProposalModel {
        let m = model(ProposalServer(detail: ProposalFixture.reply(status: status, error: error)))
        await m.load(id: ProposalFixture.id)
        return m
    }

    /// Until the whole draft has been on screen, Versturen waits (F-49).
    @Test func readGateUntilTheDraftWasSeen() async {
        let m = await loaded()
        #expect(m.sendBar(offline: false, holding: false)?.button == .readDraft)
        m.markDraftSeen()
        let bar = m.sendBar(offline: false, holding: false)
        #expect(bar?.button == .hold(SendCopy.send))
        #expect(bar?.detail == SendCopy.hint)
        #expect(bar?.meta == "Naar demi@verdergroep.nl · 1 bijlage")
    }

    @Test func holdingSaysLettingGoStops() async {
        let m = await loaded()
        m.markDraftSeen()
        let bar = m.sendBar(offline: false, holding: true)
        #expect(bar?.button == .hold(SendCopy.keepHolding))
        #expect(bar?.detail == SendCopy.holding)
    }

    @Test func offlineDisablesVersturenWithItsReason() async {
        let m = await loaded()
        m.markDraftSeen()
        let bar = m.sendBar(offline: true, holding: false)
        #expect(bar?.button == .disabled(SendCopy.send))
        #expect(bar?.title == SendCopy.offline)
    }

    /// A cancelled Face ID says so, sends nothing, and a new hold clears it.
    @Test func cancelledFaceIDIsSaidAndCleared() async {
        let server = ProposalServer(detail: ProposalFixture.reply())
        let m = model(server, auth: StubOwnerAuth(.failure(.cancelled)))
        await m.load(id: ProposalFixture.id)
        m.markDraftSeen()
        #expect(await m.approve() == .cancelled)
        #expect(server.requests(to: "/approve").isEmpty)
        #expect(m.phase == .cancelled)
        #expect(m.sendBar(offline: false, holding: false)?.title == SendCopy.cancelled)
        m.holdStarted()
        #expect(m.phase == .idle)
    }

    @Test func anApprovalHereSaysFaceID() async {
        let server = ProposalServer(detail: ProposalFixture.reply())
        let m = model(server)
        await m.load(id: ProposalFixture.id)
        #expect(await m.approve() == .approved)
        #expect(m.approvedHere)
        #expect(m.successes == 1)
        server.serve(detail: ProposalFixture.reply(status: "sending"))
        await m.load(id: ProposalFixture.id)
        #expect(m.sendBar(offline: false, holding: false)?.title == SendCopy.approvedHere)
    }

    @Test func approvedElsewhereDoesNotClaimFaceID() async {
        let m = await loaded(status: "approved")
        #expect(m.sendBar(offline: false, holding: false)?.title == SendCopy.approved)
        #expect(m.sendBar(offline: false, holding: false)?.button == .disabled(SendCopy.sending))
    }

    @Test func settledStatesOfferTheWayBack() async {
        let sent = await loaded(status: "sent")
        #expect(sent.sendBar(offline: false, holding: false)?.title == "Verstuurd aan Demi")
        #expect(sent.sendBar(offline: false, holding: false)?.button == .back)
        let failed = await loaded(status: "failed", error: #""Gmail weigerde het bericht (400).""#)
        #expect(failed.sendBar(offline: false, holding: false)?.title == SendCopy.failedNothingSent)
        #expect(failed.sendBar(offline: false, holding: false)?.detail == "Gmail weigerde het bericht.")
        // "Opnieuw versturen" is not built: the bar still leads somewhere.
        #expect(failed.sendBar(offline: false, holding: false)?.button == .back)
    }

    /// A claimed send Gmail never answered is said to be UNKNOWN, from the
    /// server's `sendingAt` — never guessed from the phone's own wait.
    @Test func anUnansweredSendIsUnknownNotSending() async {
        func with(_ extra: String) -> Data {
            let raw = String(decoding: ProposalFixture.reply(status: "sending"), as: UTF8.self)
            return Data(raw.replacingOccurrences(of: #""revision":"#, with: extra + #","revision":"#).utf8)
        }
        let claimed = Self.date("2026-10-30T08:22:00Z")
        let m = model(ProposalServer(detail: with(#""sendingAt":"2026-10-30T08:22:00.000Z""#)))
        await m.load(id: ProposalFixture.id)
        let early = m.sendBar(offline: false, holding: false, now: claimed.addingTimeInterval(60))
        #expect(early?.spinning == true)
        #expect(!m.outcomeUnknown(now: claimed.addingTimeInterval(ProposalModel.unknownAfter - 1)))
        let late = claimed.addingTimeInterval(ProposalModel.unknownAfter)
        #expect(m.outcomeUnknown(now: late))
        let bar = m.sendBar(offline: false, holding: false, now: late)
        #expect(bar?.icon == "clock")
        #expect(bar?.title == "Nog onbekend of het is aangekomen.")
        // Checking in Verzonden began when recovery did: claim + 10 minutes.
        #expect(bar?.stamp == "Controle sinds 09:32")
        #expect(bar?.extrasOnlyInSection == true)
        #expect(bar?.button == .disabled("Opnieuw versturen kan nog niet"))
        // Without the server's claim time, a send in flight is just in flight.
        let old = await loaded(status: "sending")
        #expect(!old.outcomeUnknown(now: late.addingTimeInterval(3600)))
    }

    static func date(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }

    /// A newer server's draft version and send time reach the screen; an
    /// older one's absence names no version and no time.
    @Test func versionAndSentTimeComeFromTheServer() async {
        func with(_ status: String, _ extra: String) -> Data {
            let raw = String(decoding: ProposalFixture.reply(status: status), as: UTF8.self)
            return Data(raw.replacingOccurrences(of: #""revision":"#, with: extra + #","revision":"#).utf8)
        }
        let sent = model(ProposalServer(detail: with("sent", #""draftVersion":2,"sentAt":"2026-10-30T09:31:00.000Z""#)))
        await sent.load(id: ProposalFixture.id)
        #expect(sent.sendBar(offline: false, holding: false)?.stamp == "10:31")
        let pending = model(ProposalServer(detail: with("pending", #""draftVersion":2"#)))
        await pending.load(id: ProposalFixture.id)
        #expect(pending.conceptLabel == "Concept · Versie 2")
        let drafting = model(ProposalServer(detail: with("drafting", #""draftVersion":1"#)))
        await drafting.load(id: ProposalFixture.id)
        #expect(drafting.isRedraft)
        let old = await loaded(status: "sent")
        #expect(old.sendBar(offline: false, holding: false)?.stamp == nil)
        #expect(old.conceptLabel == "Verstuurd bericht")
        let first = await loaded(status: "drafting")
        #expect(!first.isRedraft)
    }

    /// The editor's Klaar keeps only what the server offered.
    @Test func replaceDraftKeepsOnlyOfferedAttachments() async {
        let m = await loaded()
        var d = m.draft!
        d.body = "Nieuw."
        d.attachmentDocumentIds = ["a1", "a3", "zz-not-offered"]
        d.entrySummary = String(repeating: "x", count: 140)
        m.replaceDraft(d)
        #expect(m.draft?.body == "Nieuw.")
        #expect(m.draft?.attachmentDocumentIds == ["a1", "a3"])
        #expect(m.draft?.entrySummary.count == 100)
        #expect(m.isEdited)
    }

    @Test func aRejectionIsSoftNotAnError() async {
        let m = await loaded()
        #expect(await m.reject(reason: "Ik regel het zelf"))
        #expect(m.softs == 1)
        #expect(m.errors == 0)
    }
}
