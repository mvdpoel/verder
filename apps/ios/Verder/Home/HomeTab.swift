import SwiftUI

/// What the Overzicht tab says, decided outside the view so it is testable.
///
/// EVERY NUMBER HERE IS THE SERVER'S: the waiting count is `loadWaiting`
/// (packages/api/src/waiting.ts) as the inbox route serves it — the same number
/// the badge, the widget and Voor jou show — and the task counts and the map
/// headline are `/dashboard/summary`. The phone adds nothing up itself.
/// AMBER ONLY for what waits on Martin: the waiting card when it is non-zero
/// and overdue tasks; never the headline, never the upload queue.
enum HomeSummary {
    static let title = "Overzicht"
    static let nothingWaiting = "Niets wacht op je."
    static let noHeadline = "Geen open halte op de kaart."
    static let headlineLabel = "WAAR HET NU OP WACHT"
    static let waitingLabel = "WACHT OP JOU"
    static let tasksLabel = "TAKEN"
    static let scansLabel = "SCANS"
    static let moneyLabel = "GELD"
    /// How many of the ranked items the card previews.
    static let previewCount = 3

    static func waitingLine(_ count: Int) -> String {
        switch count {
        case 0: nothingWaiting
        case 1: "1 ding wacht op je"
        default: "\(count) dingen wachten op je"
        }
    }

    static let lockedHeadline = "Ontgrendel om te zien waar het nu op wacht."
    static let reveal = "Toon details"

    /// The first items in the SERVER's order — never re-ranked here. Empty
    /// while the app is locked: the glance shows counts, never titles.
    static func preview(_ inbox: InboxDTO, revealed: Bool) -> [WaitingItem] {
        revealed ? Array(inbox.items.prefix(previewCount)) : []
    }

    /// "14 jul. 2026", in Amsterdam — the case's calendar, not the phone's.
    static func day(_ date: Date) -> String {
        date.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted,
                                        locale: Locale(identifier: "nl_NL"),
                                        timeZone: TimeZone(identifier: "Europe/Amsterdam")!))
    }

    struct TaskLine: Equatable { let text: String; let amber: Bool }

    static func taskLines(_ t: DashboardSummaryDTO.Tasks) -> [TaskLine] {
        var out = [TaskLine(text: "\(t.openCount) open", amber: false)]
        if t.overdueCount > 0 { out.append(TaskLine(text: "\(t.overdueCount) te laat", amber: true)) }
        if t.waitingOnOthersCount > 0 {
            out.append(TaskLine(text: "\(t.waitingOnOthersCount) wacht op een ander", amber: false))
        }
        return out
    }
}

/// The tab the app opens on: the current state of the case at a glance —
/// where it waits, what waits on Martin, the tasks, and the scan queue.
/// Read-only: every action lives one tap further, on the screen that owns it.
///
/// OPEN WHILE LOCKED (`AppLock.Area.glance`, Martin 2026-11-01): it shows
/// counts and amounts only until `lock.revealsCaseContent`; the headline and
/// the waiting preview are not even built while locked. Every tap lands on a
/// gated screen, which asks for Face ID there — the money card included: its
/// amounts show while locked, the Geld screen behind it names counterparties
/// and is gated.
struct HomeTab: View {
    let store: InboxStore
    let money: MoneyStore
    let uploads: UploadCenter
    let lock: AppLock
    /// Opens Voor jou, optionally straight onto one item.
    let openInbox: (InboxRoute?) -> Void
    let openScan: () -> Void

    @State private var showGeld = false

    var body: some View {
        NavigationStack {
            page
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(isPresented: $showGeld) {
                    GeldScreen(store: money).lockGated(by: lock)
                }
        }
    }

    private var page: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(HomeSummary.title)
                        .font(.display(26, relativeTo: .title, weight: .ultraLight))
                        .foregroundStyle(Color.inkBright)
                    if let error = store.lastError, store.inbox == nil {
                        Text(VoorJouTab.message(error))
                            .font(.display(14, relativeTo: .callout, weight: .light))
                            .foregroundStyle(Color.ink)
                    }
                    headlineCard
                    waitingCard
                    moneyCard
                    tasksCard
                    scansCard
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 26)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .refreshable {
                async let inbox: Void = store.refresh()
                async let cash: Void = money.refresh()
                _ = await (inbox, cash)
            }
        }
        .preferredColorScheme(.dark)
        .task {
            async let inbox: Void = store.refresh()
            async let cash: Void = money.refresh()
            _ = await (inbox, cash)
        }
    }

    // MARK: cards

    @ViewBuilder private var headlineCard: some View {
        card(label: HomeSummary.headlineLabel) {
            if !lock.revealsCaseContent {
                VStack(alignment: .leading, spacing: 10) {
                    muted(HomeSummary.lockedHeadline)
                    Button {
                        Task { await lock.unlock() }
                    } label: {
                        Label(HomeSummary.reveal, systemImage: "faceid")
                            .font(.display(14, relativeTo: .callout, weight: .regular))
                            .foregroundStyle(Color.signal)
                            .frame(minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .disabled(lock.isUnlocking)
                }
            } else if let h = store.summary?.headline {
                VStack(alignment: .leading, spacing: 6) {
                    Text(h.stopTitle)
                        .font(.display(18, relativeTo: .title3, weight: .regular))
                        .foregroundStyle(Color.inkBright)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        if let track = h.trackTitle { Text(track) }
                        if let at = h.happenedAt { Text(HomeSummary.day(at)) }
                    }
                    .font(.mono(11, relativeTo: .caption2))
                    .foregroundStyle(Color.inkDim)
                    if let note = h.note, !note.isEmpty {
                        Text(note)
                            .font(.display(14, relativeTo: .callout, weight: .light))
                            .foregroundStyle(Color.ink)
                            .lineLimit(4)
                    }
                }
            } else if store.summary != nil {
                muted(HomeSummary.noHeadline)
            } else {
                loading
            }
        }
    }

    @ViewBuilder private var waitingCard: some View {
        if let inbox = store.inbox {
            Button { openInbox(nil) } label: {
                card(label: HomeSummary.waitingLabel, amber: inbox.count > 0, chevron: true) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            if inbox.count > 0 {
                                Text("\(inbox.count)")
                                    .font(.display(34, relativeTo: .largeTitle, weight: .ultraLight))
                                    .foregroundStyle(Color.attn)
                            }
                            Text(HomeSummary.waitingLine(inbox.count))
                                .font(.display(15, relativeTo: .body, weight: .light))
                                .foregroundStyle(Color.ink)
                        }
                        ForEach(HomeSummary.preview(inbox, revealed: lock.revealsCaseContent)) { item in
                            previewRow(item)
                        }
                    }
                }
            }
            .buttonStyle(.plain)
        } else {
            card(label: HomeSummary.waitingLabel) { loading }
        }
    }

    private func previewRow(_ item: WaitingItem) -> some View {
        Button { openInbox(InboxRoute(item)) } label: {
            HStack(alignment: .top, spacing: 10) {
                Circle().fill(Color.attn).frame(width: 6, height: 6).padding(.top, 7)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.display(14, relativeTo: .callout, weight: .regular))
                        .foregroundStyle(Color.inkBright)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Text(VoorJouList.kindLabel(item.kind))
                        .font(.mono(10, relativeTo: .caption2))
                        .foregroundStyle(Color.inkDim)
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Amounts only, so it shows while locked (brief §3: "counts and money").
    /// No amber: nothing about money waits on Martin.
    @ViewBuilder private var moneyCard: some View {
        if let glance = money.glance {
            Button { showGeld = true } label: {
                card(label: HomeSummary.moneyLabel, chevron: true) {
                    MoneyGlanceSummary(summary: glance.summary(revealed: lock.revealsCaseContent))
                }
            }
            .buttonStyle(.plain)
        } else if money.lastError == nil {
            card(label: HomeSummary.moneyLabel) { loading }
        }
        // A failed money fetch hides the card rather than adding a second
        // error line to Overzicht; Geld itself says why.
    }

    @ViewBuilder private var tasksCard: some View {
        card(label: HomeSummary.tasksLabel) {
            if let tasks = store.summary?.tasks {
                HStack(spacing: 14) {
                    ForEach(HomeSummary.taskLines(tasks), id: \.text) { line in
                        Text(line.text)
                            .font(.display(15, relativeTo: .body, weight: .light))
                            .foregroundStyle(line.amber ? Color.attn : Color.ink)
                    }
                }
            } else {
                loading
            }
        }
    }

    private var scansCard: some View {
        let summary = uploads.summary
        return Button(action: openScan) {
            card(label: HomeSummary.scansLabel, chevron: true) {
                if summary.isEmpty {
                    muted("Vandaag nog niets gescand.")
                } else {
                    Text(summary.parts.joined(separator: " · "))
                        .font(.display(15, relativeTo: .body, weight: .light))
                        .foregroundStyle(Color.ink)
                }
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: pieces

    private func card<Content: View>(label: String, amber: Bool = false, chevron: Bool = false,
                                     @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(label)
                    .font(.mono(11, relativeTo: .caption2, weight: .medium))
                    .foregroundStyle(amber ? Color.attn : Color.inkLabel)
                Spacer(minLength: 0)
                if chevron {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Color.inkFaint)
                }
            }
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
        .contentShape(Rectangle())
    }

    private func muted(_ text: String) -> some View {
        Text(text)
            .font(.display(14, relativeTo: .callout, weight: .light))
            .foregroundStyle(Color.inkMute)
    }

    private var loading: some View { ProgressView().tint(Color.signal) }
}
