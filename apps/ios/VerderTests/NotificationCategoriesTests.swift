import Testing
import Foundation
import UserNotifications
@testable import Verder

/// The drift guard for categories, as `TokensMatchWebTests` is for colours:
/// the worker's `CATEGORY` map (apps/worker/src/notify/notify.ts) is the ONE
/// definition, read straight off disk, and a push whose category the phone
/// never registered shows without its actions or its hidden-preview text.
struct NotificationCategoriesTests {
    static let notifyTS: String = {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()          // VerderTests/
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
            } else {
                #expect(category.actions.isEmpty, "\(category.identifier)")
            }
        }
    }

    /// No STATIC category may run anything in the background: every action
    /// they carry brings the app forward (behind Face ID) and only opens. The
    /// one background action is a question's answer, which lives in the
    /// per-question `q.*` categories (`QuestionCategories`) and never sends.
    @Test func onlyQuestionActionsWorkInBackground() {
        for category in NotificationCategories.all() {
            #expect(!QuestionCategories.isQuestion(category.identifier))
            for action in category.actions {
                #expect(action.options.contains(.foreground), "\(category.identifier).\(action.identifier)")
            }
        }
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
