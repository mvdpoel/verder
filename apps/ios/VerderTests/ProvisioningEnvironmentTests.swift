import Testing
import Foundation
@testable import Verder

/// The environment the server stores is the one the SIGNATURE says. A
/// development token sent to the production APNs host answers
/// `400 BadDeviceToken`, so guessing from `#if DEBUG` (a Release build with
/// development signing is still sandbox) is the classic silent failure.
struct ProvisioningEnvironmentTests {
    /// A synthetic plist wrapped in fake CMS bytes — not a real profile.
    static let fixture: Data = {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/embedded-development.mobileprovision")
        guard let data = try? Data(contentsOf: url) else { fatalError("missing fixture \(url.path)") }
        return data
    }()

    static func wrapped(_ plist: String) -> Data {
        Data([0x30, 0x82, 0x01, 0x00, 0x06, 0x09, 0xff]) + Data(plist.utf8) + Data([0xa0, 0x82, 0x00, 0x00])
    }

    static func profile(aps: String?) -> Data {
        let entry = aps.map { "<key>aps-environment</key><string>\($0)</string>" } ?? ""
        return wrapped("""
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0"><dict><key>Entitlements</key><dict>\(entry)</dict></dict></plist>
        """)
    }

    @Test func parsesDevelopmentFromProfile() {
        #expect(ProvisioningEnvironment.parse(Self.fixture) == "development")
    }

    @Test func parsesProduction() {
        #expect(ProvisioningEnvironment.parse(Self.profile(aps: "production")) == "production")
    }

    @Test func profileWithoutPushEntitlementIsNil() {
        #expect(ProvisioningEnvironment.parse(Self.profile(aps: nil)) == nil)
    }

    /// Only the two values the server accepts; anything else is not trusted.
    @Test func unknownApsValueIsNil() {
        #expect(ProvisioningEnvironment.parse(Self.profile(aps: "staging")) == nil)
    }

    @Test func junkIsNil() {
        #expect(ProvisioningEnvironment.parse(Data()) == nil)
        #expect(ProvisioningEnvironment.parse(Data([0x30, 0x82, 0x00])) == nil)
        #expect(ProvisioningEnvironment.parse(Data("<?xml no end".utf8)) == nil)
        #expect(ProvisioningEnvironment.parse(Self.wrapped("<?xml version=\"1.0\"?><plist>broken</plist>")) == nil)
    }

    @Test func missingProfileIsDevelopmentOnSimulator() {
        #expect(ProvisioningEnvironment.resolve(profile: nil, onSimulator: true) == "development")
        // The simulator talks to the sandbox whatever a stray profile says.
        #expect(ProvisioningEnvironment.resolve(profile: Self.profile(aps: "production"), onSimulator: true) == "development")
    }

    /// An App Store / TestFlight build carries no embedded profile and is
    /// production-signed.
    @Test func missingProfileOnDeviceIsProduction() {
        #expect(ProvisioningEnvironment.resolve(profile: nil, onSimulator: false) == "production")
    }

    @Test func deviceReadsTheProfile() {
        #expect(ProvisioningEnvironment.resolve(profile: Self.fixture, onSimulator: false) == "development")
        #expect(ProvisioningEnvironment.resolve(profile: Self.profile(aps: "production"), onSimulator: false) == "production")
    }

    @Test func currentOnTheSimulatorIsDevelopment() {
        #expect(ProvisioningEnvironment.current == "development")
    }
}
