import UserNotifications

/// The notification categories, one per kind the worker sends.
///
/// MIRRORS `CATEGORY` in apps/worker/src/notify/notify.ts; a rename there
/// fails `NotificationCategoriesTests`, which reads that file off disk.
///
/// Compiled into the app AND the notification service extension.
enum NotificationCategories {
    static let ids = ["VERDER_MAIL", "CREDITOR_MAIL", "PROPOSAL", "REMINDER", "FOLLOW_UP",
                      "TASK_DUE", "FILING", "SYSTEM", "WEEKLY"]

    /// A locked phone with previews hidden shows this and nothing else: no
    /// title (the category sets no `.hiddenPreviewsShowTitle`), no sender, no
    /// line from the dossier.
    static let hiddenPlaceholder = "Nieuw bericht van Grip"

    static let openAction = "OPEN"

    /// "Gedaan" on a deadline push ("notifications · final", task-due · lang
    /// ingedrukt): sets the task to done IN THE BACKGROUND, behind an unlocked
    /// phone (`.authenticationRequired`), without bringing Grip forward.
    /// It is the second background action, beside a question's answer, and
    /// like it sends nothing outward: the task status is Martin's, so his
    /// press is his decision and the `task.status` event it appends is his.
    static let doneAction = "DONE"
    static let taskDueCategory = "TASK_DUE"

    /// Categories whose notification leads to a draft. "Bekijken" OPENS it,
    /// behind the lock, and never sends: nothing leaves without Martin
    /// approving the final text inside the app. A question's answer buttons are
    /// NOT here: they live in its own `q.<id>` category (`QuestionCategories`).
    static let withOpenAction: Set<String> = ["PROPOSAL", "REMINDER", "FOLLOW_UP"]

    static func all() -> [UNNotificationCategory] {
        let open = UNNotificationAction(identifier: openAction, title: "Bekijken",
                                        options: [.foreground, .authenticationRequired])
        let done = UNNotificationAction(identifier: doneAction, title: "Gedaan",
                                        options: [.authenticationRequired],
                                        icon: UNNotificationActionIcon(systemImageName: "checkmark"))
        return ids.map { id in
            UNNotificationCategory(identifier: id,
                                   actions: id == taskDueCategory ? [done] : withOpenAction.contains(id) ? [open] : [],
                                   intentIdentifiers: [],
                                   hiddenPreviewsBodyPlaceholder: hiddenPlaceholder,
                                   options: [])
        }
    }

    /// What the app registers: the full static set (so a category lost to an
    /// extension bug heals at the next launch) plus the `q.*` categories the
    /// extension registered, which the static set alone would wipe —
    /// `setNotificationCategories` REPLACES everything.
    static func union(existing: Set<UNNotificationCategory>) -> Set<UNNotificationCategory> {
        Set(all()).union(existing.filter { QuestionCategories.isQuestion($0.identifier) })
    }

    /// On every launch. Reads what is registered first, for `union`.
    static func register() {
        UNUserNotificationCenter.current().getNotificationCategories { existing in
            UNUserNotificationCenter.current().setNotificationCategories(union(existing: existing))
        }
    }
}
