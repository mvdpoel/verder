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

    init(factory: VoiceLogFactory) {
        self.factory = factory
    }

    /// Meer's entry or the quick action: the log in progress, else a new one.
    func open() {
        if model == nil { model = factory.make() }
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
    @discardableResult
    func sheetDisappeared() -> Task<Void, Never>? {
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
            let stopping = sheetDisappeared()
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
