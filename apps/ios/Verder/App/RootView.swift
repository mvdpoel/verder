import SwiftUI

/// Placeholder root on `void` (#04070d; Task 3 replaces the literal with `Color.void`). Task 11 replaces this with the tab bar (Scan first).
struct RootView: View {
    var body: some View {
        ZStack {
            Color(red: 0x04 / 255, green: 0x07 / 255, blue: 0x0d / 255).ignoresSafeArea()
            Text("verder")
                .font(.largeTitle.weight(.semibold))
                .foregroundStyle(.white)
        }
        .preferredColorScheme(.dark)
    }
}
