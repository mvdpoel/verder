import Foundation

/// When a call recording shared from any app (an audio `IncomingDrop`, Added
/// 2026-11-03) may open the voice log in "opname uitschrijven" mode. RootView
/// asks on launch, on every return to the foreground, AND when the call sheet
/// goes — the last one is the case the import is built for: after a call the
/// sheet comes back ("Niet nu" keeps it up), Martin shares the recording from
/// the app that holds it and returns to Grip with the call sheet still showing. Two sheets
/// cannot show at once, so it waits; without the third moment it waited until
/// he left the app and came back (review finding, 2026-11-03).
@MainActor
enum SharedRecordingGate {
    /// Only with a session (the log sends to the server) and never over the
    /// call sheet. Returns the write-out, or nil when nothing opened.
    @discardableResult
    static func open(signedIn: Bool, call: CallSession, voice: VoiceLogSession) -> Task<Void, Never>? {
        guard signedIn, !call.isPresented else { return nil }
        return voice.openPendingRecording()
    }

    /// The call sheet's `onDismiss`. "Gesprek vastleggen" hands the call's
    /// points to the voice log first; that hand-off wins and the recording
    /// waits for the next moment.
    @discardableResult
    static func callSheetDismissed(signedIn: Bool, call: CallSession, voice: VoiceLogSession) -> Task<Void, Never>? {
        if call.sheetDismissed() { return nil }
        return open(signedIn: signedIn, call: call, voice: voice)
    }
}
