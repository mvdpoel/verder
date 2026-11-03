import SwiftUI

/// The Tijdlijn: the web's /timeline on the phone. The case as a vertical metro
/// map — newest at the top, month bands down the screen, the hoofdlijn as the
/// leftmost lane, sporen to its right — with every title in full in the label
/// column. Read-only: stops are edited on the web.
///
/// It opens on what is waiting (the page's one lit card), then the map. Amber
/// marks ONLY open stops, which by the case-history rule are work waiting on
/// Martin; steel is "it happened"; an ended spoor gets a plain cap and is never
/// drawn in a failure colour.
///
/// Lives on the Dossier stack, so it is lock-gated with the tab.
struct TimelineScreen: View {
    let store: TimelineStore
    /// Pushes onto the Dossier stack: a document or a task behind a stop.
    let open: (DossierRoute) -> Void

    @State private var selected: CaseMapDTO.Stop?
    /// Where a tap in the stop sheet leads, pushed once the sheet is gone.
    @State private var pending: DossierRoute?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    content
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .refreshable { await store.refresh() }
        }
        .navigationTitle(TimelineCopy.rowTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .preferredColorScheme(.dark)
        .task { await store.load() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await store.refresh() } }
        }
        .sheet(item: $selected, onDismiss: {
            if let route = pending {
                pending = nil
                open(route)
            }
        }) { stop in
            TimelineStopSheet(stop: stop, map: store.map, open: { route in
                pending = route
                selected = nil
            })
        }
    }

    // MARK: - Top

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(TimelineCopy.title)
                .font(.display(28, relativeTo: .title))
                .foregroundStyle(Color.inkBright)
                .accessibilityAddTraits(.isHeader)
            if let line = store.freshness {
                Text(line)
                    .font(.mono(12, relativeTo: .caption))
                    .foregroundStyle(Color.inkLabel)
            }
            if let error = store.lastError, store.map != nil {
                Text(VoorJouTab.message(error))
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(TimelineCopy.intro)
                .font(.display(15, relativeTo: .subheadline, weight: .light))
                .foregroundStyle(Color.inkMute)
                .fixedSize(horizontal: false, vertical: true)
            Toggle(isOn: Binding(get: { store.hideDebts },
                                 set: { hide in Task { await store.setHideDebts(hide) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(TimelineCopy.hideDebts)
                        .font(.display(16, relativeTo: .body))
                        .foregroundStyle(Color.inkBright)
                    // Said out loud, so nothing disappears silently.
                    if let map = store.map, map.debtEpisodesHidden {
                        Text(TimelineCopy.hiddenCount(map.hiddenDebtTrackCount))
                            .font(.mono(12, relativeTo: .caption))
                            .foregroundStyle(Color.inkLabel)
                    }
                }
            }
            .tint(Color.signal)
            .frame(minHeight: 44)
        }
    }

    @ViewBuilder private var content: some View {
        switch store.screen {
        case .loading:
            DossierCard(label: TimelineCopy.mapLabel) { SkeletonLines(count: 6) }
        case .empty:
            DossierCard(label: TimelineCopy.headlineLabel) { muted(TimelineCopy.noHeadline) }
            muted(TimelineCopy.empty)
        case .offlineNothingCached:
            DossierCard(label: TimelineCopy.mapLabel) {
                muted(TimelineCopy.offlineNothing)
                retry
            }
        case .failed(let error):
            DossierCard(label: TimelineCopy.mapLabel) {
                muted(VoorJouTab.message(error))
                retry
            }
        case .map(let map):
            let layout = TimelineLayout(map)
            headline(map)
            DossierCard(label: TimelineCopy.mapLabel) {
                TimelineMap(layout: layout, select: { selected = $0 })
            }
            Text(TimelineCopy.legend)
                .font(.display(13, relativeTo: .footnote, weight: .light))
                .foregroundStyle(Color.inkLabel)
                .fixedSize(horizontal: false, vertical: true)
            if !map.problems.isEmpty {
                // Not amber: a fact about the drawing, not a job for Martin.
                DossierCard(label: TimelineCopy.problemsLabel) {
                    ForEach(Array(map.problems.enumerated()), id: \.offset) { _, line in muted(line) }
                }
            }
        }
    }

    /// What waits on Martin, said before the map rather than hidden in it.
    @ViewBuilder private func headline(_ map: CaseMapDTO) -> some View {
        if let current = map.stops.first(where: { $0.id == map.currentStopId }) {
            let track = map.tracks.first { $0.id == current.trackId }
            Button { selected = current } label: {
                VStack(alignment: .leading, spacing: 6) {
                    Text(TimelineCopy.headlineLabel)
                        .font(.mono(12, relativeTo: .caption, weight: .medium))
                        .foregroundStyle(Color.attn)
                    if let track, !track.isRoot {
                        Text(track.title)
                            .font(.display(16, relativeTo: .callout, weight: .light))
                            .foregroundStyle(Color.signal)
                    }
                    Text(current.title)
                        .font(.display(22, relativeTo: .title2, weight: .light))
                        .foregroundStyle(Color.inkBright)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if let note = current.note, !note.isEmpty {
                        Text(note)
                            .font(.display(15, relativeTo: .subheadline, weight: .light))
                            .foregroundStyle(Color.ink)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassPanel()
                .overlay(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                    .strokeBorder(Color.attn.opacity(0.35)))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
        } else {
            DossierCard(label: TimelineCopy.headlineLabel) { muted(TimelineCopy.noHeadline) }
        }
    }

    private var retry: some View {
        Button(TimelineCopy.retry) { Task { await store.refresh() } }
            .font(.display(17, relativeTo: .body))
            .foregroundStyle(Color.signal)
            .frame(minHeight: 44)
    }

    private func muted(_ text: String) -> some View {
        Text(text)
            .font(.display(15, relativeTo: .subheadline))
            .foregroundStyle(Color.inkMute)
            .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - The map

/// The rows, each drawing its own slice of the rails beside its label. The
/// slices meet because every row's gutter fills that row's full height.
struct TimelineMap: View {
    let layout: TimelineLayout
    let select: (CaseMapDTO.Stop) -> Void

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(layout.items) { item in
                switch item {
                case .band(let band): bandRow(band)
                case .stop(let row): stopRow(row)
                }
            }
        }
    }

    private func bandRow(_ band: TimelineLayout.BandRow) -> some View {
        HStack(alignment: .top, spacing: 0) {
            RailGutter(lanes: layout.lanes, rails: band.rails, detours: band.detours)
                .frame(width: layout.lanes.width)
                .frame(maxHeight: .infinity)
            HStack(spacing: 6) {
                Text(band.label.uppercased())
                    .foregroundStyle(band.empty ? Color.inkFaint : Color.inkLabel)
                if band.empty {
                    Text("· " + TimelineCopy.quietMonth).foregroundStyle(Color.inkFaint)
                }
            }
            .font(.mono(11, relativeTo: .caption2, weight: .medium))
            .padding(.vertical, band.empty ? 4 : 10)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func stopRow(_ row: TimelineLayout.StopRow) -> some View {
        Button { select(row.stop) } label: {
            HStack(alignment: .top, spacing: 0) {
                RailGutter(lanes: layout.lanes, rails: row.rails, curves: row.curves, caps: row.caps,
                           detours: row.detours,
                           dot: .init(lane: row.stop.lane, mark: row.mark, junction: row.stop.isJunction))
                    .frame(width: layout.lanes.width)
                    .frame(maxHeight: .infinity)
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.stop.title)
                        .font(.display(16, relativeTo: .body, weight: row.mark == .current ? .medium : .regular))
                        .foregroundStyle(row.mark == .done ? Color.ink : Color.inkBright)
                        .lineLimit(TimelineLayout.titleLineLimit)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(row.meta)
                        .font(.mono(11, relativeTo: .caption2))
                        .foregroundStyle(row.mark.isAmber ? Color.attn : Color.inkLabel)
                        .fixedSize(horizontal: false, vertical: true)
                    if row.stop.datesOutOfOrder {
                        Text("! datum vóór de vorige halte")
                            .font(.mono(11, relativeTo: .caption2))
                            .foregroundStyle(Color.attn)
                    }
                }
                .padding(.vertical, 10)
                .padding(.trailing, 4)
                Spacer(minLength: 0)
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Self.spoken(row))
    }

    static func spoken(_ row: TimelineLayout.StopRow) -> String {
        var parts = [row.stop.title, row.meta]
        if row.mark == .current { parts.append(TimelineCopy.headlineLabel.lowercased()) }
        if row.stop.datesOutOfOrder { parts.append("let op: deze datum ligt vóór de vorige halte") }
        return parts.joined(separator: ", ")
    }
}

/// One row's slice of the lanes: rails, connectors, a cap and the stop's dot.
struct RailGutter: View {
    struct Dot: Equatable {
        let lane: Int
        let mark: TimelineLayout.Mark
        let junction: Bool
    }

    let lanes: TimelineLayout.Lanes
    let rails: [TimelineLayout.Rail]
    var curves: [TimelineLayout.Curve] = []
    var caps: [TimelineLayout.Cap] = []
    /// Routed connectors passing this row beside a lane another spoor holds.
    var detours: [TimelineLayout.Detour] = []
    var dot: Dot? = nil
    /// Level with the title's first line (the row's top padding plus half a line).
    @ScaledMetric(relativeTo: .body) private var dotY: CGFloat = 21

    var body: some View {
        Canvas { ctx, size in
            let y = dot == nil ? size.height / 2 : min(dotY, size.height / 2)
            for rail in rails {
                let x = lanes.x(rail.lane)
                var p = Path()
                if rail.top { p.move(to: CGPoint(x: x, y: 0)); p.addLine(to: CGPoint(x: x, y: y)) }
                if rail.bottom { p.move(to: CGPoint(x: x, y: y)); p.addLine(to: CGPoint(x: x, y: size.height)) }
                ctx.stroke(p, with: .color(rail.isRoot ? Color.steel.opacity(0.6) : Color.steelDim.opacity(0.7)),
                           lineWidth: rail.isRoot ? 2 * TimelineLayout.Marks.railHalfWidth
                               : 2 * TimelineLayout.Marks.detourHalfWidth)
            }
            for d in detours {
                let x = lanes.detourX(d.lane)
                var p = Path()
                p.move(to: CGPoint(x: x, y: 0)); p.addLine(to: CGPoint(x: x, y: size.height))
                ctx.stroke(p, with: .color(Color.steelDim.opacity(0.7)),
                           lineWidth: 2 * TimelineLayout.Marks.detourHalfWidth)
            }
            for c in curves {
                let xc = lanes.x(c.centerLane)
                let xe = c.via ? lanes.detourX(c.edgeLane) : lanes.x(c.edgeLane)
                var p = Path()
                switch c.edge {
                case .top:
                    p.move(to: CGPoint(x: xc, y: y))
                    p.addCurve(to: CGPoint(x: xe, y: 0), control1: CGPoint(x: xe, y: y),
                               control2: CGPoint(x: xe, y: y * 0.5))
                case .bottom:
                    p.move(to: CGPoint(x: xe, y: size.height))
                    p.addCurve(to: CGPoint(x: xc, y: y), control1: CGPoint(x: xe, y: y + (size.height - y) * 0.4),
                               control2: CGPoint(x: xe, y: y))
                case .level:
                    p.move(to: CGPoint(x: xc, y: y))
                    p.addLine(to: CGPoint(x: xe, y: y))
                }
                ctx.stroke(p, with: .color(Color.steelDim.opacity(0.7)), lineWidth: 2)
            }
            // Afgerond: a double bar in steel. Geëindigd: a single muted bar.
            // Both are clean outcomes; neither is ever amber or red.
            typealias M = TimelineLayout.Marks
            for cap in caps {
                let x = lanes.x(cap.lane)
                var p = Path()
                switch cap.kind {
                case .done:
                    for dy in [CGFloat(9), 13] {
                        p.move(to: CGPoint(x: x - M.doneCapHalfWidth, y: y - dy))
                        p.addLine(to: CGPoint(x: x + M.doneCapHalfWidth, y: y - dy))
                    }
                    ctx.stroke(p, with: .color(Color.steel.opacity(0.8)), lineWidth: 2)
                case .ended:
                    p.move(to: CGPoint(x: x - M.endedCapHalfWidth, y: y - 10))
                    p.addLine(to: CGPoint(x: x + M.endedCapHalfWidth, y: y - 10))
                    ctx.stroke(p, with: .color(Color.steelDim.opacity(0.8)), lineWidth: 2)
                }
            }
            if let dot {
                let center = CGPoint(x: lanes.x(dot.lane), y: y)
                let r = M.dotRadius
                func circle(_ radius: CGFloat) -> Path {
                    Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: 2 * radius, height: 2 * radius))
                }
                switch dot.mark {
                case .current:
                    ctx.stroke(circle(M.ringRadius), with: .color(Color.attn.opacity(0.5)), lineWidth: M.ringStroke)
                    ctx.fill(circle(r), with: .color(Color.attn))
                case .waiting:
                    ctx.fill(circle(r), with: .color(Color.plate))
                    ctx.stroke(circle(r), with: .color(Color.attn), lineWidth: M.dotStroke)
                case .done:
                    ctx.fill(circle(r), with: .color(Color.steel))
                }
                if dot.junction && dot.mark != .current {
                    ctx.stroke(circle(M.ringRadius), with: .color(Color.signal.opacity(0.55)), lineWidth: M.ringStroke)
                }
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - The stop sheet

/// One halte: its note, date and spoor, and what is really behind it — the
/// task, the files, the logbook entry and the mail. Files and tasks open their
/// screens; the entry and the mail have none on the phone and stay text.
struct TimelineStopSheet: View {
    let stop: CaseMapDTO.Stop
    let map: CaseMapDTO?
    let open: (DossierRoute) -> Void
    @Environment(\.dismiss) private var dismiss

    private var track: CaseMapDTO.Track? { map?.tracks.first { $0.id == stop.trackId } }
    private var isCurrent: Bool { map?.currentStopId == stop.id }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.void.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        top
                        if let note = stop.note, !note.isEmpty {
                            Text(note)
                                .font(.display(16, relativeTo: .body, weight: .light))
                                .foregroundStyle(Color.ink)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        // Amber: a date that contradicts the halte before it is
                        // Martin's to fix (on the web).
                        if stop.datesOutOfOrder {
                            Text(TimelineCopy.outOfOrder)
                                .font(.display(15, relativeTo: .subheadline))
                                .foregroundStyle(Color.attn)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        evidence
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(TimelineCopy.close) { dismiss() }.foregroundStyle(Color.signal)
                }
            }
        }
        .preferredColorScheme(.dark)
        .presentationDetents([.medium, .large])
    }

    private var top: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let track {
                Text([track.isRoot ? "Hoofdlijn" : track.title, TimelineCopy.terminus(track),
                      TimelineCopy.trackStatus(track.status)].joined(separator: " · "))
                    .font(.mono(12, relativeTo: .caption))
                    .foregroundStyle(Color.inkLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(stop.title)
                .font(.display(22, relativeTo: .title2, weight: .light))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(whenLine)
                .font(.mono(12, relativeTo: .caption))
                .foregroundStyle(stop.state == "open" ? Color.attn : Color.inkLabel)
        }
    }

    private var whenLine: String {
        let when: String = if let at = stop.happenedAt { DossierCopy.day(at) }
            else if stop.bandKey == "nu" { "loopt nu" } else { "zonder datum" }
        var parts = [TimelineCopy.stopState(stop.state), when]
        if isCurrent { parts.append("waar het nu op wacht") }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private var evidence: some View {
        let e = stop.evidence
        DossierCard(label: "ACHTER DEZE HALTE") {
            if e.isEmpty {
                Text(TimelineCopy.nothingBehind)
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.inkMute)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let task = e.task {
                link(route: Self.taskRoute(task.link), title: task.title,
                     line: "taak · " + TimelineCopy.taskStatus(task.status)
                        + (task.dueAt.map { " · uiterlijk \(DossierCopy.day($0))" } ?? ""))
            }
            ForEach(e.documents) { d in
                link(route: Self.documentRoute(d.link, title: d.title), title: d.title, line: "bestand")
            }
            if let entry = e.entry {
                DossierRow(title: entry.summary, line: "logboek · \(DossierCopy.day(entry.occurredAt))")
            }
            if let mail = e.email {
                DossierRow(title: mail.subject, line: "e-mail · van \(mail.fromAddr) · \(DossierCopy.day(mail.sentAt))")
            }
        }
    }

    @ViewBuilder private func link(route: DossierRoute?, title: String, line: String) -> some View {
        if let route {
            Button { open(route) } label: {
                HStack {
                    DossierRow(title: title, line: line)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Color.inkFaint)
                        .accessibilityHidden(true)
                }
            }
            .buttonStyle(.plain)
        } else {
            DossierRow(title: title, line: line)
        }
    }

    /// Through `DeepLink.parse`, the one strict reading of a link the server sent.
    static func taskRoute(_ link: String) -> DossierRoute? {
        if case .task(let id) = DeepLink.parse(link) { return .task(id.uuidString.lowercased()) }
        return nil
    }

    static func documentRoute(_ link: String, title: String) -> DossierRoute? {
        if case .document(let id) = DeepLink.parse(link) { return .document(id: id.uuidString.lowercased(), title: title) }
        return nil
    }
}
