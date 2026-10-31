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

    final class Calls { var answered = 0 }

    struct Rig {
        let server: StubServer
        let links: DeepLinkInbox
        let calls: Calls
        let router: NotificationRouter
    }

    func rig(_ reply: StubProtocol.Reply = .status(200, body: Data(#"{"id":"x","status":"sent","revision":5,"taskId":null}"#.utf8)),
             withClient: Bool = true) -> Rig {
        let server = StubServer()
        server.on { req in
            req.httpMethod == "POST" && req.url?.path() == Self.answerPath ? reply : .status(404)
        }
        let links = DeepLinkInbox()
        let calls = Calls()
        let client = withClient ? server.client() : nil
        let router = NotificationRouter(links: links, client: { client }, onAnswered: { calls.answered += 1 })
        return Rig(server: server, links: links, calls: calls, router: router)
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
