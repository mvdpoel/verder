import CoreGraphics
import Foundation

/// The words of the Tijdlijn, decided outside the view.
enum TimelineCopy {
    static let title = "De zaak"
    static let rowTitle = "Tijdlijn"
    static let rowLine = "De zaak, het nieuwste bovenaan"
    static let intro = "Het nieuwste staat bovenaan. De hoofdlijn is hoe de bewindvoering zelf is gelopen; "
        + "een zijspoor begint zodra er iets binnenkomt en komt terug op de hoofdlijn of eindigt op zichzelf."
    static let headlineLabel = "WAAR HET NU OP WACHT"
    static let noHeadline = "Er staat op dit moment geen halte open."
    static let mapLabel = "DE KAART"
    static let problemsLabel = "WAT DE KAART NIET KON TEKENEN"
    static let hideDebts = "Schuldeisers verbergen"
    static let empty = "Er staat nog niets op de kaart. Zodra er een halte is, staat hij hier."
    static let offlineNothing = "Geen verbinding — de tijdlijn staat nog niet op je telefoon."
    static let retry = "Opnieuw proberen"
    static let quietMonth = "geen haltes"
    static let legend = "Gevuld = gebeurd · amber = wacht op jou · omcirkeld = vertrek- of aankomstpunt van een "
        + "zijspoor · dubbele streep = spoor afgerond · enkele streep = spoor geëindigd. "
        + "Binnen een maand staan de haltes op volgorde, niet op schaal."
    static let outOfOrder = "De datum van deze halte ligt vóór de halte ervoor. De kaart tekent de volgorde zoals hij is "
        + "ingevoerd — meestal betekent dit dat deze halte op een ander spoor thuishoort."
    static let nothingBehind = "Nog niets achter deze halte. Zodra er een mail, een taak of een document aan hangt, staat het hier."
    static let close = "Sluiten"

    static func hiddenCount(_ n: Int) -> String { n == 1 ? "1 spoor verborgen" : "\(n) sporen verborgen" }

    /// The spoor's status in words. `ended` is geëindigd — handled and closed,
    /// a clean outcome — and is never worded as a failure.
    static func trackStatus(_ status: String) -> String {
        switch status {
        case "done": "afgerond"
        case "ended": "geëindigd"
        default: "loopt nog"
        }
    }

    /// How a spoor finishes, for the stop sheet.
    static func terminus(_ track: CaseMapDTO.Track) -> String {
        if track.isRoot { return "hoofdlijn" }
        if track.terminus == "merge" { return "komt terug op de hoofdlijn" }
        return "eindigt op zichzelf"
    }

    static func stopState(_ state: String) -> String { state == "open" ? "wacht op jou" : "gebeurd" }

    @MainActor static func taskStatus(_ status: String) -> String { TaskModel.label(status) }
}

/// What the Tijdlijn draws, as plain decisions — the phone's `track-marks.ts`.
/// PURE: a `CaseMapDTO` in, rows out. The view draws what comes out of here one
/// to one and decides nothing else.
///
/// The page is a list of ITEMS in the map's own order, newest first: a header
/// per month band (quiet months included — a stretch where nothing happened is
/// a fact about the case), then that band's stops by `row`. Each item carries
/// the RAILS that cross it, so the view draws every row's slice of the lanes
/// in the row's own height and the slices meet: no text is ever measured here,
/// and a title is never cut to fit a fixed row.
///
/// Connectors are a curve in ONE row. A branch leaves the parent's dot at the
/// branch stop and rises into the spoor's lane; the spoor's rail then runs up
/// to its oldest stop. When the branch stop is newer than the spoor's newest
/// stop, the curve goes DOWN into the spoor's lane instead and the rail runs
/// up to meet it; when it sits INSIDE the spoor's span, the rail stays whole
/// and the curve leaves beside it. A merge comes down the spoor's lane and
/// curves into the parent's dot at the merge stop.
///
/// A rail is stretched to its connector ONLY through rows its lane holds for
/// nobody else: `buildTrackMap` packs lanes on stop spans alone, so another
/// spoor may sit in the same lane between a spoor and its trigger. Then the
/// connector is ROUTED instead — a curve at each end and a DETOUR half a lane
/// to the left through the rows between — so two sporen never share a line.
struct TimelineLayout: Equatable {
    /// The sizes `RailGutter` draws at, in points. They are FIXED — a dot that
    /// shrank with the lane count would stop being readable — so the lane pitch
    /// is derived from them instead, and never the other way round.
    enum Marks {
        static let dotRadius: CGFloat = 5
        /// The open stop's outline, outside the dot's radius.
        static let dotStroke: CGFloat = 2
        /// The current stop's halo and a junction's ring (never both on one dot).
        static let ringRadius: CGFloat = 7
        static let ringStroke: CGFloat = 1
        /// Half the width of the afgerond (double) and geëindigd (single) bars.
        static let doneCapHalfWidth: CGFloat = 6
        static let endedCapHalfWidth: CGFloat = 5
        /// Half the root rail's 3 pt stroke — the widest line in the gutter.
        static let railHalfWidth: CGFloat = 1.5
        /// Half a detour's (and a side rail's) 2 pt stroke.
        static let detourHalfWidth: CGFloat = 1

        /// How far the largest mark reaches from its lane's centre.
        static let reach = max(dotRadius + dotStroke / 2, ringRadius + ringStroke / 2,
                               doneCapHalfWidth, endedCapHalfWidth)
    }

    /// Lane x positions in the gutter left of the labels, at ONE pitch for any
    /// number of lanes: past four the gutter grows and the label column gives
    /// way, rather than the lanes squeezing until caps and rings cover the next
    /// lane's rail and a detour lies on the rail beside it.
    struct Lanes: Equatable {
        /// The smallest pitch at which a detour, half a lane from either rail,
        /// stays clear of the largest mark on both lanes beside it.
        static let minSpacing = 2 * (Marks.reach + Marks.detourHalfWidth)
        static let baseSpacing: CGFloat = max(18, minSpacing)
        static let inset: CGFloat = 12

        let count: Int
        let spacing: CGFloat

        init(count: Int) {
            self.count = count
            spacing = Self.baseSpacing
        }

        func x(_ lane: Int) -> CGFloat { Self.inset + CGFloat(lane) * spacing }

        /// Where a routed connector runs: half a lane left of the spoor it
        /// serves, so it never lies on any lane's rail.
        func detourX(_ lane: Int) -> CGFloat { x(lane) - spacing / 2 }

        var width: CGFloat { 2 * Self.inset + CGFloat(max(count, 1) - 1) * spacing }
    }

    /// A lane's slice of rail in one row: above the dot, below it, or both.
    struct Rail: Equatable, Hashable, Sendable {
        let lane: Int
        let trackId: String
        let isRoot: Bool
        let top: Bool
        let bottom: Bool
    }

    enum CurveEdge: Equatable, Sendable {
        /// Rises from the dot to the top of the row (a branch, the spoor above).
        case top
        /// Comes from the bottom of the row into the dot (a merge, the spoor below).
        case bottom
        /// Level with the dot: a spoor with no recorded branch stop, drawn at its oldest stop.
        case level
    }

    struct Curve: Equatable, Sendable {
        enum Kind: Equatable, Sendable { case branch, merge }
        let kind: Kind
        let trackId: String
        /// The lane whose dot it touches — the parent line.
        let centerLane: Int
        /// The spoor's lane, at the edge of the row.
        let edgeLane: Int
        let edge: CurveEdge
        /// The edge end sits on the DETOUR (`Lanes.detourX(edgeLane)`), not on the lane.
        var via: Bool = false
    }

    /// A routed connector passing through a row beside a lane another spoor
    /// holds there: drawn full height at `Lanes.detourX(lane)`.
    struct Detour: Equatable, Hashable, Sendable {
        let lane: Int
        let trackId: String
    }

    /// The cap at a spoor's newest stop: afgerond and geëindigd are different
    /// facts, and BOTH are clean outcomes.
    struct Cap: Equatable, Sendable {
        enum Kind: Equatable, Sendable { case done, ended }
        let lane: Int
        let kind: Kind
    }

    enum Mark: Equatable, Sendable {
        /// The one stop the map answers with: what is waiting on Martin now.
        case current
        /// Another open stop — also work waiting on Martin.
        case waiting
        /// It happened.
        case done

        /// Amber is for open stops only: by the case-history rule every open
        /// stop is work waiting on Martin.
        var isAmber: Bool { self != .done }
    }

    struct BandRow: Equatable, Identifiable {
        let key: String
        let label: String
        let empty: Bool
        let rails: [Rail]
        var detours: [Detour] = []
        var id: String { "band:" + key }
    }

    struct StopRow: Equatable, Identifiable {
        let stop: CaseMapDTO.Stop
        let track: CaseMapDTO.Track?
        let mark: Mark
        /// "hoofdlijn · 14 okt 2026" or "Opstart en stukken · loopt nu · wacht op jou".
        let meta: String
        let rails: [Rail]
        let curves: [Curve]
        let caps: [Cap]
        var detours: [Detour] = []
        var id: String { stop.id }
    }

    enum Item: Equatable, Identifiable {
        case band(BandRow)
        case stop(StopRow)

        var id: String {
            switch self {
            case .band(let b): b.id
            case .stop(let s): s.id
            }
        }
    }

    /// Full titles, always: a title wraps on as many lines as it needs.
    static let titleLineLimit: Int? = nil

    let items: [Item]
    let lanes: Lanes

    var isEmpty: Bool { !items.contains { if case .stop = $0 { true } else { false } } }

    /// The label column: everything right of the gutter.
    func labelWidth(total: CGFloat) -> CGFloat { max(total - lanes.width, 0) }

    /// The span a track's rail covers once its connectors are drawn.
    private struct Extent {
        let trackId: String
        let lane: Int
        let isRoot: Bool
        var top: Int
        var bottom: Int
    }

    /// A routed connector between two curve rows, `top < bottom`; it passes
    /// through every row strictly between them.
    private struct DetourSpan {
        let trackId: String
        let lane: Int
        let top: Int
        let bottom: Int
    }

    private struct Slice: Hashable {
        let row: Int
        let trackId: String
    }

    init(_ map: CaseMapDTO) {
        lanes = Lanes(count: map.laneCount)
        let trackById = Dictionary(map.tracks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let tracksWithStops = Set(map.stops.map(\.trackId))
        let drawn = map.tracks.filter { tracksWithStops.contains($0.id) }

        // `buildTrackMap` reserves a lane for a spoor's STOP span only — never
        // for the row it branches from or merges into — so two sporen that never
        // ran at the same time can share a lane with one's connector having to
        // pass the other. Every extent starts as that span; a connector may
        // stretch it only through rows its lane holds for nobody else.
        var extents = drawn.map { Extent(trackId: $0.id, lane: $0.lane, isRoot: $0.isRoot,
                                         top: $0.firstRow, bottom: $0.lastRow) }
        var curvesAt: [Int: [Curve]] = [:]
        var detourSpans: [DetourSpan] = []
        // Where a connector replaces the spoor's own slice of rail.
        var cutTop: Set<Slice> = [], cutBottom: Set<Slice> = []

        /// Can a rail in `lane` run from row `edge` (the spoor's end) to the
        /// connector row `at`? Not if another spoor holds the lane in any row
        /// between them, or passes straight through the connector row. Ending
        /// AT the connector row is fine: that is an interchange — one spoor
        /// merging into the stop another branches from — and both slices there
        /// are already replaced by their curves.
        func laneIsFree(_ lane: Int, from edge: Int, to at: Int, except id: String) -> Bool {
            let lo = min(edge, at) + 1, hi = max(edge, at) - 1
            return !extents.contains { e in
                e.trackId != id && e.lane == lane
                    && ((lo <= hi && e.top <= hi && lo <= e.bottom) || (e.top < at && at < e.bottom))
            }
        }
        func curve(_ row: Int, _ c: Curve) { curvesAt[row, default: []].append(c) }

        for (i, t) in drawn.enumerated() {
            let span = (top: t.firstRow, bottom: t.lastRow)
            for edge in map.edges where edge.trackId == t.id {
                let lane = t.lane
                switch edge.kind {
                case "branch":
                    if edge.fromRow > span.bottom {
                        // The trigger is OLDER than the spoor: the line rises from it.
                        if laneIsFree(lane, from: extents[i].bottom, to: edge.fromRow, except: t.id) {
                            extents[i].bottom = edge.fromRow
                            cutTop.insert(Slice(row: edge.fromRow, trackId: t.id))
                            curve(edge.fromRow, Curve(kind: .branch, trackId: t.id, centerLane: edge.fromLane,
                                                      edgeLane: lane, edge: .top))
                        } else {
                            curve(edge.fromRow, Curve(kind: .branch, trackId: t.id, centerLane: edge.fromLane,
                                                      edgeLane: lane, edge: .top, via: true))
                            curve(span.bottom, Curve(kind: .branch, trackId: t.id, centerLane: lane,
                                                     edgeLane: lane, edge: .bottom, via: true))
                            detourSpans.append(DetourSpan(trackId: t.id, lane: lane, top: span.bottom,
                                                          bottom: edge.fromRow))
                        }
                    } else if edge.fromRow == edge.toRow && edge.fromLane != edge.toLane {
                        curve(edge.fromRow, Curve(kind: .branch, trackId: t.id, centerLane: edge.fromLane,
                                                  edgeLane: lane, edge: .level))
                    } else if edge.fromRow < span.top {
                        // The trigger is NEWER than all of the spoor (logged after its
                        // first step). `buildTrackMap` still rings the junction, so the
                        // line leaves the ring DOWNWARD and reaches the spoor's newest stop.
                        if laneIsFree(lane, from: extents[i].top, to: edge.fromRow, except: t.id) {
                            extents[i].top = min(extents[i].top, edge.fromRow)
                            cutBottom.insert(Slice(row: edge.fromRow, trackId: t.id))
                            curve(edge.fromRow, Curve(kind: .branch, trackId: t.id, centerLane: edge.fromLane,
                                                      edgeLane: lane, edge: .bottom))
                        } else {
                            curve(edge.fromRow, Curve(kind: .branch, trackId: t.id, centerLane: edge.fromLane,
                                                      edgeLane: lane, edge: .bottom, via: true))
                            curve(span.top, Curve(kind: .branch, trackId: t.id, centerLane: lane,
                                                  edgeLane: lane, edge: .top, via: true))
                            detourSpans.append(DetourSpan(trackId: t.id, lane: lane, top: edge.fromRow,
                                                          bottom: span.top))
                        }
                    } else if edge.fromRow > span.top && edge.fromRow < span.bottom && edge.fromLane != lane {
                        // The trigger sits INSIDE the spoor's span: the spoor really
                        // passes this row, so its rail stays whole and the line
                        // leaves the ring beside it, down into the spoor's lane.
                        curve(edge.fromRow, Curve(kind: .branch, trackId: t.id, centerLane: edge.fromLane,
                                                  edgeLane: lane, edge: .bottom))
                    }
                case "merge":
                    guard edge.toRow < span.top else { break }
                    if laneIsFree(lane, from: extents[i].top, to: edge.toRow, except: t.id) {
                        extents[i].top = min(extents[i].top, edge.toRow)
                        cutBottom.insert(Slice(row: edge.toRow, trackId: t.id))
                        curve(edge.toRow, Curve(kind: .merge, trackId: t.id, centerLane: edge.toLane,
                                                edgeLane: lane, edge: .bottom))
                    } else {
                        curve(span.top, Curve(kind: .merge, trackId: t.id, centerLane: lane,
                                              edgeLane: lane, edge: .top, via: true))
                        curve(edge.toRow, Curve(kind: .merge, trackId: t.id, centerLane: edge.toLane,
                                                edgeLane: lane, edge: .bottom, via: true))
                        detourSpans.append(DetourSpan(trackId: t.id, lane: lane, top: edge.toRow, bottom: span.top))
                    }
                default: break
                }
            }
        }

        func sorted(_ rails: [Rail]) -> [Rail] { rails.sorted { ($0.lane, $0.trackId) < ($1.lane, $1.trackId) } }
        func sorted(_ ds: [Detour]) -> [Detour] { ds.sorted { ($0.lane, $0.trackId) < ($1.lane, $1.trackId) } }

        func rails(atRow r: Int) -> [Rail] {
            sorted(extents.compactMap { e -> Rail? in
                let top = r > e.top && r <= e.bottom && !cutTop.contains(Slice(row: r, trackId: e.trackId))
                let bottom = r >= e.top && r < e.bottom && !cutBottom.contains(Slice(row: r, trackId: e.trackId))
                guard top || bottom else { return nil }
                return Rail(lane: e.lane, trackId: e.trackId, isRoot: e.isRoot, top: top, bottom: bottom)
            })
        }

        /// The rails crossing the boundary just above row `r`.
        func rails(above r: Int) -> [Rail] {
            sorted(extents.filter { $0.top < r && r <= $0.bottom }
                .map { Rail(lane: $0.lane, trackId: $0.trackId, isRoot: $0.isRoot, top: true, bottom: true) })
        }

        func detours(atRow r: Int) -> [Detour] {
            sorted(detourSpans.filter { $0.top < r && r < $0.bottom }.map { Detour(lane: $0.lane, trackId: $0.trackId) })
        }

        func detours(above r: Int) -> [Detour] {
            sorted(detourSpans.filter { $0.top < r && r <= $0.bottom }.map { Detour(lane: $0.lane, trackId: $0.trackId) })
        }

        let byRow = map.stops.sorted { $0.row < $1.row }
        var items: [Item] = []
        for band in map.bands {
            items.append(.band(BandRow(key: band.key, label: band.label, empty: band.empty,
                                       rails: rails(above: band.fromRow), detours: detours(above: band.fromRow))))
            for s in byRow where s.row >= band.fromRow && s.row < band.toRow {
                let track = trackById[s.trackId]
                let spoor = (track?.isRoot ?? true) ? "hoofdlijn" : (track?.title ?? "hoofdlijn")
                let mark: Mark = s.id == map.currentStopId ? .current : s.state == "open" ? .waiting : .done
                var caps: [Cap] = []
                if let track, !track.isRoot, s.row == track.firstRow {
                    switch track.terminus {
                    case "done": caps.append(Cap(lane: track.lane, kind: .done))
                    case "ended": caps.append(Cap(lane: track.lane, kind: .ended))
                    default: break
                    }
                }
                items.append(.stop(StopRow(stop: s, track: track, mark: mark, meta: Self.meta(s, spoor: spoor),
                                           rails: rails(atRow: s.row), curves: curvesAt[s.row] ?? [], caps: caps,
                                           detours: detours(atRow: s.row))))
            }
        }
        self.items = items
    }

    /// Spoor, then when, then — for an open stop — who it waits on.
    static func meta(_ s: CaseMapDTO.Stop, spoor: String) -> String {
        let when: String = if let at = s.happenedAt {
            DossierCopy.day(at)
        } else if s.bandKey == "nu" {
            "loopt nu"
        } else {
            "zonder datum"
        }
        return ([spoor, when] + (s.state == "open" ? ["wacht op jou"] : [])).joined(separator: " · ")
    }
}
