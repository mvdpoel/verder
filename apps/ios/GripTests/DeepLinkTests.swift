import Testing
import Foundation
@testable import Grip

/// `userInfo["link"]` comes off the wire. An unknown or malformed link is
/// `.none`, never a crash and never a guess.
struct DeepLinkTests {
    let id = UUID(uuidString: "6F9619FF-8B86-D011-B42D-00C04FC964FF")!

    @Test func deepLinkParsesProposal() {
        #expect(DeepLink(userInfo: ["link": "grip://proposal/6f9619ff-8b86-d011-b42d-00c04fc964ff"]) == .proposal(id))
        #expect(DeepLink(userInfo: ["link": "grip://proposal/6F9619FF-8B86-D011-B42D-00C04FC964FF"]) == .proposal(id))
    }

    @Test func deepLinkParsesDocumentAndInbox() {
        #expect(DeepLink(userInfo: ["link": "grip://document/6f9619ff-8b86-d011-b42d-00c04fc964ff"]) == .document(id))
        #expect(DeepLink(userInfo: ["link": "grip://inbox"]) == .inbox)
    }

    @Test func deepLinkParsesSuggestionAndTask() {
        #expect(DeepLink(userInfo: ["link": "grip://suggestion/6f9619ff-8b86-d011-b42d-00c04fc964ff"]) == .suggestion(id))
        #expect(DeepLink(userInfo: ["link": "grip://task/6F9619FF-8B86-D011-B42D-00C04FC964FF"]) == .task(id))
        #expect(DeepLink.parse("grip://suggestion/s1") == DeepLink.none)
        #expect(DeepLink.parse("grip://task/6f9619ff-8b86-d011-b42d-00c04fc964ff/x") == DeepLink.none)
        #expect(DeepLink.suggestion(id).tab == .voorJou)
        #expect(DeepLink.task(id).tab == .voorJou)
    }

    @Test(arguments: [
        "",
        "grip://",
        "grip://proposal",
        "grip://proposal/",
        "grip://proposal/not-a-uuid",
        "grip://proposal/6f9619ff-8b86-d011-b42d-00c04fc964ff/extra",
        "grip://proposal/6f9619ff-8b86-d011-b42d-00c04fc964ff?x=1",
        "grip://inbox/6f9619ff-8b86-d011-b42d-00c04fc964ff",
        "grip://unknown/6f9619ff-8b86-d011-b42d-00c04fc964ff",
        "https://proposal/6f9619ff-8b86-d011-b42d-00c04fc964ff",
        "https://grip.vanderpoel.pro/proposal/6f9619ff-8b86-d011-b42d-00c04fc964ff",
        "grip://user@proposal/6f9619ff-8b86-d011-b42d-00c04fc964ff",
        "grip://proposal:443/6f9619ff-8b86-d011-b42d-00c04fc964ff",
        "javascript:alert(1)",
        "%%%",
    ])
    func deepLinkRejectsJunk(_ link: String) {
        #expect(DeepLink(userInfo: ["link": link]) == DeepLink.none)
    }

    /// `grip://` is what the app and the server emit; `verder://` is the same
    /// app before the rename to Grip, and links already delivered (pushes in
    /// Notification Center, widget timelines) still carry it — both parse to
    /// the same destination, with the same strictness.
    @Test func bothTheGripAndThePreRenameVerderSchemeParse() {
        #expect(DeepLink.scheme == "grip")
        for scheme in ["grip", "verder"] {
            #expect(DeepLink.parse("\(scheme)://proposal/6f9619ff-8b86-d011-b42d-00c04fc964ff") == .proposal(id))
            #expect(DeepLink.parse("\(scheme)://task/6f9619ff-8b86-d011-b42d-00c04fc964ff") == .task(id))
            #expect(DeepLink.parse("\(scheme)://inbox") == .inbox)
            #expect(DeepLink.parse("\(scheme)://timeline") == .timeline)
            #expect(DeepLink.parse("\(scheme)://done-by-grip") == .doneByGrip)
            #expect(DeepLink.parse("\(scheme)://done-by-verder") == .doneByGrip)
            #expect(DeepLink.parse("\(scheme)://proposal/not-a-uuid") == DeepLink.none)
            #expect(QuestionCategories.proposalId(fromLink: "\(scheme)://proposal/6F9619FF-8B86-D011-B42D-00C04FC964FF")
                    == "6f9619ff-8b86-d011-b42d-00c04fc964ff")
        }
        #expect(DeepLink.parse("grap://inbox") == DeepLink.none)
        #expect(QuestionCategories.proposalId(fromLink: "grap://proposal/6f9619ff-8b86-d011-b42d-00c04fc964ff") == nil)
    }

    @Test func deepLinkRejectsNonStrings() {
        #expect(DeepLink(userInfo: [:]) == DeepLink.none)
        #expect(DeepLink(userInfo: ["link": 42]) == DeepLink.none)
        #expect(DeepLink(userInfo: ["link": ["grip://inbox"]]) == DeepLink.none)
        #expect(DeepLink(userInfo: ["aps": ["alert": "x"]]) == DeepLink.none)
    }

    /// Where each link lands; a proposal also opens its own screen on Voor jou.
    @Test func linksOpenTheirTab() {
        #expect(DeepLink.proposal(id).tab == .voorJou)
        #expect(DeepLink.inbox.tab == .voorJou)
        #expect(DeepLink.document(id).tab == .dossier)
        #expect(DeepLink.none.tab == nil)
    }
}
