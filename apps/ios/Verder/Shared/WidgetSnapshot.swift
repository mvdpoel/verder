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
/// holds is small: a count, one title and the map headline — and the widget
/// marks both titles privacy-sensitive so iOS redacts them while locked.
struct WidgetSnapshot: Codable, Equatable, Sendable {
    let count: Int
    let topTitle: String?
    /// The top item's `WaitingItem.kind` as the server spells it.
    let topKind: String?
    /// The map's current stop ("waar het nu op wacht"), or nil when none is open.
    let headline: String?
    let updatedAt: Date

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

    /// Nil when nothing was written yet or the file does not decode — the
    /// widget then says "Open verder om bij te werken", never a guessed count.
    static func read(from dir: URL) -> WidgetSnapshot? {
        guard let data = try? Data(contentsOf: fileURL(in: dir)) else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }
}
