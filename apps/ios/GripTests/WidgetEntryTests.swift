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

    static func content(_ snap: WidgetSnapshot?, _ family: WidgetFamily,
                        layout: WidgetContent.Layout = .standard, signedOut: Bool = false,
                        standBy: Bool = false) -> WidgetContent {
        WidgetContent.make(snapshot: snap, family: family, now: now, signedOut: signedOut, layout: layout,
                           standBy: standBy)
    }

    /// A `WidgetSamples` snapshot on its own clock (Mon 2 nov 09:41).
    static func sample(_ snap: WidgetSnapshot?, _ family: WidgetFamily, layout: WidgetContent.Layout = .standard,
                       standBy: Bool = false) -> WidgetContent {
        WidgetContent.make(snapshot: snap, family: family, now: WidgetSamples.today, layout: layout, standBy: standBy)
    }

    static let lockScreen: [WidgetFamily] = [.accessoryCircular, .accessoryRectangular, .accessoryInline]
    static let homeScreen: [WidgetFamily] = [.systemSmall, .systemMedium, .systemLarge]

    // MARK: - Lock screen: counts only

    @Test func lockScreenEntryHasNoTitles() {
        for family in Self.lockScreen {
            let c = Self.content(Self.snapshot(), family)
            #expect(c.rows.isEmpty, "\(family)")
            #expect(c.footer == nil, "\(family)")
            for title in Self.items.map(\.title) + [Self.headline] {
                for text in c.drawnText {
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
        #expect(Self.content(Self.snapshot(), .systemSmall).oldestText == "oudste 3 dagen")
        #expect(Self.content(Self.snapshot(), .systemMedium).oldestText == nil)
        #expect(Self.content(Self.snapshot(), .systemMedium).rows.map(\.text) == Self.items.prefix(2).map(\.title))
        #expect(Self.content(Self.snapshot(), .systemLarge).rows.map(\.text) == Self.items.map(\.title))
        #expect(Self.content(Self.snapshot(), .systemMedium).footer == nil)
        #expect(Self.content(Self.snapshot(), .systemLarge).footer?.text == Self.headline)
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
        #expect(large.footer?.sensitive == true)
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
        #expect(Self.content(empty, .systemSmall).words == "Niets wacht op je")
        #expect(Self.content(empty, .accessoryInline).inlineText == "verder · niets voor jou")
        // The check and the words replace "0" (Figma "Widgets thuis / leeg").
        #expect(Self.content(empty, .systemSmall).countText == nil)
        #expect(Self.content(empty, .systemSmall).glyph == .check)
    }

    /// Tinted and clear home screens render `.accented`, the lock screen
    /// `.vibrant`: amber is gone there, so it may never be the only carrier.
    @Test func amberOnlyInFullColor() {
        let c = Self.content(Self.snapshot(), .systemSmall)
        #expect(c.countIsAmber(in: .fullColor))
        #expect(!c.countIsAmber(in: .accented))
        #expect(!c.countIsAmber(in: .vibrant))
    }

    static let allFamilies = homeScreen + lockScreen

    /// PER FAMILY, on what that family itself draws: the words saying the
    /// count waits on Martin. `drawnText` holds only the strings the family's
    /// view paints — never another family's (the inline line is not drawn on
    /// the small face, so it may not vouch for it).
    @Test func everyFamilyDrawsWhoItWaitsOnInWords() {
        for family in Self.allFamilies {
            let w = Self.content(Self.snapshot(), family)
            // The circle draws the tray and the count (Figma "Toegangsscherm"):
            // its words are its VoiceOver label, and the rectangle beside it says them.
            if family != .accessoryCircular {
                #expect(w.drawnText.contains(w.words), "\(family) does not draw its words")
            }
            #expect(w.words.contains("op jou") || w.words.contains("voor jou"), "\(family) relies on colour alone")
            if family != .accessoryInline {
                #expect(!w.drawnText.contains(w.inlineText), "\(family) is credited with the inline line it never draws")
            }
        }
        let empty = Self.snapshot(count: 0, items: [], headline: nil, oldest: nil)
        for family in Self.allFamilies {
            let w = Self.content(empty, family)
            #expect(w.words.contains("niets") || w.words.contains("Niets") || w.words.contains("voor jou"), "\(family)")
        }
        for family in Self.allFamilies {
            let w = Self.content(nil, family)
            #expect(w.words.contains("open") || w.words.contains("Open") || w.words == "oud", "\(family) stale")
        }
    }

    /// The view really paints `words`: change only the words and the pixels
    /// must change, in every family and every state. Deleting the caption from
    /// one face, or hard-coding its words, fails here.
    @MainActor
    @Test func everyFamilyPaintsItsWords() throws {
        func png(_ c: WidgetContent, _ family: WidgetFamily) throws -> Data {
            let size: CGSize = switch family {
            case .systemSmall: CGSize(width: 158, height: 158)
            case .systemMedium: CGSize(width: 338, height: 158)
            case .systemLarge: CGSize(width: 338, height: 354)
            case .accessoryCircular: CGSize(width: 72, height: 72)
            case .accessoryRectangular: CGSize(width: 172, height: 76)
            default: CGSize(width: 240, height: 24)
            }
            let view = WidgetFamilyView(content: c, family: family)
                .frame(width: size.width, height: size.height)
                .background(Color.void)
                .environment(\.colorScheme, .dark)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            return try #require(renderer.uiImage?.pngData())
        }
        let states: [(String, WidgetSnapshot?, Bool)] = [
            ("waiting", Self.snapshot(), false),
            ("empty", Self.snapshot(count: 0, items: [], headline: nil, oldest: nil), false),
            ("stale", nil, false), ("signed out", nil, true),
        ]
        for family in Self.allFamilies {
            for (name, snap, out) in states {
                if family == .accessoryCircular && name == "waiting" { continue }
                let c = Self.content(snap, family, signedOut: out)
                let other = c.withWords("xx")
                #expect(try png(c, family) != png(other, family), "\(family) \(name) does not paint its words")
            }
        }
    }

    // MARK: - Stale

    @Test func staleSnapshotSaysOpenApp() {
        let old = Self.snapshot(age: 24 * 3600 + 1)
        for family in Self.homeScreen {
            let c = Self.content(old, family)
            #expect(c.state == .stale)
            #expect(c.words == "Open verder om bij te werken", "\(family)")
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
        #expect(Self.content(old, .accessoryInline).inlineText == "verder · open de app")
        #expect(Self.content(old, .accessoryCircular).words == "oud")
    }

    @Test func noSnapshotIsStale() {
        #expect(Self.content(nil, .systemMedium).state == .stale)
        #expect(Self.content(nil, .systemMedium).words == "Open verder om bij te werken")
        // No snapshot, no time: the "bijgewerkt" line stays away.
        #expect(Self.content(nil, .systemSmall).readout == nil)
        #expect(Self.content(nil, .systemLarge).footer == nil)
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

    /// The space INSIDE the 16 pt content margins: the smallest standard
    /// iPhone widget sizes (158 / 338×158 / 338×354), and the iPhone SE's
    /// 148 / 321×148 for the compact faces. A face whose ideal height exceeds
    /// these is clipped at the bottom by WidgetKit.
    static let budget: [(WidgetFamily, WidgetContent.Layout, CGSize)] = [
        (.systemSmall, .standard, CGSize(width: 126, height: 126)),
        (.systemMedium, .standard, CGSize(width: 306, height: 126)),
        (.systemSmall, .compact, CGSize(width: 116, height: 116)),
        (.systemMedium, .compact, CGSize(width: 289, height: 116)),
        (.systemSmall, .accessibility, CGSize(width: 138, height: 138)),
        (.systemMedium, .accessibility, CGSize(width: 330, height: 138)),
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
    static func idealHeight<V: View>(_ view: V, width: CGFloat, typeSize: DynamicTypeSize = .large) throws -> CGFloat {
        let sized = view
            .frame(width: width)
            .fixedSize(horizontal: false, vertical: true)
            .environment(\.dynamicTypeSize, typeSize)
            .environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: sized)
        renderer.scale = 1
        return try #require(renderer.uiImage).size.height
    }

    @MainActor
    static func idealHeight(_ snap: WidgetSnapshot?, _ family: WidgetFamily, width: CGFloat,
                            layout: WidgetContent.Layout = .standard, signedOut: Bool = false) throws -> CGFloat {
        let typeSize: DynamicTypeSize = layout == .accessibility ? .accessibility5 : .large
        return try idealHeight(WidgetFamilyView(content: content(snap, family, layout: layout, signedOut: signedOut),
                                                family: family), width: width, typeSize: typeSize)
    }

    static let fitCases: [(String, WidgetSnapshot?, Bool)] = [
        ("longest", longest, false), ("few", snapshot(), false),
        ("one", snapshot(count: 1, items: [items[3]]), false),
        ("empty", snapshot(count: 0, items: [], headline: nil, oldest: nil), false),
        ("stale", snapshot(age: 2 * 86_400), false), ("none", nil, false), ("signed out", nil, true),
    ]

    @MainActor
    @Test func everyHomeScreenFaceFitsItsFamily() throws {
        for (family, layout, size) in Self.budget {
            for (name, snap, out) in Self.fitCases {
                let h = try Self.idealHeight(snap, family, width: size.width, layout: layout, signedOut: out)
                #expect(h <= size.height, "\(family) \(layout) \(name): ideal \(h) pt > \(size.height) pt available")
            }
        }
    }

    /// The large face is a `ViewThatFits` over 5 → 1 rows: for every case at
    /// least one candidate fits 322 pt with the footer, and the frames' own
    /// titles fit all five at the default size.
    @MainActor
    @Test func largeKeepsTheFooterAndFitsARowCount() throws {
        for (name, snap, out) in Self.fitCases {
            let c = Self.content(snap, .systemLarge, signedOut: out)
            if c.state != .waiting {
                let h = try Self.idealHeight(snap, .systemLarge, width: 306, signedOut: out)
                #expect(h <= 322, "\(name): \(h)")
                continue
            }
            let heights = try (1...c.rows.count).map {
                try Self.idealHeight(LargeFace(content: c, shown: $0, ax: false), width: 306)
            }
            #expect(heights.contains { $0 <= 322 }, "\(name): no candidate fits, \(heights)")
        }
        let frames = Self.sample(WidgetSamples.many, .systemLarge)
        #expect(frames.footer?.text == WidgetSamples.headline)
        #expect(try Self.idealHeight(LargeFace(content: frames, shown: 5, ax: false), width: 330) <= 350)
        let ax = Self.sample(WidgetSamples.many, .systemLarge, layout: .accessibility)
        #expect(try Self.idealHeight(LargeFace(content: ax, shown: 2, ax: true), width: 330,
                                     typeSize: .accessibility5) <= 350)
    }

    // MARK: - Rows, "en nog", ages (Figma "widgets · final")

    @Test func rowsCarryTheirKindAndDate() {
        let rows = Self.sample(WidgetSamples.many, .systemLarge).rows
        #expect(rows.map(\.meta) == ["VOORSTEL · 2 NOV", "VRAAG · 1 NOV", "SUGGESTIE · 31 OKT",
                                     "TAAK · VÓÓR 3 NOV", "SUGGESTIE · 30 OKT"])
        #expect(rows[0].spoken == "voorstel, Loonstrook oktober naar Noordkust, 2 november")
        #expect(rows[3].spoken.hasSuffix("vóór 3 november"))
        // An older build's item has no date: the kind alone.
        #expect(Self.content(Self.snapshot(), .systemMedium).rows[0].meta == "VOORSTEL")
    }

    @Test func aDeadlineReadsAsAPlainDayOrAnInstant() {
        #expect(DutchDate.day(from: "2026-11-03").map(DutchDate.dayMonth) == "3 nov")
        // 23:30 UTC on 2 nov is already 3 nov in Amsterdam.
        #expect(DutchDate.day(from: "2026-11-02T23:30:00.000Z").map(DutchDate.dayMonth) == "3 nov")
        #expect(DutchDate.day(from: "morgen") == nil)
    }

    @Test func enNogCountsExactlyWhatIsHidden() {
        let medium = Self.sample(WidgetSamples.few, .systemMedium)
        #expect(medium.rows.count == 2)
        #expect(medium.readout == "en nog 2")
        let se = Self.sample(WidgetSamples.few, .systemMedium, layout: .compact)
        #expect(se.rows.count == 1)
        #expect(se.readout == "en nog 3")
        let large = Self.sample(WidgetSamples.many, .systemLarge)
        #expect(large.largeReadout(showing: 5) == "en nog 493 · oudste 6 wk")
        #expect(large.largeReadout(showing: 4) == "en nog 494 · oudste 6 wk")
        #expect(large.spokenSummary(showing: 5) == "498 wachten op jou, en nog 493, oudste 6 weken")
        let ax = Self.sample(WidgetSamples.many, .systemLarge, layout: .accessibility)
        #expect(ax.largeReadout(showing: 2) == "en nog 496")
        // Everything shown: no "en nog 0".
        #expect(Self.sample(WidgetSamples.one, .systemMedium).readout == nil)
        #expect(Self.sample(WidgetSamples.few, .systemLarge).largeReadout(showing: 4) == "oudste 2 dagen")
    }

    @Test func theAgeTurnsToWeeksAndOneItemSaysSinds() {
        #expect(WidgetContent.oldest(since: Self.now.addingTimeInterval(-13 * 86_400), now: Self.now).0 == "oudste 13 dagen")
        #expect(WidgetContent.oldest(since: Self.now.addingTimeInterval(-14 * 86_400), now: Self.now).0 == "oudste 2 wk")
        #expect(Self.sample(WidgetSamples.one, .systemSmall).readout == "sinds 2 dagen")
        #expect(Self.sample(WidgetSamples.few, .systemSmall).readout == "oudste 2 dagen")
    }

    @Test func accessibilitySizesTakeTheShortWords() {
        let small = Self.sample(WidgetSamples.few, .systemSmall, layout: .accessibility)
        #expect(small.caption == "voor jou")
        #expect(small.readout == nil)
        let medium = Self.sample(WidgetSamples.few, .systemMedium, layout: .accessibility)
        #expect(medium.caption == "voor jou")
        #expect(medium.rows.count == 1)
        #expect(medium.readout == "en nog 3")
        // The large face keeps the whole phrase; it has the width.
        #expect(Self.sample(WidgetSamples.many, .systemLarge, layout: .accessibility).caption == "wachten op jou")
    }

    @Test func theLayoutFollowsTheBoxAndTheTextSize() {
        typealias L = WidgetContent.Layout
        #expect(L.make(family: .systemSmall, displaySize: CGSize(width: 148, height: 148), accessibilitySize: false) == .compact)
        #expect(L.make(family: .systemSmall, displaySize: CGSize(width: 170, height: 170), accessibilitySize: false) == .standard)
        #expect(L.make(family: .systemMedium, displaySize: CGSize(width: 321, height: 148), accessibilitySize: false) == .compact)
        #expect(L.make(family: .systemMedium, displaySize: CGSize(width: 338, height: 158), accessibilitySize: false) == .standard)
        #expect(L.make(family: .systemLarge, displaySize: CGSize(width: 321, height: 324), accessibilitySize: false) == .standard)
        #expect(L.make(family: .systemSmall, displaySize: nil, accessibilitySize: true) == .accessibility)
        // The SE's small drops the dot; every other face keeps it.
        #expect(!Self.sample(WidgetSamples.few, .systemSmall, layout: .compact).showsDot)
        #expect(Self.sample(WidgetSamples.few, .systemMedium, layout: .compact).showsDot)
    }

    // MARK: - Empty, stale, signed out

    @Test func emptySaysWhenItLastLooked() {
        let small = Self.sample(WidgetSamples.empty, .systemSmall)
        #expect(small.readout == "bijgewerkt 08:12")
        let medium = Self.sample(WidgetSamples.empty, .systemMedium)
        #expect(medium.body == "Goed bezig. verder laat het weten zodra er iets binnenkomt.")
        let large = Self.sample(WidgetSamples.empty, .systemLarge)
        #expect(large.updatedText == "bijgewerkt 08:12")
        #expect(large.footer?.text == "Nergens op. Je bent helemaal bij.")
        #expect(large.footer?.sensitive == false)
        #expect(Self.sample(WidgetSamples.empty, .accessoryCircular).words == "niets")
    }

    @Test func staleSaysWhenItWasLastTrue() {
        #expect(Self.sample(WidgetSamples.stale, .systemSmall).readout == "bijgewerkt 31 okt")
        let medium = Self.sample(WidgetSamples.stale, .systemMedium)
        #expect(medium.readout == "laatst bijgewerkt za 31 okt 14:02")
        #expect(medium.body == "verder toont bewust geen oud aantal.")
        let large = Self.sample(WidgetSamples.stale, .systemLarge)
        #expect(large.footer?.label == "laatst bijgewerkt")
        #expect(large.footer?.text == "za 31 okt 14:02")
        #expect(Self.sample(WidgetSamples.stale, .systemSmall, standBy: true).readout
                == "laatst bijgewerkt\nza 31 okt 14:02")
    }

    @Test func signedOutSaysLogInAndHoldsNothing() {
        for family in Self.allFamilies {
            let c = Self.content(nil, family, signedOut: true)
            #expect(c.state == .signedOut, "\(family)")
            #expect(c.countText == nil && c.rows.isEmpty, "\(family)")
            #expect(c.words.lowercased().contains("log in"), "\(family)")
        }
        #expect(Self.content(nil, .systemSmall, signedOut: true).readout == "tik en log in")
        #expect(Self.content(nil, .systemMedium, signedOut: true).readout == "afgemeld · niets bewaard op dit toestel")
        #expect(Self.content(nil, .accessoryInline, signedOut: true).inlineText == "verder · log in")
        #expect(Self.content(nil, .systemLarge, signedOut: true).footer?.text == "Niets bewaard op dit toestel")
        #expect(Self.content(nil, .systemSmall, signedOut: true).eyebrow == "verder")
        // A snapshot written after signing in again wins over a stale marker.
        #expect(Self.content(Self.snapshot(), .systemSmall, signedOut: true).state == .waiting)
        #expect(Self.content(nil, .systemSmall).state == .stale)
    }

    // MARK: - The headline widget (StandBy's right stack)

    @Test func theHeadlineWidgetNamesTheStopItsSporeAndDate() {
        let h = HeadlineContent.make(snapshot: WidgetSamples.few, now: WidgetSamples.today)
        #expect(h.text == WidgetSamples.headline)
        #expect(h.sub == "Opstart bewind · 28 okt")
        #expect(h.sensitive)
        #expect(h.url == WidgetContent.mapURL)
        #expect(DeepLink.parse(h.url.absoluteString) == .timeline)
        let empty = HeadlineContent.make(snapshot: WidgetSamples.empty, now: WidgetSamples.today)
        #expect(empty.text == "Nergens op. Je bent helemaal bij.")
        #expect(empty.sub == "geen open stap")
        #expect(empty.quiet && !empty.sensitive)
        #expect(!HeadlineContent.make(snapshot: WidgetSamples.stale, now: WidgetSamples.today).sensitive)
        #expect(HeadlineContent.make(snapshot: nil, now: WidgetSamples.today, signedOut: true).text == "Log in bij verder")
    }

    @Test func theLargeFooterOpensTheMap() {
        let footer = Self.sample(WidgetSamples.many, .systemLarge).footer
        #expect(footer?.url == WidgetContent.mapURL)
        #expect(footer?.spoken == "Waar het nu op wacht: \(WidgetSamples.headline)")
    }

    /// Locked StandBy: the stop and its spoor are bars, and "ontgrendel om te
    /// zien" says why — two stops that differ only in their words render
    /// identically under the privacy redaction.
    @MainActor
    @Test func redactedHeadlineShowsNoStop() throws {
        func png(_ stop: String, redacted: Bool) throws -> Data {
            let snap = WidgetSnapshot(count: 1, topTitle: nil, topKind: nil, headline: stop,
                                      updatedAt: WidgetSamples.updated, headlineTrack: "1234567", headlineAt: nil)
            let view = HeadlineFace(content: HeadlineContent.make(snapshot: snap, now: WidgetSamples.today))
                .frame(width: 170, height: 170)
                .background(Color.void)
                .redacted(reason: redacted ? .privacy : [])
                .environment(\.colorScheme, .dark)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            return try #require(renderer.uiImage?.pngData())
        }
        #expect(try png("1234567890", redacted: false) != png("0987654321", redacted: false))
        #expect(try png("1234567890", redacted: true) == png("0987654321", redacted: true))
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
