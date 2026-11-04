import Foundation
import UserNotifications

/// The local notification Grip posts when an action taken FROM a
/// notification did not go through ("notifications · final": "Gedaan kwam
/// niet door", "Opnieuw inloggen nodig", "Taak al afgerond", "Keuze kwam niet
/// door", "Vraag al afgehandeld").
///
/// An action runs in the background, with no screen to say anything on, so
/// without these a refused or offline "Gedaan" is silent and Martin believes a
/// task is done that is still open. Nothing here is retried on its own: the
/// notice offers the SAME action again where that is the right next step (it
/// keeps the category and the payload), and otherwise opens the place to look.
///
/// Pure: builds the content; `NotificationRouter` hands it to the poster.
struct NotificationFeedback: Equatable {
    let title: String
    let body: String
    /// The category the notice carries: `TASK_DUE` or the question's own
    /// `q.<id>` when the same action may be chosen again, empty for a notice
    /// that only opens.
    let category: String
    /// The payload the notice carries: `link` always, plus whatever the
    /// action needs to run a second time (`taskTitle`; a question's
    /// `options` and `revision`).
    let userInfo: [String: AnyHashable]

    // MARK: Gedaan on a deadline push

    /// The task's own title, for the notice's sentence. A notice Grip posted
    /// itself carries it (`taskTitle`); the worker's push spells it into its
    /// title after the day ("Morgen: bijstand tekenen").
    static func taskTitle(pushTitle: String, userInfo: [AnyHashable: Any]) -> String {
        if let own = userInfo["taskTitle"] as? String, !own.isEmpty { return own }
        for prefix in ["Te laat: ", "Vandaag: ", "Morgen: "] where pushTitle.hasPrefix(prefix) {
            return String(pushTitle.dropFirst(prefix.count))
        }
        return pushTitle
    }

    /// Offline: the task is still open, and long-pressing THIS notice offers
    /// Gedaan again.
    static func taskOffline(task: String, link: String) -> Self {
        Self(title: "Gedaan kwam niet door",
             body: "\(capitalised(task)) staat nog open: er was geen verbinding. Kies Gedaan nog een keer bij deze melding.",
             category: NotificationCategories.taskDueCategory,
             userInfo: ["link": link, "taskTitle": task])
    }

    /// No answer from Grip (a 5xx): the same retry, with the honest cause.
    static func taskServer(task: String, link: String) -> Self {
        Self(title: "Gedaan kwam niet door",
             body: "\(capitalised(task)) staat nog open: Grip kon het nu niet opslaan. Kies Gedaan nog een keer bij deze melding.",
             category: NotificationCategories.taskDueCategory,
             userInfo: ["link": link, "taskTitle": task])
    }

    /// The session has ended: a tap opens Grip, which asks to sign in.
    static func taskSignIn(task: String, link: String) -> Self {
        Self(title: "Opnieuw inloggen nodig",
             body: "Gedaan voor \(task) kwam niet door. Tik om in te loggen en kies daarna Gedaan opnieuw.",
             category: NotificationCategories.taskDueCategory,
             userInfo: ["link": link, "taskTitle": task])
    }

    /// The task was done already (on the web, or a second press).
    static func taskAlreadyDone(task: String) -> Self {
        Self(title: "Taak al afgerond",
             body: "\(capitalised(task)) stond al op klaar. Tik om je taken te openen.",
             category: "", userInfo: ["link": "grip://inbox"])
    }

    // MARK: An answer to a question

    /// Offline: the question's own buttons again, on this notice.
    static func questionOffline(subject: String?, category: String, userInfo: [AnyHashable: Any]) -> Self {
        var info: [String: AnyHashable] = [:]
        if let link = userInfo["link"] as? String { info["link"] = link }
        if let options = userInfo["options"] as? [String] { info["options"] = options }
        if let revision = userInfo["revision"] as? Int { info["revision"] = revision }
        if let subject { info["subject"] = subject }
        let lead = subject.map { "\(capitalised($0)): er was geen verbinding." } ?? "Er was geen verbinding."
        return Self(title: "Keuze kwam niet door",
                    body: "\(lead) Kies opnieuw bij deze melding of tik om de vraag te openen.",
                    category: category, userInfo: info)
    }

    /// A 409: answered on the web meanwhile, or a newer revision.
    static var questionHandled: Self {
        Self(title: "Vraag al afgehandeld", body: "Tik om Voor jou te openen. Hier hoeft niets meer.",
             category: "", userInfo: ["link": "grip://inbox"])
    }

    static func capitalised(_ s: String) -> String {
        guard let first = s.first else { return s }
        return first.uppercased() + s.dropFirst()
    }

    /// The request iOS shows. Same thread as the notification it answers, so
    /// the two group; an `.active` level, because it reports Martin's own act
    /// and is not urgent in its own right.
    func request(answering requestId: String, threadId: String) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.categoryIdentifier = category
        content.userInfo = userInfo
        content.threadIdentifier = threadId
        content.sound = .default
        content.interruptionLevel = .active
        // One notice per notification: a second failure replaces the first.
        return UNNotificationRequest(identifier: "feedback.\(requestId)", content: content, trigger: nil)
    }
}
