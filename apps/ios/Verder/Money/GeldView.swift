import SwiftUI
import Accessibility

/// Geld (Figma "money · final", Geld frames): the freshness line, then one
/// card per account — never merged — each with its selected month's readouts,
/// six months of bars, the legend and "Wat niet in de balken zit". At the
/// accessibility sizes the chart gives way to a "Per maand" list.
///
/// THIN ON PURPOSE: every word and number comes from `GeldAccount` /
/// `GeldCopy` (GeldModel.swift, unit-tested). Amber appears nowhere: nothing
/// on Geld waits on Martin.
///
/// Reached from the Overzicht money card (scrolled to the leefgeldrekening)
/// and from Meer; lock-gated by its caller (it names accounts).
struct GeldScreen: View {
    let store: MoneyStore
    /// The account to land on ("Leefgeldrekening" from the leefgeld card).
    var focusAccount: String? = nil

    @State private var selection: [String: Int] = [:]
    @State private var sheetAccount: GeldAccount?
    @State private var failedRefreshes = 0
    @State private var landed = false
    /// DEBUG captures: bumped to scroll to the end (the rest of a "hele pagina" frame).
    @State private var scrollToEnd = 0
    @AccessibilityFocusState private var focusedAccount: String?
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var ax: Bool { typeSize.isAccessibilitySize }
    private static let endID = "geld-end"

    /// Over cards, or while the first answer is on its way; never above the
    /// failure card or the empty state (the frames).
    private var showsFreshness: Bool {
        if let g = store.glance {
            // Offline, the strip carries the stand's age itself.
            return !g.geld.isEmpty && GeldCopy.offline(error: store.lastError, fetchedAt: store.fetchedAt, now: store.now()) == nil
        }
        return store.lastError == nil
    }

    var body: some View {
        // Read in the body itself, not inside the ScrollViewReader's closure:
        // a state read there is not tracked as this view's dependency, so a
        // selection set by the fixture presets never redrew the cards.
        let picks = selection
        return ZStack {
            Color.void.ignoresSafeArea()
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Geld")
                                .font(HomeType.title)
                                .foregroundStyle(Color.inkBright)
                                .accessibilityAddTraits(.isHeader)
                            if showsFreshness {
                                GeldMeta(text: GeldCopy.freshness(fetchedAt: store.fetchedAt, now: store.now()), ax: ax)
                            }
                        }
                        content(picks)
                        Color.clear.frame(height: 1).id(Self.endID)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 24)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .lineHeight(.multiple(factor: HomeType.sairaLineFactor))
                }
                .refreshable {
                    await store.refresh()
                    if store.lastError != nil { failedRefreshes += 1 }
                }
                .onChange(of: store.glance?.geld.map(\.id) ?? []) { _, ids in land(proxy, ids) }
                .onAppear { land(proxy, store.glance?.geld.map(\.id) ?? []) }
                .onChange(of: scrollToEnd) { proxy.scrollTo(Self.endID, anchor: .bottom) }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .preferredColorScheme(.dark)
        .sensoryFeedback(.error, trigger: failedRefreshes)
        .sheet(item: $sheetAccount) { GeldSheetView(account: $0) }
        .task {
            #if DEBUG
            applyFixturePreset()
            #endif
            await store.refresh()
            #if DEBUG
            applyFixturePreset()
            if FixtureLaunch.current?.scroll == .end {
                try? await Task.sleep(for: .seconds(1))
                scrollToEnd += 1
            }
            #endif
            // Geld keeps itself fresh while it is on screen, as Overzicht does,
            // so an offline stand becomes current again by itself.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(HomeSummary.pollInterval))
                if Task.isCancelled { break }
                await store.refresh()
            }
        }
    }

    /// Lands once on the requested account: no animation under Reduce Motion,
    /// and VoiceOver focus on that account's heading.
    private func land(_ proxy: ScrollViewProxy, _ ids: [String]) {
        guard !landed, let target = focusAccount, ids.contains(target) else { return }
        landed = true
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(50))
            if reduceMotion { proxy.scrollTo(target, anchor: .top) } else {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.9)) { proxy.scrollTo(target, anchor: .top) }
            }
            focusedAccount = target
        }
    }

    #if DEBUG
    /// `-fixtures-geld <open|nov|sep|sheet>`: the frames' selected months and the sheet.
    private func applyFixturePreset() {
        guard let preset = FixtureLaunch.current?.geld, let g = store.glance else { return }
        func index(_ account: GeldAccount, _ month: String) -> Int? { account.months.firstIndex { $0.month.hasSuffix(month) } }
        let first = g.geld.first, second = g.geld.dropFirst().first
        switch preset {
        case .nov:
            if let a = first, let i = index(a, "-11") { selection[a.id] = i }
            if let b = second, let i = index(b, "-09") { selection[b.id] = i }
        case .sep:
            if let a = first, let i = index(a, "-09") { selection[a.id] = i }
        case .sheet:
            sheetAccount = first
        case .open:
            break
        }
    }
    #endif

    @ViewBuilder private func content(_ picks: [String: Int]) -> some View {
        if let g = store.glance {
            if let offline = GeldCopy.offline(error: store.lastError, fetchedAt: store.fetchedAt, now: store.now()) {
                offlineStrip(offline)
            } else if store.lastError != nil, store.lastError != .unauthorized,
                      let f = GeldCopy.failure(store.lastError, attemptedAt: store.attemptedAt) {
                keptStrip(f)
            }
            if g.geld.isEmpty {
                emptyCard
            }
            ForEach(g.geld) { account in
                GeldAccountCard(account: account,
                                selected: picks[account.id] ?? account.defaultSelection,
                                select: { selection[account.id] = $0 },
                                ax: ax,
                                openSheet: { sheetAccount = account })
                    .id(account.id)
                    .accessibilityFocused($focusedAccount, equals: account.id)
            }
        } else if let f = GeldCopy.failure(store.lastError, attemptedAt: store.attemptedAt) {
            failureCard(f)
        } else {
            GeldSkeleton()
        }
    }

    // MARK: States

    private var emptyCard: some View {
        GeldCard {
            GeldEmptyPreview()
                .padding(.bottom, 4)
            Text(GeldCopy.empty.title)
                .font(HomeType.bodyStrong)
                .foregroundStyle(Color.inkBright)
                .accessibilityAddTraits(.isHeader)
            Text(GeldCopy.empty.body)
                .font(HomeType.body)
                .foregroundStyle(Color.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func failureCard(_ f: GeldCopy.Failure) -> some View {
        GeldCard {
            Label {
                Text(f.headline).font(HomeType.bodyStrong).foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 17, weight: .regular))
                    .foregroundStyle(Color.inkSoft)
            }
            .labelStyle(GeldIconLabel())
            Text(f.body)
                .font(HomeType.body)
                .foregroundStyle(Color.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
            GeldMeta(text: f.readout, ax: ax)
            Button {
                Task {
                    await store.refresh()
                    if store.lastError != nil { failedRefreshes += 1 }
                }
            } label: {
                Text(HomeSummary.retry)
                    .font(HomeType.bodyStrong)
                    .foregroundStyle(Color.onSignal)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .padding(.vertical, 2)
                    .background(LinearGradient(colors: [.signalLit, .signal], startPoint: .top, endPoint: .bottom),
                                in: RoundedRectangle(cornerRadius: Radius.chip))
                    .glow(Glow.action)
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
        }
    }

    /// Offline over a kept stand: the badge, its age, and that it heals itself.
    private func offlineStrip(_ o: GeldCopy.Offline) -> some View {
        GeldCard {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 8) { offlineGlyph; offlineBadge(o); GeldMeta(text: o.stamp, ax: ax) }
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) { offlineGlyph; offlineBadge(o) }
                    GeldMeta(text: o.stamp, ax: ax)
                }
            }
            Text(o.sentence)
                .font(HomeType.body)
                .foregroundStyle(Color.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private var offlineGlyph: some View {
        Image(systemName: "wifi.slash")
            .font(.system(size: 15, weight: .regular))
            .foregroundStyle(Color.inkSoft)
            .accessibilityHidden(true)
    }

    private func offlineBadge(_ o: GeldCopy.Offline) -> some View {
        HStack(spacing: ax ? 8 : 4) {
            Circle().fill(Color.inkSoft).frame(width: 4, height: 4)
            Text(ax ? MoneyFormat.sentence(o.badge) : o.badge.uppercased())
        }
        .font(HomeType.mono)
        .lineHeight(.normal)
        .foregroundStyle(Color.ink)
        .padding(.horizontal, ax ? 12 : 8)
        .padding(.vertical, 4)
        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.steelDim, lineWidth: 1))
        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
        .fixedSize()
    }

    /// A server failure over a kept stand: the stand stays, this says why it is old.
    private func keptStrip(_ f: GeldCopy.Failure) -> some View {
        GeldCard {
            Label {
                Text(f.headline).font(HomeType.bodyStrong).foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 17, weight: .regular))
                    .foregroundStyle(Color.inkSoft)
            }
            .labelStyle(GeldIconLabel())
            GeldMeta(text: f.readout, ax: ax)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - One account

struct GeldAccountCard: View {
    let account: GeldAccount
    let selected: Int
    let select: (Int) -> Void
    let ax: Bool
    let openSheet: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var month: GeldMonth? { account.months.indices.contains(selected) ? account.months[selected] : nil }

    var body: some View {
        GeldCard {
            VStack(alignment: .leading, spacing: 4) {
                header
                if let newest = account.newestLine { GeldMeta(text: newest, ax: ax) }
            }
            if ax {
                axBody
            } else {
                readoutBlock
                    .padding(.top, 12)
                GeldChart(account: account, selected: selected, select: select)
                VStack(alignment: .leading, spacing: 16) {
                    GeldLegend(account: account)
                    disclosure
                }
            }
        }
    }

    @ViewBuilder private var header: some View {
        let title = Text(ax ? GeldAccount.compoundHyphenated(account.title) : account.title)
            .font(.display(17, relativeTo: .body, weight: .semibold))
            .foregroundStyle(Color.inkBright)
            .fixedSize(horizontal: false, vertical: true)
        let tail = account.tail.map { GeldMeta(text: $0, ax: ax, uppercase: false) }
        Group {
            if ax {
                VStack(alignment: .leading, spacing: 4) { title; tail }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) { title; tail }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(account.accessibilityTitle)
        .accessibilityAddTraits(.isHeader)
    }

    // MARK: Readouts (a fixed height, so a month change moves nothing below)

    private var readoutBlock: some View {
        ZStack(alignment: .topLeading) {
            // Every month's block, hidden, so the block is as tall as the
            // tallest of them and the chart never moves.
            ForEach(account.months) { readouts(for: $0).hidden() }
            if let month { readouts(for: month).transition(.opacity) }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.3, dampingFraction: 0.9),
                   value: selected)
    }

    @ViewBuilder private func readouts(for m: GeldMonth) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            GeldMeta(text: m.groupLabel, ax: ax, color: .ink)
            if let text = m.noDataText {
                VStack(alignment: .leading, spacing: 4) {
                    Text("geen data")
                        .font(HomeType.title)
                        .foregroundStyle(Color.inkSoft)
                    Text(text)
                        .font(HomeType.body)
                        .foregroundStyle(Color.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                ForEach(Array(m.readouts.enumerated()), id: \.offset) { i, r in
                    if i > 0 { GeldSeparator() }
                    readout(r)
                }
                if let parse = m.parseErrorText { GeldMeta(text: parse, ax: ax) }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(m.accessibilityLabel)
    }

    private func readout(_ r: GeldMonth.Readout) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .lastTextBaseline, spacing: 12) {
                    Text(r.title).font(HomeType.body).foregroundStyle(Color.inkSoft).fixedSize()
                    Spacer(minLength: 0)
                    Text(r.amount).font(HomeType.money).foregroundStyle(Color.inkBright).fixedSize()
                        .contentTransition(.numericText())
                }
                VStack(alignment: .leading, spacing: 0) {
                    Text(r.title).font(HomeType.body).foregroundStyle(Color.inkSoft)
                    Text(r.amount).font(HomeType.money).foregroundStyle(Color.inkBright)
                }
            }
            if let meta = r.meta { GeldMeta(text: meta, ax: ax) }
        }
    }

    // MARK: Disclosure

    private var disclosure: some View {
        Button(action: openSheet) {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(GeldAccount.disclosureTitle)
                        .font(HomeType.bodyStrong)
                        .foregroundStyle(Color.inkBright)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    GeldMeta(text: account.disclosureMeta, ax: ax)
                }
                Spacer(minLength: 0)
                if !ax {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Color.inkFaint)
                        .accessibilityHidden(true)
                }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opent de toelichting")
    }

    // MARK: Accessibility sizes: a list instead of a chart

    @ViewBuilder private var axBody: some View {
        if let month {
            readouts(for: month).padding(.top, 12)
        }
        GeldSeparator().padding(.vertical, 12)
        Text("Per maand")
            .font(HomeType.mono)
            .lineHeight(.normal)
            .foregroundStyle(Color.inkBright)
            .dynamicTypeSize(...DynamicTypeSize.accessibility3)
            .accessibilityAddTraits(.isHeader)
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(account.months.enumerated()), id: \.element.id) { i, m in
                if i > 0 { GeldSeparator() }
                VStack(alignment: .leading, spacing: 4) {
                    Text(MoneyFormat.sentence(m.long))
                        .font(HomeType.bodyStrong)
                        .foregroundStyle(Color.inkBright)
                    GeldMeta(text: m.stateLine, ax: true, uppercase: false)
                    ForEach(Array(m.readouts.enumerated()), id: \.offset) { _, r in
                        VStack(alignment: .leading, spacing: 0) {
                            GeldMeta(text: r.title, ax: true)
                            Text(r.amount).font(HomeType.bodyStrong).foregroundStyle(Color.inkBright)
                        }
                        .padding(.top, 8)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(m.accessibilityLabel)
            }
        }
        GeldSeparator().padding(.vertical, 12)
        disclosure
    }
}

// MARK: - The chart

/// Six months, two bars each: received solid `steel`, spent an `ink-soft`
/// outline; a partial month hatched; a month with no rows says "geen data"
/// in its slot — never a € 0,00 bar. Tap or drag across to choose a month.
struct GeldChart: View {
    let account: GeldAccount
    let selected: Int
    let select: (Int) -> Void

    @State private var width: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let plotHeight: CGFloat = 96

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let scale = account.scaleLabel { GeldMeta(text: scale, ax: false, uppercase: false) }
            HStack(alignment: .top, spacing: 0) {
                ForEach(Array(account.months.enumerated()), id: \.element.id) { i, m in
                    column(m, selected: i == selected)
                }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .contentShape(Rectangle())
            .onTapGesture(coordinateSpace: .local) { select(at: $0.x) }
            .gesture(DragGesture(minimumDistance: 12).onChanged { v in
                guard abs(v.translation.width) > abs(v.translation.height) else { return }
                select(at: v.location.x)
            })
        }
        .sensoryFeedback(.selection, trigger: selected)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.3, dampingFraction: 0.9),
                   value: selected)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Zes maanden van de \(account.title.lowercased())")
        .accessibilityValue(account.months.indices.contains(selected)
                            ? "\(account.months[selected].accessibilityLabel), geselecteerd" : "")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: select(min(account.months.count - 1, selected + 1))
            case .decrement: select(max(0, selected - 1))
            @unknown default: break
            }
        }
        .accessibilityChartDescriptor(GeldChartDescriptor(account: account))
    }

    private func select(at x: CGFloat) {
        guard width > 0, !account.months.isEmpty else { return }
        let i = Int((x / width) * CGFloat(account.months.count))
        let clamped = min(account.months.count - 1, max(0, i))
        if clamped != selected { select(clamped) }
    }

    private func column(_ m: GeldMonth, selected isSelected: Bool) -> some View {
        VStack(spacing: 0) {
            plot(m)
                .padding(.top, 4)
            VStack(spacing: 4) {
                Text(m.short.uppercased())
                    .font(.mono(13, relativeTo: .footnote, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? Color.inkBright : Color.inkLabel)
                if isSelected {
                    Rectangle().fill(Color.inkBright).frame(width: 24, height: 2)
                }
                if m.hatched {
                    Text("DEELS")
                        .font(HomeType.mono)
                        .foregroundStyle(Color.inkLabel)
                }
            }
            .lineHeight(.normal)
            .multilineTextAlignment(.center)
            .padding(.top, 8)
            .padding(.bottom, 8)
            .dynamicTypeSize(...DynamicTypeSize.xLarge)
        }
        .frame(maxWidth: .infinity)
        .background {
            if isSelected {
                RoundedRectangle(cornerRadius: Radius.chip)
                    .fill(Color.field)
                    .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.hairlineLit, lineWidth: 1))
                    .padding(.horizontal, 3)
            }
        }
    }

    private func plot(_ m: GeldMonth) -> some View {
        ZStack(alignment: .bottom) {
            if m.coverage == .none {
                Text("GEEN\nDATA")
                    .font(HomeType.mono)
                    .lineHeight(.normal)
                    .foregroundStyle(Color.inkLabel)
                    .multilineTextAlignment(.center)
                    .padding(.bottom, 8)
                    .dynamicTypeSize(...DynamicTypeSize.large)
            } else {
                HStack(alignment: .bottom, spacing: 2) {
                    bar(m.inFraction) {
                        ZStack {
                            Rectangle().fill(Color.steel)
                            if m.hatched { Hatch(spacing: 5).stroke(Color.void.opacity(0.75), lineWidth: 1.2) }
                        }
                    }
                    bar(m.outFraction) {
                        ZStack {
                            if m.hatched { Hatch(spacing: 5).stroke(Color.inkDim, lineWidth: 1.2) }
                            Rectangle().strokeBorder(Color.inkSoft, lineWidth: 1.5)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: Self.plotHeight, alignment: .bottom)
        .overlay(alignment: .top) { Rectangle().fill(Color.hairline).frame(height: 1) }
        .overlay(alignment: .bottom) { Rectangle().fill(Color.hairlineLit).frame(height: 1) }
    }

    private func bar<S: View>(_ fraction: Double, @ViewBuilder _ fill: () -> S) -> some View {
        fill()
            .frame(width: 12, height: max(fraction > 0 ? 2 : 0, Self.plotHeight * fraction))
            .clipped()
    }
}

/// The chart as an audio graph for VoiceOver: months on x, euros on y,
/// one series received and one spent. A month with no data has no point.
struct GeldChartDescriptor: AXChartDescriptorRepresentable {
    let account: GeldAccount

    func makeChartDescriptor() -> AXChartDescriptor {
        let labels = account.months.map { MoneyFormat.sentence($0.long) }
        let x = AXCategoricalDataAxisDescriptor(title: "Maand", categoryOrder: labels)
        let peak = account.months.compactMap { m in m.readouts.isEmpty ? nil : max(m.inFraction, m.outFraction) }.max() ?? 1
        let y = AXNumericDataAxisDescriptor(title: "Deel van de grootste maand", range: 0...max(peak, 1),
                                            gridlinePositions: []) { "\(Int(($0 * 100).rounded())) procent" }
        func series(_ name: String, _ value: (GeldMonth) -> Double) -> AXDataSeriesDescriptor {
            AXDataSeriesDescriptor(name: name, isContinuous: false, dataPoints: account.months.compactMap { m in
                m.readouts.isEmpty ? nil : AXDataPoint(x: MoneyFormat.sentence(m.long), y: value(m),
                                                       label: m.accessibilityLabel)
            })
        }
        return AXChartDescriptor(title: account.title, summary: account.disclosureMeta, xAxis: x, yAxis: y,
                                 additionalAxes: [],
                                 series: [series(account.inTitle, \.inFraction), series("Uitgegeven", \.outFraction)])
    }
}

/// The legend: swatches that match the marks, wrapping as the width allows.
struct GeldLegend: View {
    let account: GeldAccount

    var body: some View {
        GeldFlow(spacing: 16, rowSpacing: 8) {
            item(account.legend[0]) { Rectangle().fill(Color.steel) }
            item(account.legend[1]) { Rectangle().strokeBorder(Color.inkSoft, lineWidth: 1.5) }
            if account.showsPartialLegend {
                item("deels op afschrift") {
                    ZStack {
                        Hatch(spacing: 3).stroke(Color.inkDim, lineWidth: 1)
                        Rectangle().strokeBorder(Color.inkSoft, lineWidth: 1)
                    }
                    .clipped()
                }
            }
        }
        .accessibilityHidden(true)
    }

    private func item<S: View>(_ text: String, @ViewBuilder _ swatch: () -> S) -> some View {
        HStack(spacing: 6) {
            swatch().frame(width: 10, height: 12)
            Text(text.uppercased())
                .font(HomeType.mono)
                .lineHeight(.normal)
                .foregroundStyle(Color.inkLabel)
                .dynamicTypeSize(...DynamicTypeSize.accessibility3)
                .fixedSize()
        }
    }
}

/// Lays its children out left to right, wrapping to a new row when full.
struct GeldFlow: Layout {
    var spacing: CGFloat
    var rowSpacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews)
        let height = rows.reduce(0) { $0 + $1.height } + rowSpacing * CGFloat(max(0, rows.count - 1))
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews) {
            var x = bounds.minX
            for i in row.items {
                let size = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: .unspecified)
                x += size.width + spacing
            }
            y += row.height + rowSpacing
        }
    }

    private struct Row { var items: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(width: CGFloat, _ subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for i in subviews.indices {
            let size = subviews[i].sizeThatFits(.unspecified)
            let extra = rows[rows.count - 1].items.isEmpty ? size.width : size.width + spacing
            if rows[rows.count - 1].width + extra > width, !rows[rows.count - 1].items.isEmpty {
                rows.append(Row())
            }
            let first = rows[rows.count - 1].items.isEmpty
            rows[rows.count - 1].items.append(i)
            rows[rows.count - 1].width += first ? size.width : size.width + spacing
            rows[rows.count - 1].height = max(rows[rows.count - 1].height, size.height)
        }
        return rows
    }
}

// MARK: - The sheet

struct GeldSheetView: View {
    let account: GeldAccount
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize

    private var ax: Bool { typeSize.isAccessibilitySize }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 4) {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .center, spacing: 16) { title; Spacer(minLength: 0); done }
                        VStack(alignment: .leading, spacing: 8) { title; done }
                    }
                    GeldMeta(text: account.sheet.meta, ax: ax)
                }
                ForEach(account.sheet.sections) { section($0) }
            }
            .padding(.horizontal, 16)
            .padding(.top, 24)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
            .lineHeight(.multiple(factor: HomeType.sairaLineFactor))
        }
        // 70 %: the frame's sheet top sits at 268 of 874 pt, so the page's
        // header stays visible above it; drag up for the whole list.
        .presentationDetents([.fraction(0.7), .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.plate)
        .preferredColorScheme(.dark)
    }

    private var title: some View {
        Text(GeldSheet.title)
            .font(HomeType.title)
            .foregroundStyle(Color.inkBright)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    private var done: some View {
        Button("Klaar") { dismiss() }
            .font(HomeType.bodyStrong)
            .foregroundStyle(Color.signal)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .buttonStyle(.plain)
    }

    private func section(_ s: GeldSheet.Section) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            GeldMeta(text: s.heading, ax: ax, color: .ink)
                .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(s.rows.enumerated()), id: \.element.id) { i, r in
                    if i > 0 { GeldSeparator() }
                    VStack(alignment: .leading, spacing: 4) {
                        ViewThatFits(in: .horizontal) {
                            HStack(alignment: .firstTextBaseline, spacing: 12) {
                                Text(r.title).font(HomeType.bodyStrong).foregroundStyle(Color.inkBright)
                                Spacer(minLength: 0)
                                if let amount = r.amount {
                                    Text(amount).font(HomeType.bodyStrong).foregroundStyle(Color.inkBright).fixedSize()
                                }
                            }
                            VStack(alignment: .leading, spacing: 0) {
                                Text(r.title).font(HomeType.bodyStrong).foregroundStyle(Color.inkBright)
                                    .fixedSize(horizontal: false, vertical: true)
                                if let amount = r.amount {
                                    Text(amount).font(HomeType.bodyStrong).foregroundStyle(Color.inkBright)
                                }
                            }
                        }
                        GeldMeta(text: r.meta, ax: ax)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            if let note = s.note {
                Text(note)
                    .font(HomeType.body)
                    .foregroundStyle(Color.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 4)
            }
        }
    }
}

// MARK: - Pieces

/// One mono meta line: upper-case at the ordinary sizes, sentence case at the
/// accessibility sizes (capped there, as Overzicht's are). Spaces inside a
/// segment are NBSP, so it wraps only after a " ·".
struct GeldMeta: View {
    let text: String
    let ax: Bool
    var uppercase = true
    var color: Color = .inkLabel

    var body: some View {
        // Ordinary sizes: a segment never breaks inside, only after a " ·".
        // Accessibility sizes: a whole segment no longer fits a line, so only
        // the date units stay whole ("t/m 24 okt" → "t/m" · "24 okt").
        let joined = ax ? MoneyFormat.joinDates(text) : HomeSummary.metaLine(text.components(separatedBy: " · "))
        Text(uppercase ? (ax ? MoneyFormat.sentence(joined) : joined.uppercased()) : joined)
            .font(HomeType.mono)
            .lineHeight(.normal)
            .foregroundStyle(color)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .dynamicTypeSize(...DynamicTypeSize.accessibility3)
            .accessibilityLabel(MoneyFormat.spokenDates(text))
    }
}

struct GeldSeparator: View {
    var body: some View {
        Rectangle().fill(Color.hairlineLit).frame(height: 1).accessibilityHidden(true)
    }
}

struct GeldCard<Content: View>: View {
    @ViewBuilder let content: Content
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassPanel()
    }
}

private struct GeldIconLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            configuration.icon.accessibilityHidden(true)
            configuration.title
        }
    }
}

/// "Nog geen afschriften": six empty, dashed slots between the gridlines.
struct GeldEmptyPreview: View {
    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Color.hairline).frame(height: 1)
            HStack(spacing: 0) {
                ForEach(0..<6, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 2)
                        .strokeBorder(Color.inkDim, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                        .frame(width: 40, height: 84)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.vertical, 8)
            Rectangle().fill(Color.hairlineLit).frame(height: 1)
        }
        .accessibilityHidden(true)
    }
}

/// Loading: the shape of one account card, not a spinner (brief §2.4).
struct GeldSkeleton: View {
    var body: some View {
        GeldCard {
            HStack(spacing: 8) { bar(150, 20); bar(48, 13) }
            bar(200, 13)
            VStack(alignment: .leading, spacing: 12) {
                bar(180, 13)
                ForEach(0..<2, id: \.self) { i in
                    if i > 0 { GeldSeparator() }
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 8) { bar(220, 17); bar(110, 9) }
                        Spacer(minLength: 8)
                        bar(96, 28)
                    }
                }
            }
            .padding(.top, 12)
            bar(48, 13)
            HStack(alignment: .bottom, spacing: 0) {
                ForEach(Array([(72, 64), (92, 86), (72, 70), (76, 78), (92, 84)].enumerated()), id: \.offset) { _, pair in
                    HStack(alignment: .bottom, spacing: 2) { bar(12, CGFloat(pair.0)); bar(12, CGFloat(pair.1)) }
                        .frame(maxWidth: .infinity)
                }
                Color.clear.frame(maxWidth: .infinity, maxHeight: 1)
            }
            .frame(height: GeldChart.plotHeight, alignment: .bottom)
            .overlay(alignment: .bottom) { Rectangle().fill(Color.hairlineLit).frame(height: 1) }
            HStack(spacing: 0) {
                ForEach(0..<6, id: \.self) { _ in bar(24, 9).frame(maxWidth: .infinity) }
            }
            .padding(.bottom, 24)
            bar(220, 13)
            bar(160, 13)
            VStack(alignment: .leading, spacing: 4) { bar(180, 20); bar(140, 13) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Geld wordt geladen")
    }

    private func bar(_ w: CGFloat, _ h: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 1).fill(Color.edgeStrong.opacity(0.6)).frame(width: w, height: h)
    }
}
