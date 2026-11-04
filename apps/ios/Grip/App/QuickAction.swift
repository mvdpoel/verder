import UIKit

/// The home screen quick actions (long-press the icon). Declared statically
/// in Info.plist (project.yml `UIApplicationShortcutItems`), so they exist
/// before the app has ever run; handled here by turning each into a
/// `DeepLink`, the one path every outside entry point takes into the screens.
enum QuickAction {
    /// "Gesprek vastleggen" (plan 3 Task 25).
    static let voiceType = "pro.vanderpoel.grip.voice"
    /// "Scan een brief": the camera, at once, without Face ID (R20).
    static let scanType = "pro.vanderpoel.grip.scan"

    static func link(forType type: String) -> DeepLink {
        switch type {
        case voiceType: .voice
        case scanType: .scan
        default: .none
        }
    }
}

/// SwiftUI has no quick-action callback, so the app's scenes get this
/// delegate (`AppDelegate.application(_:configurationForConnecting:options:)`).
/// It only forwards: a cold launch carries the item in the connection
/// options, a warm one calls `performActionFor`.
@MainActor
final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        if let item = connectionOptions.shortcutItem { deliver(item) }
    }

    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        let link = QuickAction.link(forType: shortcutItem.type)
        deliver(shortcutItem)
        completionHandler(link != .none)
    }

    private func deliver(_ item: UIApplicationShortcutItem) {
        AppDelegate.current?.links.deliver(QuickAction.link(forType: item.type))
    }
}
