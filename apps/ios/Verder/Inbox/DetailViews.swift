import SwiftUI

// The shared pieces of the three detail screens (Figma "detail · final"):
// the header with its badges, cards, the dock pinned to the bottom, "Volgende
// in Voor jou", and the bottom sheet a decision with consequences opens.
// Views only; what they say comes from the models and `DetailText`.

/// The detail screens' small labels: `ProposalLabel`, but growing all the
/// way to AX5 as the "detail · final" AX5 frames draw them (still mono and
/// smaller than what they label, because the label ramp is a step below).
struct DetailLabel: View {
    let text: String
    var color: Color = .inkLabel

    init(_ text: String, color: Color = .inkLabel) {
        self.text = text
        self.color = color
    }

    var body: some View { ProposalLabel(text, color: color, cap: .accessibility5) }
}

/// A badge beside the title: amber ONLY for what waits on Martin.
struct DetailBadge: View {
    enum Tone: Equatable {
        /// "WACHT OP JOU" — amber, and nothing else is.
        case waiting
        /// "2 AANGEPAST", "WACHT OP ANDER": a fact, no colour.
        case neutral
        /// "BEANTWOORD", "VASTGELEGD", "TAAK AANGEMAAKT".
        case okay
    }

    let text: String
    let tone: Tone
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .caption) private var gap: CGFloat = 6

    init(_ text: String, tone: Tone) {
        self.text = text
        self.tone = tone
    }

    private var color: Color {
        switch tone {
        case .waiting: .attn
        case .neutral: .ink
        case .okay: .okay
        }
    }

    var body: some View {
        let ax = typeSize.isAccessibilitySize
        HStack(spacing: gap) {
            Circle().fill(color).frame(width: ax ? 10 : 5, height: ax ? 10 : 5)
            Text(ax ? text : text.uppercased())
                .wholeWords(text, font: .mono(12, relativeTo: .caption, weight: .medium))
                .tracking(ax ? 0 : 1)
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(color.opacity(0.85), lineWidth: 1))
    }
}

/// "VRAAG VAN VERDER · ZO 1 NOV" on one line where it fits; else each group
/// after the first starts its own line WITH its dot ("Vraag van verder" /
/// "· zo 1 nov"), so no line ever ends on a "·" (the final frames' rule).
struct EyebrowLine: View {
    let groups: [String]
    var color: Color = .inkLabel
    /// Two colours: the first group in `color`, the rest in `accent`
    /// ("SAMENVATTING · AANPASSEN").
    var accent: Color? = nil

    var body: some View {
        ViewThatFits(in: .horizontal) {
            line(groups.enumerated().map { ($0.offset == 0 ? "" : " · ") + $0.element }).fixedSize()
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(groups.enumerated()), id: \.offset) { i, g in
                    DetailLabel(i == 0 ? g : "· \(g)", color: i == 0 ? color : (accent ?? color))
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func line(_ parts: [String]) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(parts.enumerated()), id: \.offset) { i, p in
                DetailLabel(p, color: i == 0 ? color : (accent ?? color))
            }
        }
    }
}

/// Eyebrow, the title in Saira 28, the offline readout, then the badges.
struct DetailHeader: View {
    let eyebrow: [String]
    let title: String
    var offlineStamp: String? = nil
    var badges: [(String, DetailBadge.Tone)] = []
    var note: String? = nil
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // At the accessibility sizes a long Dutch word is HYPHENATED at a
        // dictionary point ("Betalings-" / "regeling", the AX5 frame) rather
        // than the whole title being set a size smaller to fit it: the title
        // keeps its rank above the eyebrow. `wholeWords` still steps down a
        // word that has no break point and does not fit.
        let shown = typeSize.isAccessibilitySize ? HomeSummary.hyphenated(title) : title
        VStack(alignment: .leading, spacing: 6) {
            if !eyebrow.isEmpty { EyebrowLine(groups: eyebrow) }
            Text(DetailText.dutch(shown))
                .wholeWords(shown, font: .display(28, relativeTo: .title))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel(title)
                .accessibilityAddTraits(.isHeader)
                .background {
                    GeometryReader { g in
                        Color.clear.preference(key: DetailTitleBottom.self,
                                               value: g.frame(in: .named(DetailSpace.name)).maxY)
                    }
                }
            if let offlineStamp {
                HStack(spacing: 6) {
                    Image(systemName: "wifi.slash").font(.system(size: 11, weight: .medium)).accessibilityHidden(true)
                    DetailLabel(offlineStamp, color: .inkDim)
                }
                .foregroundStyle(Color.inkDim)
                .padding(.top, 6)
            }
            if !badges.isEmpty || note != nil {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { badgeRow }
                    VStack(alignment: .leading, spacing: 6) { badgeRow }
                }
                .padding(.top, 8)
                .accessibilityElement(children: .combine)
            }
        }
    }

    @ViewBuilder private var badgeRow: some View {
        ForEach(Array(badges.enumerated()), id: \.offset) { _, b in DetailBadge(b.0, tone: b.1) }
        // Lower case, as the frames set it ("sinds 1 dag", "zo 1 nov · 14:02").
        if let note {
            Text(note)
                .wholeWords(note, font: .mono(12, relativeTo: .caption))
                .foregroundStyle(Color.inkDim)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A glass card with its label on top ("UITERLIJK OP", "TOELICHTING").
struct DetailCard<Label: View, Content: View>: View {
    @ViewBuilder let label: Label
    @ViewBuilder let content: Content
    var highlighted = false

    init(highlighted: Bool = false, @ViewBuilder label: () -> Label, @ViewBuilder content: () -> Content) {
        self.highlighted = highlighted
        self.label = label()
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            label
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
        .overlay {
            if highlighted {
                RoundedRectangle(cornerRadius: Radius.panel, style: .continuous).strokeBorder(Color.signal, lineWidth: 1.5)
            }
        }
    }
}

extension DetailCard where Label == DetailLabel {
    init(_ label: String, highlighted: Bool = false, @ViewBuilder content: () -> Content) {
        self.init(highlighted: highlighted, label: { DetailLabel(label) }, content: content)
    }
}

/// "NIET AANGEKOMEN" / "Je antwoord kwam niet aan bij verder. …".
struct DetailNotice: View {
    let label: String
    let text: String

    var body: some View {
        DetailCard(label) {
            Text(text)
                .font(.display(17, relativeTo: .body))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Body copy in Saira 17.
struct DetailPara: View {
    let text: String
    var color: Color = .ink
    var size: CGFloat = 17

    init(_ text: String, color: Color = .ink, size: CGFloat = 17) {
        self.text = text
        self.color = color
        self.size = size
    }

    var body: some View {
        Text(text)
            .wholeWords(text, font: .display(size, relativeTo: size < 17 ? .callout : .body))
            .foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// One thing that came out of a decision, or one linked item: a dot, the
/// title, a mono meta line, and a chevron when it opens something.
struct DetailRow: View {
    let title: String
    let meta: String?
    var dot: Color = .signal
    var route: InboxRoute? = nil
    /// Opens on the website instead (a logbook entry: the phone has no
    /// screen for one).
    var web: URL? = nil

    var body: some View {
        let row = HStack(alignment: .center, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Circle().fill(dot).frame(width: 6, height: 6).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 1 }
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.display(17, relativeTo: .body, weight: .medium))
                        .foregroundStyle(Color.inkBright)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if let meta { MetaLine(meta) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if route != nil || web != nil { RowChevron() }
        }
        .padding(.vertical, 14)
        .padding(.horizontal, 16)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) { Rectangle().fill(Color.hairline).frame(height: 1) }

        if let route {
            NavigationLink(value: route) { row }.buttonStyle(.plain)
        } else if let web {
            Link(destination: web) { row }.buttonStyle(.plain).accessibilityHint("Opent op de website.")
        } else {
            row.accessibilityElement(children: .combine)
        }
    }
}

/// A section's label with an optional count on the right ("GEKOPPELD  2").
struct DetailSectionLabel: View {
    let text: String
    var count: Int? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            DetailLabel(text)
            Spacer(minLength: 12)
            if let count { DetailLabel("\(count)", color: .inkDim) }
        }
        .padding(.horizontal, 16)
    }
}

// MARK: - Volgende in Voor jou

/// What the Voor jou stack gives a detail screen: the next waiting item after
/// this one, a refresh, and a way to open it. Absent (nil) on the Dossier
/// stack, where there is no "next".
struct VoorJouNext {
    let pick: @MainActor (String) -> (route: InboxRoute, remaining: Int)?
    let refresh: @MainActor () async -> Void
    let open: @MainActor (InboxRoute) -> Void
    /// A decision with nothing to review afterwards ("Nee" to a question,
    /// "Niet relevant"): back to the list, HELD there with its undo toast
    /// (`InboxDecisions`) and only posted once the window is over — so
    /// "Ongedaan maken" means nothing was ever recorded. Item id, action,
    /// the item's title.
    var hand: (@MainActor (String, ListDecision.Action, String) -> Void)? = nil
    /// Opens something ON TOP of this screen (the source voice note).
    var push: (@MainActor (InboxRoute) -> Void)? = nil
}

extension EnvironmentValues {
    @Entry var voorJouNext: VoorJouNext? = nil
}

/// "Volgende in Voor jou · 3": a deliberate tap to the next item.
struct NextInVoorJouButton: View {
    let id: String
    @Environment(\.voorJouNext) private var next

    var body: some View {
        if let next, let pick = next.pick(id) {
            AuthButton(title: DetailText.nextLabel(remaining: pick.remaining), weight: .outline) {
                next.open(pick.route)
            }
        }
    }
}

// MARK: - The screen

/// The frame every detail screen shares: the void page in one scroll column,
/// the system's own scroll-edge fade under the navigation bar and under the
/// dock (never a hard slice), the inline title once the large one has gone
/// under the bar, and the ⋯ menu.
struct DetailScaffold<Content: View, Dock: View, Menu: View>: View {
    let navTitle: String
    /// The id of the part being edited: scrolled to the top, so the field,
    /// its "was:" line and the dock all show (frame "veld aanpassen").
    var focus: String? = nil
    /// A decision sheet is up: the page behind it is dimmed, so the sheet
    /// stands apart (the frames' scrim).
    var dimmed = false
    @ViewBuilder let content: Content
    @ViewBuilder let dock: Dock
    @ViewBuilder let menu: Menu

    @State private var scrolled: CGFloat = 0
    @State private var titleBottom: CGFloat = .infinity

    init(navTitle: String, focus: String? = nil, dimmed: Bool = false, @ViewBuilder content: () -> Content,
         @ViewBuilder dock: () -> Dock, @ViewBuilder menu: () -> Menu) {
        self.navTitle = navTitle
        self.focus = focus
        self.dimmed = dimmed
        self.content = content()
        self.dock = dock()
        self.menu = menu()
    }

    /// Once the large title's last line has mostly gone under the bar, the
    /// inline one takes over: never two titles legible at once.
    private var showsInlineTitle: Bool { scrolled + 24 > titleBottom }

    /// A capture's `--scroll middle`: the screen's middle anchor at the top.
    private func fixtureScroll(_ proxy: ScrollViewProxy) async {
        #if DEBUG
        guard FixtureLaunch.current?.scroll == .middle else { return }
        try? await Task.sleep(for: .milliseconds(900))
        proxy.scrollTo(DetailSpace.middle, anchor: .top)
        #endif
    }

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) { content }
                        .padding(.horizontal, 16)
                        .padding(.bottom, 28)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .frameLeading()
                        .coordinateSpace(.named(DetailSpace.name))
                }
                .fixtureScrollAnchor()
                .task { await fixtureScroll(proxy) }
                .task(id: focus) {
                    guard let focus else { return }
                    // After the keyboard or the wheel has taken its room.
                    try? await Task.sleep(for: .milliseconds(450))
                    withAnimation(.snappy) { proxy.scrollTo(focus, anchor: .top) }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            // The system's soft fade under the navigation bar; the dock
            // draws its own (`fadingBar`), opaque behind its buttons.
            .scrollEdgeEffectStyle(.soft, for: .top)
            .scrollEdgeEffectHidden(true, for: .bottom)
            .onPreferenceChange(DetailTitleBottom.self) { b in MainActor.assumeIsolated { titleBottom = b } }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { _, now in
                scrolled = now
            }
            // The bar's hairline once anything has gone under it (the frames).
            .safeAreaBar(edge: .top, spacing: 0) {
                Rectangle().fill(Color.hairline).frame(height: 1).opacity(scrolled > 1 ? 1 : 0)
            }
            .safeAreaBar(edge: .bottom, spacing: 0) { dock }
            if dimmed { SheetScrim() }
        }
        .animation(.easeOut(duration: 0.2), value: dimmed)
        .preferredColorScheme(.dark)
        .navigationTitle(navTitle)
        .navigationBarTitleDisplayMode(.inline)
        // Opaque, as the frames draw it: nothing scrolled under the bar is
        // legible behind its title, the back button or the status bar.
        .toolbarBackground(Color.void, for: .navigationBar)
        .toolbarBackgroundVisibility(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(navTitle)
                    .font(.display(17, relativeTo: .headline, weight: .medium))
                    .foregroundStyle(Color.inkBright)
                    .lineLimit(1)
                    .opacity(showsInlineTitle ? 1 : 0)
                    .accessibilityHidden(!showsInlineTitle)
            }
            ToolbarItem(placement: .topBarTrailing) {
                SwiftUI.Menu { menu } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.system(size: 20, weight: .regular))
                        .foregroundStyle(Color.signal)
                }
                .accessibilityLabel("Meer acties")
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
    }
}

/// The dim over a page while a decision sheet is up, so the sheet reads as
/// apart from it rather than as more of the page.
struct SheetScrim: View {
    var body: some View {
        Color.black.opacity(0.55)
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .transition(.opacity)
    }
}

enum DetailSpace {
    /// The scroll content's coordinate space, where the title's bottom is measured.
    static let name = "detail.page"
    /// The id of the part a capture's `--scroll middle` puts at the top (the
    /// status control, the options).
    static let middle = "detail.middle"
}

struct DetailTitleBottom: PreferenceKey {
    static let defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = min(value, nextValue()) }
}

/// The surface of a bar the page scrolls under: opaque where its own
/// content sits, and a fade of `fade` points on the side facing the scroll,
/// so a line passing under the bar dims out instead of being cut in half
/// (Martin's rule; the final frames' "scroll edge strip").
struct FadingBarSurface: ViewModifier {
    let edge: VerticalEdge
    var color: Color = .void
    var fade: CGFloat = 28

    func body(content: Content) -> some View {
        content.background(alignment: edge == .bottom ? .top : .bottom) {
            VStack(spacing: 0) {
                if edge == .bottom { gradient(from: .bottom) }
                color
                if edge == .top { gradient(from: .top) }
            }
            .padding(edge == .bottom ? .top : .bottom, -fade)
            // Past the edge too, by hand: `ignoresSafeArea` alone does not
            // always reach the home-indicator band (measured at AX5, where
            // the page showed through under the dock).
            .padding(.bottom, edge == .bottom ? -48 : 0)
            .ignoresSafeArea(edges: edge == .bottom ? .bottom : .top)
            .allowsHitTesting(false)
        }
    }

    @ViewBuilder private func gradient(from: UnitPoint) -> some View {
        LinearGradient(colors: [color, color.opacity(0)], startPoint: from, endPoint: from == .bottom ? .top : .bottom)
            .frame(height: fade)
    }
}

extension View {
    func fadingBar(_ edge: VerticalEdge, color: Color = .void, fade: CGFloat = 28) -> some View {
        modifier(FadingBarSurface(edge: edge, color: color, fade: fade))
    }
}

/// The dock pinned under the scroll: its buttons stacked, 16 pt in, with the
/// reason an action is off above them when there is one.
struct DetailDock<Content: View>: View {
    var note: String? = nil
    @ViewBuilder let content: Content

    init(note: String? = nil, @ViewBuilder content: () -> Content) {
        self.note = note
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let note { DetailPara(note, color: .inkMute, size: 15) }
            content
        }
        .frameLeading()
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fadingBar(.bottom)
        .overlay(alignment: .top) { Rectangle().fill(Color.hairline).frame(height: 1) }
    }
}

// MARK: - Sheet

/// The bottom sheet of a decision that has consequences ("Brief koppelen aan
/// de vordering?", "Niet relevant, met reden"): a title, what will happen,
/// anything extra (the reason field), then the action and Annuleren pinned at
/// its foot. As tall as its words at the ordinary sizes; at the accessibility
/// sizes the body scrolls under the title and fades at the actions.
struct DecisionSheet<Extra: View>: View {
    let title: String
    let text: String
    let action: String
    var enabled = true
    let onConfirm: () -> Void
    let onCancel: () -> Void
    @ViewBuilder let extra: Extra

    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var contentHeight: CGFloat = 220
    @State private var dockHeight: CGFloat = 140
    @State private var titleHeight: CGFloat = 60
    /// The title's fade only once the body has scrolled under it: at rest
    /// the first line is drawn at full contrast (the frames).
    @State private var bodyScrolled = false
    /// The body is taller than its room: both pinned edges are ruled and
    /// the scroll bar flashes, so a line cut at an edge reads as scrolling.
    @State private var overflows = false

    init(title: String, text: String, action: String, enabled: Bool = true,
         onConfirm: @escaping () -> Void, onCancel: @escaping () -> Void, @ViewBuilder extra: () -> Extra) {
        self.title = title
        self.text = text
        self.action = action
        self.enabled = enabled
        self.onConfirm = onConfirm
        self.onCancel = onCancel
        self.extra = extra()
    }

    var body: some View {
        let ax = typeSize.isAccessibilitySize
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    DetailPara(text, color: .inkMute, size: 15)
                    extra
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollIndicators(.visible)
            .scrollIndicatorsFlash(trigger: overflows)
            .fixtureScrollAnchor()
            .scrollEdgeEffectHidden(true, for: .all)
            .onScrollGeometryChange(for: Bool.self) { $0.contentOffset.y + $0.contentInsets.top > 1 } action: { _, now in
                bodyScrolled = now
            }
            .onScrollGeometryChange(for: Bool.self) { g in
                g.contentSize.height > g.containerSize.height - g.contentInsets.top - g.contentInsets.bottom + 4
            } action: { _, now in
                overflows = now
            }
            // The title and the actions are bars: the body scrolls and fades
            // under both, never cut mid-line.
            .safeAreaBar(edge: .top, spacing: 0) {
                Text(title)
                    .wholeWords(title, font: .display(17, relativeTo: .headline, weight: .medium))
                    .foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 28)
                    .padding(.bottom, 12)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { titleHeight = $0 }
                    .fadingBar(.top, color: .plate, fade: bodyScrolled ? 28 : 0)
                    .overlay(alignment: .bottom) {
                        Rectangle().fill(Color.hairline).frame(height: 1).opacity(overflows ? 1 : 0)
                    }
            }
            .safeAreaBar(edge: .bottom, spacing: 0) {
                VStack(spacing: 4) {
                    AuthButton(title: action, enabled: enabled, action: onConfirm)
                    AuthButton(title: "Annuleren", weight: .ghost, action: onCancel)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 4)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { dockHeight = $0 }
                .fadingBar(.bottom, color: .plate)
                .overlay(alignment: .top) {
                    Rectangle().fill(Color.hairline).frame(height: 1).opacity(overflows ? 1 : 0)
                }
            }
        }
        .frameLeading()
        .background(Color.plate.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.plate)
        .presentationDetents(ax ? [.large] : [.height(contentHeight + dockHeight + titleHeight + 16)])
    }
}

extension DecisionSheet where Extra == EmptyView {
    init(title: String, text: String, action: String, enabled: Bool = true,
         onConfirm: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self.init(title: title, text: text, action: action, enabled: enabled,
                  onConfirm: onConfirm, onCancel: onCancel) { EmptyView() }
    }
}

/// A text input as the frames draw it: the field's dark plate, a hairline
/// edge that turns signal while it has the focus.
struct DetailInputStyle: ViewModifier {
    var focused: Bool
    func body(content: Content) -> some View {
        content
            .font(.display(17, relativeTo: .body))
            .foregroundStyle(Color.inkBright)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
            .overlay(RoundedRectangle(cornerRadius: Radius.chip)
                .strokeBorder(focused ? Color.signal : Color.edgeStrong, lineWidth: focused ? 1.5 : 1))
    }
}

/// "Taak gedaan · Ongedaan maken": a decision held on this screen for its
/// undo window, not yet posted.
struct DetailUndoRow: View {
    let text: String
    let undo: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
        layout {
            Text(text)
                .wholeWords(text, font: .display(17, relativeTo: .body))
                .foregroundStyle(Color.inkBright)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Ongedaan maken", action: undo)
                .font(.display(17, relativeTo: .body, weight: .medium))
                .foregroundStyle(Color.signalLink)
                .fixedSize(horizontal: false, vertical: true)
                .frame(minHeight: 44)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.plate.opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.chip))
        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
    }
}
