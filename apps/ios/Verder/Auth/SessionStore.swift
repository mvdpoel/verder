import Foundation
import Security
import Synchronization

/// better-auth's session cookie, exactly as the server set it. The value is sent
/// back verbatim (it is `token.signature`, already URL-encoded by the server).
struct SessionCookie: Codable, Equatable, Sendable {
    let name: String
    let value: String
    let expires: Date?

    /// In order of preference: production is https, so the secure name.
    static let names = ["__Secure-better-auth.session_token", "better-auth.session_token"]

    func isLive(at now: Date = Date()) -> Bool {
        expires.map { $0 > now } ?? true
    }
}

protocol SessionStore: Sendable {
    func load() -> SessionCookie?
    func save(_ cookie: SessionCookie) throws
    func clear()
}

struct KeychainError: Error, Equatable {
    let status: OSStatus
}

/// The session in the Keychain, `AfterFirstUnlockThisDeviceOnly`: readable
/// while the phone is locked (background uploads need it), never synced or
/// restored onto another device.
///
/// The access group is the app's `keychain-access-groups` entitlement
/// (`$(AppIdentifierPrefix)pro.vanderpoel.verder`, project.yml). Its resolved
/// value reaches the code through the Info.plist key `VerderKeychainAccessGroup`,
/// which Xcode expands from the same build setting — so the group named in code
/// cannot drift from the group the binary is entitled to. The share extension
/// (spec §7.8) adds the same entitlement to read the same item.
struct KeychainSessionStore: SessionStore {
    static let defaultService = "pro.vanderpoel.verder.session"
    private static let account = "better-auth"

    static var entitledAccessGroup: String? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "VerderKeychainAccessGroup") as? String,
              !group.isEmpty, !group.contains("$(") else { return nil }
        return group
    }

    let service: String
    let accessGroup: String?

    init(service: String = KeychainSessionStore.defaultService,
         accessGroup: String? = KeychainSessionStore.entitledAccessGroup) {
        self.service = service
        self.accessGroup = accessGroup
    }

    var baseQuery: [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    func load() -> SessionCookie? {
        var q = baseQuery
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(SessionCookie.self, from: data)
    }

    func save(_ cookie: SessionCookie) throws {
        let data = try JSONEncoder().encode(cookie)
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery
            add.merge(update) { _, new in new }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    func clear() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}

/// For tests and previews.
final class InMemorySessionStore: SessionStore {
    private let cookie: Mutex<SessionCookie?>

    init(_ cookie: SessionCookie? = nil) {
        self.cookie = Mutex(cookie)
    }

    func load() -> SessionCookie? { cookie.withLock { $0 } }
    func save(_ new: SessionCookie) throws { cookie.withLock { $0 = new } }
    func clear() { cookie.withLock { $0 = nil } }
}
