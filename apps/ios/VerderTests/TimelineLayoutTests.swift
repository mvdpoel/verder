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
    }
}
