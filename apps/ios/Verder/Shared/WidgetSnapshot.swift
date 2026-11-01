import Foundation

/// What the widget draws, written by the app (`InboxStore.refresh`) and read by
/// the widget. The widget never calls the network: this one small file is all
/// it knows.
///
/// Compiled into the app AND the widget target (Task 23), so it imports
/// Foundation only.
///
/// PROTECTION CLASS: `.completeFileProtectionUntilFirstUserAuthentication`, NOT
/// `.complete` like the pocket dossier. The widget renders while the phone is
/// locked (lock screen, StandBy), and a `.complete` file is unreadable then, so
/// the widget would show nothing exactly where it is looked at most. What it
/// holds is small: a count, the top five titles and the map headline — and
/// the widget marks every title privacy-sensitive so iOS redacts them while
/// locked, and shows none on the lock screen.
struct WidgetSnapshot: Codable, Equatable, Sendable {
    let count: Int
    let topTitle: String?
    /// The top item's `WaitingItem.kind` as the server spells it.
    let topKind: String?
    /// The map's current stop ("waar het nu op wacht"), or nil when none is open.
    let headline: String?
    let updatedAt: Date
    /// The server's top items (at most `maxItems`), in server order: the
    /// medium and large widgets' rows, each deep-linking to its own item.
    let items: [Item]
    /// The oldest `at` over ALL waiting items, not just the kept ones: the
    /// lock-screen rectangle's "oudste 3 dagen". Nil when nothing waits.
    let oldestAt: Date?

    /// One row. A title, so it is shown only where `.privacySensitive()`
    /// redacts it on a locked phone, and never on the lock screen.
    struct Item: Codable, Equatable, Sendable {
        /// `WaitingItem.kind` as the server spells it.
        let kind: String
        let id: String
        let title: String
    }

    /// The large widget's five rows.
    static let maxItems = 5

    init(count: Int, topTitle: String?, topKind: String?, headline: String?, updatedAt: Date,
         items: [Item] = [], oldestAt: Date? = nil) {
        self.count = count
        self.topTitle = topTitle
        self.topKind = topKind
        self.headline = headline
        self.updatedAt = updatedAt
        self.items = items
        self.oldestAt = oldestAt
    }

    /// `items` and `oldestAt` arrived with the widget (Plan 3 Task 23). A
    /// snapshot an older build left in the App Group has neither, and must
    /// still read — as count-only — rather than turn the widget into "Open
    /// verder om bij te werken" until the app next refreshes.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        count = try c.decode(Int.self, forKey: .count)
        topTitle = try c.decodeIfPresent(String.self, forKey: .topTitle)
        topKind = try c.decodeIfPresent(String.self, forKey: .topKind)
        headline = try c.decodeIfPresent(String.self, forKey: .headline)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        items = try c.decodeIfPresent([Item].self, forKey: .items) ?? []
        oldestAt = try c.decodeIfPresent(Date.self, forKey: .oldestAt)
    }

    static let writeOptions: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]

    typealias Writer = (Data, URL, Data.WritingOptions) throws -> Void

    /// `<dir>/widget/snapshot.json`, where `dir` is the App Group container.
    static func fileURL(in dir: URL) -> URL {
        dir.appending(path: "widget", directoryHint: .isDirectory).appending(path: "snapshot.json")
    }

    /// The writer is injected so a test can assert the OPTIONS: the simulator
    /// does not enforce data protection, so reading the attribute back there
    /// proves nothing.
    static func write(_ snapshot: WidgetSnapshot, to dir: URL,
                      writer: Writer = { try $0.write(to: $1, options: $2) }) throws {
        let file = fileURL(in: dir)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        // A private format between two targets built together: the default
        // date strategy keeps sub-second precision, so a round trip is exact.
        let data = try JSONEncoder().encode(snapshot)
        try writer(data, file, writeOptions)
    }

    /// The DEVICE check of the protection class (Plan 3 Task 9 Step 3). iOS 27
    /// refuses `devicectl device copy from` for anything in an App Group outside
    /// `Library/` ("outside the directories the container access policy
    /// allows"), so the file cannot be inspected from the Mac; the app reads the
    /// attribute back itself. Prints ONLY when launched with
    /// `VERDER_REPORT_SNAPSHOT_PROTECTION=1` (`devicectl device process launch
    /// --console --environment-variables …`), so normal use never logs. It
    /// prints the protection class, never the snapshot's contents.
    static func reportProtectionIfAsked(in dir: URL) {
        guard ProcessInfo.processInfo.environment["VERDER_REPORT_SNAPSHOT_PROTECTION"] == "1" else { return }
        let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL(in: dir).path)
        let value = (attrs?[.protectionKey] as? FileProtectionType)?.rawValue ?? "unreadable"
        print("verder: widget/snapshot.json protection = \(value)")
    }

    /// Removes the snapshot: its titles, their ids and the map headline. Sign-out
    /// and a rejected session call this (through `AuthModel` and
    /// `InboxStore`), because the pocket dossier is wiped then and the
    /// widget's copy of the same content may not outlive it. A missing file
    /// already reads as "Open verder om bij te werken", so nothing new is
    /// written in its place. Already gone is success.
    static func erase(in dir: URL) {
        try? FileManager.default.removeItem(at: fileURL(in: dir))
    }

    /// Nil when nothing was written yet or the file does not decode — the
    /// widget then says "Open verder om bij te werken", never a guessed count.
    static func read(from dir: URL) -> WidgetSnapshot? {
        guard let data = try? Data(contentsOf: fileURL(in: dir)) else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }
}
