import SwiftUI

// The money views are THIN on purpose: every word and number comes from
// `MoneyGlance` (MoneyGlance.swift, unit-tested), so aligning these to the
// Figma frames later touches layout only.
//
// Type ramp on the Geld screen (design brief §2.2, four sizes): title 28,
// hero 40, secondary 15, readout 12 (mono). Amber appears nowhere: nothing on
// it waits on Martin.

/// The Overzicht money card's content. Shown WHILE LOCKED — it holds amounts,
/// never a title or a name — so it renders no counterparty and no IBAN; the
/// account lines use the four-digit tail only once unlocked.
struct MoneyGlanceSummary: View {
    let glance: MoneyGlance
    let revealed: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let card = glance.leefgeld {
                LeefgeldFigure(card: card, heroSize: 34)
            } else if revealed {
                ForEach(glance.overview, id: \.self) { line in
                    Text(line).font(.mono(12, relativeTo: .caption)).foregroundStyle(Color.ink)
                }
            }
            Text(glance.freshness)
                .font(.mono(12, relativeTo: .caption))
                .foregroundStyle(Color.inkLabel)
        }
    }
}

/// The hero, its caption and the lines under it; hatched when the week is
/// only partly covered. Shared by the Overzicht card and the Geld screen.
struct LeefgeldFigure: View {
    let card: LeefgeldCard
    var heroSize: CGFloat = 40

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let hero = card.hero {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) { heroText(hero); caption }
                    VStack(alignment: .leading, spacing: 4) { heroText(hero); caption }
                }
            } else {
                Text(card.headline)
                    .font(.display(17, relativeTo: .headline, weight: .medium))
                    .foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(card.lines, id: \.self) { line in
                Text(line)
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.inkMute)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(card.hatched ? 12 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            if card.hatched {
                Hatch().stroke(Color.inkFaint.opacity(0.5), lineWidth: 1)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.panel))
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(card.text)
    }

    private func heroText(_ hero: String) -> some View {
        Text(hero)
            .font(.display(heroSize, relativeTo: .largeTitle, weight: .light))
            .foregroundStyle(Color.inkBright)
            .lineLimit(1)
            .fixedSize()
    }

    @ViewBuilder private var caption: some View {
        if let caption = card.heroCaption {
            Text(caption)
                .font(.display(15, relativeTo: .subheadline))
                .foregroundStyle(Color.ink)
        }
    }
}

/// Diagonal stripes: the hatched "not wholly covered by statements" state,
/// as /money draws it. Always paired with a word ("deels", "t/m …").
struct Hatch: Shape {
    var spacing: CGFloat = 6

    func path(in rect: CGRect) -> Path {
        var p = Path()
        var x = rect.minX - rect.height
        while x < rect.maxX {
            p.move(to: CGPoint(x: x, y: rect.maxY))
            p.addLine(to: CGPoint(x: x + rect.height, y: rect.minY))
            x += spacing
        }
        return p
    }
}

/// Geld: the leefgeld week with its rows, then one card per account with six
/// months of bars and their disclosures. Reached from Meer and from the
/// Overzicht money card; lock-gated (it names counterparties).
struct GeldScreen: View {
    let store: MoneyStore

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Geld")
                        .font(.display(28, relativeTo: .title))
                        .foregroundStyle(Color.inkBright)
                        .accessibilityAddTraits(.isHeader)
                    content
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .refreshable { await store.refresh() }
        }
        .navigationBarTitleDisplayMode(.inline)
        .preferredColorScheme(.dark)
        .task { await store.refresh() }
    }

    @ViewBuilder private var content: some View {
        if let g = store.glance {
            Text(g.freshness)
                .font(.mono(12, relativeTo: .caption))
                .foregroundStyle(Color.inkLabel)
            if let card = g.leefgeld { leefgeldCard(card, previous: g.previousWeek) }
            if g.accounts.isEmpty {
                panel {
                    Text("Nog geen rekeningen")
                        .font(.display(17, relativeTo: .headline, weight: .medium))
                        .foregroundStyle(Color.inkBright)
                    Text("Afschriften lees je in via verder op de computer. Daarna staat hier per rekening wat er in en uit ging.")
                        .font(.display(15, relativeTo: .subheadline))
                        .foregroundStyle(Color.inkMute)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            ForEach(g.accounts) { accountCard($0) }
        } else if let error = store.lastError {
            panel {
                Text(VoorJouTab.message(error))
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Opnieuw proberen") { Task { await store.refresh() } }
                    .font(.display(15, relativeTo: .subheadline, weight: .medium))
                    .foregroundStyle(Color.signal)
                    .frame(minHeight: 44)
            }
        } else {
            // Loading: the shape of what is coming, not a spinner (brief §2.4).
            ForEach(0..<2, id: \.self) { _ in
                RoundedRectangle(cornerRadius: Radius.panel).fill(Color.plate).frame(height: 160)
            }
            .accessibilityLabel("Laden")
        }
    }

    private func leefgeldCard(_ card: LeefgeldCard, previous: String?) -> some View {
        panel {
            label(LeefgeldCard.label)
            LeefgeldFigure(card: card)
            if let account = card.accountLine { readout(account) }
            if !card.rows.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(card.rows) { rowLine($0) }
                }
            }
            if let previous {
                Text(previous)
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.ink)
            }
        }
    }

    private func accountCard(_ a: AccountCard) -> some View {
        panel {
            Text(a.title)
                .font(.display(17, relativeTo: .headline, weight: .medium))
                .foregroundStyle(Color.inkBright)
            HStack(spacing: 12) {
                legend("in", Color.steel)
                legend("uit", Color.steelDim)
            }
            ForEach(a.months) { monthRow($0) }
        }
    }

    private func monthRow(_ m: MonthBar) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                readout(m.label)
                if let status = m.status { readout(status) }
                Spacer(minLength: 8)
                if let inText = m.inText, let outText = m.outText {
                    Text("in \(inText) · uit \(outText)")
                        .font(.mono(12, relativeTo: .caption))
                        .foregroundStyle(Color.ink)
                        .fixedSize()
                }
            }
            if m.coverage != .none {
                bar(m.inFraction, Color.steel, hatched: m.hatched)
                bar(m.outFraction, Color.steelDim, hatched: m.hatched)
            }
            if let parse = m.parseErrorText { readout(parse) }
            ForEach(m.disclosures) { rowLine($0) }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(m.text)
    }

    private func bar(_ fraction: Double, _ color: Color, hatched: Bool) -> some View {
        GeometryReader { geo in
            let w = max(2, geo.size.width * fraction)
            ZStack(alignment: .leading) {
                if hatched {
                    Hatch(spacing: 4).stroke(color, lineWidth: 1)
                        .frame(width: w)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.chip))
                        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(color, lineWidth: 1).frame(width: w),
                                 alignment: .leading)
                } else {
                    RoundedRectangle(cornerRadius: Radius.chip).fill(color).frame(width: w)
                }
            }
        }
        .frame(height: 8)
    }

    private func rowLine(_ r: DisclosureLine) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(r.day) · \(r.kind) · \(r.name)")
                .lineLimit(2)
                .foregroundStyle(Color.inkMute)
            Spacer(minLength: 8)
            Text(r.amount).fixedSize().foregroundStyle(Color.ink)
        }
        .font(.mono(12, relativeTo: .caption))
    }

    private func legend(_ text: String, _ color: Color) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: Radius.chip).fill(color).frame(width: 12, height: 8)
            readout(text)
        }
    }

    private func label(_ text: String) -> some View {
        Text(text)
            .font(.mono(12, relativeTo: .caption, weight: .medium))
            .foregroundStyle(Color.inkLabel)
    }

    private func readout(_ text: String) -> some View {
        Text(text)
            .font(.mono(12, relativeTo: .caption))
            .foregroundStyle(Color.inkLabel)
    }

    private func panel<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) { content() }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassPanel()
    }
}
