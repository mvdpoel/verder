import UIKit
import UserNotifications

/// The UIKit callbacks SwiftUI does not offer: the APNs token, and the
/// notification delegate (a tap, and a push arriving while verder is open).
///
/// The delegate is set in `didFinishLaunching`, before the launch returns, so a
/// tap that launched the app cold is still delivered — into `links`, which
/// holds it until `RootView` exists to take it.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    let links = DeepLinkInbox()
    private var registrar: PushRegistrar?
    /// A token that arrived before `attach` (cannot happen today — only the
    /// registrar asks for one — but a dropped token is a silent failure).
    private var pendingToken: Data?

    func attach(_ registrar: PushRegistrar) {
        self.registrar = registrar
        if let token = pendingToken {
            pendingToken = nil
            Task { await registrar.didRegister(deviceToken: token) }
        }
    }

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        NotificationCategories.register()
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard let registrar else { pendingToken = deviceToken; return }
        Task { await registrar.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        registrar?.didFail(error)
    }

    /// A tap on the notification, or on "Bekijken". Both only OPEN: nothing
    /// is ever sent from a notification.
    ///
    /// MAIN-ACTOR ISOLATED ON PURPOSE, with the completion-handler signature.
    /// The first version was a `nonisolated … async` method: Swift's bridge then
    /// called UIKit's completion handler from a cooperative background thread,
    /// and UIKit's main-thread assertion in
    /// `_performBlockAfterCATransactionCommitSynchronizes` aborted the app on
    /// EVERY tap (two crashes on Martin's phone, 2026-10-31 16:45 — it looked
    /// like "tapping does not open the app").
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        links.deliver(DeepLink(userInfo: response.notification.request.content.userInfo))
        completionHandler()
    }

    /// While verder is in front, still show it: a Verder question is worth
    /// the banner even mid-scan. Main thread, for the same reason as above.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
}
