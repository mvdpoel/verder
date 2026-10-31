import Foundation

/// Which APNs host this build's device token belongs to, read from the
/// SIGNATURE rather than guessed from the build configuration.
///
/// A development-signed build gets sandbox tokens, and a sandbox token sent to
/// `api.push.apple.com` answers `400 BadDeviceToken` — the classic silent
/// failure (spec §6.3). `#if DEBUG` cannot tell: `scripts/install.sh` builds
/// RELEASE with development signing, which is still sandbox. The provisioning
/// profile embedded in the app says which it is, so that is what the server
/// stores per device.
enum ProvisioningEnvironment {
    /// `Entitlements.aps-environment` from an `embedded.mobileprovision`: a CMS
    /// envelope around an XML plist. Only the plist between `<?xml` and
    /// `</plist>` is read; the signature around it is not verified (the OS
    /// already did, or the app would not have launched). Nil for anything that
    /// is not one of the two values the server accepts.
    static func parse(_ data: Data) -> String? {
        guard let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex)
        else { return nil }
        let plist = data[start.lowerBound..<end.upperBound]
        guard let root = try? PropertyListSerialization.propertyList(from: Data(plist), format: nil) as? [String: Any],
              let entitlements = root["Entitlements"] as? [String: Any],
              let aps = entitlements["aps-environment"] as? String,
              aps == "development" || aps == "production"
        else { return nil }
        return aps
    }

    /// - The simulator has no profile and always talks to the sandbox.
    /// - A device build with NO embedded profile is App Store / TestFlight
    ///   signed, which is production.
    /// - Otherwise the profile decides. A profile without a readable push
    ///   entitlement falls back to development: every build of this app so far
    ///   is development-signed, and a wrong guess is not silent — the worker
    ///   records the 400 and revokes the token (Plan 2 Task 4).
    static func resolve(profile: Data?, onSimulator: Bool) -> String {
        if onSimulator { return "development" }
        guard let profile else { return "production" }
        return parse(profile) ?? "development"
    }

    static var current: String {
        #if targetEnvironment(simulator)
        let onSimulator = true
        #else
        let onSimulator = false
        #endif
        let profile = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision")
            .flatMap { try? Data(contentsOf: $0) }
        return resolve(profile: profile, onSimulator: onSimulator)
    }
}
