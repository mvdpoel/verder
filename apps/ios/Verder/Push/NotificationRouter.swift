import Foundation
import UserNotifications

/// What a notification response does, decided in one place.
///
/// - The default tap and Plan 2's "Bekijken" (`OPEN`) OPEN the item:
///   `DeepLink(userInfo:)` into `links`, exactly as before.
/// - An `answer.<n>` action on a question's own `q.<id>` category answers it:
///   `POST /api/mobile/v1/proposals/<id>/answer { revision, option }` — Plan
///   2's body, with the revision the push announced (Task 5). That is the ONE
///   thing an action can run, and it sends nothing outward.
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
        case ignored
    }

    private let links: DeepLinkInbox
    private let client: @MainActor () -> APIClient?
    private let onAnswered: @MainActor () async -> Void

    /// `client` is read per response: a background action can arrive before
    /// any view exists, and a session can end between two notifications.
    /// `onAnswered` refreshes the inbox (and with it the badge).
    init(links: DeepLinkInbox,
         client: @escaping @MainActor () -> APIClient?,
         onAnswered: @escaping @MainActor () async -> Void = {}) {
        self.links = links
        self.client = client
        self.onAnswered = onAnswered
    }

    func handle(response: UNNotificationResponse) async -> Outcome {
        let content = response.notification.request.content
        return await handle(action: response.actionIdentifier, category: content.categoryIdentifier,
                            userInfo: content.userInfo)
    }

    func handle(action: String, category: String, userInfo: [AnyHashable: Any]) async -> Outcome {
        if action == UNNotificationDismissActionIdentifier { return .ignored }

        guard let proposalId = QuestionCategories.proposalId(fromCategory: category),
              let option = QuestionCategories.optionIndex(fromAction: action)
        else { return open(DeepLink(userInfo: userInfo)) }

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
        } catch {
            return notAnswered(link)
        }
        await onAnswered()
        return .answered(proposalId: proposalId, option: option)
    }

    private func open(_ link: DeepLink) -> Outcome {
        guard link != .none else { return .ignored }
        links.deliver(link)
        return .opened(link)
    }

    private func notAnswered(_ link: DeepLink) -> Outcome {
        links.deliver(link)
        return .notAnswered(link)
    }
}
