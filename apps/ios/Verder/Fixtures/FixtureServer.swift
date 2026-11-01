#if DEBUG
import Foundation

/// The fake verder behind `-fixtures <name>`: answers every `/api/mobile/v1/*`
/// request from the bundled synthetic dataset (`FixtureData/`, written from
/// docs/superpowers/specs/2026-11-01-iphone-synthetic-data.md — the ONLY data a
/// fixture may hold, because simulator screenshots leave this machine).
///
/// DEBUG ONLY. The whole file, the protocol, the launch parser and the
/// `FixtureData` folder are compiled out of Release twice over: `#if DEBUG`
/// here, and `EXCLUDED_SOURCE_FILE_NAMES` for the Release configuration in
/// project.yml. `FixtureIsolationTests` pins both.
///
/// Pure: a request's method and path in, a reply out. No URLSession, so the
/// tests decode every fixture into the app's real DTOs without a network.
///
/// LOOKUP: the path after `/api/mobile/v1/` names a file. A GET of
/// `proposals/<id>` reads `<name>/proposals/<id>.json`, falling back to
/// `_shared/proposals/<id>.json`, so a fixture holds only what differs from
/// the base case. A POST reads `<path>.post.json` the same way and otherwise
/// answers `{}` — the routes answer more than the phone reads (`Ignored`).
/// A GET with no `.json` falls back to `<path>.pdf` / `<path>.jpg`, served as
/// bytes: that is how `documents/<id>/file` answers (Plan 3 Task 21).
/// The query string is ignored: one fixture is one state of the world.
struct FixtureServer: Sendable {
    enum Reply: Equatable, Sendable {
        case json(status: Int, body: Data)
        /// A document's bytes (`documents/<id>/file`), served from the
        /// fixture's `file.pdf` / `file.jpg` with that type, like the route's.
        case file(contentType: String, body: Data)
        /// No HTTP answer at all: the `offline` fixture.
        case transportFailure
    }

    struct Manifest: Decodable, Equatable, Sendable {
        enum Behavior: String, Decodable, Sendable { case files, offline, unauthorized }
        let description: String
        let behavior: Behavior?
        /// A status for a path instead of its file, e.g. `{"weekly": 404}` —
        /// the route's own answer before the first Sunday.
        let statuses: [String: Int]?
        /// A generated variant of the shared data (`voorjou-many`).
        let generate: String?
        /// The voice fixture's dictated text. Not a route: transcription runs
        /// on the phone.
        let transcript: String?
    }

    static let apiPrefix = "/api/mobile/v1/"
    static let shared = "_shared"
    /// The bundled folder reference (project.yml).
    static let folderName = "FixtureData"

    let name: String
    let manifest: Manifest
    private let root: URL

    /// Nil when `name` is not a fixture folder with a `fixture.json`.
    init?(name: String, root: URL) {
        guard !name.isEmpty, name != Self.shared, !name.contains("/"), !name.hasPrefix("."),
              let data = try? Data(contentsOf: root.appending(path: name).appending(path: "fixture.json")),
              let manifest = try? JSONDecoder().decode(Manifest.self, from: data) else { return nil }
        self.name = name
        self.manifest = manifest
        self.root = root
    }

    static var bundledRoot: URL? {
        Bundle.main.url(forResource: folderName, withExtension: nil)
    }

    /// Every fixture in `root`, sorted.
    static func names(in root: URL) -> [String] {
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: root.path(percentEncoded: false))) ?? []
        return entries.filter { FixtureServer(name: $0, root: root) != nil }.sorted()
    }

    func reply(method: String, path rawPath: String) -> Reply {
        switch manifest.behavior ?? .files {
        case .offline: return .transportFailure
        case .unauthorized: return Self.error(401, "unauthorized")
        case .files: break
        }
        guard rawPath.hasPrefix(Self.apiPrefix) else { return Self.error(404, "not a fixture route") }
        let path = String(rawPath.dropFirst(Self.apiPrefix.count))
        // `..` or an empty segment would read outside the fixture folder.
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !path.isEmpty, segments.allSatisfy({ !$0.isEmpty && $0 != ".." && $0 != "." }) else {
            return Self.error(404, "not found")
        }
        if let status = manifest.statuses?[path] { return Self.error(status, "fixture status") }

        if method.uppercased() == "GET" {
            if let data = file(path + ".json") { return .json(status: 200, body: generated(path, data)) }
            for (ext, type) in Self.binaryTypes {
                if let data = file(path + "." + ext) { return .file(contentType: type, body: data) }
            }
            return Self.error(404, "not found")
        }
        return .json(status: 200, body: file(path + ".post.json") ?? Data("{}".utf8))
    }

    /// `<name>/<rel>`, else `_shared/<rel>`.
    private func file(_ rel: String) -> Data? {
        for folder in [name, Self.shared] {
            if let data = try? Data(contentsOf: root.appending(path: folder).appending(path: rel)) { return data }
        }
        return nil
    }

    private func generated(_ path: String, _ data: Data) -> Data {
        guard manifest.generate == "voorjou-many", path == "inbox" else { return data }
        return (try? FixtureGenerator.manyInbox(from: data)) ?? data
    }

    /// The non-JSON answers a fixture may hold, in lookup order.
    static let binaryTypes: [(String, String)] = [("pdf", "application/pdf"), ("jpg", "image/jpeg")]

    static func error(_ status: Int, _ message: String) -> Reply {
        .json(status: status, body: Data(#"{"error":"\#(message)"}"#.utf8))
    }
}

/// Generated rows, so the density of Voor jou is seen at production's real
/// scale (498 on 2026-10-31) without a 100 KB file nobody can read.
enum FixtureGenerator {
    static let manyCount = 498

    static let organisations = [
        "Bewindkantoor Noordkust", "Woonstichting Lindehof", "Incassobureau Kade & Partners",
        "Stroomnet Energie", "Gemeente Westerlaan", "Zorgverzekeraar Duinzorg", "Atelier Sterrenwacht",
    ]
    static let subjects = [
        "de betalingsregeling", "het leefgeld", "de huur", "de jaaropgaaf", "de polis",
        "de aanvraag bijzondere bijstand", "een herinnering", "de stukken",
    ]

    /// The shared inbox plus `manyCount - n` rows titled
    /// `Brief van <org> over <onderwerp> <n>`, appended AFTER the server's own
    /// order (the phone never re-ranks, so neither does the fixture).
    static func manyInbox(from data: Data) throws -> Data {
        guard var inbox = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              var items = inbox["items"] as? [[String: Any]] else { return data }
        let start = Date(timeIntervalSince1970: 1_793_347_200) // 2026-10-30T08:00:00Z
        var n = 1
        while items.count < manyCount {
            let org = organisations[(n - 1) % organisations.count]
            let subject = subjects[(n - 1) % subjects.count]
            let at = start.addingTimeInterval(-Double(n) * 3_600)
            items.append([
                "kind": n % 5 == 0 ? "task" : "suggestion",
                "id": String(format: "00000000-f1c5-4000-9000-%012d", n),
                "title": "Brief van \(org) over \(subject) \(n)",
                "subtitle": NSNull(),
                "priority": 3,
                "at": at.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)),
                "dueAt": NSNull(),
                "verder": false,
            ])
            n += 1
        }
        inbox["items"] = items
        inbox["count"] = items.count
        return try JSONSerialization.data(withJSONObject: inbox, options: [.sortedKeys])
    }
}
#endif
