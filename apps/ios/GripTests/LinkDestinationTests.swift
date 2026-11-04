import Testing
import Foundation
import UserNotifications
@testable import Grip

/// Every way into the app lands somewhere real (plan 3 Task GAP): every link
/// the worker or the web can send, every notification category, every widget
/// URL and every fixture route parses to a `DeepLink` with a DESTINATION — a
/// tab, a stack, or the voice sheet. A link that parses but goes nowhere is a
/// tap that silently does nothing, which is the failure this file exists for.
@MainActor
struct LinkDestinationTests {
    nonisolated static let id = UUID(uuidString: "6F9619FF-8B86-D011-B42D-00C04FC964FF")!
    nonisolated static let lower = "6f9619ff-8b86-d011-b42d-00c04fc964ff"

    static let repo = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // GripTests/
        .deletingLastPathComponent()   // apps/ios/
        .deletingLastPathComponent()   // apps/
        .deletingLastPathComponent()   // repo root

    /// Every `grip://…` literal in the non-test TypeScript under `dir`, with
    /// each `${…}` interpolation replaced by a UUID (the only thing the
    /// worker ever interpolates into a link is a row id).
    static func serverLinks(under dir: String) throws -> [(file: String, link: String)] {
        let root = repo.appending(path: dir)
        let files = (FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL } ?? [])
            .filter { ["ts", "tsx"].contains($0.pathExtension) && !$0.lastPathComponent.contains(".test.") }
        var out: [(String, String)] = []
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            for line in text.components(separatedBy: .newlines) {
                for link in try literals(in: line) { out.append((file.lastPathComponent, link)) }
            }
        }
        return out
    }

    /// The `grip://…` literals on one line of code, interpolations replaced
    /// by a UUID. A `?query` or `#fragment` is KEPT: `DeepLink.parse` refuses
    /// both, so cutting them off would let a link that lands nowhere pass.
    static func literals(in line: String) throws -> [String] {
        // Doc comments describe links; only code sends them.
        let code = line.trimmingCharacters(in: .whitespaces)
        if code.hasPrefix("//") || code.hasPrefix("*") || code.hasPrefix("/*") { return [] }
        let literal = try Regex(#"grip://[A-Za-z0-9_\-/${}.?#=&%+~:]*"#)
        let interpolation = try Regex(#"\$\{[^}]*\}"#)
        return line.matches(of: literal).map { String(line[$0.range]).replacing(interpolation, with: lower) }
    }

    @Test func aLinkLiteralKeepsItsQueryAndFragment() throws {
        #expect(try Self.literals(in: #"  link: `grip://inbox?tab=x#top`,"#) == ["grip://inbox?tab=x#top"])
        #expect(try Self.literals(in: #"  link: `grip://task/${t.id}#a`"#) == ["grip://task/\(Self.lower)#a"])
        #expect(try Self.literals(in: #"  // e.g. grip://inbox?x"#) == [])
        // …and what it keeps is exactly what the coverage tests then refuse.
        #expect(DeepLink.parse("grip://inbox?tab=x#top") == .none)
    }

    /// The mobile routes and the shared API package can send links too; none
    /// may be a tap that goes nowhere.
    @Test func everyLinkTheMobileRoutesAndTheAPIServeLandsSomewhere() throws {
        let links = try Self.serverLinks(under: "apps/web/src/app/api/mobile")
            + Self.serverLinks(under: "packages/api/src")
        for (file, link) in links {
            #expect(DeepLink.parse(link).destination != nil, "\(file): \(link)")
        }
    }

    @Test func everyLinkTheWorkerSendsLandsSomewhere() throws {
        let links = try Self.serverLinks(under: "apps/worker/src")
        // The worker sends at least proposal and inbox links (notify callers).
        #expect(links.count >= 8, "found \(links.count) links; did the worker move?")
        #expect(Set(links.map(\.link)).isSuperset(of: ["grip://inbox", "grip://proposal/\(Self.lower)"]))
        for (file, link) in links {
            let parsed = DeepLink.parse(link)
            #expect(parsed != .none, "\(file): \(link) parses to nothing")
            #expect(parsed.destination != nil, "\(file): \(link) goes nowhere")
        }
    }

    /// The web serves links too: the dossier search hits (`mobile-dto.ts`).
    @Test func everyLinkTheWebServesLandsSomewhere() throws {
        let links = try Self.serverLinks(under: "apps/web/src/lib")
        #expect(links.count >= 2)
        for (file, link) in links {
            #expect(DeepLink.parse(link).destination != nil, "\(file): \(link)")
        }
    }

    @Test func eachLinkOpensItsScreen() {
        #expect(DeepLink.proposal(Self.id).destination == .init(tab: .voorJou, stack: .inbox([.proposal(Self.lower)])))
        #expect(DeepLink.suggestion(Self.id).destination == .init(tab: .voorJou, stack: .inbox([.suggestion(Self.lower)])))
        #expect(DeepLink.task(Self.id).destination == .init(tab: .voorJou, stack: .inbox([.task(Self.lower)])))
        #expect(DeepLink.inbox.destination == .init(tab: .voorJou, stack: .inbox([])))
        #expect(DeepLink.doneByGrip.destination == .init(tab: .voorJou, stack: .inbox([.doneByGrip])))
        #expect(DeepLink.document(Self.id).destination
                == .init(tab: .dossier, stack: .dossier([.document(id: Self.lower, title: nil)])))
        #expect(DeepLink.dossier.destination == .init(tab: .dossier, stack: .dossier([])))
        #expect(DeepLink.timeline.destination == .init(tab: .dossier, stack: .dossier([.timeline])))
        #expect(DeepLink.overzicht.destination == .init(tab: .home, stack: nil))
        #expect(DeepLink.weekly.destination == .init(tab: .meer, stack: .meer([.weekly])))
        #expect(DeepLink.money.destination == .init(tab: .meer, stack: .meer([.money])))
        #expect(DeepLink.voice.destination == .init(tab: nil, stack: nil, opensVoice: true))
        #expect(DeepLink.none.destination == nil)
    }

    @Test func theNewLinksParseStrictly() {
        #expect(DeepLink.parse("grip://overzicht") == .overzicht)
        #expect(DeepLink.parse("grip://dossier") == .dossier)
        #expect(DeepLink.parse("grip://done-by-grip") == .doneByGrip)
        #expect(DeepLink.parse("grip://money") == .money)
        #expect(DeepLink.parse("grip://timeline") == .timeline)
        for junk in ["grip://overzicht/x", "grip://dossier?x=1", "grip://done-by-grip/1", "grip://money#a",
                     "grip://timeline/x", "grip://timeline?schuldeisers=verborgen"] {
            #expect(DeepLink.parse(junk) == DeepLink.none, "\(junk)")
        }
    }

    /// The tab is the destination's tab — one mapping, not two.
    @Test func theTabIsTheDestinationsTab() {
        let all: [DeepLink] = [.proposal(Self.id), .suggestion(Self.id), .task(Self.id), .document(Self.id),
                               .inbox, .doneByGrip, .dossier, .timeline, .overzicht, .weekly, .money, .voice, .scan, .none]
        for link in all { #expect(link.tab == link.destination?.tab, "\(link)") }
    }

    // MARK: - Notifications

    /// A push the worker sends WITHOUT a link (a merged duplex scan, a new
    /// loonstrook, the watchdog's "hersteld") still opens somewhere: its
    /// category decides.
    @Test func everyCategoryHasAPlaceToLandWithoutALink() {
        for category in NotificationCategories.ids {
            let target = NotificationRouter.target(action: UNNotificationDefaultActionIdentifier,
                                                   category: category, link: .none)
            #expect(target.destination != nil, "\(category)")
        }
        #expect(NotificationRouter.fallback(category: "FILING") == .dossier)
        #expect(NotificationRouter.fallback(category: "SYSTEM") == .overzicht)
        #expect(NotificationRouter.fallback(category: "WEEKLY") == .weekly)
        #expect(NotificationRouter.fallback(category: "VERDER_MAIL") == .inbox)
        #expect(NotificationRouter.fallback(category: "NOT_A_CATEGORY") == DeepLink.none)
    }

    /// The daily "Door Grip gedaan" digest is a FILING push with
    /// `grip://inbox`: a tap opens that section, not the top of Voor jou.
    @Test func theDigestOpensDoorGripGedaan() async {
        let links = DeepLinkInbox()
        let outcome = await NotificationRouter(links: links, client: { nil })
            .handle(action: UNNotificationDefaultActionIdentifier, category: "FILING",
                    userInfo: ["link": "grip://inbox"])
        #expect(outcome == .opened(.doneByGrip))
        #expect(links.pending == .doneByGrip)
    }

    @Test func aLinklessFilingPushOpensTheDossier() async {
        let links = DeepLinkInbox()
        let outcome = await NotificationRouter(links: links, client: { nil })
            .handle(action: UNNotificationDefaultActionIdentifier, category: "FILING", userInfo: [:])
        #expect(outcome == .opened(.dossier))
    }

    /// A link the push DOES carry still wins over the category.
    @Test func anExplicitLinkWinsOverTheCategory() {
        let link = DeepLink.proposal(Self.id)
        for category in NotificationCategories.ids where category != NotificationRouter.weeklyCategory {
            #expect(NotificationRouter.target(action: UNNotificationDefaultActionIdentifier,
                                              category: category, link: link) == link, "\(category)")
        }
    }

    /// Dismissing never opens anything, fallback or not.
    @Test func dismissStillOpensNothing() async {
        let links = DeepLinkInbox()
        let outcome = await NotificationRouter(links: links, client: { nil })
            .handle(action: UNNotificationDismissActionIdentifier, category: "SYSTEM", userInfo: [:])
        #expect(outcome == .ignored)
        #expect(links.pending == DeepLink.none)
    }

    // MARK: - Widgets, quick actions, fixtures

    @Test func everyWidgetURLLandsSomewhere() {
        #expect(DeepLink.parse(WidgetContent.inboxURL.absoluteString).destination != nil)
        for kind in ["proposal", "question", "suggestion", "task", "stop", "something-new"] {
            let url = WidgetContent.url(for: .init(kind: kind, id: Self.lower, title: "x"))
            #expect(DeepLink.parse(url.absoluteString).destination != nil, "\(kind)")
        }
        let broken = WidgetContent.url(for: .init(kind: "task", id: "not-a-uuid", title: "x"))
        #expect(DeepLink.parse(broken.absoluteString).destination != nil)
    }

    @Test func theQuickActionLandsSomewhere() {
        #expect(QuickAction.link(forType: QuickAction.voiceType).destination?.opensVoice == true)
    }

    @Test func everyFixtureRouteIsALinkThatLands() throws {
        for raw in ["geld", "weekly", "timeline", "proposal:\(Self.lower)", "suggestion:\(Self.lower)",
                    "task:\(Self.lower)", "document:\(Self.lower)"] {
            guard case .link(let link) = try FixtureLaunch.parseRoute(raw) else {
                Issue.record("\(raw) is not a link"); continue
            }
            #expect(link.destination != nil, "\(raw)")
        }
        #expect(try FixtureLaunch.parseRoute("geld") == .link(.money))
        #expect(try FixtureLaunch.parseRoute("timeline") == .link(.timeline))
    }
}
