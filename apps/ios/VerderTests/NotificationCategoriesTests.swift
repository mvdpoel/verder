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

    /// "Bekijken" opens the draft behind Face ID and never sends. Answer
    /// actions are Plan 3.
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
}
