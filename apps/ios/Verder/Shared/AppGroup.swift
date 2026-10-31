import Foundation

/// The App Group the app and its extensions share (the notification service
/// extension, the widget, the share extension).
///
/// Its own file, Foundation only, because it is compiled into the extensions
/// too.
enum AppGroup {
    static let id = "group.pro.vanderpoel.verder"

    /// Nil only when the entitlement is missing (a misconfigured build).
    static var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id)
    }
}
