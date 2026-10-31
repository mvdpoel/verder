import AuthenticationServices
import Testing
@testable import Verder

@Suite struct PasskeyErrorMappingTests {
    @Test func cancelIsCancelled() {
        #expect(passkeyError(from: ASAuthorizationError(.canceled)) == .cancelled)
    }

    /// 1006: a passkey for this account is already on the phone (iCloud Keychain).
    @Test func excludedCredentialIsAlreadyOnDevice() {
        #expect(passkeyError(from: ASAuthorizationError(.matchedExcludedCredential)) == .alreadyOnDevice)
    }

    @Test func associationFailureKeepsItsCode() {
        guard case .failed(let text) = passkeyError(from: ASAuthorizationError(.failed)) else {
            Issue.record("expected .failed"); return
        }
        #expect(text.contains("1004"))
    }
}
