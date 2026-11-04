import Foundation
import UserNotifications

/// What a notification response does, decided in one place.
///
/// - The default tap and Plan 2's "Bekijken" (`OPEN`) OPEN the item:
///   `DeepLink(userInfo:)` into `links`, exactly as before.
/// - An `answer.<n>` action on a question's own `q.<id>` category answers it:
///   `POST /api/mobile/v1/proposals/<id>/answer { revision, option }` — Plan
///   2's body, with the revision the push announced (Task 5).
/// - "Gedaan" (`DONE`) on a deadline push (`TASK_DUE`) sets that task to done:
///   `POST /api/mobile/v1/tasks/<id>/status { status: "done" }`. With the
///   answer, the only two things an action can run; neither sends outward.
/// - When either does not go through, a local notice says so
///   (`NotificationFeedback`), carrying the same action again where a second
///   try is the next step.
/// - A tap on the Sunday summary (`WEEKLY`) opens the Weekoverzicht, a tap on
///   the "Door verder gedaan" digest opens that section, and a push with no
///   link opens its category's place (`target`).
/// - Anything else opens at most; nothing else is reachable.
///
/// An answer that does not go through — no revision in the push, no session,
/// a 409 (answered on the web meanwhile, or a newer revision), a 400, the
/// network — changes nothing on the server and is NEVER retried; the proposal
/// is delivered to `links` so the next look at verder shows where it stands.
@MainActor
final class NotificationRouter {
    enum Outcome: Equatable {
        case opened(DeepLink)
        case answered(proposalId: String, option: Int)
        /// The answer was not recorded; the proposal waits in `links`.
        case notAnswered(DeepLink)
        /// "Gedaan" on a deadline push set the task to done.
        case taskDone(taskId: String)
        /// "Gedaan" did not go through; the task waits in `links`.
        case taskNotDone(DeepLink)
        case ignored
    }

    /// Where a feedback notice goes: the notification centre, in the app.
    typealias Poster = @MainActor (UNNotificationRequest) async -> Void

    static let systemPoster: Poster = { request in
        try? await UNUserNotificationCenter.current().add(request)
    }

    /// `CATEGORY.weekly` in apps/worker/src/notify/notify.ts.
    static let weeklyCategory = "WEEKLY"

    private let links: DeepLinkInbox
    private let client: @MainActor () -> APIClient?
    private let onAnswered: @MainActor () async -> Void
    private let post: Poster

    /// `client` is read per response: a background action can arrive before
    /// any view exists, and a session can end between two notifications.
    /// `onAnswered` refreshes the inbox (and with it the badge). `post` shows
    /// a feedback notice when an action did not go through.
    init(links: DeepLinkInbox,
         client: @escaping @MainActor () -> APIClient?,
         onAnswered: @escaping @MainActor () async -> Void = {},
         post: @escaping Poster = NotificationRouter.systemPoster) {
        self.links = links
        self.client = client
        self.onAnswered = onAnswered
        self.post = post
    }

    func handle(response: UNNotificationResponse) async -> Outcome {
        let request = response.notification.request
        let content = request.content
        return await handle(action: response.actionIdentifier, category: content.categoryIdentifier,
                            userInfo: content.userInfo, title: content.title,
                            requestId: request.identifier, threadId: content.threadIdentifier)
    }

    /// `title`, `requestId` and `threadId` are the notification's own; only a
    /// feedback notice reads them.
    func handle(action: String, category: String, userInfo: [AnyHashable: Any],
                title: String = "", requestId: String = "", threadId: String = "") async -> Outcome {
        if action == UNNotificationDismissActionIdentifier { return .ignored }
        let notice: @MainActor (NotificationFeedback) async -> Void = { [post] feedback in
            await post(feedback.request(answering: requestId, threadId: threadId))
        }

        if action == NotificationCategories.doneAction, category == NotificationCategories.taskDueCategory {
            return await markDone(userInfo: userInfo, title: title, notice: notice)
        }

        guard let proposalId = QuestionCategories.proposalId(fromCategory: category),
              let option = QuestionCategories.optionIndex(fromAction: action)
        else {
            return open(Self.target(action: action, category: category, link: DeepLink(userInfo: userInfo)))
        }

        // The category names the question its buttons belong to; a link that
        // names another proposal is answered for neither.
        guard QuestionCategories.proposalId(fromLink: userInfo["link"] as? String ?? "") == proposalId,
              let uuid = UUID(uuidString: proposalId)
        else { return .ignored }
        let link = DeepLink.proposal(uuid)

        // The extension only makes a question answerable WITH a revision, but
        // the payload is off the wire: without one there is nothing to answer at.
        guard let question = QuestionCategories.Question(userInfo: userInfo) else { return open(link) }
        guard let client = client() else { return notAnswered(link) }
        do {
            let _: Ignored = try await client.postJSON("/api/mobile/v1/proposals/\(proposalId)/answer",
                                                       AnswerOptionRequest(revision: question.revision, option: option))
        } catch let error as APIError where Self.isOffline(error) {
            await notice(.questionOffline(subject: userInfo["subject"] as? String, category: category, userInfo: userInfo))
            return notAnswered(link)
        } catch APIError.rejected(409) {
            await notice(.questionHandled)
            return notAnswered(link)
        } catch {
            // No session, a 400, a 5xx: silent, as before — the proposal opens
            // the next time Martin looks, and shows where it stands.
            return notAnswered(link)
        }
        await onAnswered()
        return .answered(proposalId: proposalId, option: option)
    }

    /// "Gedaan" on a deadline push: `POST /api/mobile/v1/tasks/<id>/status
    /// { status: "done" }`, the route the task screen uses. The push names the
    /// task in its link (`grip://task/<id>`); one that does not (an older
    /// push, `grip://inbox`) has nothing to mark, so it opens instead.
    /// Never retried on its own: a notice says what happened, and where a
    /// second try is the next step it carries Gedaan again.
    private func markDone(userInfo: [AnyHashable: Any], title: String,
                          notice: @MainActor (NotificationFeedback) async -> Void) async -> Outcome {
        let link = DeepLink(userInfo: userInfo)
        guard case .task(let uuid) = link, let raw = userInfo["link"] as? String else {
            return open(Self.fallback(category: NotificationCategories.taskDueCategory))
        }
        let id = uuid.uuidString.lowercased()
        let task = NotificationFeedback.taskTitle(pushTitle: title, userInfo: userInfo)
        guard let client = client() else {
            await notice(.taskSignIn(task: task, link: raw))
            return taskNotDone(link)
        }
        do {
            let _: TaskStatusResponse = try await client.postJSON("/api/mobile/v1/tasks/\(id)/status",
                                                                  TaskStatusRequest(status: "done"))
        } catch APIError.unauthorized {
            await notice(.taskSignIn(task: task, link: raw))
            return taskNotDone(link)
        } catch APIError.rejected(400) {
            // The route refuses an illegal move. Only a task that IS done reads
            // as "al afgerond"; dropped or waiting opens silently, to be seen.
            let all: [TaskDTO]? = try? await client.getJSON("/api/mobile/v1/tasks")
            if all?.first(where: { $0.id.lowercased() == id })?.status == "done" {
                await notice(.taskAlreadyDone(task: task))
                await onAnswered()
            }
            return taskNotDone(link)
        } catch let error as APIError where Self.isOffline(error) {
            await notice(.taskOffline(task: task, link: raw))
            return taskNotDone(link)
        } catch APIError.server {
            await notice(.taskServer(task: task, link: raw))
            return taskNotDone(link)
        } catch {
            return taskNotDone(link)
        }
        await onAnswered()
        return .taskDone(taskId: id)
    }

    /// What a tap OPENS. The push's own link, except where its category
    /// knows better:
    /// - the Sunday summary (`WEEKLY`) opens the Weekoverzicht, whatever its
    ///   link says (the worker sends `grip://inbox`);
    /// - the daily "Door verder gedaan" digest is the one `FILING` push that
    ///   carries `grip://inbox`, and opens that section;
    /// - a push with NO usable link (a merged duplex scan, a new loonstrook,
    ///   the watchdog's "hersteld") opens its category's place
    ///   (`fallback`), never nothing.
    /// Only a tap or "Bekijken" gets the category's help; any other action
    /// opens its link at most.
    static func target(action: String, category: String, link: DeepLink) -> DeepLink {
        guard action == UNNotificationDefaultActionIdentifier || action == NotificationCategories.openAction
        else { return link }
        if category == weeklyCategory { return .weekly }
        if category == filingCategory, link == .inbox { return .doneByGrip }
        return link == .none ? fallback(category: category) : link
    }

    /// Where a category's push lands when it carries no link.
    static func fallback(category: String) -> DeepLink {
        switch category {
        case "VERDER_MAIL", "CREDITOR_MAIL", "PROPOSAL", "REMINDER", "FOLLOW_UP", NotificationCategories.taskDueCategory: .inbox
        case filingCategory: .dossier
        case "SYSTEM": .overzicht
        case weeklyCategory: .weekly
        default: .none
        }
    }

    /// `CATEGORY.filing` in apps/worker/src/notify/notify.ts.
    static let filingCategory = "FILING"

    private func open(_ link: DeepLink) -> Outcome {
        guard link != .none else { return .ignored }
        links.deliver(link)
        return .opened(link)
    }

    /// No HTTP answer at all — but not the caller's own cancellation.
    static func isOffline(_ error: APIError) -> Bool {
        if case .transport = error { return error != .cancelled }
        return false
    }

    private func taskNotDone(_ link: DeepLink) -> Outcome {
        links.deliver(link)
        return .taskNotDone(link)
    }

    private func notAnswered(_ link: DeepLink) -> Outcome {
        links.deliver(link)
        return .notAnswered(link)
    }
}
