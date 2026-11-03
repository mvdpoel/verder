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

    @Test func lanesSitAtOneFixedPitchAtEveryCount() {
        for count in 1...10 {
            let layout = TimelineLayout.Lanes(count: count)
            #expect(layout.spacing == TimelineLayout.Lanes.baseSpacing)
            #expect(layout.x(0) == TimelineLayout.Lanes.inset)
            #expect(layout.x(count - 1) == TimelineLayout.Lanes.inset + CGFloat(count - 1) * TimelineLayout.Lanes.baseSpacing)
            #expect(layout.width == max(TimelineLayout.Lanes.standardWidth, TimelineLayout.Lanes.inset
                + CGFloat(count - 1) * TimelineLayout.Lanes.baseSpacing + TimelineLayout.Lanes.labelGap))
        }
    }

    /// The marks are drawn at fixed sizes, so the pitch must fit them: a pitch
    /// that shrank with the lane count put caps and rings over the next lane's
    /// rail and a detour on top of the rail beside it — two sporen on one line.
    @Test(arguments: [4, 5, 6, 7, 8])
    func everyLaneCountLeavesRoomForTheMarks(_ count: Int) {
        typealias M = TimelineLayout.Marks
        let lanes = TimelineLayout.Lanes(count: count)
        // Two dots, rings or caps on neighbouring lanes never touch.
        #expect(lanes.spacing >= 2 * M.reach)
        // No mark reaches the neighbouring lane's rail.
        #expect(M.reach + M.railHalfWidth < lanes.spacing)
        for lane in 1..<count {
            let d = lanes.detourX(lane)
            // A detour is clear of the dots on BOTH lanes beside it…
            #expect(d - lanes.x(lane - 1) > M.dotRadius + M.detourHalfWidth)
            #expect(lanes.x(lane) - d > M.dotRadius + M.detourHalfWidth)
            // …and of the largest ring, so it never reads as the rail beside it.
            #expect(d - lanes.x(lane - 1) >= M.reach + M.detourHalfWidth)
            #expect(lanes.x(lane) - d >= M.reach + M.detourHalfWidth)
        }
    }

    @Test func pastFourLanesTheGutterGrowsAndTheLabelsStillHaveRoom() {
        let four = TimelineLayout.Lanes(count: 4)
        let eight = TimelineLayout.Lanes(count: 8)
        #expect(eight.width > four.width)
        #expect(eight.x(7) - eight.x(6) == four.x(3) - four.x(2))
        // A 375 pt SE less the page's 16 pt gutters: the titles keep a real column.
        let m = Self.map(bands: [], tracks: [], stops: [], lanes: 8)
        #expect(TimelineLayout(m).labelWidth(total: 375 - 32) >= 180)
    }

    /// Figma: lanes at 24/40/56/72 from the screen edge, titles at 96 — the
    /// same column for a map with one spoor as for a map with four.
    @Test func upToFourLanesTheLabelsStartAtOneColumn() {
        for count in 1...4 {
            let lanes = TimelineLayout.Lanes(count: count)
            #expect(lanes.width == 80)
            #expect(16 + lanes.x(count - 1) == 24 + CGFloat(count - 1) * 16)
        }
        // At the accessibility sizes one rail, and the titles start at 48.
        #expect(TimelineLayout.Lanes(count: 1, minWidth: 0).width == 32)
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

    @Test func aBranchWithNoAnchorBeginsWithACap() {
        let m = Self.map(
            bands: [Self.band("2026-10", "oktober 2026", 0, 2)],
            tracks: [Self.track("root", "Bewindvoering", lane: 0, rows: 0...1, root: true),
                     Self.track("huur", "Huur", lane: 1, rows: 1...1, status: "ended", terminus: "ended")],
            stops: [Self.stop("a", track: "root", row: 0, lane: 0, band: "2026-10"),
                    Self.stop("b", track: "huur", row: 1, lane: 1, band: "2026-10")],
            edges: [.init(kind: "branch", trackId: "huur", fromLane: 0, fromRow: 1, toLane: 1, toRow: 1)])
        let b = Self.stopRows(TimelineLayout(m)).first { $0.stop.id == "b" }!
        #expect(b.curves.isEmpty)
        #expect(b.caps.contains(.init(lane: 1, end: .bottom)))
        #expect(b.sentences.contains("Hier begint dit spoor."))
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

    /// Every open stop waits on Martin (the case map's rule): the current one
    /// is the hero, any other is a hollow amber ring with "wacht op jou".
    @Test func everyOpenStopIsAmberAndWaitsOnMartin() {
        let layout = TimelineLayout(Self.mergingCase)
        let marks = Dictionary(uniqueKeysWithValues: Self.stopRows(layout).map { ($0.stop.id, $0.mark) })
        #expect(marks["s0"] == .current)
        #expect(marks["s1"] == .done)
        #expect(TimelineLayout.Mark.current.isAmber)
        #expect(TimelineLayout.Mark.open.isAmber && !TimelineLayout.Mark.done.isAmber)
        // A second open stop: amber too, and it says it waits on Martin.
        let m = Self.map(bands: [Self.band("nu", "Nu", 0, 2)],
                         tracks: [Self.track("root", "Bewindvoering", lane: 0, rows: 0...1, root: true)],
                         stops: [Self.stop("a", track: "root", row: 0, lane: 0, band: "nu", state: "open", at: nil),
                                 Self.stop("b", track: "root", row: 1, lane: 0, band: "nu", state: "open", at: nil)],
                         current: "a")
        let rows = Self.stopRows(TimelineLayout(m))
        #expect(rows.map(\.mark) == [.current, .open])
        #expect(rows[1].readouts.first == .init(text: "wacht op jou", tone: .attn))
        #expect(rows[1].sentences.contains("Wacht op jou."))
        #expect(TimelineCopy.stateBadge(isCurrent: false, state: "open") == "wacht op jou")
        #expect(TimelineCopy.stateBadge(isCurrent: false, state: "done") == "gebeurd")
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
        #expect(rows[0].caps.contains(.init(lane: 1, end: .top)))
        #expect(rows[1].caps.contains(.init(lane: 2, end: .top)))
        #expect(rows[0].readouts.first?.text.hasPrefix("afgehandeld") == true)
        #expect(rows[1].readouts.first?.text.hasPrefix("afgerond") == true)
        #expect(TimelineCopy.trackStatus("ended") == "geëindigd")
        #expect(TimelineCopy.trackStatus("done") == "afgerond")
        for word in ["mislukt", "fout", "gefaald"] {
            #expect(!TimelineCopy.trackStatus("ended").contains(word))
            #expect(!TimelineCopy.outcome(m.tracks[1]).contains(word))
            #expect(!TimelineCopy.outcomeSentence(m.tracks[1], mergedAt: nil).contains(word))
        }
    }

    @Test func anEndedStopKeepsItsSpoorAsAPartSoAWrapDropsTheSeparator() {
        let m = Self.map(
            bands: [Self.band("2026-10", "oktober 2026", 0, 1)],
            tracks: [Self.track("root", "Bewindvoering", lane: 0, rows: 0...0, root: true),
                     Self.track("huur", "Huurachterstand Lindehof", lane: 1, rows: 0...0, status: "ended", terminus: "ended")],
            stops: [Self.stop("a", track: "huur", row: 0, lane: 1, band: "2026-10")])
        let r = Self.stopRows(TimelineLayout(m))[0].readouts[0]
        #expect(r.parts.first == "afgehandeld")
        #expect(r.parts.last == "Huurachterstand Lindehof")
        // The arrangement the frame draws is on offer, and no line ends in "·".
        let candidates = TimelineLayout.lineBreaks(r.parts)
        #expect(candidates.contains { $0.count == 2 && $0[1] == ["Huurachterstand Lindehof"] })
        for lines in candidates {
            for line in lines { #expect(!line.joined(separator: " · ").hasSuffix("·")) }
        }
    }

    @Test func lineBreaksTryFewestLinesThenTheLongestFirstLine() {
        #expect(TimelineLayout.lineBreaks(["a"]) == [[["a"]]])
        #expect(TimelineLayout.lineBreaks(["a", "b", "c"]) == [
            [["a", "b", "c"]],
            [["a", "b"], ["c"]],
            [["a"], ["b", "c"]],
            [["a"], ["b"], ["c"]],
        ])
    }

    @Test func theReadoutsNameTheDateTheSpoorAndHowItEnded() {
        let layout = TimelineLayout(Self.mergingCase)
        let rows = Dictionary(uniqueKeysWithValues: Self.stopRows(layout).map { ($0.stop.id, $0) })
        // The newest stop of a merging spoor says when it came back.
        #expect(rows["s1"]?.readouts.map(\.text) == ["14 okt · Aanvraag", "laatste halte · terug op de hoofdlijn"])
        #expect(rows["s2"]?.readouts.map(\.text) == ["14 okt · Aanvraag"])
        #expect(rows["s3"]?.readouts.map(\.text) == ["2 aug"])
        // At the accessibility sizes, sentences naming every junction.
        #expect(rows["s3"]?.sentences == ["2 aug", "De hoofdlijn begint hier.", "Spoor Aanvraag splitst hier af."])
        #expect(rows["s0"]?.sentences.contains("Spoor Aanvraag komt hier terug.") == true)
    }

    /// A spoor that still runs with no open stop is drawn on towards now,
    /// dashed — and stubbed where its lane is taken above it.
    @Test func aRunningSpoorIsDrawnDashedTowardsNow() throws {
        let data = try #require(try FixtureTests.body("timeline", "case-map"))
        let map = try APIClient.jsonDecoder.decode(CaseMapDTO.self, from: data)
        let opstart = try #require(map.tracks.first { $0.title == "Opstart en stukken" })
        let layout = TimelineLayout(map)
        let rows = Self.stopRows(layout)
        let top = rows[0].rails.first { $0.trackId == opstart.id }
        #expect(top?.bottom == true && top?.dashedBottom == true)
        let newest = rows.first { $0.stop.row == opstart.firstRow }!.rails.first { $0.trackId == opstart.id }
        #expect(newest?.dashedTop == true && newest?.dashedBottom == false)
        // The hero says so in words: the spoor runs into it.
        #expect(rows[0].readouts.map(\.text) == ["spoor Opstart en stukken\nloopt hierheen"])
        #expect(TimelineCopy.runningSentence(["Opstart en stukken"], intoHere: true)
                == "Het spoor Opstart en stukken loopt nog en komt hier uit.")
        #expect(TimelineCopy.runningSentence(["Opstart en stukken"]) == "Het spoor Opstart en stukken loopt nog.")
        // A spoor with an open stop is not extended.
        let kade = try #require(map.tracks.first { $0.title == "Vordering Kade & Partners" })
        #expect(!rows[0].rails.contains { $0.trackId == kade.id })
    }

    /// The spoor's note (Martin's words) is woven into the outcome sentence;
    /// the merge names its stop in prose with the day in full.
    @Test func theOutcomeSentenceCarriesTheSpoorsOwnNote() throws {
        let data = try #require(try FixtureTests.body("timeline", "case-map"))
        let map = try APIClient.jsonDecoder.decode(CaseMapDTO.self, from: data)
        let words = TimelineLayout.Words(map)
        let huur = try #require(map.tracks.first { $0.title == "Huurachterstand Lindehof" })
        #expect(TimelineCopy.outcomeSentence(huur, mergedAt: nil) == "Dit spoor is afgehandeld: de huurachterstand is "
                + "geregeld en hoefde niet terug naar de hoofdlijn. Goed gedaan.")
        let aanvraag = try #require(map.tracks.first { $0.title == "Aanvraag bewindvoering" })
        #expect(TimelineCopy.outcomeSentence(aanvraag, mergedAt: words.mergeStop(aanvraag))
                == "Dit spoor kwam terug op de hoofdlijn bij de beschikking van 3 juni. Het was nodig om onder bewind te komen.")
        // A free title cannot take an article: it is quoted whole.
        #expect(TimelineCopy.stopPhrase("Verzoek naar de rechtbank") == "\u{201E}Verzoek naar de rechtbank\u{201D}")
        #expect(TimelineCopy.clause("KvK stuurde een aanmaning.") == "KvK stuurde een aanmaning")
    }

    @Test func theLegendSaysWachtOpJouAndHasNoSecondOpenMark() {
        #expect(TimelineCopy.LegendMark.allCases.map(TimelineCopy.legend)
                == ["gebeurd", "wacht op jou", "splitst af of komt samen", "spoor loopt nog", "begin of einde van een lijn"])
    }

    @Test func anOpenSpoorNeverReadsAsEndingOnItsOwn() {
        let t = Self.track("x", "Vordering", lane: 1, rows: 0...0)
        #expect(TimelineCopy.outcome(t) == "loopt nog")
        #expect(TimelineCopy.outcomeSentence(t, mergedAt: nil) == "Dit spoor loopt nog.")
        #expect(!TimelineCopy.outcomeSentence(t, mergedAt: nil).contains("eindigt"))
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

    /// Six open sporen at once, from the real builder: seven lanes, each its own
    /// line, each far enough from the next that its marks stay on it.
    @Test func sixConcurrentSporenEachKeepTheirOwnLine() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appending(path: "Fixtures/case-map-concurrent.json")
        let map = try APIClient.jsonDecoder.decode(CaseMapDTO.self, from: Data(contentsOf: url))
        try #require(map.laneCount >= 7) // the premise, from the real builder
        let layout = TimelineLayout(map)
        #expect(layout.lanes.count == map.laneCount)
        let xs = (0..<map.laneCount).map(layout.lanes.x)
        for (a, b) in zip(xs, xs.dropFirst()) {
            #expect(b - a >= 2 * TimelineLayout.Marks.reach)
        }
        for (id, rails) in Self.railsByItem(layout) {
            #expect(Dictionary(grouping: rails, by: \.lane).values.allSatisfy { Set($0.map(\.trackId)).count == 1 }, "\(id)")
        }
        #expect(Self.stopRows(layout).filter { $0.mark != .done }.count == 6)
    }

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
