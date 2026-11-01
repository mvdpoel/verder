import SwiftUI
import WidgetKit

/// The home- and lock-screen widget (spec §7, plan 3 Task 23). It reads ONE
/// file, the App Group snapshot `InboxStore.refresh` writes, and never calls
/// the network. Everything it decides is `WidgetContent` (Verder/Widget),
/// compiled into both targets so the app's tests cover it.
struct VerderProvider: TimelineProvider {
    private func read() -> WidgetSnapshot? {
        AppGroup.containerURL.flatMap { WidgetSnapshot.read(from: $0) }
    }

    /// The gallery and first-load placeholder, which iOS draws redacted. A
    /// fresh "nothing waits" — never a made-up count.
    func placeholder(in context: Context) -> VerderEntry {
        VerderEntry(date: .now, snapshot: WidgetSnapshot(count: 0, topTitle: nil, topKind: nil,
                                                         headline: nil, updatedAt: .now))
    }

    func getSnapshot(in context: Context, completion: @escaping (VerderEntry) -> Void) {
        completion(VerderTimeline.entry(now: .now, snapshot: read()).0)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<VerderEntry>) -> Void) {
        let now = Date.now
        let snapshot = read()
        let (_, reload) = VerderTimeline.entry(now: now, snapshot: snapshot)
        completion(Timeline(entries: VerderTimeline.entries(now: now, snapshot: snapshot), policy: .after(reload)))
    }
}

/// One entry, painted for whichever family is showing. The whole widget taps
/// through to Voor jou; a row taps through to its own item (`Link`).
struct VerderEntryView: View {
    let entry: VerderEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let content = WidgetContent.make(snapshot: entry.snapshot, family: family, now: entry.date)
        WidgetFamilyView(content: content, family: family)
            .widgetURL(content.url)
            .containerBackground(for: .widget) { Color.void }
    }
}

struct VerderWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "pro.vanderpoel.verder.waiting", provider: VerderProvider()) { entry in
            VerderEntryView(entry: entry)
        }
        .configurationDisplayName("Voor jou")
        .description("Hoeveel er op je wacht. Op het toegangsscherm alleen het aantal.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge,
                            .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

@main
struct VerderWidgetBundle: WidgetBundle {
    var body: some Widget { VerderWidget() }
}
