import Foundation

/// The call sheet that was last ACTIVE, remembered for an hour (Added
/// 2026-11-03), so a call RECORDING imported afterwards — shared from Notes,
/// where the Phone app's own "Gesprek opnemen" saves it — starts from the
/// points Martin ticked during that call, with that party preselected.
///
/// Why a time window and not "the same call": iOS never tells an app WHICH
/// call a recording is of (`CXCallObserver` only says that a call started or
/// ended), and a recording carries no party. A sheet active within the last
/// hour is the honest best guess; the voice log shows the prefill, the
/// party and the time, and Martin edits any of them before sending a
/// SUGGESTION. Memory only: case content never lands on disk here, and a
/// sign-out forgets it (`CallSession`).
@MainActor
final class RecentCallSheet {
    static let window: TimeInterval = 3600

    private struct Sheet {
        let partyId: String
        let text: String
        let startedAt: Date?
        let activeAt: Date
    }

    private var last: Sheet?

    func record(partyId: String, text: String, startedAt: Date?, at: Date) {
        last = Sheet(partyId: partyId, text: text, startedAt: startedAt, activeAt: at)
    }

    /// The party, its ticked points ("Besproken: …", empty when none were
    /// ticked) and the call's start when known; nil past the hour.
    func prefill(now: Date) -> VoicePrefill? {
        guard let last, now.timeIntervalSince(last.activeAt) <= Self.window else { return nil }
        return VoicePrefill(partyId: last.partyId, text: last.text, occurredAt: last.startedAt)
    }

    func forget() {
        last = nil
    }
}
