import Testing
import Foundation
@testable import Verder

struct LockPolicyTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    @Test("cold launch locks") func coldLaunchLocks() {
        #expect(LockPolicy.shouldLock(backgroundedAt: nil, now: t0))
    }

    @Test("299 s does not lock") func justUnderGraceDoesNotLock() {
        #expect(!LockPolicy.shouldLock(backgroundedAt: t0, now: t0.addingTimeInterval(299)))
    }

    @Test("301 s locks") func justOverGraceLocks() {
        #expect(LockPolicy.shouldLock(backgroundedAt: t0, now: t0.addingTimeInterval(301)))
    }

    /// The rule is "MORE than five minutes": the boundary itself stays open.
    @Test("exactly 300 s does not lock") func exactlyGraceDoesNotLock() {
        #expect(LockPolicy.graceSeconds == 300)
        #expect(!LockPolicy.shouldLock(backgroundedAt: t0, now: t0.addingTimeInterval(300)))
    }

    /// A clock that moved backwards while the app was away cannot be trusted
    /// to say how long it was away. Fail closed.
    @Test("clock moved back locks") func clockMovedBackLocks() {
        #expect(LockPolicy.shouldLock(backgroundedAt: t0, now: t0.addingTimeInterval(-1)))
    }
}

/// Answers the Face ID prompt the way the test says, and counts the asks.
final class StubOwnerAuth: DeviceOwnerAuthenticator, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls = 0
    let outcome: Result<Void, DeviceOwnerAuthError>

    init(_ outcome: Result<Void, DeviceOwnerAuthError>) { self.outcome = outcome }

    var calls: Int { lock.withLock { _calls } }

    func authenticate(reason: String) async throws(DeviceOwnerAuthError) {
        lock.withLock { _calls += 1 }
        try outcome.get()
    }
}

@MainActor
struct AppLockTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    final class Clock: @unchecked Sendable { var now: Date; init(_ d: Date) { now = d } }

    func make(_ outcome: Result<Void, DeviceOwnerAuthError> = .success(()), clock: Clock) -> (AppLock, StubOwnerAuth) {
        let auth = StubOwnerAuth(outcome)
        return (AppLock(authenticator: auth, now: { clock.now }), auth)
    }

    @Test func startsLockedOnColdLaunch() {
        let (lock, _) = make(clock: Clock(t0))
        #expect(lock.isLocked)
    }

    @Test func unlockSucceedsAndClearsTheLock() async {
        let (lock, auth) = make(clock: Clock(t0))
        await lock.unlock()
        #expect(!lock.isLocked)
        #expect(auth.calls == 1)
        #expect(lock.message == nil)
    }

    /// Martin closed the sheet: still locked, and nothing to say about it.
    @Test func cancelledStaysLockedWithoutMessage() async {
        let (lock, _) = make(.failure(.cancelled), clock: Clock(t0))
        await lock.unlock()
        #expect(lock.isLocked)
        #expect(lock.message == nil)
    }

    /// A phone with no passcode cannot prove its owner. Fail closed, and say
    /// what would fix it rather than silently opening the dossier.
    @Test func noPasscodeStaysLockedAndSaysWhy() async {
        let (lock, _) = make(.failure(.unavailable), clock: Clock(t0))
        await lock.unlock()
        #expect(lock.isLocked)
        #expect(lock.message == AppLock.Copy.unavailable)
    }

    @Test func failedStaysLockedWithMessage() async {
        let (lock, _) = make(.failure(.failed), clock: Clock(t0))
        await lock.unlock()
        #expect(lock.isLocked)
        #expect(lock.message == AppLock.Copy.failed)
    }

    @Test func backgroundUnderGraceStaysOpen() async {
        let clock = Clock(t0)
        let (lock, _) = make(clock: clock)
        await lock.unlock()
        lock.sceneDidEnterBackground()
        clock.now = t0.addingTimeInterval(299)
        lock.sceneDidBecomeActive()
        #expect(!lock.isLocked)
    }

    @Test func backgroundOverGraceLocks() async {
        let clock = Clock(t0)
        let (lock, _) = make(clock: clock)
        await lock.unlock()
        lock.sceneDidEnterBackground()
        clock.now = t0.addingTimeInterval(301)
        lock.sceneDidBecomeActive()
        #expect(lock.isLocked)
    }

    /// The Face ID sheet itself (and Control Center, a call banner) only makes
    /// the scene INACTIVE. Coming back from that must not re-lock or re-judge,
    /// or unlocking would trigger its own lock.
    @Test func activeWithoutBackgroundDoesNotRelock() async {
        let clock = Clock(t0)
        let (lock, _) = make(clock: clock)
        await lock.unlock()
        clock.now = t0.addingTimeInterval(10_000)
        lock.sceneDidBecomeActive()
        #expect(!lock.isLocked)
    }

    /// The grace is measured from the LAST time the app left, not the first:
    /// two short trips must not add up to one long one.
    @Test func graceIsJudgedOncePerTrip() async {
        let clock = Clock(t0)
        let (lock, _) = make(clock: clock)
        await lock.unlock()
        lock.sceneDidEnterBackground()
        clock.now = t0.addingTimeInterval(200)
        lock.sceneDidBecomeActive()
        clock.now = t0.addingTimeInterval(250)
        lock.sceneDidEnterBackground()
        clock.now = t0.addingTimeInterval(450)
        lock.sceneDidBecomeActive()
        #expect(!lock.isLocked)
    }

    /// Signing in IS proving who holds the phone; asking for Face ID straight
    /// after would be a second gate on the same door.
    @Test func signInCountsAsUnlock() {
        let (lock, auth) = make(clock: Clock(t0))
        lock.didSignIn()
        #expect(!lock.isLocked)
        #expect(auth.calls == 0)
    }

    /// Step 3's exception: capture is open while locked; the dossier is not.
    @Test func captureIsOpenWhileLockedDossierIsNot() async {
        let (lock, _) = make(clock: Clock(t0))
        #expect(!lock.isGated(.capture))
        #expect(lock.isGated(.dossier))
        await lock.unlock()
        #expect(!lock.isGated(.capture))
        #expect(!lock.isGated(.dossier))
    }

    /// Two taps (or the auto-prompt racing a tap) ask once.
    @Test func concurrentUnlocksAskOnce() async {
        let (lock, auth) = make(clock: Clock(t0))
        async let a: Void = lock.unlock()
        async let b: Void = lock.unlock()
        _ = await (a, b)
        #expect(auth.calls == 1)
        #expect(!lock.isLocked)
    }

    /// Cancelling the sheet bounces the scene inactive → active; the lock
    /// screen must not answer that by opening the sheet again.
    @Test func autoPromptOncePerLock() async {
        let clock = Clock(t0)
        let auth = StubOwnerAuth(.failure(.cancelled))
        let lock = AppLock(authenticator: auth, now: { clock.now })
        await lock.autoPromptIfNeeded()
        await lock.autoPromptIfNeeded()
        #expect(auth.calls == 1)
        #expect(lock.isLocked)
        await lock.unlock() // the button still asks
        #expect(auth.calls == 2)
    }

    @Test func autoPromptRearmsWhenTheAppLocksAgain() async {
        let clock = Clock(t0)
        let (lock, auth) = make(clock: clock)
        await lock.autoPromptIfNeeded()
        #expect(!lock.isLocked)
        lock.sceneDidEnterBackground()
        clock.now = t0.addingTimeInterval(301)
        lock.sceneDidBecomeActive()
        await lock.autoPromptIfNeeded()
        #expect(auth.calls == 2)
    }
}
