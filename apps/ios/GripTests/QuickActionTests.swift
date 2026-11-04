import Testing
import Foundation
@testable import Grip

/// The home screen quick action "Gesprek vastleggen" (plan 3 Task 25) and the
/// `grip://voice` link it rides on.
struct QuickActionTests {
    @Test func theVoiceActionOpensTheVoiceLog() {
        #expect(QuickAction.link(forType: QuickAction.voiceType) == .voice)
        #expect(QuickAction.link(forType: "pro.vanderpoel.grip.unknown") == DeepLink.none)
        #expect(QuickAction.link(forType: "") == DeepLink.none)
    }

    @Test func voiceLinkParsesStrictly() {
        #expect(DeepLink.parse("grip://voice") == .voice)
        #expect(DeepLink.parse("grip://voice/x") == DeepLink.none)
        #expect(DeepLink.parse("grip://voice?x=1") == DeepLink.none)
        // A sheet over whatever tab is showing, not a tab of its own.
        #expect(DeepLink.voice.tab == nil)
    }

    /// The Info.plist declares the action with the type the app handles.
    @Test func infoPlistDeclaresTheAction() throws {
        let items = try #require(Bundle.main.object(forInfoDictionaryKey: "UIApplicationShortcutItems") as? [[String: Any]])
        let voice = try #require(items.first { $0["UIApplicationShortcutItemType"] as? String == QuickAction.voiceType })
        #expect(voice["UIApplicationShortcutItemTitle"] as? String == "Gesprek vastleggen")
    }

    @Test func infoPlistCarriesTheDutchPurposeStrings() {
        #expect(Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") as? String
                == "verder neemt je stem op om een gesprek vast te leggen.")
        #expect(Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") as? String
                == "verder zet je opname op je telefoon om in tekst.")
    }
}
