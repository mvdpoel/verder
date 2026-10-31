import UserNotifications

/// The notification categories, one per kind the worker sends.
///
/// MIRRORS `CATEGORY` in apps/worker/src/notify/notify.ts; a rename there
/// fails `NotificationCategoriesTests`, which reads that file off disk.
enum NotificationCategories {
    static let ids = ["VERDER_MAIL", "CREDITOR_MAIL", "PROPOSAL", "REMINDER", "FOLLOW_UP",
                      "TASK_DUE", "FILING", "SYSTEM", "WEEKLY"]

    /// A locked phone with previews hidden shows this and nothing else: no
    /// title (the category sets no `.hiddenPreviewsShowTitle`), no sender, no
    /// line from the dossier.
    static let hiddenPlaceholder = "Nieuw bericht van verder"

    static let openAction = "OPEN"

    /// Categories whose notification leads to a draft. "Bekijken" OPENS it,
    /// behind the lock, and never sends: nothing leaves without Martin
    /// approving the final text inside the app. Answer actions are Plan 3.
    static let withOpenAction: Set<String> = ["PROPOSAL", "REMINDER", "FOLLOW_UP"]

    static func all() -> [UNNotificationCategory] {
        let open = UNNotificationAction(identifier: openAction, title: "Bekijken",
                                        options: [.foreground, .authenticationRequired])
        return ids.map { id in
            UNNotificationCategory(identifier: id,
                                   actions: withOpenAction.contains(id) ? [open] : [],
                                   intentIdentifiers: [],
                                   hiddenPreviewsBodyPlaceholder: hiddenPlaceholder,
                                   options: [])
        }
    }

    static func register() {
        UNUserNotificationCenter.current().setNotificationCategories(Set(all()))
    }
}
