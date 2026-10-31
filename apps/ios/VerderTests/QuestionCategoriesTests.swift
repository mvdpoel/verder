import Testing
import Foundation
import UserNotifications
@testable import Verder

/// The per-question categories the notification service extension registers
/// (`q.<proposal id>`), and the merge that keeps Plan 2's static set alive:
/// `setNotificationCategories` REPLACES the whole set, so the extension must
/// never write its own category alone.
struct QuestionCategoriesTests {
    static let id = "6f9619ff-8b86-d011-b42d-00c04fc964ff"
    static let link = "verder://proposal/6f9619ff-8b86-d011-b42d-00c04fc964ff"

    static func q(_ n: Int) -> UNNotificationCategory {
        QuestionCategories.make(proposalId: String(format: "00000000-0000-0000-0000-%012d", n), options: ["Ja", "Nee"])
    }

    @Test func questionCategoryActionsRequireAuthentication() {
        let category = QuestionCategories.make(proposalId: Self.id, options: ["Klaar", "Niets doen", "Later"])
        #expect(category.identifier == "q.\(Self.id)")
        #expect(category.actions.map(\.title) == ["Klaar", "Niets doen", "Later"])
        #expect(category.actions.map(\.identifier) == ["answer.0", "answer.1", "answer.2"])
        for action in category.actions {
            #expect(action.options.contains(.authenticationRequired), "\(action.identifier)")
            // Answered in the background: the app is not brought forward.
            #expect(!action.options.contains(.foreground), "\(action.identifier)")
            #expect(!action.options.contains(.destructive), "\(action.identifier)")
        }
        #expect(category.hiddenPreviewsBodyPlaceholder == NotificationCategories.hiddenPlaceholder)
        #expect(!category.options.contains(.hiddenPreviewsShowTitle))
    }

    @Test func questionCategoryCapsOptionsLikeTheServer() {
        let long = String(repeating: "x", count: 60)
        let category = QuestionCategories.make(proposalId: Self.id, options: [long, "b", "c", "d", "e"])
        #expect(category.actions.count == 4)
        #expect(category.actions[0].title.count == 40)
    }

    @Test func extensionKeepsStaticCategories() {
        let q = QuestionCategories.make(proposalId: Self.id, options: ["Ja", "Nee"])
        let merged = QuestionCategories.merged(existing: Set(NotificationCategories.all()), adding: q, order: [])
        let ids = Set(merged.categories.map(\.identifier))
        #expect(ids == Set(NotificationCategories.ids).union(["q.\(Self.id)"]))
        #expect(merged.order == ["q.\(Self.id)"])
    }

    @Test func questionCategoriesAreCappedAtTwenty() {
        var categories = Set(NotificationCategories.all())
        var order: [String] = []
        for n in 1...25 {
            let m = QuestionCategories.merged(existing: categories, adding: Self.q(n), order: order)
            categories = m.categories
            order = m.order
        }
        let qs = categories.map(\.identifier).filter(QuestionCategories.isQuestion)
        #expect(qs.count == 20)
        #expect(Set(qs) == Set((6...25).map { Self.q($0).identifier }))
        #expect(order == (6...25).map { Self.q($0).identifier })
        for id in NotificationCategories.ids {
            #expect(categories.contains { $0.identifier == id }, "\(id)")
        }
    }

    /// A second push for the same question (a new revision, other labels)
    /// replaces its category rather than registering a duplicate id.
    @Test func reAddingAQuestionReplacesItAndMakesItNewest() {
        let first = QuestionCategories.merged(existing: [], adding: Self.q(1), order: [])
        let second = QuestionCategories.merged(existing: first.categories, adding: Self.q(2), order: first.order)
        let again = QuestionCategories.make(proposalId: String(format: "00000000-0000-0000-0000-%012d", 1),
                                            options: ["Anders"])
        let third = QuestionCategories.merged(existing: second.categories, adding: again, order: second.order)
        #expect(third.categories.filter { $0.identifier == again.identifier }.count == 1)
        #expect(third.categories.first { $0.identifier == again.identifier }?.actions.map(\.title) == ["Anders"])
        #expect(third.order == [Self.q(2).identifier, again.identifier])
    }

    /// A `q.*` the order file does not know (the file was lost) is treated as
    /// the oldest, so it is the first to go — never kept forever.
    @Test func unknownQuestionCategoriesAreOldest() {
        let stray = Self.q(99)
        var categories: Set<UNNotificationCategory> = [stray]
        var order: [String] = []
        for n in 1...20 {
            let m = QuestionCategories.merged(existing: categories, adding: Self.q(n), order: order)
            categories = m.categories
            order = m.order
        }
        #expect(!categories.contains { $0.identifier == stray.identifier })
        #expect(categories.count == 20)
    }

    @Test func questionIsReadFromAQuestionPush() throws {
        let q = try #require(QuestionCategories.Question(userInfo: [
            "link": "verder://proposal/6F9619FF-8B86-D011-B42D-00C04FC964FF",
            "options": ["Klaar", "Niets doen"], "revision": 4,
        ]))
        #expect(q.proposalId == Self.id)
        #expect(q.options == ["Klaar", "Niets doen"])
        #expect(q.revision == 4)
    }

    /// Payloads as JSON, the shape they arrive in.
    @Test(arguments: [
        // a reply: no options
        #"{"link":"LINK"}"#,
        // no revision: answerable nowhere, so not made answerable
        #"{"link":"LINK","options":["Ja"]}"#,
        #"{"link":"LINK","options":["Ja"],"revision":"4"}"#,
        #"{"link":"LINK","options":["Ja"],"revision":1.5}"#,
        #"{"link":"LINK","options":["Ja"],"revision":true}"#,
        #"{"link":"LINK","options":[],"revision":1}"#,
        #"{"link":"LINK","options":[1,2],"revision":1}"#,
        #"{"link":"LINK","options":"Ja","revision":1}"#,
        // not a proposal
        #"{"link":"verder://inbox","options":["Ja"],"revision":1}"#,
        #"{"link":"verder://document/6f9619ff-8b86-d011-b42d-00c04fc964ff","options":["Ja"],"revision":1}"#,
        #"{"link":"LINK/x","options":["Ja"],"revision":1}"#,
        #"{"link":"LINK?x=1","options":["Ja"],"revision":1}"#,
        #"{"link":"https://proposal/6f9619ff-8b86-d011-b42d-00c04fc964ff","options":["Ja"],"revision":1}"#,
        #"{"options":["Ja"],"revision":1}"#,
    ])
    func nonQuestionsAreNotQuestions(_ json: String) throws {
        let data = Data(json.replacingOccurrences(of: "LINK", with: Self.link).utf8)
        let parsed = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(QuestionCategories.Question(userInfo: parsed) == nil)
    }

    /// The control for the table above: the same JSON path accepts a real one.
    @Test func aJSONQuestionIsAQuestion() throws {
        let data = Data(#"{"link":"verder://proposal/6f9619ff-8b86-d011-b42d-00c04fc964ff","options":["Ja","Nee"],"revision":3}"#.utf8)
        let parsed = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(QuestionCategories.Question(userInfo: parsed)?.revision == 3)
    }

    @Test func revisionMustBeAnIntegerNotABool() {
        let userInfo: [AnyHashable: Any] = ["link": "verder://proposal/\(Self.id)", "options": ["Ja"],
                                            "revision": NSNumber(value: true)]
        #expect(QuestionCategories.Question(userInfo: userInfo) == nil)
    }

    @Test func idsRoundTrip() {
        #expect(QuestionCategories.proposalId(fromCategory: "q.\(Self.id)") == Self.id)
        #expect(QuestionCategories.proposalId(fromCategory: "PROPOSAL") == nil)
        #expect(QuestionCategories.proposalId(fromCategory: "q.nope") == nil)
        #expect(QuestionCategories.optionIndex(fromAction: "answer.2") == 2)
        #expect(QuestionCategories.optionIndex(fromAction: "answer.-1") == nil)
        #expect(QuestionCategories.optionIndex(fromAction: "answer.4") == nil)
        #expect(QuestionCategories.optionIndex(fromAction: "OPEN") == nil)
        #expect(QuestionCategories.optionIndex(fromAction: UNNotificationDefaultActionIdentifier) == nil)
    }

    @Test func orderFileRoundTrips() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        #expect(QuestionCategories.Order.load(from: dir) == [])
        try QuestionCategories.Order.save(["q.a", "q.b"], to: dir)
        #expect(QuestionCategories.Order.load(from: dir) == ["q.a", "q.b"])
        #expect(QuestionCategories.Order.fileURL(in: dir).path().hasSuffix("push/q-order.json"))
    }
}
