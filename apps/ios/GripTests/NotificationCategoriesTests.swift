import Testing
import Foundation
import UserNotifications
@testable import Grip

/// The drift guard for categories, as `TokensMatchWebTests` is for colours:
/// the worker's `CATEGORY` map (apps/worker/src/notify/notify.ts) is the ONE
/// definition, read straight off disk, and a push whose category the phone
/// never registered shows without its actions or its hidden-preview text.
struct NotificationCategoriesTests {
    static let notifyTS: String = {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()          // GripTests/
            .appendingPathComponent("../../worker/src/notify/notify.ts")
            .standardizedFileURL
        return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    }()

    /// The string values inside `export const CATEGORY … = { … };`.
    static func serverCategories() throws -> [String] {
        let block = try #require(notifyTS.firstMatch(of: try Regex(#"export const CATEGORY[^=]*=\s*\{([^}]*)\}"#)))
        let body = String(try #require(block.output[1].substring))
        return body.matches(of: try Regex(#":\s*"([A-Z_]+)""#)).map { String($0.output[1].substring ?? "") }
    }

    @Test func everyServerCategoryIsRegistered() throws {
        #expect(!Self.notifyTS.isEmpty, "could not read apps/worker/src/notify/notify.ts")
        let server = try Self.serverCategories()
        #expect(server.count == 9)
        #expect(Set(server) == Set(NotificationCategories.ids))
        #expect(NotificationCategories.ids.count == Set(NotificationCategories.ids).count)
        #expect(Set(NotificationCategories.all().map(\.identifier)) == Set(NotificationCategories.ids))
    }

    /// A locked phone with previews hidden shows nothing of the dossier.
    @Test func everyCategoryHidesItsPreview() {
        for category in NotificationCategories.all() {
            #expect(category.hiddenPreviewsBodyPlaceholder == "Nieuw bericht van verder", "\(category.identifier)")
            #expect(!category.options.contains(.hiddenPreviewsShowTitle), "\(category.identifier)")
            #expect(!category.options.contains(.hiddenPreviewsShowSubtitle), "\(category.identifier)")
        }
    }

    /// "Bekijken" opens the draft behind Face ID and never sends. A question's
    /// answer buttons live in its own `q.<id>` category, never in this set.
    /// A deadline carries "Gedaan" and nothing else; every other category none.
    @Test func onlyDraftCategoriesHaveOneOpenAction() {
        let withAction: Set = ["PROPOSAL", "REMINDER", "FOLLOW_UP"]
        for category in NotificationCategories.all() {
            if withAction.contains(category.identifier) {
                #expect(category.actions.count == 1, "\(category.identifier)")
                let action = category.actions.first
                #expect(action?.title == "Bekijken")
                #expect(action?.identifier == NotificationCategories.openAction)
                #expect(action?.options.contains(.foreground) == true)
                #expect(action?.options.contains(.authenticationRequired) == true)
                #expect(action?.options.contains(.destructive) == false)
            } else if category.identifier == "TASK_DUE" {
                #expect(category.actions.map(\.identifier) == [NotificationCategories.doneAction])
                #expect(category.actions.first?.title == "Gedaan")
            } else {
                #expect(category.actions.isEmpty, "\(category.identifier)")
            }
        }
    }

    /// Exactly ONE static action may run in the background: "Gedaan" on a
    /// deadline, which sets Martin's own task status and sends nothing out.
    /// It still needs an unlocked phone. Every other static action brings the
    /// app forward (behind Face ID) and only opens; a question's answer lives
    /// in the per-question `q.*` categories (`QuestionCategories`).
    @Test func onlyQuestionAndDoneActionsWorkInBackground() {
        var background: [String] = []
        for category in NotificationCategories.all() {
            #expect(!QuestionCategories.isQuestion(category.identifier))
            for action in category.actions {
                #expect(action.options.contains(.authenticationRequired), "\(category.identifier).\(action.identifier)")
                #expect(!action.options.contains(.destructive), "\(category.identifier).\(action.identifier)")
                if !action.options.contains(.foreground) { background.append("\(category.identifier).\(action.identifier)") }
            }
        }
        #expect(background == ["TASK_DUE.DONE"])
    }

    /// The app re-registers on every launch: the static set is restored in
    /// full, the extension's `q.*` categories are kept, anything else dropped.
    @Test func launchRegistrationKeepsQuestionsAndHealsTheStaticSet() {
        let q = QuestionCategories.make(proposalId: "6f9619ff-8b86-d011-b42d-00c04fc964ff", options: ["Ja"])
        let stray = UNNotificationCategory(identifier: "OLD", actions: [], intentIdentifiers: [])
        let union = NotificationCategories.union(existing: [q, stray])
        #expect(Set(union.map(\.identifier)) == Set(NotificationCategories.ids).union([q.identifier]))
    }
}
