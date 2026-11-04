import Testing
import Foundation
import Security
@testable import Verder

struct SessionStoreTests {
    /// Each run gets its own service so a crashed run cannot leave an item that
    /// makes the next one pass for the wrong reason.
    static func scratchStore() -> KeychainSessionStore {
        KeychainSessionStore(service: "pro.vanderpoel.verder.session.test-\(UUID().uuidString)")
    }

    @Test func keychainRoundTrip() throws {
        let store = Self.scratchStore()
        defer { store.clear() }
        #expect(store.load() == nil)

        let cookie = SessionCookie(name: "__Secure-better-auth.session_token", value: "tok.sig",
                                   expires: Date(timeIntervalSince1970: 1_800_000_000))
        try store.save(cookie)
        #expect(store.load() == cookie)

        // A second save replaces, it does not fail on a duplicate item.
        let rolled = SessionCookie(name: cookie.name, value: "rolled.sig", expires: nil)
        try store.save(rolled)
        #expect(store.load() == rolled)

        store.clear()
        #expect(store.load() == nil)
    }

    /// The access group is the `keychain-access-groups` entitlement with its
    /// `$(AppIdentifierPrefix)` resolved at build time — an unresolved `$(` here
    /// would be a group no binary is entitled to.
    @Test func accessGroupIsTheEntitledGroup() throws {
        let group = try #require(KeychainSessionStore.entitledAccessGroup)
        #expect(group.hasSuffix(".pro.vanderpoel.verder"))
        #expect(!group.contains("$("))
    }

    /// Background uploads run while the phone is locked, so the item must be
    /// readable after first unlock — and must never leave this device.
    @Test func itemIsAfterFirstUnlockThisDeviceOnly() throws {
        let store = Self.scratchStore()
        defer { store.clear() }
        try store.save(SessionCookie(name: "n", value: "v", expires: nil))

        var query = store.baseQuery
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        #expect(SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess)
        let attrs = try #require(out as? [String: Any])
        #expect(attrs[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        #expect(attrs[kSecAttrAccessGroup as String] as? String == KeychainSessionStore.entitledAccessGroup)
    }
}
