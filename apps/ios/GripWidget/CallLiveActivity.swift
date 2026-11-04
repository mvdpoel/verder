import ActivityKit
import SwiftUI
import WidgetKit

/// The call's Live Activity (Added 2026-11-03): started by the app when
/// Martin taps "Bel" or "Toon tijdens het gesprek", updated on every tick,
/// ended when CallKit reports the call over. The faces live in
/// Grip/Widget/CallActivityViews.swift; what they may say is
/// `CallActivityFaces` — counts only on the lock screen.
struct CallLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CallActivityAttributes.self) { context in
            CallLockScreenView(state: context.state)
        } dynamicIsland: { context in
            CallIsland.make(context.state)
        }
    }
}
