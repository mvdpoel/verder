import SwiftUI

/// Weekoverzicht (Plan 3 Task 26, spec §7.9; Figma "weekly · final"): what
/// the Sunday push counted, against Martin's own past weeks, and one next
/// step. Reached from Meer and from a tap on the Sunday push.
///
/// Thin on purpose — every word comes from `WeeklyPage`/`WeeklyScreen`, so the
/// screen can be aligned to the frames without touching what it says.
struct WeeklyView: View {
    let store: WeeklyStore
    /// What waits on Martin NOW: the live card and the screen's only amber.
    let inbox: InboxStore
    /// The case's clock (`AppServices.now`): which week the phone should hold.
    var now: @Sendable () -> Date = { Date() }
    /// Leaves for Voor jou: the live list behind the card.
    let openVoorJou: () -> Void
    /// "7 ontvangen" / "5 opgeborgen" ›: the Dossier.
    var openDossier: () -> Void = {}
    /// "2 stukken opgeborgen" ›: Voor jou's "Door Grip gedaan".
    var openDoneByGrip: () -> Void = {}

    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if DEBUG
    @State private var scrollToEnd = 0
    #endif
    /// Where a capture's `--scroll` lands: the end, or the middle (the live
    /// card at AX sizes, the chart otherwise) of a "hele pagina" frame.
    private var scrollTarget: (id: String, anchor: UnitPoint) {
        #if DEBUG
        if FixtureLaunch.current?.scroll == .middle { return ("middle", .top) }
        #endif
        return ("end", .bottom)
    }

    private var ax: Bool { typeSize.isAccessibilitySize }

    private var live: WeeklyLive {
        WeeklyLive(count: inbox.inbox?.count, oldestAt: inbox.inbox?.items.map(\.at).min(),
                   lastClearedAt: inbox.inbox?.lastClearedAt,
                   keptAt: inbox.inbox != nil && inbox.lastError != nil ? inbox.fetchedAt : nil)
    }

    var body: some View {
        let page = WeeklyPage.make(store.state, now: now(), live: live)
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        header(page)
                        content(page)
                        // The end, below the last line's breathing room.
                        Color.clear.frame(height: 24).id("end")
                    }
                    .padding(.horizontal, 16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // At accessibility sizes Saira's own ~1.57 em leading set
                    // the lines of ONE wrapped title nearly a line apart, so
                    // "2 stukken / opgeborgen" read as two rows; the AX5 frame
                    // sets them tight. Below AX the frames match the natural
                    // leading, so only the accessibility sizes change.
                    .lineHeight(ax ? .multiple(factor: WeeklyType.axLineFactor) : .normal)
                    .animation(reduceMotion ? .easeInOut(duration: 0.2) : .default, value: page)
                }
                .refreshable { await refreshAll() }
                #if DEBUG
                .onChange(of: scrollToEnd) { _, _ in proxy.scrollTo(scrollTarget.id, anchor: scrollTarget.anchor) }
                #endif
            }
        }
        .toolbarTitleDisplayMode(.inline)
        // As Overzicht: past AX3 the 28-pt title no longer fits one line at
        // 343 pt and Saira would break "Weekoverzicht" inside the word.
        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
        .preferredColorScheme(.dark)
        .sensoryFeedback(.error, trigger: store.failedRetries)
        .task {
            await refreshAll()
            #if DEBUG
            if [.end, .middle].contains(FixtureLaunch.current?.scroll) {
                try? await Task.sleep(for: .seconds(1))
                scrollToEnd += 1
            }
            #endif
            // Kept fresh while it is up, as Overzicht and Geld are: an offline
            // stand becomes current again by itself.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(HomeSummary.pollInterval))
                if Task.isCancelled { break }
                await refreshAll()
                #if DEBUG
                if [.end, .middle].contains(FixtureLaunch.current?.scroll) { scrollToEnd += 1 }
                #endif
            }
        }
    }

    private func refreshAll() async {
        async let w: Void = store.refresh()
        async let i: Void = inbox.refresh()
        _ = await (w, i)
    }

    // MARK: - Header

    private func header(_ page: WeeklyPage) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Group {
                if ax {
                    VStack(alignment: .leading, spacing: 0) { ForEach(page.eyebrow, id: \.self) { Text($0) } }
                } else {
                    Text(page.eyebrow.joined(separator: " · "))
                }
            }
            .font(.mono(12, relativeTo: .caption))
            .tracking(1)
            .foregroundStyle(Color.inkLabel)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(eyebrowSpoken(page))
            Text(WeeklyScreen.title)
                .font(.display(28, relativeTo: .title))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let status = page.status { statusRow(status).padding(.top, 12) }
        }
        .accessibilitySortPriority(1)
    }

    private func eyebrowSpoken(_ page: WeeklyPage) -> String {
        if case .summary(let s) = page.body { return s.eyebrowSpoken }
        return page.eyebrow.joined(separator: ", ").lowercased()
    }

    private func statusRow(_ s: WeeklyPage.Status) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 12) {
                    MoreBadge(text: s.badge)
                    Spacer(minLength: 0)
                    if s.retry { retryLink }
                }
                VStack(alignment: .leading, spacing: 4) {
                    MoreBadge(text: s.badge)
                    if s.retry { retryLink }
                }
            }
            if let stand = s.stand {
                Text(stand)
                    .font(.mono(12, relativeTo: .caption))
                    .foregroundStyle(Color.inkLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var retryLink: some View {
        Button(WeeklyScreen.retry) { Task { await store.retry() } }
            .font(.display(17, relativeTo: .body, weight: .medium))
            .foregroundStyle(Color.signal)
            .buttonStyle(.plain)
            .frame(minHeight: 44)
    }

    // MARK: - Body

    @ViewBuilder private func content(_ page: WeeklyPage) -> some View {
        switch page.body {
        case .skeleton:
            WeeklySkeleton().padding(.top, 28)
        case .summary(let s):
            summary(s, live: page.live)
        case .notYet(let empty, let preview):
            VStack(alignment: .leading, spacing: 24) {
                emptyMessage(empty)
                WeeklyChartView(chart: preview, ghost: true).accessibilityHidden(true)
                if let live = page.live { liveBlock(live) }
            }
            .padding(.top, 24)
        case .empty(let empty):
            VStack(alignment: .leading, spacing: 24) {
                emptyMessage(empty)
                if let live = page.live { liveBlock(live) }
            }
            .padding(.top, 24)
        }
    }

    private func summary(_ s: WeeklyScreen, live: LiveCard?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            hero(s).padding(.top, page24)
            if ax, let live {
                liveBlock(live).padding(.top, 24).id("middle")
            }
            if let chart = s.chart, !ax {
                WeeklyChartView(chart: chart, ghost: false)
                    .padding(.top, 24)
                    .id("middle")
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(chart.accessibilityLabel)
            }
            VStack(alignment: .leading, spacing: 16) {
                card(WeeklyScreen.happenedLabel, s.rows)
                if !s.grip.isEmpty { card(WeeklyScreen.gripLabel, s.grip) }
                if !ax, let live { liveBlock(live) }
                if ax, case .waiting? = live {
                    Button(LiveCard.open, action: openVoorJou)
                        .font(.display(17, relativeTo: .body, weight: .medium))
                        .foregroundStyle(Color.signal)
                        .buttonStyle(.plain)
                        .frame(minHeight: 44)
                }
            }
            .padding(.top, 24)
        }
    }

    private var page24: CGFloat { 0 }

    private func hero(_ s: WeeklyScreen) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Group {
                if ax {
                    VStack(alignment: .leading, spacing: 0) { heroNumber(s.hero); heroWords(s.hero) }
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: 8) { heroNumber(s.hero); heroWords(s.hero) }
                }
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(s.hero.parts, id: \.self) { Text($0) }
            }
            .font(.mono(12, relativeTo: .caption))
            .foregroundStyle(Color.inkLabel)
            .fixedSize(horizontal: false, vertical: true)
            if let sentence = s.sentence {
                Text(ax ? sentence.compact : sentence.full)
                    .font(.display(17, relativeTo: .body))
                    .foregroundStyle(Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 4)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel([s.hero.accessibilityLabel, s.sentence?.full].compactMap { $0 }.joined(separator: ". "))
    }

    private func heroNumber(_ h: WeeklyScreen.Hero) -> some View {
        Text("\(h.value)")
            .font(.display(48, relativeTo: .largeTitle))
            .foregroundStyle(Color.inkBright)
            .monospacedDigit()
            .contentTransition(reduceMotion ? .identity : .numericText(value: Double(h.value)))
    }

    private func heroWords(_ h: WeeklyScreen.Hero) -> some View {
        Text(h.words)
            .font(.display(17, relativeTo: .body))
            .foregroundStyle(Color.ink)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Cards

    private func card(_ label: String, _ rows: [WeeklyScreen.Row]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label)
                .font(.mono(12, relativeTo: .caption))
                .tracking(1)
                .foregroundStyle(Color.inkLabel)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 4)
                .accessibilityAddTraits(.isHeader)
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                if index > 0 {
                    Rectangle().fill(Color.hairline).frame(height: 1).padding(.leading, 16)
                }
                rowView(row)
            }
        }
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
    }

    @ViewBuilder private func rowView(_ row: WeeklyScreen.Row) -> some View {
        let content = HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(row.title)
                    .font(.display(17, relativeTo: .body, weight: .medium))
                    .foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
                let lines = ax ? row.lines.flatMap { $0.map { [$0] } } : row.lines
                if !lines.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, parts in
                            Text(parts.joined(separator: " · "))
                        }
                    }
                    .font(.mono(12, relativeTo: .caption))
                    .foregroundStyle(Color.inkLabel)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if row.destination != nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.inkLabel)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .contentShape(Rectangle())

        switch row.destination {
        case .dossier?:
            Button(action: openDossier) { content }
                .buttonStyle(MoreRowButtonStyle())
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(row.accessibilityLabel)
                .accessibilityAddTraits(.isButton)
        case .doneByGrip?:
            Button(action: openDoneByGrip) { content }
                .buttonStyle(MoreRowButtonStyle())
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(row.accessibilityLabel)
                .accessibilityAddTraits(.isButton)
        case nil:
            content
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(row.accessibilityLabel)
        }
    }

    // MARK: - The live card

    @ViewBuilder private func liveBlock(_ live: LiveCard) -> some View {
        switch live {
        case .waiting(let text):
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(LiveCard.label)
                        .font(.mono(12, relativeTo: .caption))
                        .tracking(1)
                        .foregroundStyle(Color.attn)
                    Text(text)
                        .font(.display(17, relativeTo: .body))
                        .foregroundStyle(Color.inkBright)
                            .fixedSize(horizontal: false, vertical: true)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.plate, in: RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                    .strokeBorder(Color.attn.opacity(0.85), lineWidth: 1))
                .shadow(color: Color.attn.opacity(0.25), radius: 4)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Wacht op je: \(text)")
                MoreButton(title: LiveCard.open, weight: .primary, action: openVoorJou)
            }
        case .calm(let caption):
            VStack(alignment: .leading, spacing: 4) {
                MoreBadge(text: LiveCard.calmBadge, tone: .okay)
                if let caption {
                    Text(caption)
                        .font(.mono(12, relativeTo: .caption))
                        .foregroundStyle(Color.inkLabel)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
        case .unknown:
            MoreButton(title: LiveCard.open, weight: .secondary, action: openVoorJou)
        }
    }

    // MARK: - No summary

    private func emptyMessage(_ e: WeeklyEmpty) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Image(systemName: e.symbol)
                .font(.system(size: 26, weight: .regular))
                .foregroundStyle(Color.inkSoft)
                .accessibilityHidden(true)
                .padding(.bottom, 20)
            Text(e.title)
                .font(.display(17, relativeTo: .headline, weight: .semibold))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(e.body)
                .font(.display(17, relativeTo: .body))
                .foregroundStyle(Color.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6)
            if e.retry {
                Button { Task { await store.retry() } } label: {
                    Text(WeeklyScreen.retry)
                        .font(.display(17, relativeTo: .body, weight: .medium))
                        .foregroundStyle(Color.signal)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .frame(minHeight: 48)
                        .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
                        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.top, 16)
            }
            if let older = e.older {
                Button(older) { store.showOlder() }
                    .font(.display(17, relativeTo: .body, weight: .medium))
                    .foregroundStyle(Color.signal)
                    .buttonStyle(.plain)
                    .frame(minHeight: 44)
                    .padding(.top, 16)
            }
        }
    }
}

/// The eight weeks as bars (Figma "weekly · final" chart): past weeks
/// ink-faint, this week ink-mute with an ink-bright cap, a dashed average
/// behind them with "gem. 5" at its end, and every value placed by
/// `Chart.placement` so it never touches the line. A week with no summary is
/// a dashed slot. `ghost`: the first-week preview, all slots.
///
/// Its labels stop growing at xLarge: the chart is dropped at accessibility
/// sizes (its sentence carries it), and below them the eight columns would
/// otherwise run out of room.
struct WeeklyChartView: View {
    let chart: WeeklyScreen.Chart
    let ghost: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var grown = false

    private typealias C = WeeklyScreen.Chart
    /// Room above the plot for a value label; none on the ghost preview.
    private var top: CGFloat { ghost ? 0 : 20 }
    private static let labelRow: CGFloat = 16
    private static let labelGap: CGFloat = 6

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(chart.title)
                .font(.mono(12, relativeTo: .caption))
                .tracking(1)
                .foregroundStyle(Color.inkLabel)
            HStack(alignment: .bottom, spacing: 8) {
                HStack(alignment: .bottom, spacing: 8) {
                    ForEach(chart.bars) { column($0) }
                }
                .background(alignment: .bottom) { averageLine }
                if let avg = chart.average, let line = chart.averageHeight {
                    VStack(spacing: Self.labelGap) {
                        ZStack(alignment: .bottom) {
                            Color.clear
                            Text("gem. \(avg)")
                                .font(.mono(12, relativeTo: .caption))
                                .foregroundStyle(Color.inkLabel)
                                .fixedSize()
                                .padding(.bottom, max(0, line - 8))
                        }
                        .frame(height: top + C.plotHeight)
                        Color.clear.frame(height: Self.labelRow)
                    }
                    .fixedSize(horizontal: true, vertical: false)
                }
            }
            if let caption = chart.caption {
                Text(caption)
                    .font(.mono(12, relativeTo: .caption))
                    .foregroundStyle(Color.inkLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .onAppear {
            if reduceMotion { grown = true } else {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.9).delay(0.1)) { grown = true }
            }
        }
    }

    @ViewBuilder private var averageLine: some View {
        if let line = chart.averageHeight {
            Line()
                .stroke(Color.inkLabel, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .frame(height: 1)
                .padding(.bottom, Self.labelRow + Self.labelGap + line)
        }
    }

    private func column(_ bar: C.Bar) -> some View {
        VStack(spacing: Self.labelGap) {
            ZStack(alignment: .bottom) {
                Color.clear
                if let value = bar.value, !ghost {
                    let h = chart.height(value)
                    let shown = bar.isCurrent && !grown ? C.minBar : h
                    VStack(spacing: 0) {
                        if bar.isCurrent { Rectangle().fill(Color.inkBright).frame(height: 2) }
                        Rectangle().fill(bar.isCurrent ? Color.inkMute : Color.inkFaint)
                    }
                    .clipShape(UnevenRoundedRectangle(topLeadingRadius: 2, topTrailingRadius: 2))
                    .frame(height: shown)
                    valueLabel(value, bar: bar, height: h)
                } else {
                    RoundedRectangle(cornerRadius: 2)
                        .strokeBorder(Color.inkFaint, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                        .frame(height: C.plotHeight)
                }
            }
            .frame(height: top + C.plotHeight)
            Text(bar.label)
                .font(.mono(12, relativeTo: .caption, weight: bar.isCurrent ? .semibold : .regular))
                .foregroundStyle(bar.isCurrent ? Color.inkBright : Color.inkLabel)
                .lineLimit(1)
                .fixedSize()
                .frame(height: Self.labelRow)
        }
        .frame(maxWidth: .infinity)
    }

    private func valueLabel(_ value: Int, bar: C.Bar, height h: Double) -> some View {
        let placement = chart.placement(value)
        let bottom: Double = switch placement {
        case .above: h + C.labelGap
        case .inside: h - 8 - C.labelHeight
        case .aboveLine: (chart.averageHeight ?? 0) + C.lineClearance
        }
        return Text("\(value)")
            .font(.mono(12, relativeTo: .caption, weight: bar.isCurrent ? .semibold : .regular))
            .foregroundStyle(bar.isCurrent || placement == .inside ? Color.inkBright : Color.inkLabel)
            .fixedSize()
            .frame(height: C.labelHeight)
            .padding(.bottom, bottom)
            .opacity(bar.isCurrent && !grown ? 0 : 1)
    }

    private struct Line: Shape {
        func path(in rect: CGRect) -> Path {
            var p = Path()
            p.move(to: CGPoint(x: rect.minX, y: rect.midY))
            p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            return p
        }
    }
}

/// Laden: the shape of what is coming, not a spinner (brief §2.4) — the hero,
/// its lines, the chart and the "Wat er gebeurde" card at the loaded rows'
/// 68-pt stride.
private struct WeeklySkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .bottom, spacing: 8) { bar(32, 40); bar(132, 12).padding(.bottom, 4) }
            VStack(alignment: .leading, spacing: 6) { bar(96, 10); bar(176, 10); bar(104, 10) }.padding(.top, 14)
            VStack(alignment: .leading, spacing: 10) { bar(300, 16); bar(120, 16) }.padding(.top, 14)
            bar(150, 10).padding(.top, 30)
            HStack(alignment: .bottom, spacing: 8) {
                ForEach([24, 40, 28, 34, 46, 28, 34, 56], id: \.self) { h in
                    VStack(spacing: 8) {
                        bar(nil, CGFloat(h))
                        bar(nil, 8)
                    }
                    .frame(maxWidth: .infinity)
                }
                Color.clear.frame(width: 50, height: 1)
            }
            .padding(.top, 44)
            VStack(alignment: .leading, spacing: 0) {
                Text(WeeklyScreen.happenedLabel)
                    .font(.mono(12, relativeTo: .caption))
                    .tracking(1)
                    .foregroundStyle(Color.inkLabel)
                    .padding(.horizontal, 16)
                    .padding(.top, 16)
                    .padding(.bottom, 4)
                ForEach(0..<4, id: \.self) { i in
                    if i > 0 { Rectangle().fill(Color.hairline).frame(height: 1).padding(.leading, 16) }
                    VStack(alignment: .leading, spacing: 10) { bar(220, 12); bar(110, 8) }
                        .padding(.horizontal, 16)
                        .frame(height: 67, alignment: .center)
                }
            }
            .padding(.bottom, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassPanel()
            .padding(.top, 24)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Laden")
    }

    private func bar(_ width: CGFloat?, _ height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 1)
            .fill(Color.edgeStrong.opacity(0.35))
            .frame(maxWidth: width == nil ? .infinity : nil)
            .frame(width: width, height: height)
    }
}

/// The Weekoverzicht's type metrics that are not a font.
enum WeeklyType {
    /// Line pitch at accessibility sizes, as a multiple of the point size:
    /// the AX5 frame's ~1.17 (a 40-pt body on ~47). Text never clips at a
    /// pitch above 1, it only stops wrapped lines drifting apart.
    static let axLineFactor: CGFloat = 1.2
}
