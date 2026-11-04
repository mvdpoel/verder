import Foundation
import UserNotifications

/// The per-question notification categories, `q.<proposal id>`.
///
/// iOS fixes a category's action titles when the category is registered, and a
/// question's options are known only once its push arrives. So the
/// notification service extension (VerderNotify) reads the push's `options`,
/// builds `q.<id>` here, registers it, and points the notification at it.
///
/// An option is answered IN THE BACKGROUND (`.authenticationRequired`, NOT
/// `.foreground`): answering runs a ledgered action on the server but sends
/// nothing outward, which is why spec §7.2 allows it from the notification.
/// Every OTHER action verder registers only opens the app
/// (`NotificationCategoriesTests.onlyQuestionActionsWorkInBackground`).
///
/// Compiled into the app AND the extension, so Foundation + UserNotifications
/// only — no `DeepLink` (it names `RootView`), hence the small strict link
/// parse below.
enum QuestionCategories {
    static let prefix = "q."
    static let actionPrefix = "answer."
    /// How many `q.*` categories are kept registered. One per question push;
    /// a question older than the twentieth newest is answered in the app.
    static let keep = 20
    /// The worker's caps (`MAX_PUSH_OPTIONS`, 40 characters, apns.ts), applied
    /// again here because the payload is off the wire.
    static let maxOptions = 4
    static let maxLabel = 40

    /// What a question push carries: Plan 2's `link` to the proposal, Plan 3
    /// Task 5's top-level `options` and `revision`.
    struct Question: Equatable, Sendable {
        /// Lowercased UUID string, as the server spells it.
        let proposalId: String
        let options: [String]
        let revision: Int

        /// Nil for anything that is not a well-formed, answerable question: a
        /// reply (no options), a question WITHOUT a revision (the answer route
        /// requires one, so it stays a plain "Bekijken" notification), or a link
        /// that is not exactly `verder://proposal/<uuid>`.
        init?(userInfo: [AnyHashable: Any]) {
            guard let link = userInfo["link"] as? String,
                  let id = QuestionCategories.proposalId(fromLink: link),
                  let raw = userInfo["options"] as? [Any], !raw.isEmpty,
                  let revision = QuestionCategories.integer(userInfo["revision"])
            else { return nil }
            var options: [String] = []
            for item in raw {
                guard let s = item as? String else { return nil }
                options.append(s)
            }
            self.proposalId = id
            self.options = options
            self.revision = revision
        }
    }

    static func isQuestion(_ categoryId: String) -> Bool { categoryId.hasPrefix(prefix) }

    static func identifier(proposalId: String) -> String { prefix + proposalId.lowercased() }

    /// The proposal a `q.*` category belongs to; nil for any other category.
    static func proposalId(fromCategory categoryId: String) -> String? {
        guard isQuestion(categoryId), let uuid = UUID(uuidString: String(categoryId.dropFirst(prefix.count)))
        else { return nil }
        return uuid.uuidString.lowercased()
    }

    /// `answer.<n>` → n, for n within the option cap; nil for anything else
    /// (the default tap, "Bekijken", dismiss).
    static func optionIndex(fromAction actionId: String) -> Int? {
        guard actionId.hasPrefix(actionPrefix) else { return nil }
        let digits = actionId.dropFirst(actionPrefix.count)
        guard !digits.isEmpty, digits.allSatisfy(\.isASCII), digits.allSatisfy(\.isNumber),
              let n = Int(digits), n < maxOptions
        else { return nil }
        return n
    }

    /// `verder://proposal/<uuid>` exactly → the lowercased id. Same strictness
    /// as `DeepLink.parse`: no user, port, query, fragment or extra segment.
    static func proposalId(fromLink link: String) -> String? {
        guard let parts = URLComponents(string: link),
              parts.scheme == "verder", parts.host == "proposal",
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.query == nil, parts.fragment == nil
        else { return nil }
        let segments = parts.path.split(separator: "/", omittingEmptySubsequences: false)
        guard segments.count == 2, segments[0].isEmpty, let uuid = UUID(uuidString: String(segments[1]))
        else { return nil }
        return uuid.uuidString.lowercased()
    }

    /// An integer from a JSON payload. `NSNumber` bridges `true` to 1 and 1.5
    /// to nothing; a Bool is refused outright.
    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return value as? Int
    }

    static func make(proposalId: String, options: [String]) -> UNNotificationCategory {
        let actions = options.prefix(maxOptions).enumerated().map { index, label in
            UNNotificationAction(identifier: "\(actionPrefix)\(index)", title: String(label.prefix(maxLabel)),
                                 options: [.authenticationRequired],
                                 icon: iconName(for: label).map(UNNotificationActionIcon.init(systemImageName:)))
        }
        return UNNotificationCategory(identifier: identifier(proposalId: proposalId),
                                      actions: Array(actions),
                                      intentIdentifiers: [],
                                      hiddenPreviewsBodyPlaceholder: NotificationCategories.hiddenPlaceholder,
                                      options: [])
    }

    /// The SF Symbol beside an option in the long-press menu ("vraag · lang
    /// ingedrukt": a link for "Ja, koppel hem", a cross for "Nee", a question
    /// mark for "Weet ik niet"). The push carries labels only, so the symbol is
    /// read off the label's own words, and only for the four shapes the frames
    /// draw; any other label gets no symbol rather than a guessed one.
    static func iconName(for label: String) -> String? {
        let l = label.trimmingCharacters(in: .whitespaces).lowercased()
        if l == "nee" || l.hasPrefix("nee,") || l.hasPrefix("nee ") { return "xmark" }
        if l.hasPrefix("weet ik niet") { return "questionmark.circle" }
        if l.hasPrefix("ja") && l.contains("koppel") { return "link" }
        if l == "ja" || l.hasPrefix("ja,") || l.hasPrefix("ja ") { return "checkmark" }
        return nil
    }

    struct Merge {
        let categories: Set<UNNotificationCategory>
        /// The `q.*` ids kept, oldest first. Saved to `push/q-order.json`.
        let order: [String]
    }

    /// `setNotificationCategories` REPLACES the whole set, so the extension
    /// writes the union: every non-`q.` category kept as it is, `adding`
    /// (replacing an older category with its id) as the newest, and at most
    /// `keep` `q.*` in all. The ids carry no date, so "newest" is the `order`
    /// list; a registered `q.*` that list does not know counts as oldest.
    static func merged(existing: Set<UNNotificationCategory>, adding: UNNotificationCategory,
                       keep: Int = keep, order: [String]) -> Merge {
        let others = existing.filter { !isQuestion($0.identifier) && $0.identifier != adding.identifier }
        var questions: [String: UNNotificationCategory] = [:]
        for c in existing where isQuestion(c.identifier) { questions[c.identifier] = c }
        if isQuestion(adding.identifier) {
            questions[adding.identifier] = adding
        } else {
            return Merge(categories: others.union([adding]).union(questions.values), order: order)
        }

        let known = order.filter { questions[$0] != nil && $0 != adding.identifier }
        let unknown = questions.keys.filter { !order.contains($0) && $0 != adding.identifier }.sorted()
        let newestLast = unknown + known + [adding.identifier]
        let kept = Array(newestLast.suffix(max(keep, 1)))
        return Merge(categories: others.union(kept.compactMap { questions[$0] }), order: kept)
    }

    /// The order list in the App Group container, `push/q-order.json`.
    enum Order {
        static func fileURL(in dir: URL) -> URL {
            dir.appending(path: "push", directoryHint: .isDirectory).appending(path: "q-order.json")
        }

        /// Empty when missing or unreadable: the merge then treats every
        /// registered question as oldest, which only ever drops too early.
        static func load(from dir: URL) -> [String] {
            guard let data = try? Data(contentsOf: fileURL(in: dir)),
                  let ids = try? JSONDecoder().decode([String].self, from: data)
            else { return [] }
            return ids.filter(QuestionCategories.isQuestion)
        }

        static func save(_ ids: [String], to dir: URL) throws {
            let file = fileURL(in: dir)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            // Proposal ids only, no dossier text. The default protection class
            // (until first unlock) is the right one: the extension runs while
            // the phone is locked.
            try JSONEncoder().encode(ids).write(to: file, options: [.atomic])
        }
    }
}
