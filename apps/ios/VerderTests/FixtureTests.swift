import Testing
import Foundation
@testable import Verder

/// The DEBUG fixtures (`-fixtures <name>`): every fixture decodes into the
/// app's REAL DTOs, the money in them reconciles the way /money's does, the
/// data is the synthetic case and nothing else, and the launch arguments parse
/// strictly. Release isolation is `FixtureIsolationTests`.
@MainActor
struct FixtureTests {
    static let root = FixtureServer.bundledRoot!

    /// docs/superpowers/specs/2026-11-01-iphone-synthetic-data.md and the task
    /// that asked for them.
    nonisolated static let expectedNames = [
        "calm", "dossier", "empty", "loading", "meer-account-fails", "meer-no-passkey", "meer-offline", "meer-save-fails", "money-complete", "money-empty", "money-geen-data", "money-no-account",
        "money-no-budget", "money-overspent", "money-partial", "money-unrecognised", "offline", "offline-cached",
        "one-item", "server-error", "server-error-cached", "timeline", "timeline-fout", "timeline-offline",
        "timeline-vier", "unauthorized", "voice", "voorjou-een", "voorjou-few", "voorjou-fout", "voorjou-laden", "voorjou-lang",
        "voorjou-leeg", "voorjou-long", "voorjou-many", "voorjou-offline", "voorjou-selecteren", "voorjou-storing", "voorjou-veel", "voorjou-vijf", "voorstel", "voorstel-offline", "weekly", "weekly-eerste", "weekly-fout", "weekly-loading",
        "weekly-offline-kept", "weekly-offline-missing", "weekly-rustig", "weekly-tweede",
    ]
    static let reply = "00000000-f1c5-4000-8000-000000000001"
    static let question = "00000000-f1c5-4000-8000-000000000002"
    static let suggestion = "00000000-f1c5-4000-8000-000000000003"
    static let task = "00000000-f1c5-4000-8000-000000000004"

    static func server(_ name: String) throws -> FixtureServer {
        try #require(FixtureServer(name: name, root: root), "no fixture \(name)")
    }

    /// The body of a 200, or nil for any other answer.
    static func body(_ name: String, _ path: String, method: String = "GET") throws -> Data? {
        guard case .json(200, let body) = try server(name).reply(method: method, path: FixtureServer.apiPrefix + path)
        else { return nil }
        return body
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String, _ path: String, method: String = "GET") throws -> T {
        let data = try #require(try body(name, path, method: method), "\(name): \(method) \(path) did not answer 200")
        return try APIClient.jsonDecoder.decode(T.self, from: data)
    }

    nonisolated static var fileFixtures: [String] {
        expectedNames.filter { !["offline", "unauthorized", "loading", "server-error", "weekly-loading",
                                "timeline-fout", "timeline-offline", "voorjou-fout", "voorjou-laden", "voorjou-offline",
                                "voorjou-storing"].contains($0) }
    }

    // MARK: - The set

    @Test func everyFixtureTheDataDocNamesIsBundled() {
        #expect(FixtureServer.names(in: Self.root) == Self.expectedNames)
    }

    /// `offlinePaths`: one route gets no answer at all while the rest answer.
    @Test func anOfflinePathFailsAloneAndTheCacheSeedIsReadable() throws {
        let s = try Self.server("timeline-offline")
        #expect(s.reply(method: "GET", path: FixtureServer.apiPrefix + "case-map") == .transportFailure)
        #expect(s.reply(method: "GET", path: FixtureServer.apiPrefix + "inbox").isError == false)
        #expect(s.manifest.timelineCachedAt != nil)
        let data = try #require(s.body("case-map"))
        #expect(try APIClient.jsonDecoder.decode(CaseMapDTO.self, from: data).stops.count == 14)
    }

    /// `"POST push/preferences": 503`: the save fails, the read still answers.
    @Test func aStatusCanFailOneMethodOnly() throws {
        let s = try Self.server("meer-save-fails")
        #expect(s.reply(method: "POST", path: FixtureServer.apiPrefix + "push/preferences").isError)
        #expect(!s.reply(method: "GET", path: FixtureServer.apiPrefix + "push/preferences").isError)
        let dto = try Self.decode(PushPreferencesDTO.self, "meer-save-fails", "push/preferences")
        #expect(dto.muted == ["CREDITOR_MAIL", "FILING"])
        #expect(try Self.decode(AccountDTO.self, "meer-no-passkey", "me").passkeys == 0)
        #expect(try Self.server("meer-offline").manifest.offlineAfter == 2)
    }

    @Test func sharedIsNotAFixtureAndPathsCannotEscape() throws {
        #expect(FixtureServer(name: "_shared", root: Self.root) == nil)
        #expect(FixtureServer(name: "../FixtureData", root: Self.root) == nil)
        let s = try Self.server("voorjou-few")
        #expect(s.reply(method: "GET", path: "/api/mobile/v1/../voorjou-few/fixture") == FixtureServer.error(404, "not found"))
        #expect(s.reply(method: "GET", path: "/api/auth/get-session") == FixtureServer.error(404, "not a fixture route"))
        #expect(s.reply(method: "GET", path: "/api/mobile/v1/no-such-route") == FixtureServer.error(404, "not found"))
    }

    /// `<path>~<query>.json` answers a request WITH that query, so the
    /// Tijdlijn's "Schuldeisers verbergen" shows the filtered map in a capture;
    /// without the file the query is ignored, as before.
    @Test func aQueryVariantAnswersItsOwnQuery() throws {
        let s = try Self.server("timeline")
        let path = FixtureServer.apiPrefix + "case-map"
        guard case .json(200, let hiddenBody) = s.reply(method: "GET", path: path, query: "schuldeisers=verborgen"),
              case .json(200, let shownBody) = s.reply(method: "GET", path: path) else {
            Issue.record("case-map did not answer"); return
        }
        let hidden = try APIClient.jsonDecoder.decode(CaseMapDTO.self, from: hiddenBody)
        let shown = try APIClient.jsonDecoder.decode(CaseMapDTO.self, from: shownBody)
        #expect(hidden.debtEpisodesHidden && !shown.debtEpisodesHidden)
        #expect(s.reply(method: "GET", path: FixtureServer.apiPrefix + "me", query: "x=1")
                == s.reply(method: "GET", path: FixtureServer.apiPrefix + "me"))
        // A query cannot name a file outside the fixture.
        #expect(s.reply(method: "GET", path: path, query: "../../x") == s.reply(method: "GET", path: path))
    }

    /// The data doc's case: the hoofdlijn's open stop is the headline, the
    /// ended Lindehof spoor is a clean outcome, and hiding schuldeisers drops
    /// the Kade & Partners spoor and its trigger.
    @Test func theTimelineIsTheDataDocsCase() throws {
        let map = try Self.decode(CaseMapDTO.self, "timeline", "case-map")
        let current = try #require(map.stops.first { $0.id == map.currentStopId })
        #expect(current.title == "Stukken aanleveren bij Team Startdossier")
        #expect(map.tracks.first { $0.isRoot }?.title == "Bewindvoering")
        #expect(map.tracks.first { $0.title == "Huurachterstand Lindehof" }?.terminus == "ended")
        #expect(map.tracks.first { $0.title == "Aanvraag bewindvoering" }?.terminus == "merge")
        let hidden = try Self.decode(CaseMapDTO.self, "timeline", "case-map~schuldeisers=verborgen")
        #expect(!hidden.stops.contains { $0.title.contains("Kade & Partners") })
        #expect(!hidden.tracks.contains { $0.title == "Vordering Kade & Partners" })
        let empty = try Self.decode(CaseMapDTO.self, "empty", "case-map")
        #expect(empty.stops.isEmpty)
    }

    // MARK: - Decoding into the real DTOs

    @Test(arguments: fileFixtures)
    func everyFixtureDecodesIntoTheAppDTOs(_ name: String) throws {
        let inbox = try Self.decode(InboxDTO.self, name, "inbox")
        #expect(inbox.count == inbox.items.count)
        _ = try Self.decode(DashboardSummaryDTO.self, name, "dashboard/summary")
        _ = try Self.decode([TaskDTO].self, name, "tasks")
        _ = try Self.decode(ProposalList.self, name, "proposals")
        // Every row of the case that opens a screen has that screen's data.
        for item in inbox.items where item.id.hasPrefix("00000000-f1c5-4000-8000-") {
            switch item.kind {
            case .proposal, .question:
                let d = try Self.decode(ProposalDetail.self, name, "proposals/\(item.id)")
                #expect(d.id == item.id)
            case .suggestion:
                let d = try Self.decode(SuggestionDTO.self, name, "suggestions/\(item.id)")
                #expect(d.id == item.id)
            case .task:
                let tasks = try Self.decode([TaskDTO].self, name, "tasks")
                #expect(tasks.contains { $0.id == item.id })
            default: break
            }
        }
        _ = try Self.decode(Ignored.self, name, "push/register", method: "POST")
        _ = try Self.decode(UploadResponse.self, name, "documents", method: "POST")
        _ = try Self.decode([PartyDTO].self, name, "parties")
        // meer-account-fails answers /me with its 503 by design.
        if name != "meer-account-fails" { _ = try Self.decode(AccountDTO.self, name, "me") }
        _ = try Self.decode(CaseMapDTO.self, name, "case-map")
        _ = try Self.decode(VoiceEntryAnswer.self, name, "entries/voice", method: "POST")
        // Every fixture holds a summary but `empty` and `weekly-eerste`
        // (404: no Sunday yet) and `weekly-fout` (503 by design).
        if let weekly = try Self.body(name, "weekly") {
            _ = try APIClient.jsonDecoder.decode(WeeklyDTO.self, from: weekly)
        } else {
            #expect(["empty", "weekly-eerste", "weekly-fout"].contains(name))
        }
    }

    @Test func theFewCaseIsTheDataDocsFourInServerOrder() throws {
        let inbox = try Self.decode(InboxDTO.self, "voorjou-few", "inbox")
        #expect(inbox.items.map(\.id) == [Self.reply, Self.question, Self.suggestion, Self.task])
        #expect(inbox.items.map(\.kind) == [.proposal, .question, .suggestion, .task])
        #expect(inbox.items[0].verder)
        #expect(inbox.doneByVerder.count == 3)
        let summary = try Self.decode(DashboardSummaryDTO.self, "voorjou-few", "dashboard/summary")
        #expect(summary.headline?.stopTitle == "Stukken aanleveren bij Team Startdossier")
        #expect(summary.tasks == .init(openCount: 6, overdueCount: 1, waitingOnOthersCount: 2))
        let tasks = try Self.decode([TaskDTO].self, "voorjou-few", "tasks")
        #expect(tasks.filter { $0.status == "open" }.count == 6)
        #expect(tasks.filter { $0.status == "waiting" }.count == 2)
        let q = try Self.decode(ProposalDetail.self, "voorjou-few", "proposals/\(Self.question)")
        #expect(q.options.map(\.label) == ["Ja, koppel hem", "Nee", "Weet ik niet"])
        let status = try Self.decode(TaskStatusResponse.self, "voorjou-few", "tasks/\(Self.task)/status", method: "POST")
        #expect(status.taskId == Self.task)
    }

    @Test func manyIsTheProductionCountWithTheFourOnTop() throws {
        let many = try Self.decode(InboxDTO.self, "voorjou-many", "inbox")
        let few = try Self.decode(InboxDTO.self, "voorjou-few", "inbox")
        #expect(many.count == 498)
        #expect(many.items.count == 498)
        #expect(Array(many.items.prefix(4)) == few.items)
        #expect(Set(many.items.map(\.id)).count == 498)
        #expect(many.items[4].title.hasPrefix("Brief van "))
        let summary = try Self.decode(DashboardSummaryDTO.self, "voorjou-many", "dashboard/summary")
        #expect(summary.waitingCount == 498)
    }

    @Test func longCarriesTheLongDutchTitle() throws {
        let inbox = try Self.decode(InboxDTO.self, "voorjou-long", "inbox")
        #expect(inbox.items[0].title.count > 120)
        #expect(inbox.items[0].title.hasPrefix("Antwoord aan Bewindkantoor Noordkust over de aanvullende stukken"))
    }

    @Test func emptyHasNothingAndNoWeeklySummaryYet() throws {
        let inbox = try Self.decode(InboxDTO.self, "empty", "inbox")
        #expect(inbox.count == 0 && inbox.items.isEmpty && inbox.doneByVerder.isEmpty)
        #expect(try Self.server("empty").reply(method: "GET", path: "/api/mobile/v1/weekly")
                == FixtureServer.error(404, "fixture status"))
    }

    @Test func offlineFailsEveryRequestAndUnauthorizedAnswers401() throws {
        for path in ["inbox", "dashboard/summary", "proposals/\(Self.reply)"] {
            #expect(try Self.server("offline").reply(method: "GET", path: FixtureServer.apiPrefix + path) == .transportFailure)
            guard case .json(401, _) = try Self.server("unauthorized").reply(method: "GET", path: FixtureServer.apiPrefix + path)
            else { Issue.record("unauthorized did not answer 401 for \(path)"); continue }
        }
    }

    /// Overzicht's states: nothing answered (the skeleton), a server that
    /// fails from the start, and a board that loaded ONCE and then lost its
    /// server or its connection — the first answer is the base case's.
    @Test func overzichtFailureStatesAnswerAsTheyClaim() throws {
        let inbox = FixtureServer.apiPrefix + "inbox"
        #expect(try Self.server("loading").reply(method: "GET", path: inbox) == .never)
        #expect(try Self.server("server-error").reply(method: "GET", path: inbox) == FixtureServer.error(503, "fixture status"))
        #expect(try Self.server("server-error-cached").reply(method: "GET", path: inbox, answeredBefore: true)
                == FixtureServer.error(503, "fixture failure"))
        #expect(try Self.server("offline-cached").reply(method: "GET", path: inbox, answeredBefore: true) == .transportFailure)
        // The kept stand is the evening before the case's today (Geld / offline:
        // "bijgewerkt gisteren 22:14", "de stand van gisteravond").
        let kept = try #require(try Self.server("offline-cached").manifest.keptAt)
        #expect(HomeSummary.stamp(kept, now: FixtureEnvironment.today) == "gisteren 22:14")
        #expect(try Self.server("voorjou-few").manifest.keptAt == nil)
        // The first answer is the ordinary one, and a fixture without
        // `thenFail` never fails on a repeat.
        #expect(try Self.body("server-error-cached", "inbox") == Self.body("voorjou-few", "inbox"))
        guard case .json(200, _) = try Self.server("voorjou-few").reply(method: "GET", path: inbox, answeredBefore: true)
        else { Issue.record("a repeat on an ordinary fixture failed"); return }
    }

    @Test func calmAndOneItemAreTheOverzichtFrames() throws {
        let calm = try Self.decode(InboxDTO.self, "calm", "inbox")
        #expect(calm.count == 0 && calm.doneByVerder.count == 3)
        #expect(calm.lastClearedAt == ISO8601DateFormatter().date(from: "2026-11-01T07:20:00Z"),
                "the calm card's 'jij was klaar · vandaag 08:20'")
        #expect(try Self.decode(DashboardSummaryDTO.self, "calm", "dashboard/summary").tasks
                == .init(openCount: 0, overdueCount: 0, waitingOnOthersCount: 2))
        let one = try Self.decode(InboxDTO.self, "one-item", "inbox")
        #expect(one.items.map(\.id) == [Self.reply])
        #expect(try Self.decode(DashboardSummaryDTO.self, "one-item", "dashboard/summary").waitingCount == 1)
    }

    // MARK: - Routes with no iOS DTO yet: the server's contract, key for key

    /// The JSON object at `path`, or a recorded failure.
    static func object(_ name: String, _ path: String) throws -> [String: JSONValue] {
        let value = try decode(JSONValue.self, name, path)
        guard case .object(let o) = value else { throw FixtureError.notAnObject(path) }
        return o
    }

    static func keys(_ v: JSONValue?) -> Set<String> {
        if case .object(let o)? = v { return Set(o.keys) }
        return []
    }

    static func ints(_ v: JSONValue?) -> Int? {
        if case .number(let n)? = v, n == n.rounded() { return Int(n) }
        return nil
    }

    static func array(_ v: JSONValue?) -> [JSONValue] {
        if case .array(let a)? = v { return a }
        return []
    }

    static let disclosedRowKeys: Set<String> = ["id", "bookedAt", "amountCents", "counterpartyName"]
    static let monthKeys: Set<String> = ["month", "coverage", "inCents", "outCents", "outByCategory", "incidentalCents",
                                         "internalCents", "parseErrorRows", "internalRows", "incidentalRows",
                                         "outRows", "inSources"]
    static let inSourceKeys: Set<String> = ["label", "count", "cadence", "fromAccountIban"]

    /// `MoneySummaryDTO` (apps/web/src/app/api/mobile/v1/money/summary/route.ts),
    /// `MonthSeries` (money-series.ts) and `LeefgeldWeek` (leefgeld-week.ts).
    /// Every total is the sum of its disclosed rows, and there is NO total
    /// across accounts — the same laws as /money.
    @Test(arguments: ["money-complete", "money-partial", "money-geen-data", "money-empty", "money-no-account",
                      "money-no-budget", "money-overspent", "money-unrecognised", "empty", "offline-cached"])
    func moneyMatchesTheRouteContractAndReconciles(_ name: String) throws {
        let m = try Self.object(name, "money/summary")
        #expect(Set(m.keys) == ["accounts", "leefgeld", "previousWeek", "newestBooking"])
        for account in Self.array(m["accounts"]) {
            #expect(Self.keys(account) == ["accountIban", "months", "newestBooking", "isLeefgeldAccount"])
            #expect(account["accountIban"]?.string?.hasPrefix("NL00TEST") == true)
            // An account's own newest booking is never newer than the table's.
            if let own = account["newestBooking"]?.string {
                #expect(own <= (m["newestBooking"]?.string ?? ""), "\(name): an account newer than the whole table")
            }
            for month in Self.array(account["months"]) {
                #expect(Self.keys(month) == Self.monthKeys)
                #expect(["complete", "partial", "none"].contains(month["coverage"]?.string ?? ""))
                // A month with no rows is `none` ("geen data"), never a covered
                // € 0,00: the GELD card would draw "nov '26 deels · in € 0,00".
                if month["coverage"]?.string != "none" {
                    #expect(Self.ints(month["inCents"]) != 0 || Self.ints(month["outCents"]) != 0,
                            "\(name) \(month["month"]?.string ?? "?"): a covered month with no money is a month with no rows")
                }
                // The captions (mobile-money-meta.ts) describe the bars they
                // sit under: income has a source exactly when it has money,
                // and a month with no rows counts no bookings.
                let sources = Self.array(month["inSources"])
                #expect(sources.allSatisfy { Self.keys($0) == Self.inSourceKeys })
                #expect(sources.isEmpty == (Self.ints(month["inCents"]) == 0))
                if month["coverage"]?.string == "none" { #expect(Self.ints(month["outRows"]) == 0) }
                #expect((Self.ints(month["outRows"]) ?? 0) > 0 || Self.ints(month["outCents"]) == 0)
                let cats = Self.array(month["outByCategory"]).compactMap { Self.ints($0["cents"]) }
                #expect(cats.reduce(0, +) == Self.ints(month["outCents"]))
                for (total, rows) in [("incidentalCents", "incidentalRows"), ("internalCents", "internalRows")] {
                    let list = Self.array(month[rows])
                    #expect(list.allSatisfy { Self.keys($0) == Self.disclosedRowKeys })
                    #expect(list.compactMap { Self.ints($0["amountCents"]) }.reduce(0, +) == Self.ints(month[total]))
                }
            }
        }
        for weekKey in ["leefgeld", "previousWeek"] {
            let w = try #require(m[weekKey])
            switch w["state"]?.string {
            case "complete", "partial":
                #expect(Self.keys(w) == ["state", "accountIban", "accountReason", "week", "coveredThrough", "budgetCents",
                                         "spentCents", "leftCents", "spentRows", "depositCents", "depositRows"])
                let spent = Self.array(w["spentRows"]).compactMap { Self.ints($0["amountCents"]) }
                #expect(spent.allSatisfy { $0 < 0 }, "spentRows are amounts as booked (negative)")
                #expect(-spent.reduce(0, +) == Self.ints(w["spentCents"]))
                #expect(Self.ints(w["leftCents"]) == (Self.ints(w["budgetCents"]) ?? 0) - (Self.ints(w["spentCents"]) ?? 0))
                let deposits = Self.array(w["depositRows"]).compactMap { Self.ints($0["amountCents"]) }
                #expect(deposits.reduce(0, +) == Self.ints(w["depositCents"]))
            case "geen-data":
                #expect(Self.keys(w) == ["state", "accountIban", "accountReason", "week", "newestBooking"])
            case "no-account": #expect(Self.keys(w) == ["state", "candidates"])
            case "no-budget": #expect(Self.keys(w) == ["state"])
            default: Issue.record("\(name) \(weekKey): unknown state")
            }
        }
    }

    @Test func moneyStatesAreTheOnesTheDataDocNames() throws {
        func state(_ name: String) throws -> String? { try Self.object(name, "money/summary")["leefgeld"]?["state"]?.string }
        #expect(try state("money-complete") == "complete")
        #expect(try state("money-partial") == "partial")
        #expect(try Self.object("money-partial", "money/summary")["leefgeld"]?["coveredThrough"]?.string == "2026-10-29")
        #expect(try state("money-geen-data") == "geen-data")
        #expect(try Self.object("money-geen-data", "money/summary")["newestBooking"]?.string == "2026-10-18")
        let complete = try Self.object("money-complete", "money/summary")["leefgeld"]
        #expect(Self.ints(complete?["spentCents"]) == 6240 && Self.ints(complete?["leftCents"]) == 3760)
        #expect(Self.array(try Self.object("money-empty", "money/summary")["accounts"]).isEmpty)
        // Production's state once P3-D3 sets the budget: no rows, no IBAN.
        #expect(try state("money-no-account") == "no-account")
        #expect(Self.array(try Self.object("money-no-account", "money/summary")["leefgeld"]?["candidates"]).isEmpty)
        #expect(try Self.object("money-no-account", "money/summary")["newestBooking"] == .null)
        #expect(Self.array(try Self.object("money-unrecognised", "money/summary")["leefgeld"]?["candidates"]).count == 2)
        #expect(try state("money-no-budget") == "no-budget")
        #expect(Self.ints(try Self.object("money-overspent", "money/summary")["leefgeld"]?["leftCents"]) == -1240)
    }

    /// `DossierDelta`/`DossierText` (routers/dossier-sync.ts), `SearchDTO`
    /// (mobile-dto.ts), `WeeklySummary` (weekly-summary.ts), the parties route
    /// and the voice route's answer.
    @Test func dossierWeeklyAndVoiceMatchTheRouteContracts() throws {
        let sync = try Self.object("dossier", "documents/sync")
        #expect(Set(sync.keys) == ["cursor", "more", "upserts", "tombstones"])
        let docs = Self.array(sync["upserts"])
        #expect(docs.count == 12)
        #expect(docs.allSatisfy {
            Self.keys($0) == ["id", "title", "docType", "status", "receivedAt", "mime", "sizeBytes", "sha256", "hasText"]
        })
        #expect(docs.allSatisfy { ["inbox", "filed"].contains($0["status"]?.string ?? "") })
        let texts = try Self.decode(JSONValue.self, "dossier", "documents/texts")
        #expect(Self.array(texts).allSatisfy { Self.keys($0) == ["id", "text", "truncated"] })

        let search = try Self.object("dossier", "search")
        #expect(Set(search.keys) == ["hits", "nextCursor"])
        let hits = Self.array(search["hits"])
        #expect(hits.count == 2)
        for hit in hits {
            #expect(Self.keys(hit) == ["entityType", "entityId", "title", "snippet", "occurredAt", "status", "link"])
            // `link` is a route the app's own strict parser accepts.
            #expect(DeepLink.parse(hit["link"]?.string ?? "") != .none)
        }

        let weekly = try Self.object("weekly", "weekly")
        // `history` and `renamedByVerder` are the two fields the "weekly ·
        // final" frames need beyond packages/api/src/weekly-summary.ts; the
        // phone treats them as optional (`WeeklyDTO`).
        #expect(Set(weekly.keys) == ["week", "from", "to", "sent", "received", "filedByMartin", "filedByVerder",
                                     "tasksDone", "waiting", "topWaiting", "history", "renamedByVerder"])
        #expect(weekly["week"]?.string == "2026-W44")
        let top = try JSONDecoder.verder.decode([WaitingItem].self,
                                                from: JSONEncoder().encode(weekly["topWaiting"] ?? .null))
        #expect(top.map(\.id) == [Self.reply, Self.question, Self.suggestion])

        let parties = try Self.decode(JSONValue.self, "voice", "parties")
        #expect(Self.array(parties).map { $0["name"]?.string } ==
                ["Woonstichting Lindehof", "Bewindkantoor Noordkust", "Incassobureau Kade & Partners"])
        #expect(Self.array(parties).allSatisfy {
            Self.keys($0) == ["id", "kind", "name", "organization", "lastContactAt"]
        })
        let voice = try Self.decode(JSONValue.self, "voice", "entries/voice", method: "POST")
        #expect(Self.keys(voice) == ["suggestionId", "audioDocumentId", "duplicate"])
        #expect(try Self.server("voice").manifest.transcript?.hasPrefix("Gebeld met Woonstichting Lindehof.") == true)
    }

    // MARK: - The pocket dossier

    /// Every document in the delta has its bytes, and they hash to the delta's
    /// sha256 — the check the phone makes on every download.
    /// `scripts/make-dossier-fixtures.swift` writes all three files at once.
    @Test func dossierFilesAreServedAndHashToTheirSha() throws {
        let sync = try Self.decode(DossierDelta.self, "dossier", "documents/sync")
        #expect(sync.upserts.count == 12)
        for doc in sync.upserts {
            guard case .file("application/pdf", let body) = try Self.server("dossier")
                .reply(method: "GET", path: FixtureServer.apiPrefix + "documents/\(doc.id)/file") else {
                Issue.record("\(doc.title): no file"); continue
            }
            #expect(DossierStore.sha256Hex(body) == doc.sha256, "\(doc.title)")
            #expect(body.count == doc.sizeBytes, "\(doc.title)")
        }
        let texts = try Self.decode([DossierText].self, "dossier", "documents/texts")
        #expect(Set(texts.map(\.id)) == Set(sync.upserts.filter(\.hasText).map(\.id)))
        #expect(sync.upserts.filter { !$0.hasText }.map(\.title) == ["ID-kaart"])
    }

    /// The data doc's promise, through the real store and the real search:
    /// twelve documents, and "bijstand" finds two.
    @Test func theRealDossierStoreSyncsTheFixture() async throws {
        let dir = URL.temporaryDirectory.appending(path: "dossier-fixture-\(UUID().uuidString)", directoryHint: .isDirectory)
        let store = DossierStore(dir: dir)
        try await store.sync(client: FixtureEnvironment.client(fixture: "dossier"))
        #expect(await store.documents().count == 12)
        #expect(await store.cursor == 412)
        let indexed = await store.indexed()
        #expect(indexed.filter { $0.text != nil }.count == 11)
        #expect(Set(DossierSearch.search("bijstand", in: indexed).map(\.doc.title)) ==
                ["Formulier bijzondere bijstand", "Bevestiging aanmelding Noordkust"])
        let open = DossierCopy.openTasks(try Self.decode([TaskDTO].self, "dossier", "tasks"))
        #expect(open.count == 6)
    }

    // MARK: - Synthetic only

    /// Simulator screenshots and Figma frames leave this machine: no real
    /// name, organisation, address or IBAN may be in a fixture.
    @Test func fixturesHoldOnlyTheSyntheticCase() throws {
        let files = FileManager.default.enumerator(at: Self.root, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "json" } ?? []
        #expect(files.count > 20)
        let denied = ["vanderpoel", "martin", "verdergroep", "verder bewind", "verderbewind", "woonhave", "truefullstaq",
                      "regio 3", "stam", "het cak", "plm", "kamer van koophandel", "abn", "loondossier", "saurens",
                      "almere", "nltz", "gmail"]
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            let lower = text.lowercased()
            // Whole words: the contract's own key `filedByMartin` is not a name.
            for word in denied {
                let pattern = try Regex("\\b" + NSRegularExpression.escapedPattern(for: word) + "\\b")
                #expect(!lower.contains(pattern), "\(file.lastPathComponent) mentions \(word)")
            }
            for match in text.matches(of: /[A-Z]{2}\d{2}[A-Z]{4}\d{6,}/) {
                #expect(text[match.range].hasPrefix("NL00TEST"), "\(file.lastPathComponent): IBAN outside the test range")
            }
            for match in text.matches(of: /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)/) {
                #expect(match.output.1.hasSuffix(".example"), "\(file.lastPathComponent): a real mail domain")
            }
        }
    }

    /// The real case's dates are as identifying as its names (commit 0aba9f3
    /// took the beschikking's date out; the aanmelding's survived it): the
    /// aanmelding (16-04), the stukken to the rechtbank (24-04), the
    /// beschikking (14-07) and the zaak number. Scanned in the JSON AND in the
    /// generated PDFs, in ISO and Dutch spellings.
    @Test func fixturesHoldNoRealCaseDate() throws {
        let files = FileManager.default.enumerator(at: Self.root, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }.filter { ["json", "pdf"].contains($0.pathExtension) } ?? []
        #expect(files.contains { $0.pathExtension == "pdf" })
        let denied = [/04-16/, /16-04/, /\b16 apr/, /04-24/, /24-04/, /\b24 apr/, /07-14/, /14-07/, /\b14 jul/, /2612548/]
        for file in files {
            let lower = String(decoding: try Data(contentsOf: file), as: UTF8.self).lowercased()
            for pattern in denied {
                #expect(!lower.contains(pattern), "\(file.path(percentEncoded: false)) carries a real case date")
            }
        }
    }

    // MARK: - Through the real stores

    @Test func theRealInboxStoreReadsAFixture() async throws {
        let store = InboxStore(client: FixtureEnvironment.client(fixture: "voorjou-few"), snapshotDir: nil, setBadge: { _ in })
        await store.refresh()
        #expect(store.lastError == nil)
        #expect(store.inbox?.count == 4)
        #expect(store.summary?.tasks.overdueCount == 1)
    }

    @Test func offlineIsATransportErrorInTheStore() async {
        let store = InboxStore(client: FixtureEnvironment.client(fixture: "offline"), snapshotDir: nil, setBadge: { _ in })
        await store.refresh()
        guard case .transport? = store.lastError else { Issue.record("expected transport, got \(String(describing: store.lastError))"); return }
        #expect(store.inbox == nil)
    }

    @Test func unauthorizedSignsOutThroughTheStore() async {
        final class Seen { var rejected = 0 }
        let seen = Seen()
        let store = InboxStore(client: FixtureEnvironment.client(fixture: "unauthorized"), snapshotDir: nil,
                               setBadge: { _ in }, onUnauthorized: { seen.rejected += 1 })
        await store.refresh()
        #expect(store.lastError == .unauthorized)
        #expect(seen.rejected == 1)
    }

    @Test func theProposalScreenModelLoadsTheFixtureReply() async throws {
        let model = ProposalModel(client: FixtureEnvironment.client(fixture: "voorjou-few"), gate: ApprovalGate())
        await model.load(id: Self.reply)
        #expect(model.detail?.payload?.reply?.attachmentDocumentIds.count == 1)
    }

    @Test func fixtureServicesPresentASignedInUnlockedApp() {
        let unlocked = FixtureEnvironment.services(for: FixtureLaunch(fixture: "voorjou-few", locked: false, tab: nil, route: nil))
        #expect(unlocked.store.load()?.isLive() == true)
        #expect(!unlocked.lock.isLocked)
        #expect(unlocked.lock.revealsCaseContent)
        #expect(unlocked.snapshotDir == nil)
        let locked = FixtureEnvironment.services(for: FixtureLaunch(fixture: "voorjou-few", locked: true, tab: nil, route: nil))
        #expect(locked.lock.isLocked)
        #expect(!locked.lock.revealsCaseContent)
    }

    @Test func lockedFixtureDeclinesTheAutomaticPromptOnlyOnce() async {
        let lock = AppLock(authenticator: FixtureOwner(declinesFirst: true))
        await lock.autoPromptIfNeeded()
        #expect(lock.isLocked)
        #expect(lock.message == nil)
        await lock.unlock()
        #expect(!lock.isLocked)
    }

    // MARK: - Launch arguments

    @Test func withoutFixturesNothingElseApplies() throws {
        #expect(try FixtureLaunch.parse(["Verder", "-tab", "meer", "-route", "geld"]) == nil)
    }

    @Test func parsesFixtureTabRouteAndLock() throws {
        let l = try #require(try FixtureLaunch.parse(["Verder", "-fixtures", "money-partial", "-tab", "voorjou",
                                                      "-route", "proposal:\(Self.reply)", "-fixtures-locked"]))
        #expect(l.fixture == "money-partial")
        #expect(l.locked)
        #expect(l.tab == .voorjou)
        #expect(l.tab?.tabID == .voorJou)
        #expect(l.route == .link(.proposal(UUID(uuidString: Self.reply)!)))
        #expect(l.scroll == nil && !l.scans)
        let board = try #require(try FixtureLaunch.parse(["Verder", "-fixtures", "voorjou-few", "-fixtures-scroll", "end",
                                                          "-fixtures-scans"]))
        #expect(board.scroll == .end && board.scans)
        let geld = try #require(try FixtureLaunch.parse(["Verder", "-fixtures", "money-partial", "-fixtures-geld", "nov"]))
        #expect(geld.geld == .nov)
        #expect(FixtureLaunch.GeldState.allCases.map(\.rawValue) == ["open", "nov", "sep", "sheet"], "capture.sh's --geld grammar")
        #expect(throws: FixtureLaunch.ParseError.unknownValue("-fixtures-geld", "okt")) {
            try FixtureLaunch.parse(["-fixtures", "x", "-fixtures-geld", "okt"])
        }
        let asking = try #require(try FixtureLaunch.parse(["Verder", "-fixtures", "money-complete", "-fixtures-locked",
                                                           "-fixtures-faceid", "asking"]))
        #expect(asking.faceID == .asking && asking.locked)
        #expect(FixtureLaunch.FaceIDState.allCases.map(\.rawValue) == ["asking", "idle", "nopasscode"], "capture.sh's --faceid grammar")
        #expect(throws: FixtureLaunch.ParseError.unknownValue("-fixtures-faceid", "ja")) {
            try FixtureLaunch.parse(["-fixtures", "x", "-fixtures-faceid", "ja"])
        }
        #expect(FixtureLaunch.Scroll.allCases.map(\.rawValue) == ["waiting", "leefgeld", "rest", "end", "middle"],
                "capture.sh's --scroll grammar")
        let meer = try #require(try FixtureLaunch.parse(["Verder", "-fixtures", "meer-offline", "-route", "meer:developer",
                                                         "-fixtures-push", "denied", "-fixtures-more", "signout"]))
        #expect(meer.route == .meer([.about, .developer]))
        #expect(meer.push == .denied && meer.more == .signOut)
        #expect(try FixtureLaunch.parseRoute("meer:account") == .meer([.account]))
        #expect(FixtureLaunch.MoreState.allCases.map(\.rawValue) == ["signout", "savefail"], "capture.sh's --more grammar")
        #expect(throws: FixtureLaunch.ParseError.unknownRoute("meer:geheim")) { try FixtureLaunch.parseRoute("meer:geheim") }
        #expect(throws: FixtureLaunch.ParseError.unknownValue("-fixtures-push", "ja")) {
            try FixtureLaunch.parse(["-fixtures", "x", "-fixtures-push", "ja"])
        }
        #expect(throws: FixtureLaunch.ParseError.unknownScroll("top")) {
            try FixtureLaunch.parse(["-fixtures", "x", "-fixtures-scroll", "top"])
        }
        #expect(try FixtureLaunch.parseRoute("suggestion:\(Self.suggestion)") == .link(.suggestion(UUID(uuidString: Self.suggestion)!)))
        #expect(try FixtureLaunch.parseRoute("task:\(Self.task)") == .link(.task(UUID(uuidString: Self.task)!)))
        for s in FixtureLaunch.Screen.allCases { #expect(try FixtureLaunch.parseRoute(s.rawValue) == .screen(s)) }
        #expect(FixtureLaunch.Tab.allCases.map(\.rawValue) == ["overzicht", "voorjou", "scan", "dossier", "meer"])
    }

    @Test func refusesWhatItCannotRead() {
        #expect(throws: FixtureLaunch.ParseError.missingValue("-fixtures")) { try FixtureLaunch.parse(["-fixtures"]) }
        #expect(throws: FixtureLaunch.ParseError.missingValue("-tab")) { try FixtureLaunch.parse(["-fixtures", "x", "-tab", "-route"]) }
        #expect(throws: FixtureLaunch.ParseError.unknownTab("geld")) { try FixtureLaunch.parse(["-fixtures", "x", "-tab", "geld"]) }
        #expect(throws: FixtureLaunch.ParseError.unknownRoute("proposal:nope")) { try FixtureLaunch.parseRoute("proposal:nope") }
        #expect(throws: FixtureLaunch.ParseError.unknownRoute("document:nope")) { try FixtureLaunch.parseRoute("document:nope") }
        #expect(throws: FixtureLaunch.ParseError.unknownRoute("inbox:\(Self.reply)")) {
            try FixtureLaunch.parseRoute("inbox:\(Self.reply)")
        }
    }

    /// The Dossier tab's viewer, opened the way a `verder://document/<id>` push would.
    @Test func parsesADocumentRoute() throws {
        let id = "00000000-f1c5-4000-8000-200000000311"
        #expect(try FixtureLaunch.parseRoute("document:\(id)") == .link(.document(UUID(uuidString: id)!)))
    }

    /// The test process itself is never a fixture launch.
    @Test func theTestHostIsNotAFixtureLaunch() {
        #expect(FixtureLaunch.current == nil)
    }
}

enum FixtureError: Error { case notAnObject(String) }

private extension JSONDecoder {
    static var verder: JSONDecoder { APIClient.jsonDecoder }
}
