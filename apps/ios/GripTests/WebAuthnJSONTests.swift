import Testing
import Foundation
@testable import Verder

struct WebAuthnJSONTests {
    struct FakeAssertion: PasskeyAssertion {
        var credentialID = Data([0x01, 0xfb, 0xff])
        var rawClientDataJSON = Data(#"{"type":"webauthn.get"}"#.utf8)
        var rawAuthenticatorData: Data? = Data([0xaa, 0xbb])
        var signature: Data? = Data([0x30, 0x45])
        var userID: Data? = Data("user-1".utf8)
    }

    struct FakeRegistration: PasskeyRegistration {
        var credentialID = Data([0x02, 0xfe, 0xfc])
        var rawClientDataJSON = Data(#"{"type":"webauthn.create"}"#.utf8)
        var rawAttestationObject: Data? = Data([0xa3, 0x63])
    }

    @Test func base64urlHasNoPaddingOrPlusSlash() {
        #expect(base64url(Data([0xfb, 0xff])) == "-_8")
        #expect(base64url(Data()) == "")
        #expect(base64url(Data("f".utf8)) == "Zg")
    }

    @Test func base64urlDecodesWhatTheServerSends() {
        #expect(base64urlDecode("-_8") == Data([0xfb, 0xff]))
        #expect(base64urlDecode("Zg") == Data("f".utf8))
        #expect(base64urlDecode("Zm9v") == Data("foo".utf8))
        #expect(base64urlDecode("not base64!") == nil)
    }

    @Test func authenticationJSONShape() throws {
        let json = try #require(authenticationJSON(FakeAssertion()))
        #expect(json["id"] as? String == "Afv_")
        #expect(json["rawId"] as? String == "Afv_")
        #expect(json["type"] as? String == "public-key")
        #expect(json["authenticatorAttachment"] as? String == "platform")
        #expect((json["clientExtensionResults"] as? [String: Any])?.isEmpty == true)
        let response = try #require(json["response"] as? [String: Any])
        #expect(response["clientDataJSON"] as? String == base64url(Data(#"{"type":"webauthn.get"}"#.utf8)))
        #expect(response["authenticatorData"] as? String == "qrs")
        #expect(response["signature"] as? String == "MEU")
        #expect(response["userHandle"] as? String == base64url(Data("user-1".utf8)))
        // It must survive JSONSerialization: that is how it reaches the wire.
        #expect(JSONSerialization.isValidJSONObject(json))
    }

    /// An empty user handle is absent, never "" — simplewebauthn treats a
    /// present userHandle as a claim about the user.
    @Test func authenticationJSONOmitsEmptyUserHandle() throws {
        var a = FakeAssertion()
        a.userID = Data()
        let response = try #require(authenticationJSON(a)?["response"] as? [String: Any])
        #expect(response["userHandle"] == nil)
        a.userID = nil
        let again = try #require(authenticationJSON(a)?["response"] as? [String: Any])
        #expect(again["userHandle"] == nil)
    }

    /// No signature means there is nothing the server could verify.
    @Test func assertionWithoutSignatureIsNil() {
        var a = FakeAssertion()
        a.signature = nil
        #expect(authenticationJSON(a) == nil)
    }

    @Test func registrationJSONShape() throws {
        let json = try #require(registrationJSON(FakeRegistration()))
        #expect(json["id"] as? String == "Av78")
        #expect(json["rawId"] as? String == "Av78")
        #expect(json["type"] as? String == "public-key")
        #expect(json["authenticatorAttachment"] as? String == "platform")
        let response = try #require(json["response"] as? [String: Any])
        #expect(response["clientDataJSON"] as? String == base64url(Data(#"{"type":"webauthn.create"}"#.utf8)))
        #expect(response["attestationObject"] as? String == "o2M")
        #expect(response["transports"] as? [String] == ["hybrid", "internal"])
        #expect(JSONSerialization.isValidJSONObject(json))
    }

    /// No attestation object means there is nothing the server could verify.
    @Test func registrationWithoutAttestationIsNil() {
        var r = FakeRegistration()
        r.rawAttestationObject = nil
        #expect(registrationJSON(r) == nil)
    }

    @Test func parsesAuthenticationOptions() throws {
        let body = Data(#"""
        {"rpId":"verder.vanderpoel.pro","challenge":"-_8","timeout":60000,"userVerification":"preferred",
         "allowCredentials":[{"id":"Afv_","type":"public-key","transports":["internal"]}]}
        """#.utf8)
        let o = try AssertionOptions.decode(body)
        #expect(o.rpID == "verder.vanderpoel.pro")
        #expect(o.challenge == Data([0xfb, 0xff]))
        #expect(o.allowCredentialIDs == [Data([0x01, 0xfb, 0xff])])
    }

    @Test func parsesRegistrationOptions() throws {
        let body = Data(#"""
        {"challenge":"Zm9v","rp":{"name":"Verder","id":"verder.vanderpoel.pro"},
         "user":{"id":"Zg","name":"martin@vanderpoel.pro","displayName":"martin@vanderpoel.pro"},
         "pubKeyCredParams":[{"alg":-7,"type":"public-key"}],"timeout":60000,"attestation":"none",
         "excludeCredentials":[{"id":"Av78","type":"public-key","transports":["internal"]}],
         "authenticatorSelection":{"residentKey":"preferred","userVerification":"preferred","requireResidentKey":false}}
        """#.utf8)
        let o = try RegistrationOptions.decode(body)
        #expect(o.rpID == "verder.vanderpoel.pro")
        #expect(o.challenge == Data("foo".utf8))
        #expect(o.userID == Data("f".utf8))
        #expect(o.userName == "martin@vanderpoel.pro")
        #expect(o.excludeCredentialIDs == [Data([0x02, 0xfe, 0xfc])])
    }

    @Test func optionsWithBadChallengeAreRefused() {
        let body = Data(#"{"rpId":"verder.vanderpoel.pro","challenge":"!!"}"#.utf8)
        #expect(throws: PasskeyError.badOptions) { try AssertionOptions.decode(body) }
    }
}
