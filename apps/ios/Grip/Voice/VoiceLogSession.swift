import Foundation
import Observation

/// Owns the open voice log, ABOVE the lock gate and the sign-in screen.
///
/// The voice sheet's copy promises "je tekst blijft staan" after a 401, an
/// offline send and a server failure. The sheet itself cannot keep that
/// promise: it hangs off the tabs, which the sign-in screen replaces on a 401,
/// and its content is replaced by the lock screen on a relock — either way the
/// view goes, and anything it held went with it. So the model lives here, made
/// by `RootView`'s owner, and the rule is:
///
/// - ONLY an explicit close (`close()`: Sluiten, Klaar, or a swipe on a log
///   holding nothing) discards — the recording is deleted, the next opening is
///   a fresh log with a new clientId.
/// - A sheet that goes away by itself (sign-in, relock, a swipe on the lock
///   screen) keeps the text and the recording in memory. Opening "Gesprek
///   vastleggen" again, or signing in again, brings the same log back.
///
/// Nothing here is written to disk beyond the recording the model already
/// keeps in its temporary folder, which the next fresh log empties.
@MainActor
@Observable
final class VoiceLogSession {
    private(set) var model: VoiceLogModel?
    private(set) var isPresented = false

    /// Also what the DEBUG fixture screen makes its own log with.
    @ObservationIgnored let factory: VoiceLogFactory
    /// The App Group, where the share extension leaves call recordings
    /// (audio `IncomingDrop`s). Nil where there is none (a fixture run).
    @ObservationIgnored let groupDir: URL?

    init(factory: VoiceLogFactory, groupDir: URL? = nil) {
        self.factory = factory
        self.groupDir = groupDir
    }

    // MARK: - A call recording shared from any app (Added 2026-11-03)

    /// On launch and every return to the foreground (RootView): the oldest
    /// recording the share extension left opens the voice log in "opname
    /// uitschrijven" mode. Returns the write-out, or nil when nothing opened
    /// — nothing waiting, this drop already open, or another log holding
    /// work (the drop then waits for the next time; work is never replaced).
    @discardableResult
    func openPendingRecording() -> Task<Void, Never>? {
        guard let groupDir, let drop = IncomingDrop.pendingAudio(groupDir: groupDir).first else { return nil }
        return openImport(.drop(drop, groupDir: groupDir))
    }

    @discardableResult
    func openImport(_ source: RecordingImport) -> Task<Void, Never>? {
        if let model {
            if source.drop != nil, model.importedDrop == source.drop { return nil }
            switch model.phase {
            case .idle where !model.holdsUnsentWork && !model.hasRecording, .sent:
                close()
            default:
                return nil
            }
        }
        let fresh = factory.make()
        model = fresh
        isPresented = true
        return Task { await fresh.importRecording(source) }
    }

    /// Meer's entry or the quick action: the log in progress, else a new one.
    func open() {
        if model == nil { model = factory.make() }
        isPresented = true
    }

    /// "Gesprek vastleggen" after a call: the log in progress if there is one
    /// (its work is never overwritten — `VoiceLogModel.apply` refuses), else a
    /// new one starting from the call's ticked points.
    func open(prefill: VoicePrefill) {
        if model == nil { model = factory.make() }
        model?.apply(prefill)
        isPresented = true
    }

    /// Martin closed it: throw away whatever was not sent.
    func close() {
        model?.discard()
        model = nil
        isPresented = false
    }

    /// The sheet's binding was set. `false` arrives both from a swipe and from
    /// SwiftUI tearing the sheet down; only a log with nothing in it is closed,
    /// because a swipe on the log itself is disabled while it holds work
    /// (`holdsUnsentWork`) — so a `false` over held work was never Martin
    /// throwing it away.
    func presentationChanged(_ presented: Bool) {
        if presented { open(); return }
        if model?.holdsUnsentWork == true {
            isPresented = false
        } else {
            close()
        }
    }

    /// The sheet's content went (lock screen, sign-in, background). A
    /// recording cannot finish without its finger, so it is stopped and
    /// transcribed here — kept, never dropped.
    ///
    /// EXCEPT a hands-free recording (started with a tap): it needs no finger,
    /// so pulling the sheet down leaves it running, shown in the tab bar's
    /// accessory ("Opname loopt 0:14 Stop", frame "opname · blad omlaag").
    @discardableResult
    func sheetDisappeared() -> Task<Void, Never>? {
        guard let model, model.phase == .recording, !model.handsFree else { return nil }
        return Task { await model.stopRecording() }
    }

    /// A recording runs with the sheet down: the tab bar's accessory.
    var recordsInBackground: Bool {
        !isPresented && model?.phase == .recording
    }

    /// The accessory's "Stop": stop, transcribe, and bring the sheet back
    /// to show what was heard.
    @discardableResult
    func stopInBackground() -> Task<Void, Never>? {
        guard let model, model.phase == .recording else { return nil }
        isPresented = true
        return Task { await model.stopRecording() }
    }

    /// Stops whatever is recording, hands-free or not.
    private func stopRecording() -> Task<Void, Never>? {
        guard let model, model.phase == .recording else { return nil }
        return Task { await model.stopRecording() }
    }

    /// The session ended (a 401, or signed out). Unsent work waits in memory
    /// for the next sign-in; an empty log is simply closed, so no empty sheet
    /// pops up afterwards. Returns the stop-and-transcribe of a recording
    /// that was in progress, if there was one.
    @discardableResult
    func sessionEnded() -> Task<Void, Never>? {
        guard let model else { isPresented = false; return nil }
        if model.holdsUnsentWork || model.phase == .recording {
            // Signed out, nothing may keep listening: hands-free stops too.
            let stopping = stopRecording()
            isPresented = false
            return stopping
        } else {
            close()
            return nil
        }
    }

    /// Signed in again: the log that was waiting comes back.
    func sessionStarted() {
        if model != nil { isPresented = true }
    }
}
