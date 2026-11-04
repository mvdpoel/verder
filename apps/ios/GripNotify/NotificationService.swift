import UserNotifications

/// The notification service extension: the one piece of code that runs after a
/// push arrives and BEFORE it is shown, which is the only moment a question's
/// options can become buttons — iOS fixes a category's action titles at
/// registration, and those titles are known only once the push is here.
///
/// For a question push (`mutable-content`, a top-level `options` array, an
/// integer `revision`, and `link: verder://proposal/<uuid>`) it registers
/// `q.<uuid>` — through `QuestionCategories.merged`, because
/// `setNotificationCategories` REPLACES the whole set and writing the one
/// category alone would wipe Plan 2's nine — and points the notification at it.
/// `revision` stays in `userInfo` for `NotificationRouter`.
///
/// Anything else is delivered exactly as it came. It never makes a network
/// call and never changes what the notification SAYS, only its category.
final class NotificationService: UNNotificationServiceExtension {
    /// The handler as iOS gave it; `serviceExtensionTimeWillExpire` delivers
    /// the original content through it if the registration has not finished.
    private let pending = Pending()

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        pending.set(contentHandler, original: request.content)
        guard let question = QuestionCategories.Question(userInfo: request.content.userInfo),
              let content = request.content.mutableCopy() as? UNMutableNotificationContent
        else { pending.deliver(nil); return }

        let category = QuestionCategories.make(proposalId: question.proposalId, options: question.options)
        content.categoryIdentifier = category.identifier
        let rewritten = Rewritten(content: content)
        let pending = pending
        Task {
            await Self.register(category)
            pending.deliver(rewritten.content)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        pending.deliver(nil)
    }

    /// Reads the registered set, merges, writes the union, and reads it back:
    /// the read-back orders the write before the notification is handed over,
    /// so the category exists when iOS shows it (measured on the device, plan 3
    /// Task 8 step 3).
    private static func register(_ category: UNNotificationCategory) async {
        let center = UNUserNotificationCenter.current()
        let existing = await center.notificationCategories()
        let dir = AppGroup.containerURL
        let order = dir.map(QuestionCategories.Order.load(from:)) ?? []
        let merged = QuestionCategories.merged(existing: existing, adding: category, order: order)
        center.setNotificationCategories(merged.categories)
        if let dir { try? QuestionCategories.Order.save(merged.order, to: dir) }
        _ = await center.notificationCategories()
    }
}

/// The mutable copy, carried into the Task. Nothing else touches it once it is
/// handed over.
private struct Rewritten: @unchecked Sendable {
    let content: UNMutableNotificationContent
}

/// The content handler, called exactly once: with the rewritten content, or —
/// on a non-question, or when time runs out — with the original.
private final class Pending: @unchecked Sendable {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?

    func set(_ handler: @escaping (UNNotificationContent) -> Void, original: UNNotificationContent) {
        lock.withLock {
            self.handler = handler
            self.original = original
        }
    }

    /// Nil delivers the original.
    func deliver(_ content: UNNotificationContent?) {
        let (handler, original) = lock.withLock {
            defer { self.handler = nil; self.original = nil }
            return (self.handler, self.original)
        }
        guard let handler, let original else { return }
        handler(content ?? original)
    }
}
