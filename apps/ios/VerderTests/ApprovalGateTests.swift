import Testing
import Foundation
@testable import Verder

@MainActor
struct ApprovalGateTests {
    final class Clock: @unchecked Sendable { var now: Date; init(_ d: Date) { now = d } }

    /// THE APP LOCK'S GRACE IS NOT A SEND APPROVAL. Unlocked a minute ago,
    /// backgrounded and back well inside the five minutes: the app stays
    /// open, and "Versturen" still asks Face ID — every time.
    @Test func gateAsksEvenInsideGrace() async {
        let clock = Clock(Date(timeIntervalSince1970: 1_800_000_000))
        let auth = StubOwnerAuth(.success(()))
        let lock = AppLock(authenticator: auth, now: { clock.now })
        await lock.unlock()
        #expect(!lock.isLocked)
        lock.sceneDidEnterBackground()
        clock.now = clock.now.addingTimeInterval(30)
        lock.sceneDidBecomeActive()
        #expect(!lock.isLocked, "inside the grace the app stays unlocked")

        let gate = ApprovalGate(authenticator: auth)
        #expect(await gate.confirmSend(to: ["demi@verdergroep.nl"]))
        #expect(await gate.confirmSend(to: ["demi@verdergroep.nl"]))
        #expect(auth.calls == 3, "one unlock plus one Face ID per send")
    }

    @Test func gateReasonNamesTheRecipients() async {
        let auth = RecordingOwnerAuth()
        let gate = ApprovalGate(authenticator: auth)
        _ = await gate.confirmSend(to: ["demi@verdergroep.nl", "opstart@verdergroep.nl"])
        #expect(auth.reasons == ["Versturen aan demi@verdergroep.nl, opstart@verdergroep.nl"])
    }

    @Test(arguments: [DeviceOwnerAuthError.cancelled, .failed, .unavailable])
    func anyFailureIsNo(_ error: DeviceOwnerAuthError) async {
        let gate = ApprovalGate(authenticator: StubOwnerAuth(.failure(error)))
        #expect(await gate.confirmSend(to: ["demi@verdergroep.nl"]) == false)
    }
}

final class RecordingOwnerAuth: DeviceOwnerAuthenticator, @unchecked Sendable {
    private let lock = NSLock()
    private var _reasons: [String] = []
    var reasons: [String] { lock.withLock { _reasons } }
    func authenticate(reason: String) async throws(DeviceOwnerAuthError) {
        lock.withLock { _reasons.append(reason) }
    }
}
