import Foundation
import LocalAuthentication
import Observation

/// When the app asks for Face ID again: on a cold launch, and after MORE than
/// five minutes in the background (spec §6.2 — the whole dossier is in this
/// pocket). Pure, so the boundary is pinned by tests rather than by a phone.
enum LockPolicy {
    static let graceSeconds: TimeInterval = 300

    /// `backgroundedAt == nil` means the process never saw itself leave: a cold
    /// launch. A clock that moved BACKWARDS while the app was away cannot say how
    /// long it was away, so it locks too (fail closed).
    static func shouldLock(backgroundedAt: Date?, now: Date) -> Bool {
        guard let backgroundedAt else { return true }
        let away = now.timeIntervalSince(backgroundedAt)
        return away < 0 || away > graceSeconds
    }
}

/// Why proving the owner did not work, reduced to what the lock screen needs.
enum DeviceOwnerAuthError: Error, Equatable {
    /// Martin (or the system, e.g. the app left mid-prompt) closed the sheet.
    case cancelled
    /// This phone cannot prove its owner at all (no passcode set).
    case unavailable
    /// Face ID and the passcode both failed, or anything else.
    case failed
}

/// Face ID with the device passcode as fallback. A protocol so tests answer
/// for the sheet.
protocol DeviceOwnerAuthenticator: Sendable {
    func authenticate(reason: String) async throws(DeviceOwnerAuthError)
}

/// `LAPolicy.deviceOwnerAuthentication`, NOT `…WithBiometrics`: when Face ID
/// fails or is unavailable, the passcode still opens the app.
struct PlatformOwnerAuthenticator: DeviceOwnerAuthenticator {
    func authenticate(reason: String) async throws(DeviceOwnerAuthError) {
        let context = LAContext()
        var probe: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &probe) else {
            throw Self.map(probe)
        }
        do {
            let ok = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
            if !ok { throw DeviceOwnerAuthError.failed }
        } catch let error as DeviceOwnerAuthError {
            throw error
        } catch {
            throw Self.map(error as NSError)
        }
    }

    static func map(_ error: NSError?) -> DeviceOwnerAuthError {
        guard let error, error.domain == LAErrorDomain, let code = LAError.Code(rawValue: error.code) else {
            return .failed
        }
        switch code {
        case .userCancel, .appCancel, .systemCancel, .userFallback, .notInteractive:
            return .cancelled
        case .passcodeNotSet:
            return .unavailable
        default:
            return .failed
        }
    }
}

/// The app lock. It hides the DOSSIER, not the camera.
///
/// THE EXCEPTION (plan Task 7 step 3, Martin's call): the Scan tab shows the
/// live camera and queues captures BEFORE unlock — a lock in front of the
/// shutter breaks the 2-second cold-launch anti-goal, and a queued scan reveals
/// nothing. Uploading still needs the stored session, which the lock does not
/// touch. Viewing the dossier and approving anything require unlock.
///
/// THE HOOK FOR TASK 11 (and every later tab): gating is per AREA, not per app.
/// - The Scan tab is `.capture` and is shown WITHOUT `.lockGated(by:)`; it never
///   reads `isLocked`, and must not start the Face ID prompt by itself.
/// - Every other tab (Voor jou, Dossier, Meer) wraps its content in
///   `.lockGated(by: appLock)`, which covers it with `LockView` while
///   `isGated(.dossier)` and prompts when that tab is shown.
/// - A new area defaults to gated: add a case to `Area` and it is `.dossier`-
///   like unless it is listed as open in `isGated`. Open is the exception that
///   has to be argued, never the default.
/// - `RootView` forwards `scenePhase` to `sceneDidEnterBackground()` /
///   `sceneDidBecomeActive()` ONCE for the whole app, never per tab.
@MainActor
@Observable
final class AppLock {
    enum Copy {
        static let reason = "Ontgrendel verder om je dossier te zien."
        static let button = "Ontgrendel met Face ID"
        static let failed = "Ontgrendelen lukte niet. Probeer het nog eens."
        static let unavailable = "Stel een toegangscode in op je iPhone; daarna kun je verder ontgrendelen."
    }

    /// What a screen shows. `capture` is open while locked; everything else is not.
    enum Area { case capture, dossier }

    private(set) var isLocked: Bool
    /// The outcome of the last unlock attempt, for the lock screen. Nil after a
    /// cancel: closing the sheet is not an error.
    private(set) var message: String?
    private(set) var isUnlocking = false

    @ObservationIgnored private let authenticator: any DeviceOwnerAuthenticator
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var backgroundedAt: Date?
    /// Whether this lock episode has already prompted by itself. The sheet makes
    /// the scene inactive and then active again, so a lock screen that prompted
    /// on every activation would re-open the sheet Martin just cancelled, forever.
    @ObservationIgnored private var autoPrompted = false

    init(authenticator: any DeviceOwnerAuthenticator = PlatformOwnerAuthenticator(),
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.authenticator = authenticator
        self.now = now
        self.isLocked = LockPolicy.shouldLock(backgroundedAt: nil, now: now())
    }

    func isGated(_ area: Area) -> Bool {
        switch area {
        case .capture: false
        case .dossier: isLocked
        }
    }

    /// Asks for Face ID (or the passcode). A second call while the sheet is up
    /// asks nothing — the auto-prompt and a tap must not stack two sheets.
    func unlock() async {
        guard isLocked, !isUnlocking else { return }
        isUnlocking = true
        defer { isUnlocking = false }
        message = nil
        do {
            try await authenticator.authenticate(reason: Copy.reason)
            isLocked = false
        } catch {
            switch error {
            case .cancelled: break // Martin closed the sheet; nothing to say.
            case .unavailable: message = Copy.unavailable
            case .failed: message = Copy.failed
            }
        }
    }

    /// The lock screen's own prompt: at most ONCE per time the app locks. After
    /// that, only the button asks.
    func autoPromptIfNeeded() async {
        guard isLocked, !autoPrompted else { return }
        autoPrompted = true
        await unlock()
    }

    /// A password or passkey sign-in just proved who holds the phone; asking
    /// Face ID straight after would be a second gate on the same door.
    func didSignIn() {
        isLocked = false
        message = nil
    }

    func sceneDidEnterBackground() {
        backgroundedAt = now()
    }

    /// Judges the trip just ended, once. Only a return from the BACKGROUND
    /// counts: the Face ID sheet, Control Center and a call banner make the
    /// scene merely inactive, and re-judging those would let unlocking lock.
    func sceneDidBecomeActive() {
        guard let left = backgroundedAt else { return }
        backgroundedAt = nil
        if LockPolicy.shouldLock(backgroundedAt: left, now: now()) {
            isLocked = true
            autoPrompted = false
            message = nil
        }
    }
}
