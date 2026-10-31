import Testing
import Foundation
@testable import Verder

/// `userInfo["link"]` comes off the wire. An unknown or malformed link is
/// `.none`, never a crash and never a guess.
struct DeepLinkTests {
    let id = UUID(uuidString: "6F9619FF-8B86-D011-B42D-00C04FC964FF")!

    @Test func deepLinkParsesProposal() {
        #expect(DeepLink(userInfo: ["link": "verder://proposal/6f9619ff-8b86-d011-b42d-00c04fc964ff"]) == .proposal(id))
        #expect(DeepLink(userInfo: ["link": "verder://proposal/6F9619FF-8B86-D011-B42D-00C04FC964FF"]) == .proposal(id))
    }

    @Test func deepLinkParsesDocumentAndInbox() {
        #expect(DeepLink(userInfo: ["link": "verder://document/6f9619ff-8b86-d011-b42d-00c04fc964ff"]) == .document(id))
        #expect(DeepLink(userInfo: ["link": "verder://inbox"]) == .inbox)
    }

    @Test(arguments: [
        "",
        "verder://",
        "verder://proposal",
        "verder://proposal/",
        "verder://proposal/not-a-uuid",
        "verder://proposal/6f9619ff-8b86-d011-b42d-00c04fc964ff/extra",
        "verder://proposal/6f9619ff-8b86-d011-b42d-00c04fc964ff?x=1",
        "verder://inbox/6f9619ff-8b86-d011-b42d-00c04fc964ff",
        "verder://unknown/6f9619ff-8b86-d011-b42d-00c04fc964ff",
        "https://proposal/6f9619ff-8b86-d011-b42d-00c04fc964ff",
        "https://verder.vanderpoel.pro/proposal/6f9619ff-8b86-d011-b42d-00c04fc964ff",
        "verder://user@proposal/6f9619ff-8b86-d011-b42d-00c04fc964ff",
        "verder://proposal:443/6f9619ff-8b86-d011-b42d-00c04fc964ff",
        "javascript:alert(1)",
        "%%%",
    ])
    func deepLinkRejectsJunk(_ link: String) {
        #expect(DeepLink(userInfo: ["link": link]) == DeepLink.none)
    }

    @Test func deepLinkRejectsNonStrings() {
        #expect(DeepLink(userInfo: [:]) == DeepLink.none)
        #expect(DeepLink(userInfo: ["link": 42]) == DeepLink.none)
        #expect(DeepLink(userInfo: ["link": ["verder://inbox"]]) == DeepLink.none)
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
