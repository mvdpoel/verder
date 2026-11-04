#if DEBUG
import SwiftUI
import WidgetKit

/// Previews on the synthetic case (`WidgetSamples`, Verder/Widget).
#Preview("Klein", as: .systemSmall) { VerderWidget() } timeline: {
    WidgetSamples.entry(WidgetSamples.few)
    WidgetSamples.entry(WidgetSamples.many)
    WidgetSamples.entry(WidgetSamples.one)
    WidgetSamples.entry(WidgetSamples.empty)
    WidgetSamples.entry(WidgetSamples.stale)
    WidgetSamples.entry(nil)
    WidgetSamples.entry(nil, signedOut: true)
}
#Preview("Middel", as: .systemMedium) { VerderWidget() } timeline: {
    WidgetSamples.entry(WidgetSamples.few)
    WidgetSamples.entry(WidgetSamples.many)
    WidgetSamples.entry(WidgetSamples.one)
    WidgetSamples.entry(WidgetSamples.empty)
    WidgetSamples.entry(WidgetSamples.stale)
    WidgetSamples.entry(nil)
    WidgetSamples.entry(nil, signedOut: true)
}
#Preview("Groot", as: .systemLarge) { VerderWidget() } timeline: {
    WidgetSamples.entry(WidgetSamples.few)
    WidgetSamples.entry(WidgetSamples.many)
    WidgetSamples.entry(WidgetSamples.one)
    WidgetSamples.entry(WidgetSamples.empty)
    WidgetSamples.entry(WidgetSamples.stale)
    WidgetSamples.entry(nil)
    WidgetSamples.entry(nil, signedOut: true)
}
#Preview("Rond", as: .accessoryCircular) { VerderWidget() } timeline: {
    WidgetSamples.entry(WidgetSamples.few)
    WidgetSamples.entry(WidgetSamples.many)
    WidgetSamples.entry(WidgetSamples.one)
    WidgetSamples.entry(WidgetSamples.empty)
    WidgetSamples.entry(WidgetSamples.stale)
    WidgetSamples.entry(nil)
    WidgetSamples.entry(nil, signedOut: true)
}
#Preview("Rechthoek", as: .accessoryRectangular) { VerderWidget() } timeline: {
    WidgetSamples.entry(WidgetSamples.few)
    WidgetSamples.entry(WidgetSamples.many)
    WidgetSamples.entry(WidgetSamples.one)
    WidgetSamples.entry(WidgetSamples.empty)
    WidgetSamples.entry(WidgetSamples.stale)
    WidgetSamples.entry(nil)
    WidgetSamples.entry(nil, signedOut: true)
}
#Preview("Regel", as: .accessoryInline) { VerderWidget() } timeline: {
    WidgetSamples.entry(WidgetSamples.few)
    WidgetSamples.entry(WidgetSamples.many)
    WidgetSamples.entry(WidgetSamples.one)
    WidgetSamples.entry(WidgetSamples.empty)
    WidgetSamples.entry(WidgetSamples.stale)
    WidgetSamples.entry(nil)
    WidgetSamples.entry(nil, signedOut: true)
}
#Preview("Waar het nu op wacht", as: .systemSmall) { HeadlineWidget() } timeline: {
    WidgetSamples.entry(WidgetSamples.few)
    WidgetSamples.entry(WidgetSamples.many)
    WidgetSamples.entry(WidgetSamples.one)
    WidgetSamples.entry(WidgetSamples.empty)
    WidgetSamples.entry(WidgetSamples.stale)
    WidgetSamples.entry(nil)
    WidgetSamples.entry(nil, signedOut: true)
}
#endif
