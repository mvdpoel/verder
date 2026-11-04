import CoreGraphics
import SwiftUI
import Testing
@testable import Grip

/// The pre-prompts' two layouts (Figma "auth · final", Pre-prompts row):
/// the 6.3-inch frames, and the SE frame's smaller picture, nearer title and
/// raised button.
@Suite struct PrePromptLayoutTests {
    typealias Layout = PermissionPrePrompt<EmptyArt>.Layout
    struct EmptyArt: SwiftUI.View { var body: some SwiftUI.View { SwiftUI.EmptyView() } }

    @Test func anSEIsCompact() {
        // 667 − the 20 pt status bar.
        let m = Layout.metrics(height: 647)
        #expect(m.compact)
        #expect(m.titleFromBottom == 208)
        #expect(m.actionsBottom == 52)
    }

    @Test func aFaceIDPhoneIsNot() {
        // iPhone 17: 874 − 62 − 34; the smallest Face ID phone is ~728.
        for h: CGFloat in [778, 728] {
            let m = Layout.metrics(height: h)
            #expect(!m.compact)
            #expect(m.titleFromBottom == Layout.titleFromBottom)
            #expect(m.actionsBottom == 16)
        }
    }

    @Test func beforeTheFirstMeasurementItIsNotCompact() {
        #expect(!Layout.metrics(height: 0).compact)
    }

    @Test func theSELetterMatchesItsFrame() {
        // Brackets 132 wide (width + 26) and 160 tall (width × 1.3 + 22).
        #expect(LetterArt.compactWidth + 26 == 132)
        #expect(abs(LetterArt.compactWidth * 1.3 + 22 - 160) < 1)
    }
}
