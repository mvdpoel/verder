import SwiftUI
import WidgetKit

/// The call's Live Activity, drawn. Every string comes from
/// `CallActivityFaces` (Verder/Shared/CallActivity.swift), which is where the
/// privacy rule is kept and tested: the lock screen and the compact/minimal
/// Dynamic Island show COUNTS ONLY; only the expanded island may show the next
/// point's text, and draws it `.privacySensitive()`. The party's name appears
/// on no face — it is not even in the activity's data.
struct CallLockScreenView: View {
    let state: CallActivityAttributes.ContentState

    var body: some View {
        let face = CallActivityFaces.lockScreen(state)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "checklist").accessibilityHidden(true)
                Text(face.title)
                Spacer(minLength: 0)
            }
            .font(.mono(12, relativeTo: .caption, weight: .medium))
            .foregroundStyle(Color.inkLabel)
            Text(face.progress)
                .font(.display(20, relativeTo: .title3, weight: .light))
                .foregroundStyle(Color.inkBright)
                .monospacedDigit()
            ProgressView(value: face.fraction)
                .tint(Color.steel)
                .accessibilityHidden(true)
            Text(face.detail)
                .font(.mono(11, relativeTo: .caption2))
                .foregroundStyle(Color.inkMute)
        }
        .padding(16)
        .activityBackgroundTint(Color.void)
        .activitySystemActionForegroundColor(Color.signalLink)
        .widgetURL(CallActivityFaces.url)
    }
}

enum CallIsland {
    static func make(_ state: CallActivityAttributes.ContentState) -> DynamicIsland {
        let compact = CallActivityFaces.compact(state)
        let expanded = CallActivityFaces.expanded(state)
        return DynamicIsland {
            DynamicIslandExpandedRegion(.leading) {
                Image(systemName: compact.leadingSymbol)
                    .foregroundStyle(Color.signalLink)
                    .accessibilityHidden(true)
            }
            DynamicIslandExpandedRegion(.trailing) {
                Text(compact.trailing)
                    .font(.mono(14, relativeTo: .body, weight: .medium))
                    .foregroundStyle(Color.inkBright)
                    .monospacedDigit()
            }
            DynamicIslandExpandedRegion(.bottom) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(expanded.nextLabel.uppercased())
                        .font(.mono(11, relativeTo: .caption2, weight: .medium))
                        .foregroundStyle(Color.inkLabel)
                    if let next = expanded.nextPoint {
                        // Unlocked use only: redacted whenever the phone is locked.
                        Text(next)
                            .font(.display(15, relativeTo: .subheadline, weight: .light))
                            .foregroundStyle(Color.inkBright)
                            .lineLimit(2)
                            .privacySensitive(expanded.nextPointIsPrivacySensitive)
                    }
                    Text(expanded.progress)
                        .font(.mono(11, relativeTo: .caption2))
                        .foregroundStyle(Color.inkMute)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } compactLeading: {
            Image(systemName: compact.leadingSymbol)
                .foregroundStyle(Color.signalLink)
                .accessibilityLabel("Gesprek")
        } compactTrailing: {
            Text(compact.trailing)
                .font(.mono(13, relativeTo: .caption, weight: .medium))
                .foregroundStyle(Color.inkBright)
                .monospacedDigit()
        } minimal: {
            Text(CallActivityFaces.minimal(state))
                .font(.mono(11, relativeTo: .caption2, weight: .medium))
                .foregroundStyle(Color.inkBright)
                .monospacedDigit()
        }
        .widgetURL(CallActivityFaces.url)
        .keylineTint(Color.signal)
    }
}
