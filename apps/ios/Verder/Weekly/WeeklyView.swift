import SwiftUI

/// Weekoverzicht (Plan 3 Task 26, spec §7.9): what the Sunday push counted,
/// and one next step. Reached from Meer and from a tap on the Sunday push.
///
/// Thin on purpose — every word comes from `WeeklyScreen`, so the screen can
/// be aligned to the Figma frames without touching what it says.
struct WeeklyView: View {
    @State private var store: WeeklyStore
    /// What waits on Martin NOW (`InboxStore`'s count, nil until it loaded):
    /// the next step's line and the screen's only amber.
    let liveWaiting: Int?
    /// Leaves for Voor jou: the live list behind Sunday's snapshot.
    let openVoorJou: () -> Void

    init(client: APIClient, onUnauthorized: @escaping @MainActor () -> Void, liveWaiting: Int?,
         openVoorJou: @escaping () -> Void) {
        _store = State(initialValue: WeeklyStore(client: client, onUnauthorized: onUnauthorized))
        self.liveWaiting = liveWaiting
        self.openVoorJou = openVoorJou
    }

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(WeeklyScreen.title)
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
        switch store.state {
        case .loading:
            // The shape of what is coming, not a spinner (brief §2.4).
            RoundedRectangle(cornerRadius: Radius.panel).fill(Color.plate).frame(height: 180)
            RoundedRectangle(cornerRadius: Radius.panel).fill(Color.plate).frame(height: 120)
                .accessibilityLabel("Laden")
        case .notYet:
            panel {
                Text(WeeklyStore.Copy.notYet)
                    .font(.display(17, relativeTo: .headline, weight: .medium))
                    .foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
                secondary(WeeklyStore.Copy.notYetDetail)
            }
        case .failed(let error):
            panel {
                Text(VoorJouTab.message(error))
                    .font(.display(15, relativeTo: .subheadline))
                    .foregroundStyle(Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .loaded(let s):
            readout(s.windowLine)
            counts(s.counts)
            waiting(s.waiting)
        }
        ForEach(WeeklyScreen.steps(for: store.state, liveWaiting: liveWaiting), id: \.self) { step in
            switch step {
            case .retry:
                Button(WeeklyScreen.retry) { Task { await store.refresh() } }
                    .font(.display(15, relativeTo: .subheadline, weight: .medium))
                    .foregroundStyle(Color.signal)
                    .frame(minHeight: 44)
            case .voorJou(let next):
                nextStep(next)
            }
        }
    }

    private func counts(_ counts: [WeeklyScreen.Count]) -> some View {
        panel {
            LazyVGrid(columns: [GridItem(.flexible(), alignment: .topLeading), GridItem(.flexible(), alignment: .topLeading)],
                      alignment: .leading, spacing: 16) {
                ForEach(counts) { c in
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(c.value)")
                            .font(.display(34, relativeTo: .largeTitle))
                            .foregroundStyle(c.tone.strong)
                            .monospacedDigit()
                        Text(c.words)
                            .font(.display(15, relativeTo: .subheadline))
                            .foregroundStyle(c.tone.words)
                        if let detail = c.detail { readout(detail) }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel([c.text, c.detail].compactMap { $0 }.joined(separator: ", "))
                }
            }
        }
    }

    private func waiting(_ w: WeeklyScreen.Waiting) -> some View {
        panel {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if w.tone == .waitsOnMartin { attnDot }
                Text(w.headline)
                    .font(.display(17, relativeTo: .headline, weight: .medium))
                    .foregroundStyle(w.tone.strong)
            }
            ForEach(w.items) { item in
                VStack(alignment: .leading, spacing: 2) {
                    readout(item.kind)
                    Text(item.title)
                        .font(.display(15, relativeTo: .subheadline))
                        .foregroundStyle(w.tone.words)
                        .lineLimit(2)
                        .truncationMode(.tail)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func nextStep(_ step: WeeklyScreen.NextStep) -> some View {
        Button(action: openVoorJou) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(step.title)
                        .font(.display(17, relativeTo: .body, weight: .medium))
                        .foregroundStyle(Color.inkBright)
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if step.tone == .waitsOnMartin { attnDot }
                        Text(step.detail)
                            .font(.display(15, relativeTo: .subheadline))
                            .foregroundStyle(step.tone == .waitsOnMartin ? Color.attn : Color.inkMute)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.inkFaint)
            }
            .padding(16)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .glassPanel()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var attnDot: some View {
        Circle().fill(Color.attn).frame(width: 6, height: 6).alignmentGuide(.firstTextBaseline) { $0[.bottom] }
    }

    private func secondary(_ text: String) -> some View {
        Text(text)
            .font(.display(15, relativeTo: .subheadline))
            .foregroundStyle(Color.inkMute)
            .fixedSize(horizontal: false, vertical: true)
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

/// The model decides the tone; this is the only place it becomes a colour.
private extension WeeklyScreen.Tone {
    /// A figure or headline.
    var strong: Color { self == .waitsOnMartin ? .attn : .inkBright }
    /// The words under it.
    var words: Color { self == .waitsOnMartin ? .attn : .ink }
}
