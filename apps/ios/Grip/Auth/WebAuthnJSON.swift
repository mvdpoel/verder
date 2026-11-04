import Foundation
import AuthenticationServices

// The WebAuthn wire format between AuthenticationServices and better-auth.
//
// better-auth's passkey plugin hands the browser's answer straight to
// @simplewebauthn/server (13.3.3 here), which expects the
// `AuthenticationResponseJSON` / `RegistrationResponseJSON` shapes that
// @simplewebauthn/browser produces: every binary field base64url WITHOUT
// padding, and `id` equal to `rawId`. These functions build exactly that from
// what iOS returns, and are pure so they can be tested without Face ID.

/// RFC 4648 §5 base64url, no padding.
func base64url(_ d: Data) -> String {
    d.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

/// Accepts base64url with or without padding; nil for anything else.
func base64urlDecode(_ s: String) -> Data? {
    var b64 = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    switch b64.count % 4 {
    case 0: break
    case 2: b64 += "=="
    case 3: b64 += "="
    default: return nil
    }
    return Data(base64Encoded: b64)
}

// MARK: - What iOS returns, as protocols the Apple types already satisfy

/// The fields of an `ASAuthorizationPlatformPublicKeyCredentialAssertion` the
/// server needs. A protocol rather than the concrete class because the class
/// has no public initializer, so a test could never build one.
///
/// Three fields are optional because ASAuthorizationPublicKeyCredentialAssertion.h
/// has no nullability annotations: Swift imports them as `Data!`. An `Data!`
/// property cannot witness ANY protocol requirement (measured: neither `Data`
/// nor `Data?`), so the Apple assertion class does not conform; it is copied
/// into `AssertionValues` instead, and the IUO is read as the optional it is.
protocol PasskeyAssertion {
    var credentialID: Data { get }
    var rawClientDataJSON: Data { get }
    var rawAuthenticatorData: Data? { get }
    var signature: Data? { get }
    var userID: Data? { get }
}

protocol PasskeyRegistration {
    var credentialID: Data { get }
    var rawClientDataJSON: Data { get }
    var rawAttestationObject: Data? { get }
}

extension ASAuthorizationPlatformPublicKeyCredentialRegistration: PasskeyRegistration {}

/// A Sendable copy of an assertion, taken on the main actor where the
/// AuthenticationServices delegate runs.
struct AssertionValues: PasskeyAssertion, Sendable {
    let credentialID: Data
    let rawClientDataJSON: Data
    let rawAuthenticatorData: Data?
    let signature: Data?
    let userID: Data?

    init(credentialID: Data, rawClientDataJSON: Data, rawAuthenticatorData: Data?, signature: Data?, userID: Data?) {
        self.credentialID = credentialID
        self.rawClientDataJSON = rawClientDataJSON
        self.rawAuthenticatorData = rawAuthenticatorData
        self.signature = signature
        self.userID = userID
    }

    init(_ c: ASAuthorizationPlatformPublicKeyCredentialAssertion) {
        let authenticatorData: Data? = c.rawAuthenticatorData
        let signature: Data? = c.signature
        let userID: Data? = c.userID
        self.init(credentialID: c.credentialID, rawClientDataJSON: c.rawClientDataJSON,
                  rawAuthenticatorData: authenticatorData, signature: signature, userID: userID)
    }
}

struct RegistrationValues: PasskeyRegistration, Sendable {
    let credentialID: Data
    let rawClientDataJSON: Data
    let rawAttestationObject: Data?

    init(credentialID: Data, rawClientDataJSON: Data, rawAttestationObject: Data?) {
        self.credentialID = credentialID
        self.rawClientDataJSON = rawClientDataJSON
        self.rawAttestationObject = rawAttestationObject
    }

    init(_ c: some PasskeyRegistration) {
        self.init(credentialID: c.credentialID, rawClientDataJSON: c.rawClientDataJSON,
                  rawAttestationObject: c.rawAttestationObject)
    }
}

// MARK: - iOS → server

/// `AuthenticationResponseJSON`, sent as `{ response: <this> }` to
/// verify-authentication. `userHandle` is omitted when empty: present, it is a
/// claim about which user signed in. nil when iOS returned no authenticator
/// data or no signature — there would be nothing for the server to verify.
func authenticationJSON(_ c: some PasskeyAssertion) -> [String: Any]? {
    guard let authenticatorData = c.rawAuthenticatorData, let signature = c.signature else { return nil }
    let id = base64url(c.credentialID)
    var response: [String: Any] = [
        "clientDataJSON": base64url(c.rawClientDataJSON),
        "authenticatorData": base64url(authenticatorData),
        "signature": base64url(signature),
    ]
    if let user = c.userID, !user.isEmpty { response["userHandle"] = base64url(user) }
    return [
        "id": id,
        "rawId": id,
        "type": "public-key",
        "authenticatorAttachment": "platform",
        "clientExtensionResults": [String: Any](),
        "response": response,
    ]
}

/// The plan's entry point for the Apple type itself.
func authenticationJSON(_ c: ASAuthorizationPlatformPublicKeyCredentialAssertion) -> [String: Any]? {
    authenticationJSON(AssertionValues(c))
}

/// `RegistrationResponseJSON`, sent as `{ response: <this>, name }` to
/// verify-registration. nil when iOS returned no attestation object, which
/// leaves the server nothing to verify.
///
/// `transports` is what Safari reports for the same iCloud Keychain
/// authenticator (`["hybrid", "internal"]`); iOS does not expose it natively.
/// better-auth stores it on the passkey row and replays it as an
/// allowCredentials hint, and an omitted list is stored as "" and replayed as
/// `[""]`.
func registrationJSON(_ c: some PasskeyRegistration) -> [String: Any]? {
    guard let attestation = c.rawAttestationObject else { return nil }
    let id = base64url(c.credentialID)
    return [
        "id": id,
        "rawId": id,
        "type": "public-key",
        "authenticatorAttachment": "platform",
        "clientExtensionResults": [String: Any](),
        "response": [
            "clientDataJSON": base64url(c.rawClientDataJSON),
            "attestationObject": base64url(attestation),
            "transports": ["hybrid", "internal"],
        ] as [String: Any],
    ]
}

// MARK: - server → iOS

private struct CredentialDescriptorJSON: Decodable {
    let id: String
}

/// `PublicKeyCredentialRequestOptionsJSON` from generate-authenticate-options,
/// reduced to what `ASAuthorizationPlatformPublicKeyCredentialProvider` takes.
struct AssertionOptions: Sendable, Equatable {
    let rpID: String
    let challenge: Data
    let allowCredentialIDs: [Data]

    private struct Wire: Decodable {
        let rpId: String
        let challenge: String
        let allowCredentials: [CredentialDescriptorJSON]?
    }

    static func decode(_ body: Data) throws -> AssertionOptions {
        guard let w = try? JSONDecoder().decode(Wire.self, from: body),
              let challenge = base64urlDecode(w.challenge), !challenge.isEmpty,
              !w.rpId.isEmpty else { throw PasskeyError.badOptions }
        let ids = try (w.allowCredentials ?? []).map {
            guard let id = base64urlDecode($0.id) else { throw PasskeyError.badOptions }
            return id
        }
        return AssertionOptions(rpID: w.rpId, challenge: challenge, allowCredentialIDs: ids)
    }
}

/// `PublicKeyCredentialCreationOptionsJSON` from generate-register-options.
struct RegistrationOptions: Sendable, Equatable {
    let rpID: String
    let challenge: Data
    let userID: Data
    let userName: String
    let excludeCredentialIDs: [Data]

    private struct Wire: Decodable {
        struct RP: Decodable { let id: String? }
        struct User: Decodable { let id: String; let name: String }
        let challenge: String
        let rp: RP
        let user: User
        let excludeCredentials: [CredentialDescriptorJSON]?
    }

    static func decode(_ body: Data) throws -> RegistrationOptions {
        guard let w = try? JSONDecoder().decode(Wire.self, from: body),
              let rpID = w.rp.id, !rpID.isEmpty,
              let challenge = base64urlDecode(w.challenge), !challenge.isEmpty,
              let userID = base64urlDecode(w.user.id), !userID.isEmpty else { throw PasskeyError.badOptions }
        let ids = try (w.excludeCredentials ?? []).map {
            guard let id = base64urlDecode($0.id) else { throw PasskeyError.badOptions }
            return id
        }
        return RegistrationOptions(rpID: rpID, challenge: challenge, userID: userID,
                                   userName: w.user.name, excludeCredentialIDs: ids)
    }
}
