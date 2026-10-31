import Foundation
import Observation
import UIKit
import UserNotifications

/// What the system says about alerts, reduced to what the app acts on.
enum PushPermission: Equatable, Sendable {
    case notDetermined
    case denied
    /// Authorized, provisional or ephemeral: alerts can arrive.
    case allowed
}

/// The system permission sheet. A protocol so tests answer for it.
protocol NotificationPermission: Sendable {
    func status() async -> PushPermission
    /// Shows the system sheet; true when alerts were allowed.
    func request() async -> Bool
}

struct SystemNotificationPermission: NotificationPermission {
    func status() async -> PushPermission {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .notDetermined: .notDetermined
        case .denied: .denied
        case .authorized, .provisional, .ephemeral: .allowed
        @unknown default: .denied
        }
    }

    func request() async -> Bool {
        // `.timeSensitive` is not an option to ask for: it comes from the
        // entitlement plus the payload's interruption-level.
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }
}

/// The body of `POST /api/mobile/v1/push/register`, exactly the server's zod
/// schema (packages/api/src/routers/push.ts). No session id: the route takes
/// it from the validated cookie, never from a body.
struct PushRegistration: Encodable, Equatable {
    static let bundleId = "pro.vanderpoel.verder"

    let token: String
    let environment: String
    let bundleId: String
    let appVersion: String
}

/// The APNs token as the server stores it: lowercase hex, no spaces or
/// brackets (the server refuses anything but `^[0-9a-f]{64,200}$`).
func hexToken(_ d: Data) -> String {
    d.map { String(format: "%02x", $0) }.joined()
}

/// Asks for permission, registers with APNs, and tells verder the token.
///
/// WHEN IT ASKS (plan Task 7 step 3): once, after the first successful
/// sign-in or the first unlock with a session — never on a cold launch,
/// which belongs to the camera (the 2-second anti-goal). A Dutch pre-prompt
/// comes first, and the system sheet only on yes, so a "not now" costs
/// nothing: the system sheet can be shown once per install, the pre-prompt
/// can be offered again from Meer.
///
/// `registerForRemoteNotifications()` runs on EVERY launch with a session and
/// permission (`registerIfAllowed`), because tokens change; the server upserts
/// on the token, so re-sending one is harmless.
@MainActor
@Observable
final class PushRegistrar {
    enum Copy {
        static let prePromptTitle = "Meldingen aanzetten?"
        static let prePrompt = "verder laat je weten als Verder iets vraagt of als er iets klaarstaat om te versturen."
        static let allow = "Meldingen aanzetten"
        static let notNow = "Niet nu"
        static let registerFailed = "Aanmelden voor meldingen lukte niet. verder probeert het bij de volgende start opnieuw."
        static let apnsFailed = "Deze iPhone kon zich niet aanmelden bij Apple voor meldingen."
    }

    static let askedKey = "pushPrePromptShown"

    /// Nil until first read.
    private(set) var permission: PushPermission?
    /// The environment verder last accepted for this phone's token.
    private(set) var registeredEnvironment: String?
    private(set) var prePromptPending = false
    private(set) var lastError: String?

    @ObservationIgnored let client: APIClient
    @ObservationIgnored let auth: AuthModel
    @ObservationIgnored let permissionSource: any NotificationPermission
    @ObservationIgnored let environment: String
    @ObservationIgnored let appVersion: String
    @ObservationIgnored let defaults: UserDefaults
    @ObservationIgnored let registerRemote: @MainActor () -> Void

    init(client: APIClient, auth: AuthModel,
         permission: any NotificationPermission = SystemNotificationPermission(),
         environment: String = ProvisioningEnvironment.current,
         appVersion: String = PushRegistrar.bundleVersion,
         defaults: UserDefaults = .standard,
         registerRemote: @escaping @MainActor () -> Void = { UIApplication.shared.registerForRemoteNotifications() }) {
        self.client = client
        self.auth = auth
        self.permissionSource = permission
        self.environment = environment
        self.appVersion = appVersion
        self.defaults = defaults
        self.registerRemote = registerRemote
    }

    /// `0.1 (1)`: marketing version and build, as /settings would want to see it.
    static var bundleVersion: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        return String("\(short) (\(build))".prefix(40))
    }

    func refresh() async {
        permission = await permissionSource.status()
    }

    /// The asking moment: after a sign-in or an unlock. Registers straight
    /// away when alerts are already allowed; offers the pre-prompt once when
    /// nobody has decided yet; does nothing when Martin said no in Settings.
    func requestPermissionIfNeeded() async {
        guard auth.isSignedIn else { return }
        let status = await permissionSource.status()
        permission = status
        switch status {
        case .allowed: registerRemote()
        case .denied: break
        case .notDetermined:
            if !defaults.bool(forKey: Self.askedKey) { prePromptPending = true }
        }
    }

    /// Launch with a session: refresh the token, never prompt.
    func registerIfAllowed() async {
        guard auth.isSignedIn else { return }
        let status = await permissionSource.status()
        permission = status
        if status == .allowed { registerRemote() }
    }

    /// "Meldingen aanzetten": the pre-prompt's yes, or the row in Meer.
    func acceptPrePrompt() async {
        prePromptPending = false
        defaults.set(true, forKey: Self.askedKey)
        let granted = await permissionSource.request()
        permission = granted ? .allowed : .denied
        if granted { registerRemote() }
    }

    func declinePrePrompt() {
        prePromptPending = false
        defaults.set(true, forKey: Self.askedKey)
    }

    /// From `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`.
    /// One attempt; a failure waits for the next launch, which registers again.
    func didRegister(deviceToken: Data) async {
        guard auth.isSignedIn else { return }
        let body = PushRegistration(token: hexToken(deviceToken), environment: environment,
                                    bundleId: PushRegistration.bundleId, appVersion: appVersion)
        do {
            let data = try JSONEncoder().encode(body)
            let req = client.request("/api/mobile/v1/push/register", method: "POST", body: data,
                                     contentType: "application/json")
            _ = try await client.send(req)
            registeredEnvironment = environment
            lastError = nil
        } catch APIError.unauthorized {
            // The server no longer knows this session (revoked in
            // /settings/security, or expired): back to sign-in.
            registeredEnvironment = nil
            auth.sessionRejected()
        } catch {
            lastError = Copy.registerFailed
        }
    }

    /// From `application(_:didFailToRegisterForRemoteNotificationsWithError:)`.
    func didFail(_ error: Error) {
        let ns = error as NSError
        lastError = Copy.apnsFailed + " (\(ns.domain) \(ns.code))"
    }
}
