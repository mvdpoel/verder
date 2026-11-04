import SwiftUI
import WidgetKit

/// The home- and lock-screen widget (spec §7, plan 3 Task 23). It reads ONE
/// file, the App Group snapshot `InboxStore.refresh` writes, and never calls
/// the network. Everything it decides is `WidgetContent` (Grip/Widget),
/// compiled into both targets so the app's tests cover it.
struct GripProvider: TimelineProvider {
    private func read() -> WidgetSnapshot? {
        AppGroup.containerURL.flatMap { WidgetSnapshot.read(from: $0) }
    }

    /// The empty marker sign-out leaves (no case content): "Log in bij Grip".
    private func signedOut() -> Bool {
        AppGroup.containerURL.map { WidgetSnapshot.isSignedOut(in: $0) } ?? false
    }

    /// The gallery and first-load placeholder, which iOS draws redacted. A
    /// fresh "nothing waits" — never a made-up count.
    func placeholder(in context: Context) -> GripEntry {
        GripEntry(date: .now, snapshot: WidgetSnapshot(count: 0, topTitle: nil, topKind: nil,
                                                         headline: nil, updatedAt: .now))
    }

    func getSnapshot(in context: Context, completion: @escaping (GripEntry) -> Void) {
        completion(GripTimeline.entry(now: .now, snapshot: read(), signedOut: signedOut(),
                                        displaySize: context.displaySize).0)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GripEntry>) -> Void) {
        let now = Date.now
        let snapshot = read()
        let out = signedOut()
        let (_, reload) = GripTimeline.entry(now: now, snapshot: snapshot)
        completion(Timeline(entries: GripTimeline.entries(now: now, snapshot: snapshot, signedOut: out,
                                                            displaySize: context.displaySize),
                            policy: .after(reload)))
    }
}

/// One entry, painted for whichever family is showing. The whole widget taps
/// through to Voor jou; a row taps through to its own item (`Link`).
struct GripEntryView: View {
    let entry: GripEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.showsWidgetContainerBackground) private var showsBackground

    var body: some View {
        let layout = WidgetContent.Layout.make(family: family, displaySize: entry.displaySize,
                                               accessibilitySize: typeSize.isAccessibilitySize)
        let standBy = family == .systemSmall && !showsBackground
        let content = WidgetContent.make(snapshot: entry.snapshot, family: family, now: entry.date,
                                         signedOut: entry.signedOut, layout: layout, standBy: standBy)
        WidgetFamilyView(content: content, family: family, standBy: standBy)
            .widgetURL(content.url)
            .containerBackground(for: .widget) { WidgetPlate() }
    }
}

/// "Waar het nu op wacht": the map's open stop, its spoor and its date —
/// StandBy's right-hand stack beside "Voor jou" (Figma "StandBy /
/// ontgrendeld"). A tap opens the map at that stop.
struct HeadlineEntryView: View {
    let entry: GripEntry
    @Environment(\.showsWidgetContainerBackground) private var showsBackground

    var body: some View {
        let content = HeadlineContent.make(snapshot: entry.snapshot, now: entry.date, signedOut: entry.signedOut)
        HeadlineFace(content: content, standBy: !showsBackground)
            .widgetURL(content.url)
            .containerBackground(for: .widget) { WidgetPlate() }
    }
}

struct HeadlineWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "pro.vanderpoel.grip.headline", provider: GripProvider()) { entry in
            HeadlineEntryView(entry: entry)
        }
        .configurationDisplayName("Waar het nu op wacht")
        .description("De halte waar je dossier nu op wacht. Vergrendeld zie je alleen dat er een is.")
        .supportedFamilies([.systemSmall])
    }
}

struct GripWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "pro.vanderpoel.grip.waiting", provider: GripProvider()) { entry in
            GripEntryView(entry: entry)
        }
        .configurationDisplayName("Voor jou")
        .description("Hoeveel er op je wacht. Op het toegangsscherm nooit titels.")
        .supportedFamilies(WidgetContent.families)
    }
}

@main
struct GripWidgetBundle: WidgetBundle {
    var body: some Widget {
        GripWidget()
        HeadlineWidget()
        ScanControl()
        CallLiveActivity()
    }
}
