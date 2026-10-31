import UIKit
import UserNotifications

/// The UIKit callbacks SwiftUI does not offer: the APNs token, and the
/// notification delegate (a tap, and a push arriving while verder is open).
///
/// The delegate is set in `didFinishLaunching`, before the launch returns, so a
/// tap that launched the app cold is still delivered — into `links`, which
/// holds it until `RootView` exists to take it.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
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
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let link = DeepLink(userInfo: response.notification.request.content.userInfo)
        await MainActor.run { links.deliver(link) }
    }

    /// While verder is in front, still show it: a Verder question is worth
    /// the banner even mid-scan.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
}
