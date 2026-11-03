import SwiftUI

/// The Tijdlijn: the web's /timeline on the phone. The case as a vertical metro
/// map — newest at the top, month bands down the screen, the hoofdlijn as the
/// leftmost lane, sporen to its right — with every title in full in the label
/// column. Read-only: stops are edited on the web.
///
/// It opens on what is waiting (the hero, ON the map at its own stop), and
/// once that scrolls away a strip under the bar keeps saying it. Amber marks
/// ONLY the current stop — the web's rule, there is exactly one; any other open
/// stop is a hollow signal ring. Steel is "it happened"; a finished spoor gets
/// a plain cap and is never drawn in a failure colour.
///
/// Lives on the Dossier stack (and on Overzicht's, from its headline card), so
/// it is lock-gated with them.
struct TimelineScreen: View {
    let store: TimelineStore
    /// Pushes onto the stack this screen is on: a document or a task behind a stop.
    let open: (DossierRoute) -> Void
    /// The empty state's "Open Voor jou".
    var openVoorJou: () -> Void = {}
    /// Raise the NU sheet 0.15 s after the map is up (the headline cards).
    var raiseCurrent = false
    /// The phone's copy of a document, if it holds one (its soort, and whether
    /// it opens offline).
    var heldDocument: (String) -> DossierDoc? = { _ in nil }
    private var now: @Sendable () -> Date { store.now }

    @State private var selected: CaseMapDTO.Stop?
    /// Where a tap in the stop sheet leads, pushed once the sheet is gone.
    @State private var pending: DossierRoute?
    /// A spoor to scroll to once the sheet is gone ("Toon spoor op de tijdlijn").
    @State private var pendingTrack: String?
    @State private var pinned = false
    /// The hero's bottom edge in the scroll CONTENT (stable while scrolling).
    @State private var heroBottom: CGFloat = .infinity
    @State private var flash: String?
    @State private var flashOn = false
    @State private var raised = false
    @AccessibilityFocusState private var focusedStop: String?
    @Namespace private var rotor
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var ax: Bool { typeSize.isAccessibilitySize }

    private var current: CaseMapDTO.Stop? {
        guard let map = store.map else { return nil }
        return map.stops.first { $0.id == map.currentStopId }
    }

    var body: some View {
        scroller
        .navigationTitle(TimelineCopy.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // The bar names the screen only once the page's own title is gone.
            ToolbarItem(placement: .principal) {
                Text(TimelineCopy.title)
                    .font(.display(17, relativeTo: .headline, weight: .medium))
                    .foregroundStyle(Color.inkBright)
                    .opacity(pinned ? 1 : 0)
                    .accessibilityHidden(!pinned)
            }
            ToolbarItem(placement: .topBarTrailing) { filterMenu }
        }
        .toolbar(.visible, for: .navigationBar)
        .preferredColorScheme(.dark)
        .task { await store.load() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await store.refresh() } }
        }
        .sensoryFeedback(.selection, trigger: store.hideDebts)
        .sensoryFeedback(.error, trigger: store.failedRetries)
        .sheet(item: $selected, onDismiss: {
            if let route = pending {
                pending = nil
                open(route)
            }
        }) { stop in
            TimelineStopSheet(stop: stop, map: store.map, offline: store.offline,
                              keptAt: store.savedAt.map { TimelineCopy.clock($0, now: now()) },
                              heldDocument: heldDocument, now: now,
                              open: { route in
                                  pending = route
                                  selected = nil
                              },
                              showTrack: { id in
                                  selected = nil
                                  pendingTrack = id
                              })
        }
        .onChange(of: selected) { old, new in
            // ✕ returns VoiceOver to the row the sheet was opened from.
            if new == nil, let old { focusedStop = old.id }
        }
    }

    private static let endID = "timeline-end"

    private var scroller: some View {
        ScrollViewReader { proxy in
            mapScroll(proxy)
            .safeAreaInset(edge: .top, spacing: 0) {
                if pinned, let current {
                    TimelineStrip(stop: current, ax: ax) { scrollToCurrent(proxy, sheet: true) }
                        .transition(.opacity)
                }
            }
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: pinned)
            .onChange(of: store.map) { _, map in
                raiseIfAsked(proxy)
                if let id = flashAfterShowAll, map?.stops.contains(where: { $0.id == id }) == true {
                    flashAfterShowAll = nil
                    Task {
                        try? await Task.sleep(for: .seconds(0.2))
                        scrollAndFlash(id, proxy)
                    }
                }
            }
            .task(id: store.map == nil) { raiseIfAsked(proxy) }
            #if DEBUG
            .task { await fixtureState(proxy) }
            #endif
            .onChange(of: pendingTrack) { _, id in
                guard let id, selected == nil else { return }
                showTrack(id, proxy)
            }
            .accessibilityRotor("Sporen") {
                ForEach(trackEntries, id: \.stopId) { entry in
                    AccessibilityRotorEntry(Text(entry.label), id: entry.stopId, in: rotor)
                }
            }
        }
    }

    private func mapScroll(_ proxy: ScrollViewProxy) -> some View {
        ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header
                    content(proxy)
                    // Clear of the floating tab bar at the end.
                    Color.clear.frame(height: 96).id(Self.endID)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .coordinateSpace(.named(TimelineMap.contentSpace))
                // Saira's own ~1.57 em leading set a wrapped title's lines nearly
                // a line apart; the frames set them at the ramp's 23/17.
                .lineHeight(.multiple(factor: ax ? TimelineType.axLineFactor : TimelineType.lineFactor))
            }
            .background(Color.void.ignoresSafeArea())
            .refreshable { await store.refresh() }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { _, y in
                // The strip shows once the hero has scrolled under the bar;
                // hysteresis, so the strip's own height never toggles it back.
                if !pinned && y > heroBottom { pinned = true }
                else if pinned && y < heroBottom - 72 { pinned = false }
            }
    }

    // MARK: - Top

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(ax ? TimelineCopy.eyebrow : TimelineCopy.eyebrow.uppercased())
                .font(.mono(12, relativeTo: .caption)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
                .tracking(ax ? 0 : 1.9)
                .foregroundStyle(Color.inkLabel)
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) {
                    titleText
                    Spacer(minLength: 12)
                    showAllButton
                }
                VStack(alignment: .leading, spacing: 4) {
                    titleText
                    showAllButton
                }
            }
            headerLine
                .padding(.top, 4)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 16)
        .accessibilityElement(children: .contain)
    }

    private var titleText: some View {
        Text(TimelineCopy.title)
            .font(.display(28, relativeTo: .title))
            .foregroundStyle(Color.inkBright)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder private var showAllButton: some View {
        if store.map?.debtEpisodesHidden == true {
            Button {
                Task { await showAll() }
            } label: {
                HStack(spacing: 4) {
                    Text(TimelineCopy.showAll)
                    Image(systemName: "chevron.right").font(.system(size: 13, weight: .medium)).accessibilityHidden(true)
                }
                .font(.display(15, relativeTo: .subheadline))
                .foregroundStyle(Color.signal)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder private var headerLine: some View {
        switch store.headerLine {
        case .stats(let parts):
            readout(parts)
        case .hidden(let count, let open):
            if ax {
                VStack(alignment: .leading, spacing: 0) {
                    Text(HomeSummary.sentence(count)).foregroundStyle(Color.inkLabel)
                    if let open { Text(HomeSummary.sentence(open)).foregroundStyle(Color.signal) }
                }
                .font(.mono(12, relativeTo: .caption)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
                .fixedSize(horizontal: false, vertical: true)
            } else {
                Text(Self.twoTone(count.uppercased(), open.map { " · " + $0.uppercased() }, .signal))
                    .font(.mono(12, relativeTo: .caption)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
                    .tracking(1)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .offline(let line):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "wifi.slash")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.inkLabel)
                    .accessibilityHidden(true)
                readout([line])
            }
        case .failed(let line):
            readout([line])
        case .none:
            if store.screen == .loading {
                RoundedRectangle(cornerRadius: Radius.chip).fill(Color.edge)
                    .frame(width: 122, height: 8)
                    .padding(.vertical, 4)
                    .accessibilityLabel("Laden")
            }
        }
    }

    static func twoTone(_ a: String, _ b: String?, _ tone: Color) -> AttributedString {
        var first = AttributedString(a)
        first.foregroundColor = Color.inkLabel
        guard let b else { return first }
        var second = AttributedString(b)
        second.foregroundColor = tone
        return first + second
    }

    /// Mono readouts: one line of " · " parts, or one fact per line in sentence case at AX.
    private func readout(_ parts: [String]) -> some View {
        Group {
            if ax {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(parts.enumerated()), id: \.offset) { _, p in Text(HomeSummary.sentence(p)) }
                }
            } else {
                Text(parts.joined(separator: " · ").uppercased()).tracking(1)
            }
        }
        .font(.mono(12, relativeTo: .caption)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
        .foregroundStyle(Color.inkLabel)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var filterMenu: some View {
        Menu {
            Picker(selection: Binding(get: { store.hideDebts },
                                      set: { hide in Task { await store.setHideDebts(hide) } })) {
                Text(TimelineCopy.allTracks).tag(false)
                Label(TimelineCopy.hideDebts, systemImage: "eye.slash").tag(true)
            } label: { EmptyView() }
                .pickerStyle(.inline)
            Section {
                Text(TimelineCopy.filterFooter)
            }
        } label: {
            Image(systemName: store.hideDebts ? "line.3.horizontal.decrease.circle.fill"
                  : "line.3.horizontal.decrease.circle")
                .foregroundStyle(store.map == nil ? Color.inkLabel : Color.signal)
        }
        .accessibilityLabel(TimelineCopy.filterLabel)
        .accessibilityValue(store.hideDebts ? TimelineCopy.hideDebts : TimelineCopy.allTracks)
        .disabled(store.map == nil)
    }

    // MARK: - Content

    @ViewBuilder private func content(_ proxy: ScrollViewProxy) -> some View {
        switch store.screen {
        case .loading:
            TimelineSkeleton()
        case .empty:
            TimelineEmpty(ax: ax, openVoorJou: openVoorJou)
        case .offlineNothingCached:
            TimelineProblem(icon: "wifi.slash", title: TimelineCopy.offlineNothing, message: nil,
                            hint: nil, busy: store.isLoading) { Task { await store.refresh() } }
        case .failed(let error):
            TimelineProblem(icon: "exclamationmark.triangle", title: TimelineCopy.failedTitle,
                            message: TimelineCopy.failedBody, hint: TimelineCopy.retryHint(error),
                            busy: store.isLoading) { Task { await store.refresh() } }
        case .map(let map):
            let layout = TimelineLayout(map, singleLane: ax)
            TimelineMap(layout: layout, ax: ax, rotor: rotor, flash: flashOn ? flash : nil,
                        focusedStop: $focusedStop,
                        select: { selected = $0 },
                        open: open,
                        showTrack: { showTrack($0, proxy) },
                        heroBottom: { heroBottom = $0 })
            TimelineLegend(ax: ax, closesUndated: !layout.hasUndatedBand, lanes: layout.lanes)
            if !map.problems.isEmpty {
                // Not amber: a fact about the drawing, not a job for Martin.
                VStack(alignment: .leading, spacing: 8) {
                    Text(ax ? TimelineCopy.problemsLabel : TimelineCopy.problemsLabel.uppercased())
                        .font(.mono(12, relativeTo: .caption)).dynamicTypeSize(...DynamicTypeSize.accessibility3).tracking(ax ? 0 : 1)
                        .foregroundStyle(Color.inkLabel)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(Array(map.problems.enumerated()), id: \.offset) { _, line in
                        Text(line).font(.display(15, relativeTo: .subheadline)).foregroundStyle(Color.inkMute)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.leading, layout.lanes.width + 16)
                .padding(.trailing, 16)
                .padding(.top, 16)
            }
        }
    }

    private struct TrackEntry { let label: String; let stopId: String }

    /// The "Sporen" rotor: each spoor with its outcome, landing on its newest stop.
    private var trackEntries: [TrackEntry] {
        guard let map = store.map else { return [] }
        return map.tracks.compactMap { t in
            guard let newest = map.stops.filter({ $0.trackId == t.id }).min(by: { $0.row < $1.row }) else { return nil }
            let name = t.isRoot ? "Hoofdlijn \(t.title)" : "Spoor \(t.title)"
            return TrackEntry(label: "\(name), \(t.isRoot ? TimelineCopy.trackStatus(t.status) : TimelineCopy.outcome(t))",
                              stopId: newest.id)
        }
    }

    // MARK: - Moves

    private func raiseIfAsked(_ proxy: ScrollViewProxy) {
        guard raiseCurrent, !raised, let current else { return }
        raised = true
        Task {
            try? await Task.sleep(for: .seconds(0.15))
            selected = current
        }
    }

    private func scrollToCurrent(_ proxy: ScrollViewProxy, sheet: Bool) {
        guard let current else { return }
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.3)) { proxy.scrollTo(current.id, anchor: .top) }
        if sheet { selected = current }
    }

    private func showTrack(_ trackId: String, _ proxy: ScrollViewProxy) {
        pendingTrack = nil
        guard let map = store.map,
              let newest = map.stops.filter({ $0.trackId == trackId }).min(by: { $0.row < $1.row }) else { return }
        scrollAndFlash(newest.id, proxy)
    }

    private func scrollAndFlash(_ id: String, _ proxy: ScrollViewProxy) {
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.3)) {
            proxy.scrollTo(id, anchor: UnitPoint(x: 0, y: 0.3))
        }
        flash = id
        Task {
            // Twice, then gone; under Reduce Motion one steady highlight.
            for _ in 0..<(reduceMotion ? 1 : 2) {
                try? await Task.sleep(for: .seconds(0.35))
                withAnimation(.easeInOut(duration: 0.25)) { flashOn = true }
                try? await Task.sleep(for: .seconds(reduceMotion ? 1.2 : 0.35))
                withAnimation(.easeInOut(duration: 0.25)) { flashOn = false }
            }
            flash = nil
        }
    }

    @State private var flashAfterShowAll: String?

    /// "Toon alle sporen": the filter off, then the hidden waiting stop, flashed twice.
    private func showAll() async {
        let target = store.hiddenOpenStopIds.first
        await store.setHideDebts(false)
        flashAfterShowAll = target
    }

    #if DEBUG
    /// `-fixtures-timeline`: a state only a gesture reaches, for the captures.
    private func fixtureState(_ proxy: ScrollViewProxy) async {
        guard let states = FixtureLaunch.current?.timeline, !states.isEmpty else {
            if FixtureLaunch.current?.scroll == .end {
                try? await Task.sleep(for: .seconds(1.2))
                proxy.scrollTo(Self.endID, anchor: .bottom)
            }
            return
        }
        try? await Task.sleep(for: .seconds(1.2))
        if states.contains(.verborgen) {
            await store.setHideDebts(true)
            try? await Task.sleep(for: .seconds(0.5))
        }
        for state in states {
            switch state {
            case .scroll(let id):
                // A stop sits just under its pinned band; a band at the top.
                proxy.scrollTo(id, anchor: id.hasPrefix("band:") ? .top : UnitPoint(x: 0, y: 0.1))
            case .stop(let id):
                proxy.scrollTo(id, anchor: UnitPoint(x: 0, y: 0.35))
                try? await Task.sleep(for: .seconds(0.4))
                selected = store.map?.stops.first { $0.id == id }
            case .sheet:
                selected = current
            case .end:
                proxy.scrollTo(Self.endID, anchor: .bottom)
            case .dicht:
                try? await Task.sleep(for: .seconds(1.0))
                selected = nil
            case .verborgen, .overzicht:
                break
            }
        }
    }
    #endif
}

// MARK: - The map

/// The rows, each drawing its own slice of the rails beside its label. The
/// slices meet because every row's gutter fills that row's full height. Month
/// bands pin under the bar while their rows scroll past.
struct TimelineMap: View {
    let layout: TimelineLayout
    let ax: Bool
    let rotor: Namespace.ID
    let flash: String?
    var focusedStop: AccessibilityFocusState<String?>.Binding
    let select: (CaseMapDTO.Stop) -> Void
    let open: (DossierRoute) -> Void
    let showTrack: (String) -> Void
    static let contentSpace = "timeline-content"
    /// Where the hero's bottom is in the scroll content: the strip follows it.
    let heroBottom: (CGFloat) -> Void

    /// A band and the rows under it.
    private struct BandGroup: Identifiable {
        let band: TimelineLayout.BandRow
        let rows: [TimelineLayout.StopRow]
        var id: String { band.id }
    }

    private var groups: [BandGroup] {
        var out: [BandGroup] = []
        for item in layout.items {
            switch item {
            case .band(let b): out.append(BandGroup(band: b, rows: []))
            case .stop(let s):
                if let last = out.popLast() { out.append(BandGroup(band: last.band, rows: last.rows + [s])) }
            }
        }
        return out
    }

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: .sectionHeaders) {
            ForEach(groups) { group in
                if group.band.labelHidden {
                    Section {
                        TimelineBandRule(layout: layout, rails: group.band.rails, detours: group.band.detours)
                        rows(group.rows)
                    }
                } else {
                    Section {
                        rows(group.rows)
                    } header: {
                        TimelineBandHeader(band: group.band, layout: layout, ax: ax).id(group.band.id)
                    }
                }
            }
        }
    }

    @ViewBuilder private func rows(_ rows: [TimelineLayout.StopRow]) -> some View {
        ForEach(rows) { row in
            TimelineStopRowView(row: row, layout: layout, ax: ax, flashing: flash == row.id,
                                select: select, open: open, showTrack: showTrack, heroBottom: heroBottom)
                .id(row.id)
                .accessibilityFocused(focusedStop, equals: row.id)
                .accessibilityRotorEntry(id: row.id, in: rotor)
        }
    }
}

/// The rule that opens a band whose label the hero carries (NU).
struct TimelineBandRule: View {
    let layout: TimelineLayout
    let rails: [TimelineLayout.Rail]
    let detours: [TimelineLayout.Detour]

    var body: some View {
        HStack(spacing: 0) {
            RailGutter(lanes: layout.lanes, rails: rails, detours: detours, dotY: 0)
                .frame(width: layout.lanes.width + 16)
            Rectangle().fill(Color.hairline).frame(height: 1).frame(maxHeight: .infinity, alignment: .top)
                .padding(.trailing, 16)
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }
}

/// A month band: rule → 12 → label → 4. Pinned under the strip it hides its
/// own rule, so the strip's hairline is the only line there.
struct TimelineBandHeader: View {
    let band: TimelineLayout.BandRow
    let layout: TimelineLayout
    let ax: Bool
    @State private var pinnedTop = false

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            RailGutter(lanes: layout.lanes, rails: band.rails, detours: band.detours, dotY: 0)
                .frame(width: layout.lanes.width + 16)
                .frame(maxHeight: .infinity)
            VStack(alignment: .leading, spacing: 0) {
                Rectangle().fill(Color.hairline).frame(height: 1).opacity(pinnedTop ? 0 : 1)
                label
                    .padding(.top, 12)
                    .padding(.bottom, 4)
            }
            .padding(.trailing, 16)
        }
        .fixedSize(horizontal: false, vertical: true)
        .background(Color.void)
        .onGeometryChange(for: Bool.self) { $0.frame(in: .scrollView).minY <= 0.5 } action: { pinnedTop = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private var label: some View {
        let quiet = band.empty ? " · " + TimelineCopy.quietMonth : ""
        let text = band.label + quiet
        return Text(ax ? text : text.uppercased())
            .font(.mono(12, relativeTo: .caption, weight: .medium)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
            .tracking(ax ? 0 : 1.9)
            .foregroundStyle(Color.inkSoft)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// One stop: its dot on the rails, its title in full, its readouts. The
/// current stop is the HERO — the page's answer — at its own place on the map.
struct TimelineStopRowView: View {
    let row: TimelineLayout.StopRow
    let layout: TimelineLayout
    let ax: Bool
    let flashing: Bool
    let select: (CaseMapDTO.Stop) -> Void
    let open: (DossierRoute) -> Void
    let showTrack: (String) -> Void
    let heroBottom: (CGFloat) -> Void

    @State private var titleTop: CGFloat = 8
    @State private var lineHeight: CGFloat = 20

    private var isHero: Bool { row.mark == .current }
    private var titleFont: Font {
        isHero ? .display(22, relativeTo: .title2, weight: .semibold)
            : .display(15, relativeTo: .subheadline, weight: row.mark == .done ? .regular : .medium)
    }

    var body: some View {
        Button { select(row.stop) } label: {
            HStack(alignment: .top, spacing: 0) {
                RailGutter(lanes: layout.lanes, rails: row.rails, curves: row.curves, caps: row.caps,
                           detours: row.detours,
                           dot: .init(lane: row.lane, mark: row.mark, junction: row.stop.isJunction),
                           dotY: titleTop + lineHeight / 2)
                    .frame(width: layout.lanes.width + 16)
                    .frame(maxHeight: .infinity)
                labels
                    .padding(.top, 8)
                    .padding(.bottom, 12)
                    .padding(.trailing, 16)
                Spacer(minLength: 0)
            }
            .coordinateSpace(.named("stop"))
            .fixedSize(horizontal: false, vertical: true)
            .frame(minHeight: 44)
            .background(Color.signal.opacity(flashing ? 0.1 : 0))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.spoken)
        .accessibilityAddTraits(.isButton)
        .contextMenu { menu }
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(TimelineMap.contentSpace)).maxY } action: { y in
            if isHero { heroBottom(y) }
        }
    }

    private var labels: some View {
        VStack(alignment: .leading, spacing: 4) {
            if isHero {
                Text(ax ? TimelineCopy.headlineLabel : TimelineCopy.headlineLabel.uppercased())
                    .font(.mono(12, relativeTo: .caption, weight: .medium)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
                    .tracking(ax ? 0 : 1.9)
                    .foregroundStyle(Color.attn)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(row.stop.title)
                .font(titleFont)
                .foregroundStyle(row.mark == .done ? Color.inkSoft : Color.inkBright)
                .lineLimit(TimelineLayout.titleLineLimit)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named("stop")).minY } action: { titleTop = $0 }
                .background(alignment: .topLeading) {
                    // One line of the same face: where the first line's middle is.
                    Text(verbatim: "Ag").font(titleFont).fixedSize().hidden()
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { lineHeight = $0 }
                }
            if isHero, let note = row.stop.note, !note.isEmpty {
                Text(note)
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if ax {
                ForEach(Array(row.sentences.enumerated()), id: \.offset) { _, s in
                    Text(s)
                        .font(.mono(12, relativeTo: .caption)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
                        .foregroundStyle(Color.inkLabel)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                ForEach(Array(row.readouts.enumerated()), id: \.offset) { _, r in
                    Text(r.text.uppercased())
                        .font(.mono(12, relativeTo: .caption)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
                        .tracking(1)
                        .foregroundStyle(r.tone == .signal ? Color.signal : Color.inkLabel)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if row.stop.datesOutOfOrder {
                    Text("! " + TimelineCopy.flagged.uppercased())
                        .font(.mono(12, relativeTo: .caption)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
                        .foregroundStyle(Color.attn)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder private var menu: some View {
        Button(TimelineCopy.view, systemImage: "doc.text.magnifyingglass") { select(row.stop) }
        if let task = row.stop.evidence.task, let route = TimelineStopSheet.taskRoute(task.link) {
            Button(TimelineCopy.openTask, systemImage: "checklist") { open(route) }
        } else if let doc = row.stop.evidence.documents.first,
                  let route = TimelineStopSheet.documentRoute(doc.link, title: doc.title) {
            Button(TimelineCopy.openDocument, systemImage: "doc") { open(route) }
        }
        if let track = row.track, !track.isRoot {
            Button(TimelineCopy.showTrack, systemImage: "point.topleft.down.to.point.bottomright.curvepath") {
                showTrack(track.id)
            }
        }
    }
}

/// One row's slice of the lanes: rails, connectors, caps and the stop's dot.
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
    /// Level with the title's first line, measured by the row.
    var dotY: CGFloat

    /// The page's 16 pt gutter: lane x positions are inside the gutter column.
    nonisolated static let page: CGFloat = 16

    var body: some View {
        Canvas { ctx, size in
            typealias M = TimelineLayout.Marks
            let y = dot == nil ? size.height / 2 : min(max(dotY, 0), size.height)
            func x(_ lane: Int) -> CGFloat { Self.page + lanes.x(lane) }
            func dx(_ lane: Int) -> CGFloat { Self.page + lanes.detourX(lane) }
            let dash = StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: [2, 4])
            for rail in rails {
                let px = x(rail.lane)
                let width = rail.isRoot ? 2 * M.railHalfWidth : 2 * M.detourHalfWidth
                let color = Color.steel.opacity(rail.isRoot ? 0.85 : 0.6)
                func segment(_ from: CGFloat, _ to: CGFloat, dashed: Bool) {
                    var p = Path()
                    p.move(to: CGPoint(x: px, y: from)); p.addLine(to: CGPoint(x: px, y: to))
                    if dashed { ctx.stroke(p, with: .color(Color.steel.opacity(0.7)), style: dash) }
                    else { ctx.stroke(p, with: .color(color), lineWidth: width) }
                }
                if rail.top { segment(0, y, dashed: rail.dashedTop) }
                if rail.bottom { segment(y, size.height, dashed: rail.dashedBottom) }
            }
            for d in detours {
                var p = Path()
                p.move(to: CGPoint(x: dx(d.lane), y: 0)); p.addLine(to: CGPoint(x: dx(d.lane), y: size.height))
                ctx.stroke(p, with: .color(Color.steel.opacity(0.6)), lineWidth: 2 * M.detourHalfWidth)
            }
            for c in curves {
                let xc = x(c.centerLane)
                let xe = c.via ? dx(c.edgeLane) : x(c.edgeLane)
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
                }
                ctx.stroke(p, with: .color(Color.steel.opacity(0.6)), lineWidth: 2)
            }
            // The bar that begins or ends a line: a clean outcome, never amber or red.
            for cap in caps {
                let px = x(cap.lane)
                let cy = cap.end == .top ? y - M.capOffset : y + M.capOffset
                var p = Path()
                p.move(to: CGPoint(x: px, y: y)); p.addLine(to: CGPoint(x: px, y: cy))
                ctx.stroke(p, with: .color(Color.steel.opacity(0.6)), lineWidth: 2)
                var bar = Path()
                bar.move(to: CGPoint(x: px - M.capHalfWidth, y: cy)); bar.addLine(to: CGPoint(x: px + M.capHalfWidth, y: cy))
                ctx.stroke(bar, with: .color(Color.steel.opacity(0.85)), lineWidth: 2)
            }
            if let dot {
                let center = CGPoint(x: x(dot.lane), y: y)
                func circle(_ radius: CGFloat) -> Path {
                    Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: 2 * radius, height: 2 * radius))
                }
                switch dot.mark {
                case .current:
                    ctx.fill(circle(M.currentRadius + 3), with: .color(Color.attn.opacity(0.12)))
                    ctx.fill(circle(M.currentRadius), with: .color(Color.void))
                    ctx.stroke(circle(M.currentRadius), with: .color(Color.attn), lineWidth: M.currentStroke)
                case .open:
                    ctx.fill(circle(M.dotRadius), with: .color(Color.void))
                    ctx.stroke(circle(M.dotRadius), with: .color(Color.signal), lineWidth: M.dotStroke)
                case .done:
                    ctx.fill(circle(M.dotRadius), with: .color(Color.steel))
                }
                if dot.junction && dot.mark != .current {
                    ctx.fill(circle(M.ringRadius - 0.5), with: .color(Color.void.opacity(0.0)))
                    ctx.stroke(circle(M.ringRadius), with: .color(Color.steel), lineWidth: M.ringStroke + 0.5)
                }
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - The strip, the legend and the other states

/// Under the bar once the hero has scrolled away: what waits, one tap from its
/// sheet. At the accessibility sizes only the eyebrow is drawn; VoiceOver
/// still hears the full title.
struct TimelineStrip: View {
    let stop: CaseMapDTO.Stop
    let ax: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Circle().strokeBorder(Color.attn, lineWidth: ax ? 2.5 : 2)
                    .frame(width: ax ? 18 : 12, height: ax ? 18 : 12)
                    .frame(width: ax ? 24 : 12)
                if ax {
                    Text(TimelineCopy.stripShort)
                        .font(.mono(12, relativeTo: .caption, weight: .medium)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
                        .foregroundStyle(Color.attn)
                        .lineLimit(1)
                        .minimumScaleFactor(0.9)
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(TimelineCopy.headlineLabel.uppercased())
                            .font(.mono(12, relativeTo: .caption, weight: .medium)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
                            .tracking(1.9)
                            .foregroundStyle(Color.attn)
                        Text(stop.title)
                            .font(.display(15, relativeTo: .subheadline))
                            .foregroundStyle(Color.inkBright)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.system(size: ax ? 24 : 13, weight: .medium))
                    .foregroundStyle(Color.inkLabel)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, ax ? 12 : 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.plate)
            .overlay(alignment: .bottom) { Rectangle().fill(Color.hairline).frame(height: 1) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(TimelineCopy.headlineLabel): \(stop.title)")
        .accessibilityAddTraits(.isButton)
    }
}

/// The marks, said once, under the map — and the undated band, closed in words.
struct TimelineLegend: View {
    let ax: Bool
    let closesUndated: Bool
    let lanes: TimelineLayout.Lanes

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if closesUndated {
                VStack(alignment: .leading, spacing: 0) {
                    Rectangle().fill(Color.hairline).frame(height: 1)
                    let lines = [TimelineCopy.unknownBand, TimelineCopy.noUndated]
                    Text(ax ? lines.joined(separator: "\n") : lines.map { $0.uppercased() }.joined(separator: "\n"))
                        .font(.mono(12, relativeTo: .caption, weight: .medium)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
                        .tracking(ax ? 0 : 1.9)
                        .foregroundStyle(Color.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 12)
                        .accessibilityAddTraits(.isHeader)
                }
                .padding(.bottom, 24)
            }
            VStack(alignment: .leading, spacing: 8) {
                ForEach(TimelineCopy.LegendMark.allCases, id: \.self) { mark in
                    HStack(alignment: .center, spacing: 10) {
                        LegendGlyph(mark: mark).frame(width: 14, height: 18)
                        Text(ax ? HomeSummary.sentence(TimelineCopy.legend(mark)) : TimelineCopy.legend(mark).uppercased())
                            .font(.mono(12, relativeTo: .caption)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
                            .tracking(ax ? 0 : 1)
                            .foregroundStyle(mark == .current ? Color.attn : Color.inkLabel)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Text(ax ? TimelineCopy.notToScale : TimelineCopy.notToScale.uppercased())
                    .font(.mono(12, relativeTo: .caption)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
                    .tracking(ax ? 0 : 1)
                    .foregroundStyle(Color.inkLabel)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 4)
            }
            .accessibilityElement(children: .combine)
        }
        .padding(.leading, lanes.width + 16)
        .padding(.trailing, 16)
        .padding(.top, 8)
    }
}

private struct LegendGlyph: View {
    let mark: TimelineCopy.LegendMark

    var body: some View {
        Canvas { ctx, size in
            typealias M = TimelineLayout.Marks
            let c = CGPoint(x: size.width / 2, y: size.height / 2)
            func circle(_ r: CGFloat) -> Path { Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)) }
            switch mark {
            case .done: ctx.fill(circle(M.dotRadius), with: .color(.steel))
            case .current: ctx.stroke(circle(M.currentRadius), with: .color(.attn), lineWidth: M.currentStroke)
            case .open: ctx.stroke(circle(M.dotRadius), with: .color(.signal), lineWidth: M.dotStroke)
            case .junction:
                ctx.fill(circle(M.dotRadius - 0.5), with: .color(.steel))
                ctx.stroke(circle(M.ringRadius), with: .color(.steel), lineWidth: 1.5)
            case .running:
                var p = Path(); p.move(to: CGPoint(x: c.x, y: 0)); p.addLine(to: CGPoint(x: c.x, y: size.height))
                ctx.stroke(p, with: .color(.steel.opacity(0.7)), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: [2, 4]))
            case .end:
                var p = Path(); p.move(to: CGPoint(x: c.x - M.capHalfWidth, y: c.y)); p.addLine(to: CGPoint(x: c.x + M.capHalfWidth, y: c.y))
                ctx.stroke(p, with: .color(.steel.opacity(0.85)), lineWidth: 2)
            }
        }
        .accessibilityHidden(true)
    }
}

/// The loading state in the shape of the map, never a spinner (brief §2.1).
struct TimelineSkeleton: View {
    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Canvas { ctx, size in
                let faint = Color.edge
                func line(_ x: CGFloat, _ y0: CGFloat, _ y1: CGFloat, dashed: Bool = false) {
                    var p = Path(); p.move(to: CGPoint(x: x, y: y0)); p.addLine(to: CGPoint(x: x, y: y1))
                    ctx.stroke(p, with: .color(faint),
                               style: dashed ? StrokeStyle(lineWidth: 1.5, dash: [2, 4]) : StrokeStyle(lineWidth: 2))
                }
                line(24, 50, size.height)
                line(40, 62, size.height, dashed: true)
                line(56, 200, 400)
                for y in [50.0, 305, 445, 525] {
                    ctx.fill(Path(ellipseIn: CGRect(x: 24 - 5, y: y - 5, width: 10, height: 10)), with: .color(faint))
                }
                ctx.fill(Path(ellipseIn: CGRect(x: 56 - 5, y: 195, width: 10, height: 10)), with: .color(faint))
            }
            .frame(width: TimelineLayout.Lanes.standardWidth + 16)
            VStack(alignment: .leading, spacing: 0) {
                Rectangle().fill(Color.hairline).frame(height: 1)
                VStack(alignment: .leading, spacing: 8) {
                    bar(64, 8).padding(.top, 14)
                    bar(.infinity, 12).padding(.top, 14)
                    bar(174, 12)
                    bar(174, 12).padding(.top, 8)
                    bar(122, 8).padding(.top, 8)
                    bar(122, 8)
                    bar(174, 12).padding(.top, 44)
                    bar(122, 8)
                    bar(122, 8)
                }
                Rectangle().fill(Color.hairline).frame(height: 1).padding(.top, 16)
                VStack(alignment: .leading, spacing: 8) {
                    bar(64, 8).padding(.top, 14)
                    ForEach(0..<4, id: \.self) { _ in
                        bar(.infinity, 12).padding(.top, 18)
                        bar(174, 12)
                        bar(122, 8).padding(.top, 4)
                    }
                }
            }
            .padding(.trailing, 16)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Laden")
    }

    @ViewBuilder private func bar(_ width: CGFloat, _ height: CGFloat) -> some View {
        if width == .infinity {
            RoundedRectangle(cornerRadius: Radius.chip).fill(Color.edge).frame(height: height)
        } else {
            RoundedRectangle(cornerRadius: Radius.chip).fill(Color.edge).frame(width: width, height: height)
        }
    }
}

/// No stops yet: the NU band with one hollow mark, and where to go instead.
struct TimelineEmpty: View {
    let ax: Bool
    let openVoorJou: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Canvas { ctx, size in
                let x: CGFloat = 16 + TimelineLayout.Lanes.inset
                let y: CGFloat = 54
                var p = Path(); p.move(to: CGPoint(x: x, y: y + 8)); p.addLine(to: CGPoint(x: x, y: size.height))
                ctx.stroke(p, with: .linearGradient(Gradient(colors: [.steel.opacity(0.5), .steel.opacity(0)]),
                                                    startPoint: CGPoint(x: x, y: y), endPoint: CGPoint(x: x, y: size.height)),
                           style: StrokeStyle(lineWidth: 1.5, dash: [2, 4]))
                ctx.stroke(Path(ellipseIn: CGRect(x: x - 7, y: y - 7, width: 14, height: 14)),
                           with: .color(.steel.opacity(0.85)), lineWidth: 1.5)
            }
            .frame(width: (ax ? 32 : TimelineLayout.Lanes.standardWidth) + 16)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                Rectangle().fill(Color.hairline).frame(height: 1)
                Text(ax ? "Nu" : "NU")
                    .font(.mono(12, relativeTo: .caption, weight: .medium)).dynamicTypeSize(...DynamicTypeSize.accessibility3).tracking(ax ? 0 : 1.9)
                    .foregroundStyle(Color.inkSoft)
                    .padding(.top, 4)
                    .accessibilityAddTraits(.isHeader)
                Text(TimelineCopy.emptyTitle)
                    .font(.display(17, relativeTo: .headline, weight: .medium))
                    .foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
                Text(TimelineCopy.emptyBody)
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
                Text(TimelineCopy.emptyVoorJou)
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 12)
                Button(action: openVoorJou) {
                    Text(TimelineCopy.openVoorJou)
                        .font(.display(17, relativeTo: .body, weight: .medium))
                        .foregroundStyle(Color.signal)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.trailing, 16)
            .padding(.bottom, 40)
        }
    }
}

/// Offline with nothing kept, or the server failed: what happened, that the
/// rest of the app still works, and one way forward.
struct TimelineProblem: View {
    let icon: String
    let title: String
    let message: String?
    let hint: String?
    let busy: Bool
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 28, weight: .regular))
                .foregroundStyle(Color.inkBright)
                .padding(.bottom, 16)
                .accessibilityHidden(true)
            Text(title)
                .font(.display(17, relativeTo: .headline, weight: .medium))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let message {
                Text(message)
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }
            MoreButton(title: TimelineCopy.retry, weight: .primary, busy: busy, action: retry)
                .accessibilityHint(hint ?? "")
                .padding(.top, 16)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }
}

// MARK: - The stop sheet

/// One halte: its state and date, its note, its spoor and how that spoor
/// went, and what is really behind it — the task, the files, the logbook
/// entry and the mail. Files and tasks open their screens; the entry and the
/// mail have none on the phone and stay text.
struct TimelineStopSheet: View {
    let stop: CaseMapDTO.Stop
    let map: CaseMapDTO?
    let offline: Bool
    /// "09:20": when the kept map was fetched, said while offline.
    let keptAt: String?
    let heldDocument: (String) -> DossierDoc?
    let now: @Sendable () -> Date
    let open: (DossierRoute) -> Void
    let showTrack: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var notOnPhone: String?
    @State private var detent: PresentationDetent = .fraction(0.66)

    private var ax: Bool { typeSize.isAccessibilitySize }
    private var track: CaseMapDTO.Track? { map?.tracks.first { $0.id == stop.trackId } }
    private var isCurrent: Bool { map?.currentStopId == stop.id }
    private var words: TimelineLayout.Words? { map.map(TimelineLayout.Words.init) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                top
                section(TimelineCopy.noteLabel) {
                    let note = stop.note.flatMap { $0.isEmpty ? nil : $0 }
                    Text(note ?? TimelineCopy.noNote)
                        .font(.display(15, relativeTo: .subheadline))
                        .foregroundStyle(note == nil ? Color.inkMute : Color.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if stop.datesOutOfOrder {
                    // Amber: a date that contradicts the halte before it is
                    // Martin's to fix (on the web).
                    Text(TimelineCopy.outOfOrder)
                        .font(.display(15, relativeTo: .subheadline))
                        .foregroundStyle(Color.attn)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 16)
                }
                if let track { spoor(track) }
                evidence
                Text(TimelineCopy.editOnWeb)
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.inkMute)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 28)
            }
            .padding(.horizontal, 16)
            .padding(.top, 24)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
            .lineHeight(.multiple(factor: ax ? TimelineType.axLineFactor : TimelineType.lineFactor))
        }
        .background(Color.plate.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .presentationDetents([.fraction(0.66), .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.plate)
        .onAppear { if ax { detent = .large } }
    }

    private var top: some View {
        VStack(alignment: .leading, spacing: 8) {
            // At the accessibility sizes the ✕ gets its own row, so the title
            // has the full width and no word is ever broken.
            if ax { HStack { Spacer(); closeButton } }
            HStack(alignment: .top, spacing: 12) {
                Text(stop.title)
                    .font(.display(22, relativeTo: .title2, weight: .semibold))
                    .foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                if !ax { closeButton.padding(.top, -6) }
            }
            let date = offline ? "offline · van \(keptAt ?? "eerder")" : TimelineCopy.when(stop)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { stateBadge; dateText(date) }
                VStack(alignment: .leading, spacing: 8) { stateBadge; dateText(date) }
            }
        }
    }

    private var closeButton: some View {
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: ax ? 22 : 16, weight: .semibold))
                        .foregroundStyle(Color.inkSoft)
                        .frame(width: ax ? 56 : 44, height: ax ? 56 : 44)
                        .background(Circle().fill(Color.void.opacity(0.6)))
                        .overlay(Circle().strokeBorder(Color.edge))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(TimelineCopy.close)
    }

    private var stateBadge: some View {
        let tone: TimelineBadge.Tone = isCurrent ? .attn : stop.state == "open" ? .signal : .steel
        return TimelineBadge(text: TimelineCopy.stateBadge(isCurrent: isCurrent, state: stop.state), tone: tone)
    }

    private func dateText(_ s: String) -> some View {
        Text(ax ? HomeSummary.sentence(s) : s.uppercased())
            .font(.mono(12, relativeTo: .caption)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
            .tracking(ax ? 0 : 1)
            .foregroundStyle(Color.inkLabel)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func label(_ text: String, count: Int? = nil) -> some View {
        HStack {
            Text(ax ? text : text.uppercased())
                .font(.mono(12, relativeTo: .caption)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
                .tracking(ax ? 0 : 1.9)
                .foregroundStyle(Color.inkLabel)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if let count {
                Text("\(count)").font(.mono(12, relativeTo: .caption)).dynamicTypeSize(...DynamicTypeSize.accessibility3).foregroundStyle(Color.inkLabel)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private func section<Content: View>(_ title: String, count: Int? = nil,
                                        @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            label(title, count: count)
            content()
        }
        .padding(.top, 24)
    }

    @ViewBuilder private func spoor(_ track: CaseMapDTO.Track) -> some View {
        section(TimelineCopy.trackLabel) {
            Text(track.isRoot ? "Hoofdlijn · \(track.title)" : track.title)
                .font(.display(17, relativeTo: .body, weight: .medium))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
            if track.isRoot {
                if let line = TimelineCopy.runningSentence(words?.running.map(\.title) ?? []) {
                    sentence(line)
                }
            } else {
                TimelineBadge(text: TimelineCopy.outcome(track), tone: track.terminus == "open" ? .signal : .okay)
                    .padding(.vertical, 2)
                sentence(TimelineCopy.outcomeSentence(track, mergedAt: words?.mergeStop(track))
                         + (track.note.map { " " + $0 } ?? ""))
                let stops = map?.stops.filter { $0.trackId == track.id } ?? []
                let from = words?.branchStop(track)?.happenedAt ?? stops.compactMap(\.happenedAt).min()
                let to = words?.mergeStop(track)?.happenedAt ?? stops.compactMap(\.happenedAt).max()
                dateText(TimelineCopy.span(from: from, to: to, stops: stops.count))
                Button { showTrack(track.id) } label: {
                    HStack(spacing: 4) {
                        Text(TimelineCopy.showTrack)
                        Image(systemName: "chevron.right").font(.system(size: 13, weight: .medium)).accessibilityHidden(true)
                    }
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.signal)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.top, 4)
            }
        }
    }

    private func sentence(_ s: String) -> some View {
        Text(s)
            .font(.display(15, relativeTo: .subheadline))
            .foregroundStyle(Color.inkSoft)
            .fixedSize(horizontal: false, vertical: true)
    }

    private struct Row: Identifiable {
        let id: String
        let title: String
        let line: String
        var amberLead: String? = nil
        var route: DossierRoute? = nil
        /// Offline and not on the phone: a tap says so instead of opening.
        var unavailable = false
    }

    private var rows: [Row] {
        let e = stop.evidence
        var out: [Row] = []
        if let task = e.task {
            let line = TimelineCopy.taskLine(task, now: now())
            let lead = line.hasPrefix("voor jou") ? "voor jou" : nil
            out.append(Row(id: "task", title: task.title, line: line, amberLead: lead, route: Self.taskRoute(task.link)))
        }
        for d in e.documents {
            let held = heldDocument(d.id)
            out.append(Row(id: d.id, title: d.title,
                           line: TimelineCopy.documentLine(docType: held?.docType, held: held != nil, offline: offline),
                           route: Self.documentRoute(d.link, title: d.title), unavailable: offline && held == nil))
        }
        if let entry = e.entry {
            out.append(Row(id: "entry", title: entry.summary, line: "logboek · \(MoneyFormat.day(entry.occurredAt))"))
        }
        if let mail = e.email {
            out.append(Row(id: "mail", title: mail.subject,
                           line: "e-mail · van \(mail.fromAddr) · \(MoneyFormat.day(mail.sentAt))"))
        }
        return out
    }

    @ViewBuilder private var evidence: some View {
        let rows = rows
        section(TimelineCopy.behindLabel, count: rows.count) {
            VStack(alignment: .leading, spacing: 0) {
                if rows.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(TimelineCopy.nothingBehind)
                            .font(.display(15, relativeTo: .subheadline))
                            .foregroundStyle(Color.inkSoft)
                        Text(ax ? TimelineCopy.linkOnWeb : TimelineCopy.linkOnWeb.uppercased())
                            .font(.mono(12, relativeTo: .caption)).dynamicTypeSize(...DynamicTypeSize.accessibility3).tracking(ax ? 0 : 1)
                            .foregroundStyle(Color.inkLabel)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(16)
                    .accessibilityElement(children: .combine)
                }
                ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
                    if i > 0 { Hairline().padding(.horizontal, 16) }
                    evidenceRow(row)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassPanel()
        }
    }

    @ViewBuilder private func evidenceRow(_ row: Row) -> some View {
        let content = HStack(alignment: .center, spacing: 8) {
            // One dot column for every row, so every title starts at one x.
            Circle().strokeBorder(Color.attn, lineWidth: 2).frame(width: 9, height: 9)
                .opacity(row.amberLead == nil ? 0 : 1)
                .frame(width: ax ? 0 : 12)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(row.title)
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(row.unavailable ? Color.inkSoft : Color.inkBright)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                lineText(row)
                if notOnPhone == row.id {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "wifi.slash").font(.system(size: 13)).foregroundStyle(Color.inkSoft)
                            .accessibilityHidden(true)
                        Text(TimelineCopy.notOnPhone(row.title))
                            .font(.display(15, relativeTo: .subheadline))
                            .foregroundStyle(Color.inkSoft)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 8)
                }
            }
            Spacer(minLength: 0)
            if row.route != nil && !row.unavailable {
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.inkFaint)
                    .accessibilityHidden(true)
            }
        }
        .padding(.leading, ax ? 8 : 16)
        .padding(.trailing, 16)
        .padding(.vertical, 12)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        if let route = row.route {
            Button {
                if row.unavailable { notOnPhone = row.id } else { open(route) }
            } label: { content }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
        } else {
            content.accessibilityElement(children: .combine)
        }
    }

    private func lineText(_ row: Row) -> some View {
        let rest = row.amberLead.map { String(row.line.dropFirst($0.count)) } ?? row.line
        let lead = row.amberLead ?? ""
        return Group {
            if ax {
                Text(HomeSummary.sentence(row.line))
                    .foregroundStyle(row.amberLead == nil ? Color.inkLabel : Color.attn)
            } else {
                Text(Self.leadThenRest(lead.uppercased(), rest.uppercased()))
            }
        }
        .font(.mono(12, relativeTo: .caption)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
        .fixedSize(horizontal: false, vertical: true)
    }

    static func leadThenRest(_ lead: String, _ rest: String) -> AttributedString {
        var a = AttributedString(lead)
        a.foregroundColor = Color.attn
        var b = AttributedString(rest)
        b.foregroundColor = Color.inkLabel
        return a + b
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

/// The sheet's outlined badges: amber only for what waits on Martin now.
struct TimelineBadge: View {
    enum Tone { case attn, signal, steel, okay }
    let text: String
    let tone: Tone
    @Environment(\.dynamicTypeSize) private var typeSize

    private var color: Color {
        switch tone {
        case .attn: .attn
        case .signal: .signal
        case .steel: .steel
        case .okay: .okay
        }
    }

    var body: some View {
        let ax = typeSize.isAccessibilitySize
        HStack(spacing: ax ? 8 : 6) {
            Circle().fill(color).frame(width: ax ? 12 : 5, height: ax ? 12 : 5).accessibilityHidden(true)
            Text(ax ? HomeSummary.sentence(text) : text.uppercased())
                .font(.mono(12, relativeTo: .caption)).dynamicTypeSize(...DynamicTypeSize.accessibility3)
                .tracking(ax ? 0 : 1)
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, ax ? 12 : 7)
        .padding(.vertical, ax ? 8 : 3)
        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(color.opacity(0.8), lineWidth: 1))
    }
}

/// The Tijdlijn's leading: the Figma ramp's 23/17, and tighter at the
/// accessibility sizes so one wrapped title never reads as two rows.
enum TimelineType {
    static let lineFactor: CGFloat = 23.0 / 17.0
    static let axLineFactor: CGFloat = 1.25
}
