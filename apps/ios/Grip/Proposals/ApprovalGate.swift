import Foundation

/// The second door in front of a SEND (spec §6.5: "behind Face ID").
///
/// IT ALWAYS ASKS. The app lock's five-minute grace answers "may this phone
/// show the dossier?"; it is not an approval of an outbound mail, so a send
/// never rides on it. `PlatformOwnerAuthenticator` makes a FRESH `LAContext`
/// for every call, and a fresh context's `touchIDAuthenticationAllowableReuseDuration`
/// is 0, so the system cannot reuse the unlock either. The reason names the
/// recipients, because the sheet is the last thing Martin reads before verder
/// sends for him.
///
/// The server cannot see this gate (Plan 2, "Not grounded in code"): it relies
/// on the session and the revision. The gate exists so a picked-up, unlocked
/// phone cannot send in Martin's name with one tap.
struct ApprovalGate: Sendable {
    let authenticator: any DeviceOwnerAuthenticator

    init(authenticator: any DeviceOwnerAuthenticator = PlatformOwnerAuthenticator()) {
        self.authenticator = authenticator
    }

    static func reason(to: [String]) -> String {
        "Versturen aan \(to.joined(separator: ", "))"
    }

    /// True only when the owner was proven just now. A cancel, a failure and a
    /// phone without a passcode are all "no".
    func confirmSend(to: [String]) async -> Bool {
        do {
            try await authenticator.authenticate(reason: Self.reason(to: to))
            return true
        } catch {
            return false
        }
    }
}
