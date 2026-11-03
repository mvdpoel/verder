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
/// The query string is ignored — one fixture is one state of the world —
/// EXCEPT where a fixture holds `<path>~<query>.json`: then a GET with exactly
/// that query reads it (the Tijdlijn's `?schuldeisers=verborgen`), so a
/// switch on screen shows its own answer in a capture.
struct FixtureServer: Sendable {
    enum Reply: Equatable, Sendable {
        case json(status: Int, body: Data)
        /// A document's bytes (`documents/<id>/file`), served from the
        /// fixture's `file.pdf` / `file.jpg` with that type, like the route's.
        case file(contentType: String, body: Data)
        /// No HTTP answer at all: the `offline` fixture.
        case transportFailure
        /// No answer EVER: the `loading` fixture, so the skeleton stays up.
        case never

        /// An HTTP error status (4xx/5xx).
        var isError: Bool {
            if case .json(let status, _) = self { return status >= 400 }
            return false
        }
    }

    struct Manifest: Decodable, Equatable, Sendable {
        enum Behavior: String, Decodable, Sendable { case files, offline, unauthorized, loading }

        /// How every request after a path's FIRST answer fails (`"offline"`
        /// or a status such as `503`): a board that loaded once and then lost
        /// its server, so the kept-board states can be captured.
        enum ThenFail: Decodable, Equatable, Sendable {
            case offline
            case status(Int)

            init(from decoder: Decoder) throws {
                let c = try decoder.singleValueContainer()
                if let code = try? c.decode(Int.self) { self = .status(code); return }
                guard try c.decode(String.self) == "offline" else {
                    throw DecodingError.dataCorruptedError(in: c, debugDescription: "thenFail is \"offline\" or a status")
                }
                self = .offline
            }
        }

        let description: String
        let behavior: Behavior?
        /// A status for a path instead of its file, e.g. `{"weekly": 404}` —
        /// the route's own answer before the first Sunday; `"POST <path>"`
        /// for one method only.
        let statuses: [String: Int]?
        /// A generated variant of the shared data (`voorjou-many`).
        let generate: String?
        /// The voice fixture's dictated text. Not a route: transcription runs
        /// on the phone.
        let transcript: String?
        let thenFail: ThenFail?
        /// With `thenFail`: the moment the first, good answers were given
        /// ("2026-10-31T21:14:00Z", the evening before the case's today), so a
        /// kept stand reads "bijgewerkt gisteren 22:14" instead of the
        /// capture's own minute. The clock reads it until the first failure,
        /// then the case's today (`FixtureEnvironment.clock(keptAt:)`).
        let keptAt: Date?
        /// Seconds after launch at which the phone reports no network
        /// (`UploadCenter.isOffline`), with `thenFail: "offline"`.
        let offlineAfter: Double?
        /// The case's "today" for this fixture instead of Sun 1 nov 09:41
        /// (`FixtureEnvironment.today`): the Weekoverzicht's states need a
        /// clock past that Sunday's 18:00, when week 44 has been composed.
        let today: Date?
        /// Paths that get no HTTP answer at all while the rest answer (the
        /// Tijdlijn offline over a dossier that syncs).
        let offlinePaths: [String]?
        /// Seeds the phone's copy of the case map, saved at this moment, before
        /// launch: the kept map an offline Tijdlijn shows with its age.
        let timelineCachedAt: Date?

        private enum Key: String, CodingKey {
            case description, behavior, statuses, generate, transcript, thenFail, keptAt, offlineAfter, today
            case offlinePaths, timelineCachedAt
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            description = try c.decode(String.self, forKey: .description)
            behavior = try c.decodeIfPresent(Behavior.self, forKey: .behavior)
            statuses = try c.decodeIfPresent([String: Int].self, forKey: .statuses)
            generate = try c.decodeIfPresent(String.self, forKey: .generate)
            transcript = try c.decodeIfPresent(String.self, forKey: .transcript)
            thenFail = try c.decodeIfPresent(ThenFail.self, forKey: .thenFail)
            offlineAfter = try c.decodeIfPresent(Double.self, forKey: .offlineAfter)
            keptAt = try c.decodeIfPresent(String.self, forKey: .keptAt).map { (raw: String) throws -> Date in
                guard let d = ISO8601DateFormatter().date(from: raw) else {
                    throw DecodingError.dataCorruptedError(forKey: .keptAt, in: c, debugDescription: "keptAt is ISO 8601")
                }
                return d
            }
            today = try c.decodeIfPresent(String.self, forKey: .today).map { (raw: String) throws -> Date in
                guard let d = ISO8601DateFormatter().date(from: raw) else {
                    throw DecodingError.dataCorruptedError(forKey: .today, in: c, debugDescription: "today is ISO 8601")
                }
                return d
            }
            offlinePaths = try c.decodeIfPresent([String].self, forKey: .offlinePaths)
            timelineCachedAt = try c.decodeIfPresent(String.self, forKey: .timelineCachedAt).map { (raw: String) throws -> Date in
                guard let d = ISO8601DateFormatter().date(from: raw) else {
                    throw DecodingError.dataCorruptedError(forKey: .timelineCachedAt, in: c,
                                                           debugDescription: "timelineCachedAt is ISO 8601")
                }
                return d
            }
        }
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

    /// `answeredBefore`: this fixture already answered this path once in this
    /// process — only `thenFail` reads it (`FixtureProtocol` keeps the count).
    func reply(method: String, path rawPath: String, query: String? = nil, answeredBefore: Bool = false) -> Reply {
        switch manifest.behavior ?? .files {
        case .offline: return .transportFailure
        case .unauthorized: return Self.error(401, "unauthorized")
        case .loading: return .never
        case .files: break
        }
        switch answeredBefore ? manifest.thenFail : nil {
        case .offline?: return .transportFailure
        case .status(let code)?: return Self.error(code, "fixture failure")
        case nil: break
        }
        guard rawPath.hasPrefix(Self.apiPrefix) else { return Self.error(404, "not a fixture route") }
        let path = String(rawPath.dropFirst(Self.apiPrefix.count))
        // `..` or an empty segment would read outside the fixture folder.
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !path.isEmpty, segments.allSatisfy({ !$0.isEmpty && $0 != ".." && $0 != "." }) else {
            return Self.error(404, "not found")
        }
        if manifest.offlinePaths?.contains(path) == true { return .transportFailure }
        // `"POST push/preferences": 503` fails one method only (a save that
        // fails over a read that works).
        if let status = manifest.statuses?["\(method.uppercased()) \(path)"] ?? manifest.statuses?[path] {
            return Self.error(status, "fixture status")
        }

        if method.uppercased() == "GET" {
            // A query names a file only when it cannot leave the folder.
            if let query, !query.isEmpty, !query.contains("/"), !query.contains(".."),
               let data = file(path + "~" + query + ".json") {
                return .json(status: 200, body: generated(path, data))
            }
            if let data = file(path + ".json") { return .json(status: 200, body: generated(path, data)) }
            for (ext, type) in Self.binaryTypes {
                if let data = file(path + "." + ext) { return .file(contentType: type, body: data) }
            }
            return Self.error(404, "not found")
        }
        return .json(status: 200, body: file(path + ".post.json") ?? Data("{}".utf8))
    }

    /// The fixture's own answer to a GET of `path` (no failure applied): what
    /// `timelineCachedAt` seeds the phone's copy from.
    func body(_ path: String) -> Data? { file(path + ".json") }

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
