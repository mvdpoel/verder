import Testing
import Foundation
@testable import Verder

/// The Tijdlijn's drawing, decided without SwiftUI: rows in the map's own
/// order with their month bands, lane positions, the rails that pass through
/// each row, the branch and merge connectors, and the label column.
@MainActor
struct TimelineLayoutTests {
    // MARK: - Builders

    nonisolated static func band(_ key: String, _ label: String, _ from: Int, _ to: Int) -> CaseMapDTO.Band {
        .init(key: key, label: label, fromRow: from, toRow: to, empty: from == to)
    }

    nonisolated static func track(_ id: String, _ title: String, lane: Int, rows: ClosedRange<Int>,
                                  status: String = "open", root: Bool = false, terminus: String = "open") -> CaseMapDTO.Track {
        .init(id: id, title: title, status: status, isRoot: root, parentTrackId: root ? nil : "root", note: nil,
              lane: lane, firstRow: rows.lowerBound, lastRow: rows.upperBound,
              mergesBack: terminus == "merge", terminus: terminus)
    }

    nonisolated static func stop(_ id: String, track: String, row: Int, lane: Int, band: String,
                                 state: String = "done", title: String? = nil, at: String? = "2026-10-14T09:00:00Z",
                                 outOfOrder: Bool = false) -> CaseMapDTO.Stop {
        .init(id: id, trackId: track, title: title ?? id, note: nil, state: state, kind: "other",
              happenedAt: at.flatMap(parseISODate), row: row, lane: lane, bandKey: band,
              isJunction: false, datesOutOfOrder: outOfOrder, evidence: .none)
    }

    nonisolated static func map(bands: [CaseMapDTO.Band], tracks: [CaseMapDTO.Track], stops: [CaseMapDTO.Stop],
                                edges: [CaseMapDTO.Edge] = [], current: String? = nil, lanes: Int? = nil) -> CaseMapDTO {
        CaseMapDTO(bands: bands, tracks: tracks, stops: stops, edges: edges, rowCount: stops.count,
                   laneCount: lanes ?? ((tracks.map(\.lane).max() ?? 0) + 1),
                   currentStopId: current, problems: [], hiddenDebtTrackCount: 0, debtEpisodesHidden: false)
    }

    /// A root on lane 0 (rows 0–3) and one spoor on lane 1 (rows 1–2) that
    /// branches at row 3 and merges at row 0.
    nonisolated static let mergingCase = map(
        bands: [band("nu", "Nu", 0, 1), band("2026-10", "oktober 2026", 1, 3), band("2026-09", "september 2026", 3, 3),
                band("2026-08", "augustus 2026", 3, 4)],
        tracks: [track("root", "Bewindvoering", lane: 0, rows: 0...3, root: true),
                 track("side", "Aanvraag", lane: 1, rows: 1...2, status: "done", terminus: "merge")],
        stops: [stop("s0", track: "root", row: 0, lane: 0, band: "nu", state: "open", at: nil),
                stop("s1", track: "side", row: 1, lane: 1, band: "2026-10"),
                stop("s2", track: "side", row: 2, lane: 1, band: "2026-10"),
                stop("s3", track: "root", row: 3, lane: 0, band: "2026-08", at: "2026-08-02T09:00:00Z")],
        edges: [.init(kind: "branch", trackId: "side", fromLane: 0, fromRow: 3, toLane: 1, toRow: 2),
                .init(kind: "merge", trackId: "side", fromLane: 1, fromRow: 1, toLane: 0, toRow: 0)],
        current: "s0")

    static func stopRows(_ layout: TimelineLayout) -> [TimelineLayout.StopRow] {
        layout.items.compactMap { if case .stop(let s) = $0 { s } else { nil } }
    }

    static func rails(_ layout: TimelineLayout, _ id: String) -> [TimelineLayout.Rail] {
        stopRows(layout).first { $0.stop.id == id }?.rails ?? []
    }

    // MARK: - Order

    @Test func rowsComeInBandOrderNewestFirstWithEveryBandHeaded() {
        let layout = TimelineLayout(Self.mergingCase)
        let order: [String] = layout.items.map {
            switch $0 {
            case .band(let b): "band:\(b.key)"
            case .stop(let s): s.stop.id
            }
        }
        #expect(order == ["band:nu", "s0", "band:2026-10", "s1", "s2", "band:2026-09", "band:2026-08", "s3"])
        // A quiet month is a fact about the case: headed, and marked empty.
        guard case .band(let quiet) = layout.items[5] else { Issue.record("not a band"); return }
        #expect(quiet.empty)
    }

    @Test func rowsFollowTheServersRowNumberNotTheArrayOrder() {
        var m = Self.mergingCase
        m = CaseMapDTO(bands: m.bands, tracks: m.tracks, stops: m.stops.reversed(), edges: m.edges,
                       rowCount: m.rowCount, laneCount: m.laneCount, currentStopId: m.currentStopId,
                       problems: [], hiddenDebtTrackCount: 0, debtEpisodesHidden: false)
        #expect(Self.stopRows(TimelineLayout(m)).map(\.stop.id) == ["s0", "s1", "s2", "s3"])
    }

    @Test func anEmptyMapHasNoRows() {
        let layout = TimelineLayout(Self.map(bands: [], tracks: [], stops: []))
        #expect(layout.items.isEmpty)
        #expect(layout.isEmpty)
    }

    // MARK: - Lanes

    @Test func lanesSitAtFixedSpacingUpToFour() {
        for count in 1...4 {
            let layout = TimelineLayout.Lanes(count: count)
            #expect(layout.spacing == TimelineLayout.Lanes.baseSpacing)
            #expect(layout.x(0) == TimelineLayout.Lanes.inset)
            #expect(layout.x(count - 1) == TimelineLayout.Lanes.inset + CGFloat(count - 1) * TimelineLayout.Lanes.baseSpacing)
            #expect(layout.width == 2 * TimelineLayout.Lanes.inset + CGFloat(count - 1) * TimelineLayout.Lanes.baseSpacing)
        }
    }

    @Test func moreThanFourLanesSqueezeIntoTheFourLaneGutter() {
        let four = TimelineLayout.Lanes(count: 4)
        let six = TimelineLayout.Lanes(count: 6)
        #expect(six.width == four.width)
        #expect(six.x(5) == four.x(3))
        #expect(six.spacing < four.spacing)
        #expect(six.x(1) > six.x(0))
    }

    @Test func zeroLanesStillHasAGutter() {
        #expect(TimelineLayout.Lanes(count: 0).width == TimelineLayout.Lanes(count: 1).width)
    }

    // MARK: - Rails and connectors

    @Test func theRootRailRunsFromItsNewestToItsOldestStop() {
        let layout = TimelineLayout(Self.mergingCase)
        let root = { (id: String) in Self.rails(layout, id).first { $0.lane == 0 } }
        #expect(root("s0") == .init(lane: 0, trackId: "root", isRoot: true, top: false, bottom: true))
        #expect(root("s1") == .init(lane: 0, trackId: "root", isRoot: true, top: true, bottom: true))
        #expect(root("s3") == .init(lane: 0, trackId: "root", isRoot: true, top: true, bottom: false))
    }

    @Test func aBranchLeavesTheParentAndTheSpoorRisesFromIt() {
        let layout = TimelineLayout(Self.mergingCase)
        let s3 = Self.stopRows(layout).first { $0.stop.id == "s3" }!
        #expect(s3.curves == [.init(kind: .branch, trackId: "side", centerLane: 0, edgeLane: 1, edge: .top)])
        // The curve replaces the spoor's own rail in that row.
        #expect(!s3.rails.contains { $0.lane == 1 })
        // Rows between the branch point and the spoor's oldest stop carry it.
        let s2 = Self.rails(layout, "s2").first { $0.lane == 1 }
        #expect(s2 == .init(lane: 1, trackId: "side", isRoot: false, top: true, bottom: true))
    }

    @Test func aMergeComesBackOntoTheParent() {
        let layout = TimelineLayout(Self.mergingCase)
        let s0 = Self.stopRows(layout).first { $0.stop.id == "s0" }!
        #expect(s0.curves == [.init(kind: .merge, trackId: "side", centerLane: 0, edgeLane: 1, edge: .bottom)])
        #expect(!s0.rails.contains { $0.lane == 1 })
        #expect(Self.rails(layout, "s1").first { $0.lane == 1 } == .init(lane: 1, trackId: "side", isRoot: false,
                                                                            top: true, bottom: true))
    }

    @Test func aBandBetweenRowsCarriesEveryRailThatCrossesIt() {
        let layout = TimelineLayout(Self.mergingCase)
        let bands = layout.items.compactMap { if case .band(let b) = $0 { b } else { nil } }
        #expect(bands[0].rails.isEmpty) // above the first row nothing runs
        #expect(bands[1].rails.map(\.lane) == [0, 1]) // between s0 and s1: root, and the merging spoor
        #expect(bands[2].rails.map(\.lane) == [0, 1]) // between s2 and s3: root, and the spoor coming up
        #expect(bands[2].rails.allSatisfy { $0.top && $0.bottom })
    }

    @Test func aBranchWithNoAnchorIsDrawnLevel() {
        let m = Self.map(
            bands: [Self.band("2026-10", "oktober 2026", 0, 2)],
            tracks: [Self.track("root", "Bewindvoering", lane: 0, rows: 0...1, root: true),
                     Self.track("huur", "Huur", lane: 1, rows: 1...1, status: "ended", terminus: "ended")],
            stops: [Self.stop("a", track: "root", row: 0, lane: 0, band: "2026-10"),
                    Self.stop("b", track: "huur", row: 1, lane: 1, band: "2026-10")],
            edges: [.init(kind: "branch", trackId: "huur", fromLane: 0, fromRow: 1, toLane: 1, toRow: 1)])
        let b = Self.stopRows(TimelineLayout(m)).first { $0.stop.id == "b" }!
        #expect(b.curves == [.init(kind: .branch, trackId: "huur", centerLane: 0, edgeLane: 1, edge: .level)])
    }

    /// A trigger on the trunk logged AFTER the first stop of its own spoor (a
    /// sommatie entered a day after "verwerkt als vordering"): the branch stop
    /// sits ABOVE the spoor's oldest stop. `buildTrackMap` still emits the edge
    /// and rings the junction, so the phone must draw a line out of that ring —
    /// down into the spoor's lane — and the spoor's rail must reach it.
    @Test func aBranchFromAStopNewerThanTheSpoorsOldestStillLeavesTheRing() {
        let m = Self.map(
            bands: [Self.band("2026-10", "oktober 2026", 0, 4)],
            tracks: [Self.track("root", "Bewindvoering", lane: 0, rows: 0...3, root: true),
                     Self.track("kvk", "Vordering KvK", lane: 1, rows: 2...3)],
            stops: [Self.stop("r0", track: "root", row: 0, lane: 0, band: "2026-10"),
                    Self.stop("trigger", track: "root", row: 1, lane: 0, band: "2026-10"),
                    Self.stop("k2", track: "kvk", row: 2, lane: 1, band: "2026-10"),
                    Self.stop("k3", track: "kvk", row: 3, lane: 1, band: "2026-10")],
            edges: [.init(kind: "branch", trackId: "kvk", fromLane: 0, fromRow: 1, toLane: 1, toRow: 3)])
        let layout = TimelineLayout(m)
        let trigger = Self.stopRows(layout).first { $0.stop.id == "trigger" }!
        #expect(trigger.curves == [.init(kind: .branch, trackId: "kvk", centerLane: 0, edgeLane: 1, edge: .bottom)])
        // The curve is the spoor's slice in the trigger row — no extra rail beside it.
        #expect(!trigger.rails.contains { $0.lane == 1 })
        // The spoor's rail runs from the curve down to its own stops, unbroken.
        #expect(Self.rails(layout, "k2").first { $0.lane == 1 }
            == .init(lane: 1, trackId: "kvk", isRoot: false, top: true, bottom: true))
        #expect(Self.rails(layout, "k3").first { $0.lane == 1 }
            == .init(lane: 1, trackId: "kvk", isRoot: false, top: true, bottom: false))
        // Nothing of the spoor floats above the ring.
        #expect(!Self.rails(layout, "r0").contains { $0.lane == 1 })
    }

    /// The same shape with the trigger BETWEEN two of the spoor's stops: the
    /// rail already passes that row, and the ring still gets its line out.
    @Test func aBranchFromInsideTheSpoorsSpanStillDrawsItsConnector() {
        let m = Self.map(
            bands: [Self.band("2026-10", "oktober 2026", 0, 3)],
            tracks: [Self.track("root", "Bewindvoering", lane: 0, rows: 1...1, root: true),
                     Self.track("kvk", "Vordering KvK", lane: 1, rows: 0...2)],
            stops: [Self.stop("k0", track: "kvk", row: 0, lane: 1, band: "2026-10"),
                    Self.stop("trigger", track: "root", row: 1, lane: 0, band: "2026-10"),
                    Self.stop("k2", track: "kvk", row: 2, lane: 1, band: "2026-10")],
            edges: [.init(kind: "branch", trackId: "kvk", fromLane: 0, fromRow: 1, toLane: 1, toRow: 2)])
        let layout = TimelineLayout(m)
        let trigger = Self.stopRows(layout).first { $0.stop.id == "trigger" }!
        #expect(trigger.curves == [.init(kind: .branch, trackId: "kvk", centerLane: 0, edgeLane: 1, edge: .bottom)])
        // The spoor really passes through this row: its rail runs on, unbroken,
        // and the curve leaves it beside the rail rather than replacing it.
        #expect(trigger.rails.first { $0.lane == 1 }
            == .init(lane: 1, trackId: "kvk", isRoot: false, top: true, bottom: true))
    }

    // MARK: - Lane sharing (real buildTrackMap output)

    /// `buildTrackMap` packs lanes on each spoor's STOP span alone, so two sporen
    /// that never ran at the same time share a lane even when one's connector
    /// has to travel past the other. These maps come from the real builder via
    /// `mobile-case-map.fixture.test.ts`.
    static func laneShared(_ name: String) throws -> CaseMapDTO {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appending(path: "Fixtures/case-map-lane-shared-\(name).json")
        return try APIClient.jsonDecoder.decode(CaseMapDTO.self, from: Data(contentsOf: url))
    }

    static func railsByItem(_ layout: TimelineLayout) -> [(id: String, rails: [TimelineLayout.Rail])] {
        layout.items.map {
            switch $0 {
            case .band(let b): (b.id, b.rails)
            case .stop(let s): (s.id, s.rails)
            }
        }
    }

    @Test(arguments: ["below", "above", "merge"])
    func twoSporenOnOneLaneNeverShareARail(_ name: String) throws {
        let map = try Self.laneShared(name)
        let a = try #require(map.tracks.first { $0.title == "Spoor A" })
        let b = try #require(map.tracks.first { $0.title == "Spoor B" })
        try #require(a.lane == b.lane) // the premise, from the real builder
        let layout = TimelineLayout(map)
        for (id, rails) in Self.railsByItem(layout) {
            let lane = rails.filter { $0.lane == a.lane }
            #expect(Set(lane.map(\.trackId)).count <= 1, "\(name) \(id): two sporen on one rail")
        }
        // B's own rows carry B's rail only, so its ended cap closes a line that stops.
        for row in Self.stopRows(layout) where row.stop.trackId == b.id {
            #expect(!row.rails.contains { $0.trackId == a.id }, "\(name) \(row.stop.title)")
        }
    }

    @Test(arguments: ["below", "above", "merge"])
    func aConnectorPastAnotherSporenIsRoutedBesideItUnbroken(_ name: String) throws {
        let map = try Self.laneShared(name)
        let a = try #require(map.tracks.first { $0.title == "Spoor A" })
        let layout = TimelineLayout(map)
        let rows = Self.stopRows(layout)
        // The connector whose path crosses B: in "merge" A's own branch is clear.
        let kind = name == "merge" ? "merge" : "branch"
        for edge in map.edges where edge.trackId == a.id && edge.kind == kind {
            let far = edge.kind == "merge" ? edge.toRow : edge.fromRow
            let spoorEdge = edge.kind == "merge" ? a.firstRow : (far > a.lastRow ? a.lastRow : a.firstRow)
            // Both ends are curves on the detour; nothing at either end is left as a bare ring.
            let atFar = rows.first { $0.stop.row == far }!.curves.filter { $0.trackId == a.id }
            let atSpoor = rows.first { $0.stop.row == spoorEdge }!.curves.filter { $0.trackId == a.id }
            #expect(atFar.count == 1 && atFar.allSatisfy(\.via), "\(name) \(edge.kind) far end")
            #expect(atSpoor.count == 1 && atSpoor.allSatisfy(\.via), "\(name) \(edge.kind) spoor end")
            #expect(atSpoor.first?.centerLane == a.lane)
            // Every row and band between the two ends carries the detour.
            let lo = min(far, spoorEdge), hi = max(far, spoorEdge)
            for row in rows where row.stop.row > lo && row.stop.row < hi {
                #expect(row.detours == [.init(lane: a.lane, trackId: a.id)], "\(name) \(row.stop.title)")
            }
        }
    }

    @Test func theFindingsShapeIsDrawnRowByRow() throws {
        let map = try Self.laneShared("below")
        let a = try #require(map.tracks.first { $0.title == "Spoor A" })
        let rows = Self.stopRows(TimelineLayout(map))
        // Row 4: the trunk's ring sends the connector up toward the detour.
        #expect(rows[4].curves.contains(.init(kind: .branch, trackId: a.id, centerLane: 0, edgeLane: 1,
                                              edge: .top, via: true)))
        // Rows 2–3 are B's: the detour runs beside B's rail, not on it.
        #expect(rows[2].detours == [.init(lane: 1, trackId: a.id)])
        #expect(rows[3].detours == [.init(lane: 1, trackId: a.id)])
        // Row 1, A's oldest stop: the detour curves into A's dot; A's rail stops there.
        #expect(rows[1].curves == [.init(kind: .branch, trackId: a.id, centerLane: 1, edgeLane: 1,
                                         edge: .bottom, via: true)])
        #expect(rows[1].rails.first { $0.lane == 1 } == .init(lane: 1, trackId: a.id, isRoot: false,
                                                               top: true, bottom: false))
    }

    @Test func aDetourSitsHalfALaneLeftOfItsSpoor() {
        let lanes = TimelineLayout.Lanes(count: 3)
        #expect(lanes.detourX(1) == lanes.x(1) - lanes.spacing / 2)
        #expect(lanes.detourX(1) > lanes.x(0) && lanes.detourX(1) < lanes.x(1))
    }

    @Test func aTrackWithNoStopsDrawsNothing() {
        let m = Self.map(
            bands: [Self.band("2026-10", "oktober 2026", 0, 1)],
            tracks: [Self.track("root", "Bewindvoering", lane: 0, rows: 0...0, root: true),
                     Self.track("leeg", "Leeg", lane: 1, rows: 0...0)],
            stops: [Self.stop("a", track: "root", row: 0, lane: 0, band: "2026-10")],
            edges: [.init(kind: "branch", trackId: "leeg", fromLane: 0, fromRow: 0, toLane: 1, toRow: 0)])
        let a = Self.stopRows(TimelineLayout(m)).first!
        #expect(a.curves.isEmpty)
        #expect(a.rails.isEmpty)
    }

    // MARK: - Marks, caps and words

    @Test func amberOnlyOnOpenStopsSteelForDone() {
        let layout = TimelineLayout(Self.mergingCase)
        let marks = Dictionary(uniqueKeysWithValues: Self.stopRows(layout).map { ($0.stop.id, $0.mark) })
        #expect(marks["s0"] == .current)
        #expect(marks["s1"] == .done)
        #expect(TimelineLayout.Mark.current.isAmber && TimelineLayout.Mark.waiting.isAmber)
        #expect(!TimelineLayout.Mark.done.isAmber)
        // A second open stop waits on Martin too: amber, but not the headline.
        let m = Self.map(bands: [Self.band("nu", "Nu", 0, 2)],
                         tracks: [Self.track("root", "Bewindvoering", lane: 0, rows: 0...1, root: true)],
                         stops: [Self.stop("a", track: "root", row: 0, lane: 0, band: "nu", state: "open", at: nil),
                                 Self.stop("b", track: "root", row: 1, lane: 0, band: "nu", state: "open", at: nil)],
                         current: "a")
        #expect(Self.stopRows(TimelineLayout(m)).map(\.mark) == [.current, .waiting])
    }

    @Test func anEndedSpoorIsACleanCapNeverAFailure() {
        let m = Self.map(
            bands: [Self.band("2026-10", "oktober 2026", 0, 2)],
            tracks: [Self.track("root", "Bewindvoering", lane: 0, rows: 0...1, root: true),
                     Self.track("huur", "Huur", lane: 1, rows: 0...0, status: "ended", terminus: "ended"),
                     Self.track("klaar", "Klaar", lane: 2, rows: 1...1, status: "done", terminus: "done")],
            stops: [Self.stop("a", track: "huur", row: 0, lane: 1, band: "2026-10"),
                    Self.stop("b", track: "klaar", row: 1, lane: 2, band: "2026-10")])
        let rows = Self.stopRows(TimelineLayout(m))
        #expect(rows[0].caps == [.init(lane: 1, kind: .ended)])
        #expect(rows[1].caps == [.init(lane: 2, kind: .done)])
        #expect(TimelineCopy.trackStatus("ended") == "geëindigd")
        #expect(TimelineCopy.trackStatus("done") == "afgerond")
        for word in ["mislukt", "fout", "gefaald"] {
            #expect(!TimelineCopy.trackStatus("ended").contains(word))
        }
    }

    @Test func theMetaLineNamesSpoorWhenAndWhoItWaitsOn() {
        let layout = TimelineLayout(Self.mergingCase)
        let rows = Dictionary(uniqueKeysWithValues: Self.stopRows(layout).map { ($0.stop.id, $0) })
        #expect(rows["s0"]?.meta == "hoofdlijn · loopt nu · wacht op jou")
        #expect(rows["s1"]?.meta == "Aanvraag · 14 okt 2026")
        let undated = Self.stop("u", track: "root", row: 0, lane: 0, band: "onbekend", at: nil)
        #expect(TimelineLayout.meta(undated, spoor: "hoofdlijn") == "hoofdlijn · zonder datum")
    }

    @Test func titlesAreNeverTruncatedAndTheLabelColumnTakesTheRest() {
        let long = String(repeating: "Antwoord aan Bewindkantoor Noordkust over de aanvullende stukken ", count: 3)
        let m = Self.map(bands: [Self.band("2026-10", "oktober 2026", 0, 1)],
                         tracks: [Self.track("root", "Bewindvoering", lane: 0, rows: 0...0, root: true)],
                         stops: [Self.stop("a", track: "root", row: 0, lane: 0, band: "2026-10", title: long)])
        let layout = TimelineLayout(m)
        #expect(Self.stopRows(layout)[0].stop.title == long)
        #expect(TimelineLayout.titleLineLimit == nil)
        #expect(layout.labelWidth(total: 375) == 375 - layout.lanes.width)
        #expect(layout.labelWidth(total: 10) == 0)
    }

    @Test func aFlaggedDateIsCarriedToTheRow() {
        let m = Self.map(bands: [Self.band("2026-10", "oktober 2026", 0, 1)],
                         tracks: [Self.track("root", "Bewindvoering", lane: 0, rows: 0...0, root: true)],
                         stops: [Self.stop("a", track: "root", row: 0, lane: 0, band: "2026-10", outOfOrder: true)])
        #expect(Self.stopRows(TimelineLayout(m))[0].stop.datesOutOfOrder)
    }

    // MARK: - The fixture

    @Test func theTimelineFixtureLaysOutWithoutGaps() throws {
        let data = try #require(try FixtureTests.body("timeline", "case-map"))
        let map = try APIClient.jsonDecoder.decode(CaseMapDTO.self, from: data)
        let layout = TimelineLayout(map)
        #expect(Self.stopRows(layout).map(\.stop.row) == Array(0..<map.rowCount))
        #expect(Self.stopRows(layout).first?.mark == .current)
        #expect(layout.lanes.count == map.laneCount)
        // The fixture shares lane 1 only at an interchange (Aanvraag merges into
        // the stop Opstart branches from): no lane is held twice, so nothing is routed.
        #expect(Self.stopRows(layout).allSatisfy { $0.detours.isEmpty && !$0.curves.contains(where: \.via) })
        for (id, rails) in Self.railsByItem(layout) {
            #expect(Dictionary(grouping: rails, by: \.lane).values.allSatisfy { Set($0.map(\.trackId)).count == 1 }, "\(id)")
        }
    }
}
