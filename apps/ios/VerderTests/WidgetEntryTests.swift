import Testing
import Foundation
import SwiftUI
import WidgetKit
@testable import Verder

/// The widget's model: what each family shows, what is sensitive, when it is
/// amber, where a tap goes. The views only paint what this decides.
struct WidgetEntryTests {
    /// The case's "today" in the synthetic dataset: Sun 1 nov 2026, 12:00 Amsterdam.
    static let now = Date(timeIntervalSince1970: 1_793_530_800)

    static func item(_ kind: String, _ n: Int, _ title: String) -> WidgetSnapshot.Item {
        WidgetSnapshot.Item(kind: kind, id: String(format: "00000000-f1c5-4000-8000-%012d", n), title: title)
    }

    /// `voorjou-few`, as the app writes it.
    static let items = [
        item("proposal", 1, "Antwoord aan Bewindkantoor Noordkust: loonstrook oktober"),
        item("question", 2, "Hoort deze brief bij de vordering van Kade & Partners?"),
        item("suggestion", 3, "Telefoongesprek met Woonstichting Lindehof over de betalingsregeling"),
        item("task", 4, "Formulier bijzondere bijstand ondertekenen"),
    ]
    static let headline = "Stukken aanleveren bij Team Startdossier"

    static func snapshot(count: Int = 4, items: [WidgetSnapshot.Item] = items,
                         headline: String? = headline, age: TimeInterval = 600,
                         oldest: Date? = Date(timeIntervalSince1970: 1_793_530_800 - 3 * 86_400)) -> WidgetSnapshot {
        WidgetSnapshot(count: count, topTitle: items.first?.title, topKind: items.first?.kind,
                       headline: headline, updatedAt: now.addingTimeInterval(-age),
                       items: items, oldestAt: oldest)
    }

    static func content(_ snap: WidgetSnapshot?, _ family: WidgetFamily) -> WidgetContent {
        WidgetContent.make(snapshot: snap, family: family, now: now)
    }

    static let lockScreen: [WidgetFamily] = [.accessoryCircular, .accessoryRectangular, .accessoryInline]
    static let homeScreen: [WidgetFamily] = [.systemSmall, .systemMedium, .systemLarge]

    // MARK: - Lock screen: counts only

    @Test func lockScreenEntryHasNoTitles() {
        for family in Self.lockScreen {
            let c = Self.content(Self.snapshot(), family)
            #expect(c.rows.isEmpty, "\(family)")
            #expect(c.headline == nil, "\(family)")
            for title in Self.items.map(\.title) + [Self.headline] {
                for text in c.allText {
                    #expect(!text.contains(title), "\(family) shows \(title)")
                }
            }
            #expect(c.url == WidgetContent.inboxURL)
        }
    }

    @Test func lockScreenShowsTheCount() {
        #expect(Self.content(Self.snapshot(), .accessoryCircular).countText == "4")
        #expect(Self.content(Self.snapshot(), .accessoryInline).inlineText == "verder · 4 voor jou")
        let rect = Self.content(Self.snapshot(), .accessoryRectangular)
        #expect(rect.countText == "4")
        #expect(rect.caption == "wachten op jou")
        #expect(rect.oldestText == "oudste 3 dagen")
    }

    // MARK: - Home screen families

    @Test func eachFamilyShowsItsShareOfItems() {
        #expect(Self.content(Self.snapshot(), .systemSmall).rows.isEmpty)
        #expect(Self.content(Self.snapshot(), .systemMedium).rows.map(\.text) == Self.items.prefix(2).map(\.title))
        #expect(Self.content(Self.snapshot(), .systemLarge).rows.map(\.text) == Self.items.map(\.title))
        #expect(Self.content(Self.snapshot(), .systemMedium).headline == nil)
        #expect(Self.content(Self.snapshot(), .systemLarge).headline?.text == Self.headline)
    }

    @Test func largeShowsAtMostFive() {
        let many = (1...7).map { Self.item("task", $0, "Taak \($0)") }
        let c = Self.content(Self.snapshot(count: 498, items: many), .systemLarge)
        #expect(c.rows.count == 5)
        #expect(c.countText == "498")
    }

    @Test func mediumTitlesAreMarkedPrivacySensitive() {
        let medium = Self.content(Self.snapshot(), .systemMedium)
        #expect(!medium.rows.isEmpty)
        #expect(medium.rows.allSatisfy { $0.sensitive })
        let large = Self.content(Self.snapshot(), .systemLarge)
        #expect(large.rows.allSatisfy { $0.sensitive })
        #expect(large.headline?.sensitive == true)
        // The count and its words are not sensitive: they ARE the glance.
        #expect(medium.countSensitive == false)
    }

    @Test func captionAgreesWithTheCount() {
        #expect(Self.content(Self.snapshot(count: 1, items: [Self.items[0]]), .systemSmall).caption == "wacht op jou")
        #expect(Self.content(Self.snapshot(count: 4), .systemSmall).caption == "wachten op jou")
    }

    // MARK: - Amber

    @Test func zeroCountIsNotAmber() {
        let empty = Self.snapshot(count: 0, items: [], headline: nil, oldest: nil)
        for family in Self.homeScreen + Self.lockScreen {
            let c = Self.content(empty, family)
            #expect(c.state == .empty, "\(family)")
            #expect(!c.countIsAmber(in: .fullColor), "\(family)")
        }
        #expect(Self.content(empty, .systemSmall).caption == "Niets wacht op je.")
        #expect(Self.content(empty, .accessoryInline).inlineText == "verder · niets voor jou")
        #expect(Self.content(empty, .systemSmall).countText == "0")
    }

    /// Tinted and clear home screens render `.accented`, the lock screen
    /// `.vibrant`: amber is gone there, so it may never be the only carrier.
    @Test func amberOnlyInFullColorAndAlwaysWithWords() {
        let c = Self.content(Self.snapshot(), .systemSmall)
        #expect(c.countIsAmber(in: .fullColor))
        #expect(!c.countIsAmber(in: .accented))
        #expect(!c.countIsAmber(in: .vibrant))
        for family in Self.homeScreen + Self.lockScreen {
            let w = Self.content(Self.snapshot(), family)
            #expect(w.allText.contains { $0.contains("op jou") || $0.contains("voor jou") }, "\(family) relies on colour alone")
        }
    }

    // MARK: - Stale

    @Test func staleSnapshotSaysOpenApp() {
        let old = Self.snapshot(age: 24 * 3600 + 1)
        for family in Self.homeScreen {
            let c = Self.content(old, family)
            #expect(c.state == .stale)
            #expect(c.caption == "Open verder om bij te werken", "\(family)")
            #expect(c.countText == nil, "a day-old count is a guess")
            #expect(c.rows.isEmpty)
            #expect(!c.countIsAmber(in: .fullColor))
            #expect(c.url == WidgetContent.inboxURL)
        }
        for family in Self.lockScreen {
            let c = Self.content(old, family)
            #expect(c.state == .stale)
            #expect(c.countText == nil)
            #expect(!c.countIsAmber(in: .fullColor))
        }
        #expect(Self.content(old, .accessoryInline).inlineText == "verder · open om bij te werken")
    }

    @Test func noSnapshotIsStale() {
        #expect(Self.content(nil, .systemMedium).state == .stale)
        #expect(Self.content(nil, .systemMedium).caption == "Open verder om bij te werken")
    }

    @Test func justUnderADayIsFresh() {
        #expect(Self.content(Self.snapshot(age: 24 * 3600 - 1), .systemSmall).state == .waiting)
    }

    // MARK: - Deep links

    @Test func everyRowDeepLinksToItsItem() throws {
        let rows = Self.content(Self.snapshot(), .systemLarge).rows
        let links = rows.map { DeepLink.parse($0.url.absoluteString) }
        let ids = try Self.items.map { try #require(UUID(uuidString: $0.id)) }
        #expect(links == [.proposal(ids[0]), .proposal(ids[1]), .suggestion(ids[2]), .task(ids[3])])
    }

    @Test func aStopOrUnknownOrNonUUIDLeadsToTheInbox() {
        let odd = [Self.item("stop", 9, "Op de kaart"),
                   WidgetSnapshot.Item(kind: "reminder", id: "00000000-f1c5-4000-8000-000000000010", title: "Nieuw"),
                   WidgetSnapshot.Item(kind: "task", id: "t1", title: "Geen uuid")]
        let rows = Self.content(Self.snapshot(count: 3, items: odd), .systemLarge).rows
        #expect(rows.map(\.url) == Array(repeating: WidgetContent.inboxURL, count: 3))
        #expect(DeepLink.parse(WidgetContent.inboxURL.absoluteString) == .inbox)
    }

    @Test func widgetURLIsTheInbox() {
        for family in Self.homeScreen + Self.lockScreen {
            #expect(Self.content(Self.snapshot(), family).url == WidgetContent.inboxURL)
        }
    }

    // MARK: - Age of the oldest

    @Test func oldestAgeReadsInAmsterdamDays() {
        func age(_ seconds: TimeInterval) -> String? {
            Self.content(Self.snapshot(oldest: Self.now.addingTimeInterval(-seconds)), .accessoryRectangular).oldestText
        }
        #expect(age(3600) == "oudste van vandaag")
        #expect(age(86_400) == "oudste 1 dag")
        #expect(age(5 * 86_400) == "oudste 5 dagen")
        #expect(Self.content(Self.snapshot(oldest: nil), .accessoryRectangular).oldestText == nil)
    }

    // MARK: - An older build's snapshot

    @Test func aSnapshotWithoutItemsStillReads() throws {
        let old = Data(#"{"count":2,"topTitle":"Iets","topKind":"task","headline":null,"updatedAt":815100000}"#.utf8)
        let snap = try JSONDecoder().decode(WidgetSnapshot.self, from: old)
        #expect(snap.count == 2)
        #expect(snap.items.isEmpty)
        #expect(snap.oldestAt == nil)
    }

    // MARK: - The timeline

    @Test func timelineReloadsInThirtyMinutesAndReadsOnlyTheFile() {
        let (entry, reload) = VerderTimeline.entry(now: Self.now, snapshot: Self.snapshot())
        #expect(entry.date == Self.now)
        #expect(entry.snapshot == Self.snapshot())
        #expect(reload == Self.now.addingTimeInterval(30 * 60))
    }

    /// A snapshot that turns stale before the next reload gets a second entry
    /// at the moment it does, so the widget never shows a day-old count for
    /// half an hour.
    @Test func timelineFlipsToStaleOnTime() {
        let snap = Self.snapshot(age: 24 * 3600 - 60)
        let entries = VerderTimeline.entries(now: Self.now, snapshot: snap)
        #expect(entries.count == 2)
        #expect(entries[1].date == snap.updatedAt.addingTimeInterval(24 * 3600))
    }

    // MARK: - Every face fits its family

    /// The space INSIDE the 16 pt content margins on the smallest current
    /// iPhone widget sizes (158 / 338×158 / 338×354): a face whose ideal height
    /// exceeds these is clipped at the bottom by WidgetKit, and on the large
    /// family what got clipped was "waar het nu op wacht".
    static let budget: [(WidgetFamily, CGSize)] = [
        (.systemSmall, CGSize(width: 126, height: 126)),
        (.systemMedium, CGSize(width: 306, height: 126)),
        (.systemLarge, CGSize(width: 306, height: 322)),
    ]

    /// `voorjou-many` with `voorjou-long`'s item 1: five rows, the longest
    /// synthetic titles, a three-digit count, the oldest age shown.
    static let longest: WidgetSnapshot = {
        var rows = items
        rows[0] = item("proposal", 1, "Antwoord aan Bewindkantoor Noordkust over de aanvullende stukken voor de aanvraag bijzondere bijstand en de vraag om een kopie van de beschikking van de rechtbank")
        rows.append(item("suggestion", 5, "Brief van Gemeente Westerlaan over de huurtoeslag en de terugvordering over 2025 5"))
        return snapshot(count: 498, items: rows, oldest: now.addingTimeInterval(-40 * 86_400))
    }()

    @MainActor
    static func idealHeight(_ snap: WidgetSnapshot?, _ family: WidgetFamily, width: CGFloat) throws -> CGFloat {
        let view = WidgetFamilyView(content: content(snap, family), family: family)
            .frame(width: width)
            .fixedSize(horizontal: false, vertical: true)
            .environment(\.dynamicTypeSize, .large)
            .environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 1
        return try #require(renderer.uiImage).size.height
    }

    @MainActor
    @Test func everyHomeScreenFaceFitsItsFamily() throws {
        let cases: [(String, WidgetSnapshot?)] = [
            ("longest", Self.longest), ("few", Self.snapshot()),
            ("one", Self.snapshot(count: 1, items: [Self.items[3]])),
            ("empty", Self.snapshot(count: 0, items: [], headline: nil, oldest: nil)),
            ("stale", Self.snapshot(age: 2 * 86_400)), ("none", nil),
        ]
        for (family, size) in Self.budget {
            for (name, snap) in cases {
                let h = try Self.idealHeight(snap, family, width: size.width)
                #expect(h <= size.height, "\(family) \(name): ideal \(h) pt > \(size.height) pt available")
            }
        }
    }

    /// The headline is the large face's footer: present, and inside the
    /// budget even with five of the longest rows above it.
    @MainActor
    @Test func largeKeepsTheHeadlineWithFiveRows() throws {
        let c = Self.content(Self.longest, .systemLarge)
        #expect(c.rows.count == 5)
        #expect(c.headline?.text == Self.headline)
        #expect(try Self.idealHeight(Self.longest, .systemLarge, width: 306) <= 322)
    }

    // MARK: - Redaction, rendered

    /// iOS redacts `.privacySensitive()` content whenever the phone is locked
    /// (StandBy, the always-on home screen). Rendered under the privacy
    /// redaction, two media widgets that differ ONLY in their titles must be
    /// pixel-identical; unredacted, they must differ (or the test proves
    /// nothing). The titles are digit strings of equal length so the
    /// placeholders' geometry cannot differ by glyph width.
    @MainActor
    @Test func redactedMediumShowsNoTitleText() throws {
        func snap(_ a: String, _ b: String) -> WidgetSnapshot {
            Self.snapshot(items: [Self.item("task", 1, a), Self.item("task", 2, b)])
        }
        let one = snap("1234567890", "2345678901")
        let two = snap("0987654321", "1098765432")

        func png(_ s: WidgetSnapshot, redacted: Bool) throws -> Data {
            let view = WidgetFamilyView(content: Self.content(s, .systemMedium), family: .systemMedium)
                .frame(width: 338, height: 158)
                .background(Color.void)
                .redacted(reason: redacted ? .privacy : [])
                .environment(\.colorScheme, .dark)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            return try #require(renderer.uiImage?.pngData())
        }

        let plainOne = try png(one, redacted: false), plainTwo = try png(two, redacted: false)
        let hiddenOne = try png(one, redacted: true), hiddenTwo = try png(two, redacted: true)
        #expect(plainOne != plainTwo, "the titles must reach the pixels, or this proves nothing")
        #expect(hiddenOne == hiddenTwo)
    }
}
