import UIKit
import UserNotifications

/// The UIKit callbacks SwiftUI does not offer: the APNs token, the silent
/// refresh push, and the notification delegate (a tap, an answer button, and a
/// push arriving while Grip is open).
///
/// The delegate is set in `didFinishLaunching`, before the launch returns, so a
/// tap that launched the app cold is still delivered — into `links`, which
/// holds it until `RootView` exists to take it.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    /// The process's client and inbox store, handed over by `GripApp.init`.
    /// STATIC, not attached from a view: a question answered from the lock
    /// screen or a silent refresh launches the app in the BACKGROUND, where no
    /// scene connects and no `onAppear` ever runs. `GripApp.init` does run
    /// (it builds the delegate), before any delegate callback.
    struct Services {
        let client: APIClient
        let inbox: InboxStore
    }
    static var services: Services?

    /// The delegate SwiftUI made, for `SceneDelegate` (quick actions):
    /// `UIApplication.shared.delegate` is SwiftUI's own wrapper, not this.
    static weak var current: AppDelegate?

    let links = DeepLinkInbox()
    private lazy var router = NotificationRouter(
        links: links,
        client: { AppDelegate.services?.client },
        onAnswered: { await AppDelegate.services?.inbox.refresh() })
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
        Self.current = self
        ScanLaunch.run = { [weak self] in self?.links.deliver(.scan) }
        NotificationCategories.register()
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /// The home screen quick actions arrive at the SCENE, so every scene gets
    /// `SceneDelegate`; SwiftUI still owns the window.
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard let registrar else { pendingToken = deviceToken; return }
        Task { await registrar.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        registrar?.didFail(error)
    }

    /// A tap on the notification, "Bekijken", or a question's answer button —
    /// `NotificationRouter` decides which. A tap and "Bekijken" only OPEN; an
    /// answer button posts the answer and sends nothing outward. Nothing is
    /// ever SENT from a notification.
    ///
    /// MAIN-ACTOR ISOLATED ON PURPOSE, with the completion-handler signature.
    /// The first version was a `nonisolated … async` method: Swift's bridge then
    /// called UIKit's completion handler from a cooperative background thread,
    /// and UIKit's main-thread assertion in
    /// `_performBlockAfterCATransactionCommitSynchronizes` aborted the app on
    /// EVERY tap (two crashes on Martin's phone, 2026-10-31 16:45 — it looked
    /// like "tapping does not open the app"). The async work runs in a
    /// main-actor Task and the handler is called LAST, inside it: for an answer
    /// pressed on the lock screen that is also what keeps the process alive
    /// until the POST has finished.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let done = MainThreadCallback(completionHandler)
        let router = router
        Task { @MainActor in
            _ = await router.handle(response: response)
            done.call()
        }
    }

    /// A silent `content-available` push (`badge.sync`): refresh the inbox,
    /// which rewrites the widget snapshot and the icon badge. Nothing depends
    /// on it arriving — iOS throttles these and never wakes a force-quit app.
    /// Main-actor with the completion handler, for the same reason as above.
    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        let done = MainThreadCallback(completionHandler)
        guard let inbox = Self.services?.inbox else { done.call(.noData); return }
        Task { @MainActor in
            await inbox.refresh()
            done.call(inbox.lastError == nil ? .newData : .failed)
        }
    }

    /// While Grip is in front, still show it: a Verder question is worth
    /// the banner even mid-scan. Main thread, for the same reason as above.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
}

/// A UIKit completion handler carried into a main-actor Task. UIKit hands it
/// over on the main thread and wants it called there; the Task is main-actor,
/// so it is. `@unchecked Sendable` only because the closure type does not say
/// so — it is never called off the main actor.
private struct MainThreadCallback<Value>: @unchecked Sendable {
    private let body: (Value) -> Void
    init(_ body: @escaping (Value) -> Void) { self.body = body }
    @MainActor func call(_ value: Value) { body(value) }
}

private extension MainThreadCallback where Value == Void {
    init(_ body: @escaping () -> Void) { self.body = { _ in body() } }
    @MainActor func call() { body(()) }
}
