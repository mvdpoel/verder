import SwiftUI

/// Placeholder root on `void`. Task 11 replaces this with the tab bar (Scan first).
struct RootView: View {
    var body: some View {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-tokenPreview") {
            TokenPreview().preferredColorScheme(.dark)
        } else {
            placeholder
        }
        #else
        placeholder
        #endif
    }

    private var placeholder: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            Text("verder")
                .font(.display(34, relativeTo: .largeTitle, weight: .ultraLight))
                .foregroundStyle(Color.inkBright)
        }
        .preferredColorScheme(.dark)
    }
}
