import Foundation
import Observation

/// The call in progress, owned ABOVE the lock gate and the tabs (like
/// `VoiceLogSession`), so a relock, a tab switch or the Phone app taking the
/// screen never loses the ticks. One call at a time.
///
/// THE FLOW: Dossier, a Voor jou item or a proposal opens the sheet for a
/// party → "Bel" starts the Live Activity and hands the number to the Phone
/// app (`tel:`; the call itself is the Phone app's) → Martin ticks points,
/// and each tick updates the Live Activity → `CXCallObserver` reports the
/// call ended → the Live Activity ends, the sheet comes back with "Gesprek
/// vastleggen", and that opens the voice quick-log with "Besproken: …" and
/// the party preselected. Nothing here writes the dossier: the voice log
/// still sends a SUGGESTION that Martin approves in Voor jou.
///
/// "ACTIVE" — when a call's end means something: a call sheet is prepared
/// AND either showing or mirrored by its Live Activity. A call that ends
/// while Martin is just reading Dossier offers nothing. CallKit cannot say
/// WHICH call it was (only that one ended), so the rule is about the sheet,
/// never about the number.
@MainActor
@Observable
final class CallSession {
    private(set) var model: CallPrepModel?
    private(set) var isPresented = false
    /// The call ended while this sheet was active: offer "Gesprek vastleggen".
    private(set) var callEnded = false
    private(set) var notice: String?
    /// Dossier's "Bellen" card.
    private(set) var parties: [PartyDTO] = []
    private(set) var partiesFailed = false

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let cache: CallCache
    @ObservationIgnored private let activities: any CallActivityControlling
    @ObservationIgnored private let now: @MainActor () -> Date
    @ObservationIgnored private let dial: @MainActor (URL) -> Void
    @ObservationIgnored private let openVoice: @MainActor (VoicePrefill) -> Void
    @ObservationIgnored private let onUnauthorized: @MainActor () -> Void
    @ObservationIgnored private let epoch: SessionEpoch
    @ObservationIgnored private let observer: any CallObserving
    /// When the call this sheet is following started (CallKit's first word on it).
    @ObservationIgnored private var callStartedAt: Date?
    @ObservationIgnored private var callEndedAt: Date?
    /// Calls already reported ended: CallKit may say so more than once.
    @ObservationIgnored private var endedCalls: Set<UUID> = []
    @ObservationIgnored private var startedCalls: [UUID: Date] = [:]
    /// When "Bel" handed the number to the Phone app, until that call's end
    /// is taken. Lets `reconcile` end a call whose `.started` never arrived.
    @ObservationIgnored private var dialledAt: Date?
    /// verder went to the BACKGROUND since that dial — the Phone app took the
    /// screen. The "Bel …?" prompt iOS shows first only makes the scene
    /// inactive, so a cancelled prompt never reads as a finished call.
    @ObservationIgnored private var leftAfterDial = false
    /// Until when a `.started` for a call never seen is the late echo of a
    /// call the DIAL PATH already ended (`reconcile`), not a new call. A
    /// suspended app's queued CallKit callbacks are delivered on resume, and
    /// their order against `scenePhase == .active` is unmeasured; the dial
    /// path ends a call it never had an id for, so without this its late
    /// `.started`/`.ended` pair ended it a second time — bringing back an
    /// offer Martin dismissed — and a late `.started` alone sat in
    /// `startedCalls` until the next `reconcile` ended whatever sheet was
    /// active then (review, 2026-11-03).
    @ObservationIgnored private var lateEchoUntil: Date?
    /// Queued callbacks land within moments of resuming; a minute is slack,
    /// and short enough that a genuinely new call counts. It outlives
    /// "Gesprek vastleggen" and opening another party on purpose (an echo
    /// arriving then would otherwise sit stale in `startedCalls`); only a new
    /// "Bel" — a call verder itself just started — closes it early.
    static let lateEchoWindow: TimeInterval = 60
    /// Waiting for the call sheet to finish dismissing (`sheetDismissed`).
    @ObservationIgnored private var pendingVoice: VoicePrefill?
    /// The last active sheet's ticks, for a call recording imported within
    /// the hour (`RecentCallSheet`, Added 2026-11-03).
    @ObservationIgnored let recent: RecentCallSheet

    init(client: APIClient, cache: CallCache, activities: any CallActivityControlling,
         observer: any CallObserving, epoch: SessionEpoch,
         now: @escaping @MainActor () -> Date = { Date() },
         dial: @escaping @MainActor (URL) -> Void,
         openVoice: @escaping @MainActor (VoicePrefill) -> Void,
         recent: RecentCallSheet = RecentCallSheet(),
         onUnauthorized: @escaping @MainActor () -> Void = {}) {
        self.recent = recent
        self.client = client
        self.cache = cache
        self.activities = activities
        self.now = now
        self.dial = dial
        self.openVoice = openVoice
        self.onUnauthorized = onUnauthorized
        self.epoch = epoch
        self.observer = observer
        observer.observe { [weak self] event in self?.handle(event) }
        epoch.whenEnded { [weak self] in self?.forget() }
    }

    var isActive: Bool { model != nil && (isPresented || activities.isRunning) }
    /// The controller's state, mirrored so the sheet redraws when it changes.
    private(set) var activityRunning = false

    // MARK: - Opening

    /// The sheet for this party. The same party keeps its call (and its
    /// ticks); another party ends the running Live Activity first.
    func open(partyId: String, name: String?) async {
        if model?.partyId != partyId {
            endActivity()
            callEnded = false
            notice = nil
            callStartedAt = nil
            callEndedAt = nil
            forgetDial()
            let m = CallPrepModel(partyId: partyId, name: name, client: client, cache: cache, epoch: epoch, now: now,
                                  onUnauthorized: onUnauthorized)
            m.onChecklistChanged = { [weak self, weak m] in
                guard let self, let m, self.model === m else { return }
                self.activities.update(m.checklist.activityState)
                self.noteActive()
            }
            model = m
        }
        isPresented = true
        noteActive()
        let started = epoch.current
        await model?.load()
        guard epoch.isCurrent(started) else { return }
    }

    /// The Live Activity's tap (`verder://call`): the call in progress, if any.
    func reopen() {
        if model != nil { isPresented = true }
    }

    /// "Sluiten": the sheet goes. A running Live Activity keeps the call
    /// active — Martin may be on the phone, reading the Phone app.
    func close() {
        noteActive()
        isPresented = false
    }

    func presentationChanged(_ presented: Bool) {
        if presented { reopen() } else { close() }
    }

    /// The call is over and nothing is to be logged ("Niet nu", "Stoppen").
    func finish() {
        noteActive()
        endActivity()
        forgetDial()
        model = nil
        callEnded = false
        isPresented = false
    }

    // MARK: - During the call

    func toggle(_ id: String) {
        model?.toggle(id)
    }

    /// "Bel": the Live Activity first (the app is about to leave the screen),
    /// then the number to the Phone app. No number, no dialler.
    func bel() {
        guard let model, let url = model.dialURL else { return }
        startActivity()
        dialledAt = now()
        leftAfterDial = false
        lateEchoUntil = nil
        dial(url)
    }

    /// "Toon tijdens het gesprek": the Live Activity without dialling.
    func startActivity() {
        guard let model else { return }
        if activities.isRunning { activities.update(model.checklist.activityState); return }
        notice = activities.start(model.checklist.activityState) ? nil : CallCopy.activitiesOff
        activityRunning = activities.isRunning
    }

    func endActivity() {
        activities.end()
        activityRunning = false
    }

    // MARK: - CallKit

    func handle(_ event: CallEvent) {
        switch event {
        case .started(let id):
            // Already ended (a late `.started` after its `.ended`, or a call
            // the dial path spent): never a call to follow again.
            guard !endedCalls.contains(id) else { return }
            if startedCalls[id] == nil, let until = lateEchoUntil, now() <= until {
                endedCalls.insert(id)
                return
            }
            if startedCalls[id] == nil { startedCalls[id] = now() }
            if isActive, callStartedAt == nil { callStartedAt = startedCalls[id] }
        case .ended(let id):
            guard !endedCalls.contains(id) else { return }
            endedCalls.insert(id)
            let startedAt = startedCalls.removeValue(forKey: id)
            guard isActive else { return }
            if callStartedAt == nil { callStartedAt = startedAt }
            endCall()
        }
    }

    /// The followed call is over: the Live Activity goes, the sheet comes
    /// back offering "Gesprek vastleggen", and the dial is spent.
    private func endCall() {
        callEndedAt = now()
        endActivity()
        callEnded = true
        isPresented = true
        forgetDial()
        noteActive()
    }

    /// While the sheet is active, `recent` holds its party and ticks: the
    /// voice log reads them when a recording of this call is imported.
    private func noteActive() {
        guard let model, isActive || callEnded else { return }
        recent.record(partyId: model.partyId, text: model.checklist.prefillText,
                      startedAt: callStartedAt, at: now())
    }

    private func forgetDial() {
        dialledAt = nil
        leftAfterDial = false
    }

    /// The app is back in the foreground (RootView's `scenePhase == .active`).
    ///
    /// "Bel" hands the call to the Phone app, and iOS suspends verder for the
    /// whole call — so the delegate's `.ended` may arrive late, coalesced, or
    /// not at all. Waiting for it would leave the Live Activity on the lock
    /// screen for hours, keep the sheet "active", and let some LATER call's
    /// end be taken for this one. So the session asks CallKit what is live
    /// NOW (`CXCallObserver.calls`) and ends every call it saw start that is
    /// gone or listed as ended — through `handle`, so it is the same end.
    ///
    /// A call it never saw start counts too, when THIS sheet dialled it: once
    /// verder is suspended the `.started` can be lost exactly like the
    /// `.ended` (what CallKit delivers to a suspended app is unmeasured), so
    /// "dialled, went to the background, and nothing is live now" is a call
    /// that is over, started at the dial (review, 2026-11-03).
    ///
    /// Not a Live Activity started by hand ("Toon tijdens het gesprek") with no
    /// call seen: switching apps does not end that. And not a cancelled
    /// "Bel …?" prompt: that never takes verder to the background.
    ///
    /// A return that comes WITHOUT a background since the dial, and with no
    /// call live, is the cancelled prompt: it spends the dial there and then.
    /// Kept armed, the dial waited for any later background (locking the
    /// phone, another app) and the return after THAT ended a call that never
    /// took place (review, 2026-11-03). With a call live it is not a cancel —
    /// the in-call UI may only have made verder inactive — so the dial stays.
    func reconcile() {
        let live = observer.currentCalls()
        for id in Array(startedCalls.keys) where live[id] != false {
            handle(.ended(id))
        }
        guard let dialledAt else { return }
        let callLive = live.values.contains(false)
        if !leftAfterDial {
            if !callLive { forgetDial() }
            return
        }
        guard isActive, !callLive else { return }
        if callStartedAt == nil { callStartedAt = dialledAt }
        endCall()
        // The dial path never had this call's id. Whatever CallKit still
        // lists is that call; what it does not list yet may still arrive.
        for id in live.keys {
            endedCalls.insert(id)
            startedCalls.removeValue(forKey: id)
        }
        lateEchoUntil = now().addingTimeInterval(Self.lateEchoWindow)
    }

    /// RootView's `scenePhase == .background`: the Phone app has the screen.
    func sceneEnteredBackground() {
        if dialledAt != nil { leftAfterDial = true }
    }

    /// "Niet nu" on the ended banner: the sheet stays, the offer goes.
    func dismissEnded() {
        callEnded = false
    }

    /// "Gesprek vastleggen": the call sheet goes, and the voice log opens once
    /// it has (`sheetDismissed`) — two sheets cannot swap in one frame.
    func logCall() {
        guard let model else { return }
        pendingVoice = VoicePrefill(partyId: model.partyId, text: model.checklist.prefillText,
                                    occurredAt: callStartedAt ?? callEndedAt ?? now())
        finish()
    }

    /// The sheet's `onDismiss`.
    func sheetDismissed() {
        guard let prefill = pendingVoice else { return }
        pendingVoice = nil
        openVoice(prefill)
    }

    // MARK: - Dossier's party list

    func loadParties() async {
        if parties.isEmpty, let cached = cache.loadParties() { parties = cached }
        let started = epoch.current
        do {
            let rows: [PartyDTO] = try await client.getJSON("/api/mobile/v1/parties?recent=1")
            guard epoch.isCurrent(started) else { return }
            parties = rows
            partiesFailed = false
            try? cache.saveParties(rows)
        } catch {
            guard epoch.isCurrent(started), !APIError.isCancellation(error) else { return }
            if (error as? APIError) == .unauthorized { onUnauthorized(); return }
            partiesFailed = parties.isEmpty
        }
    }

    // MARK: - The session ended

    private func forget() {
        endActivity()
        forgetDial()
        lateEchoUntil = nil
        model = nil
        isPresented = false
        callEnded = false
        pendingVoice = nil
        parties = []
        recent.forget()
        cache.wipe()
    }
}
