import Testing
import Foundation
import UserNotifications
@testable import Verder

/// What a notification response may do. A tap and "Bekijken" only OPEN; the
/// one thing an action can run is answering a QUESTION, through Plan 2's
/// answer route with the revision the push announced. Nothing else is
/// reachable from a notification — least of all a send.
@MainActor
struct NotificationRouterTests {
    nonisolated static let id = "6f9619ff-8b86-d011-b42d-00c04fc964ff"
    nonisolated static let uuid = UUID(uuidString: "6f9619ff-8b86-d011-b42d-00c04fc964ff")!
    nonisolated static let answerPath = "/api/mobile/v1/proposals/\(id)/answer"
    static let questionCategory = "q.\(id)"
    static let questionInfo: [AnyHashable: Any] = [
        "link": "verder://proposal/\(id)", "options": ["Klaar", "Niets doen"], "revision": 4,
    ]
    static let replyInfo: [AnyHashable: Any] = ["link": "verder://proposal/\(id)"]

    nonisolated static let taskId = "00000000-f1c5-4000-8000-0000000000d1"
    nonisolated static let taskPath = "/api/mobile/v1/tasks/\(taskId)/status"
    static let taskInfo: [AnyHashable: Any] = ["link": "verder://task/\(taskId)"]
    static let taskTitle = "Morgen: bijstand tekenen"

    final class Calls {
        var answered = 0
        var posted: [UNNotificationRequest] = []
    }

    struct Rig {
        let server: StubServer
        let links: DeepLinkInbox
        let calls: Calls
        let router: NotificationRouter
    }

    func rig(_ reply: StubProtocol.Reply = .status(200, body: Data(#"{"id":"x","status":"sent","revision":5,"taskId":null}"#.utf8)),
             withClient: Bool = true,
             tasks: StubProtocol.Reply = .status(200, body: Data("[]".utf8))) -> Rig {
        let server = StubServer()
        server.on { req in
            if req.httpMethod == "POST" && (req.url?.path() == Self.answerPath || req.url?.path() == Self.taskPath) { return reply }
            if req.httpMethod == "GET" && req.url?.path() == "/api/mobile/v1/tasks" { return tasks }
            return .status(404)
        }
        let links = DeepLinkInbox()
        let calls = Calls()
        let client = withClient ? server.client() : nil
        let router = NotificationRouter(links: links, client: { client }, onAnswered: { calls.answered += 1 },
                                        post: { calls.posted.append($0) })
        return Rig(server: server, links: links, calls: calls, router: router)
    }

    static let taskDone = StubProtocol.Reply.status(200, body: Data(#"{"taskId":"\#(taskId)","status":"done","validNext":["open"]}"#.utf8))

    func done(_ r: Rig, info: [AnyHashable: Any] = taskInfo) async -> NotificationRouter.Outcome {
        await r.router.handle(action: NotificationCategories.doneAction, category: "TASK_DUE", userInfo: info,
                              title: Self.taskTitle, requestId: "req-1", threadId: "")
    }

    /// "Gedaan" posts exactly the task screen's body, refreshes the inbox and
    /// opens nothing.
    @Test func doneSetsTheTaskDone() async throws {
        let r = rig(Self.taskDone)
        let outcome = await done(r)
        #expect(outcome == .taskDone(taskId: Self.taskId))
        let req = try #require(r.server.requests.only)
        #expect(req.httpMethod == "POST")
        #expect(req.url?.path() == Self.taskPath)
        let body = try #require(req.httpBody)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(Set(json.keys) == ["status"])
        #expect(json["status"] as? String == "done")
        #expect(r.calls.answered == 1)
        #expect(r.calls.posted.isEmpty)
        #expect(r.links.pending == DeepLink.none)
    }

    /// Offline: the notice carries Gedaan again (TASK_DUE, the task's link
    /// and its title) and the task opens at the next look.
    @Test func doneOfflinePostsARetryableNotice() async throws {
        let r = rig(.failure(.notConnectedToInternet))
        let outcome = await done(r)
        #expect(outcome == .taskNotDone(.task(UUID(uuidString: Self.taskId)!)))
        let notice = try #require(r.calls.posted.only)
        #expect(notice.identifier == "feedback.req-1")
        #expect(notice.content.title == "Gedaan kwam niet door")
        #expect(notice.content.body == "Bijstand tekenen staat nog open: er was geen verbinding. Kies Gedaan nog een keer bij deze melding.")
        #expect(notice.content.categoryIdentifier == "TASK_DUE")
        #expect(notice.content.userInfo["link"] as? String == "verder://task/\(Self.taskId)")
        #expect(notice.content.userInfo["taskTitle"] as? String == "bijstand tekenen")
        #expect(r.calls.answered == 0)

        // Choosing Gedaan on the notice itself runs the same request again.
        let again = rig(Self.taskDone)
        let second = await again.router.handle(action: NotificationCategories.doneAction, category: "TASK_DUE",
                                               userInfo: notice.content.userInfo, title: notice.content.title)
        #expect(second == .taskDone(taskId: Self.taskId))
    }

    @Test func doneWithoutSessionAsksToSignIn() async throws {
        for r in [rig(withClient: false), rig(.status(401))] {
            _ = await done(r)
            let notice = try #require(r.calls.posted.only)
            #expect(notice.content.title == "Opnieuw inloggen nodig")
            #expect(notice.content.body == "Gedaan voor bijstand tekenen kwam niet door. Tik om in te loggen en kies daarna Gedaan opnieuw.")
        }
    }

    /// A 400 reads as "al afgerond" ONLY when the task is in fact done.
    @Test func doneOnADoneTaskSaysSo() async throws {
        let list = Data(#"[{"id":"\#(Self.taskId)","title":"bijstand tekenen","details":null,"dueAt":null,"status":"done","assigneeName":null,"validNext":["open"]}]"#.utf8)
        let r = rig(.status(400), tasks: .status(200, body: list))
        _ = await done(r)
        let notice = try #require(r.calls.posted.only)
        #expect(notice.content.title == "Taak al afgerond")
        #expect(notice.content.body == "Bijstand tekenen stond al op klaar. Tik om je taken te openen.")
        #expect(notice.content.categoryIdentifier == "")

        let dropped = rig(.status(400), tasks: .status(200, body: Data(String(decoding: list, as: UTF8.self).replacingOccurrences(of: #""status":"done""#, with: #""status":"dropped""#).utf8)))
        _ = await done(dropped)
        #expect(dropped.calls.posted.isEmpty)
        #expect(dropped.links.pending == .task(UUID(uuidString: Self.taskId)!))
    }

    /// A deadline push that names no task (an older push) opens Voor jou.
    @Test func doneWithoutATaskLinkOpens() async {
        let r = rig(Self.taskDone)
        let outcome = await done(r, info: ["link": "verder://inbox"])
        #expect(outcome == .opened(.inbox))
        #expect(r.server.requests.isEmpty)
    }

    /// DONE means nothing in any other category.
    @Test func doneOutsideADeadlineRunsNothing() async {
        let r = rig(Self.taskDone)
        let outcome = await r.router.handle(action: NotificationCategories.doneAction, category: "PROPOSAL",
                                            userInfo: Self.taskInfo)
        #expect(outcome == .opened(.task(UUID(uuidString: Self.taskId)!)))
        #expect(r.server.requests.isEmpty)
    }

    @Test func anOfflineAnswerOffersTheOptionsAgain() async throws {
        let r = rig(.failure(.notConnectedToInternet))
        var info = Self.questionInfo
        info["subject"] = "brief van 14 okt"
        _ = await r.router.handle(action: "answer.0", category: Self.questionCategory, userInfo: info)
        let notice = try #require(r.calls.posted.only)
        #expect(notice.content.title == "Keuze kwam niet door")
        #expect(notice.content.body == "Brief van 14 okt: er was geen verbinding. Kies opnieuw bij deze melding of tik om de vraag te openen.")
        #expect(notice.content.categoryIdentifier == Self.questionCategory)
        #expect(QuestionCategories.Question(userInfo: notice.content.userInfo)?.revision == 4)
    }

    @Test func aLateAnswerSaysTheQuestionIsHandled() async throws {
        let r = rig(.status(409))
        _ = await r.router.handle(action: "answer.0", category: Self.questionCategory, userInfo: Self.questionInfo)
        let notice = try #require(r.calls.posted.only)
        #expect(notice.content.title == "Vraag al afgehandeld")
        #expect(notice.content.body == "Tik om Voor jou te openen. Hier hoeft niets meer.")
        #expect(notice.content.userInfo["link"] as? String == "verder://inbox")
    }

    @Test func routerMapsReplyTapToDetailNotSend() async {
        for action in [UNNotificationDefaultActionIdentifier, NotificationCategories.openAction] {
            let r = rig()
            let outcome = await r.router.handle(action: action, category: "PROPOSAL", userInfo: Self.replyInfo)
            #expect(outcome == .opened(.proposal(Self.uuid)))
            #expect(r.links.pending == .proposal(Self.uuid))
            #expect(r.server.requests.isEmpty, "a tap must never reach the network")
        }
    }

    /// Tapping the body of a question (not a button) opens it too.
    @Test func questionTapOpensInsteadOfAnswering() async {
        let r = rig()
        let outcome = await r.router.handle(action: UNNotificationDefaultActionIdentifier,
                                            category: Self.questionCategory, userInfo: Self.questionInfo)
        #expect(outcome == .opened(.proposal(Self.uuid)))
        #expect(r.server.requests.isEmpty)
    }

    @Test func routerSendsAnswerOnlyForQCategories() async throws {
        let r = rig()
        let outcome = await r.router.handle(action: "answer.1", category: Self.questionCategory, userInfo: Self.questionInfo)
        #expect(outcome == .answered(proposalId: Self.id, option: 1))
        #expect(r.calls.answered == 1)
        let req = try #require(r.server.requests.only)
        #expect(req.httpMethod == "POST")
        #expect(req.url?.path() == Self.answerPath)
        let body = try #require(req.httpBody)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(Set(json.keys) == ["revision", "option"])
        #expect(json["revision"] as? Int == 4)
        #expect(json["option"] as? Int == 1)
        #expect(r.links.pending == DeepLink.none, "an answered question opens nothing")

        // The same action identifier in any static category posts nothing.
        for category in NotificationCategories.ids {
            let other = rig()
            let o = await other.router.handle(action: "answer.1", category: category, userInfo: Self.questionInfo)
            #expect(o == .opened(.proposal(Self.uuid)), "\(category)")
            #expect(other.server.requests.isEmpty, "\(category)")
            #expect(other.calls.answered == 0)
        }
    }

    @Test func routerWithoutRevisionOpensInsteadOfAnswering() async {
        var info = Self.questionInfo
        info["revision"] = nil
        let r = rig()
        let outcome = await r.router.handle(action: "answer.0", category: Self.questionCategory, userInfo: info)
        #expect(outcome == .opened(.proposal(Self.uuid)))
        #expect(r.server.requests.isEmpty)
        #expect(r.links.pending == .proposal(Self.uuid))
    }

    /// 409 (answered on the web meanwhile, or a newer revision) and 400 change
    /// nothing on the server; the proposal is opened so the next look shows
    /// where it stands. Never retried.
    @Test(arguments: [409, 400, 404, 503])
    func aRefusedAnswerOpensTheProposal(_ status: Int) async {
        let r = rig(.status(status))
        let outcome = await r.router.handle(action: "answer.0", category: Self.questionCategory, userInfo: Self.questionInfo)
        #expect(outcome == .notAnswered(.proposal(Self.uuid)))
        #expect(r.server.requests.count == 1)
        #expect(r.calls.answered == 0)
        #expect(r.links.pending == .proposal(Self.uuid))
    }

    @Test func noSessionOpensInsteadOfAnswering() async {
        let r = rig(withClient: false)
        let outcome = await r.router.handle(action: "answer.0", category: Self.questionCategory, userInfo: Self.questionInfo)
        #expect(outcome == .notAnswered(.proposal(Self.uuid)))
        #expect(r.links.pending == .proposal(Self.uuid))
    }

    /// The category names the proposal the actions belong to; a link that
    /// names another one is not answered for either.
    @Test func aCategoryAndLinkThatDisagreeAnswerNothing() async {
        var info = Self.questionInfo
        info["link"] = "verder://proposal/00000000-0000-0000-0000-000000000001"
        let r = rig()
        let outcome = await r.router.handle(action: "answer.0", category: Self.questionCategory, userInfo: info)
        #expect(outcome == .ignored)
        #expect(r.server.requests.isEmpty)
        #expect(r.links.pending == DeepLink.none)
    }

    @Test func dismissDoesNothing() async {
        let r = rig()
        let outcome = await r.router.handle(action: UNNotificationDismissActionIdentifier,
                                            category: Self.questionCategory, userInfo: Self.questionInfo)
        #expect(outcome == .ignored)
        #expect(r.server.requests.isEmpty)
        #expect(r.links.pending == DeepLink.none)
    }
}

private extension Array {
    var only: Element? { count == 1 ? first : nil }
}
