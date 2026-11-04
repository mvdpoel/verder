import Foundation
import Testing
@testable import Verder

/// Every sign-in failure as the screen names it (Figma "auth · final",
/// Sign-in row; FEATURES 3.10–3.16): kind, time, cause, and what it offers.
@Suite struct SignInNoticeTests {
    /// 14:02 on Sun 1 nov 2026 in Amsterdam (CET).
    static let at = Date(timeIntervalSince1970: 1_793_538_120)

    static let everyNotice: [SignInNotice] = [
        .init(cause: .wrongPassword, at: at, method: .password),
        .init(cause: .noPasskeyOnDevice, at: at, method: .passkey),
        .init(cause: .passkeyNotOnAccount, at: at, method: .passkey),
        .init(cause: .passkeyFailed("(x)"), at: at, method: .passkey),
        .init(cause: .rateLimited(until: at.addingTimeInterval(60)), at: at, method: .password),
        .init(cause: .serverDown, at: at, method: .passkey),
        .init(cause: .offline, at: at, method: .password),
        .init(cause: .offline, at: at, method: .passkey),
        .init(cause: .failed(nil), at: at, method: .password),
        .init(cause: .sessionExpired, at: at, method: .passkey),
    ]

    @Test func theLabelNamesTheKindAndTheMoment() {
        #expect(SignInNotice(cause: .wrongPassword, at: Self.at, method: .password).label == "WACHTWOORD · 14:02")
        #expect(SignInNotice(cause: .noPasskeyOnDevice, at: Self.at, method: .passkey).label == "TOEGANGSSLEUTEL · 14:02")
        #expect(SignInNotice(cause: .serverDown, at: Self.at, method: .passkey).label == "SERVER · 14:02")
        #expect(SignInNotice(cause: .offline, at: Self.at, method: .password).label == "NETWERK · 14:02")
        #expect(SignInNotice(cause: .rateLimited(until: Self.at), at: Self.at, method: .password).label
                == "BEVEILIGING · 14:02")
        // An expiry carries its day: it may be read the next morning.
        let expiry = Self.at.addingTimeInterval(-(4 * 3600 + 50 * 60)) // 09:12
        #expect(SignInNotice(cause: .sessionExpired, at: expiry, method: .passkey).label == "UITGELOGD · 1 NOV 09:12")
    }

    /// At AX5 the time goes on its own line, so its halves carry no " · ":
    /// a line never starts with the dot (auth final, Geen toegangssleutel
    /// gevonden · AX5).
    @Test func theLabelSplitsIntoKindAndMomentWithoutTheDot() {
        let n = SignInNotice(cause: .noPasskeyOnDevice, at: Self.at, method: .passkey)
        #expect(n.labelKind == "TOEGANGSSLEUTEL")
        #expect(n.labelStamp == "14:02")
        #expect(n.label == "\(n.labelKind) · \(n.labelStamp)")
        for notice in Self.everyNotice {
            #expect(!notice.labelKind.contains("·") && !notice.labelStamp.contains("·"))
        }
    }

    @Test func theFramesWords() {
        let wrong = SignInNotice(cause: .wrongPassword, at: Self.at, method: .password)
        #expect(wrong.title == "E-mailadres of wachtwoord klopt niet.")
        #expect(wrong.body == "Controleer je wachtwoord, of log in met je toegangssleutel.")
        let limit = SignInNotice(cause: .rateLimited(until: Self.at.addingTimeInterval(60)), at: Self.at, method: .password)
        #expect(limit.body == "Wacht een minuut · daarna kun je het opnieuw proberen.")
        #expect(limit.caption(now: Self.at) == "Weer mogelijk om 14:03")
        let server = SignInNotice(cause: .serverDown, at: Self.at, method: .passkey)
        #expect(server.title == "De server reageert niet.")
        #expect(server.caption(now: Self.at.addingTimeInterval(300)) == "Laatste poging 14:02")
        let gone = SignInNotice(cause: .passkeyNotOnAccount, at: Self.at, method: .passkey)
        #expect(gone.caption(now: Self.at) == "Daarna vragen we of je een nieuwe wilt.")
    }

    /// A 429 disables the button until the time it names, and then lets go
    /// by itself — nothing is sent automatically.
    @Test func rateLimitDisablesUntilItsTime() {
        let until = Self.at.addingTimeInterval(150)
        let n = SignInNotice(cause: .rateLimited(until: until), at: Self.at, method: .passkey)
        #expect(!n.primaryEnabled(now: Self.at.addingTimeInterval(149)))
        #expect(n.primaryEnabled(now: until))
        #expect(n.caption(now: until) == nil)
        #expect(n.body.hasPrefix("Wacht 3 minuten"))
        #expect(n.primary == .passkey)
    }

    /// Only a password attempt is ever retried by itself; the toegangssleutel
    /// never promises it, because its retry is a Face ID sheet.
    @Test func offlineOnlyPromisesWhatTheCodeDoes() {
        let password = SignInNotice(cause: .offline, at: Self.at, method: .password)
        #expect(password.body.contains("We proberen het zelf opnieuw"))
        #expect(password.caption(now: Self.at) == "Ook inloggen met toegangssleutel wacht op netwerk.")
        let passkey = SignInNotice(cause: .offline, at: Self.at, method: .passkey)
        #expect(!passkey.body.contains("zelf"))
        #expect(passkey.primary == .retry)
    }

    @Test func whatEachCauseOffers() {
        func n(_ c: SignInNotice.Cause, _ m: SignInMethod = .passkey) -> SignInNotice { .init(cause: c, at: Self.at, method: m) }
        #expect(n(.noPasskeyOnDevice).showsFields && n(.noPasskeyOnDevice).ghost == .retryPasskey)
        #expect(n(.wrongPassword, .password).showsFields && n(.wrongPassword, .password).ghost == .toPasskey)
        #expect(!n(.passkeyNotOnAccount).showsFields && n(.passkeyNotOnAccount).primary == .password)
        #expect(n(.passkeyNotOnAccount).ghost == nil, "only the password: the toegangssleutel is gone")
        #expect(n(.serverDown).primary == .retry && n(.serverDown).ghost == nil)
        #expect(n(.passkeyFailed(nil)).ghost == .toPassword)
    }

    @Test func noNoticeSaysPasskeyOrUsesAmberWords() {
        for notice in Self.everyNotice {
            for text in [notice.title, notice.body, notice.label] {
                #expect(!text.lowercased().contains("passkey"), "\(text)")
            }
        }
    }

    /// Every refusal maps to the cause the frames draw.
    @Test func causesFromErrors() {
        let at = Self.at
        #expect(AuthModel.cause(for: APIError.transport("x"), method: .password, networkUp: false, now: at) == .offline)
        #expect(AuthModel.cause(for: APIError.transport("x"), method: .password, networkUp: true, now: at) == .serverDown)
        #expect(AuthModel.cause(for: APIError.server(502), method: .passkey, networkUp: true, now: at) == .serverDown)
        #expect(AuthModel.cause(for: AuthRefusal(error: .unauthorized, code: "INVALID_EMAIL_OR_PASSWORD", retryAfter: nil),
                                method: .password, networkUp: true, now: at) == .wrongPassword)
        #expect(AuthModel.cause(for: AuthRefusal(error: .rateLimited, code: nil, retryAfter: nil),
                                method: .password, networkUp: true, now: at)
                == .rateLimited(until: at.addingTimeInterval(SignInNotice.defaultRetryAfter)))
        #expect(AuthModel.cause(for: PasskeyError.notOnAccount, method: .passkey, networkUp: true, now: at)
                == .passkeyNotOnAccount)
        guard case .passkeyFailed(let detail) = AuthModel.cause(for: PasskeyError.failed("ASAuthorizationError 1004"),
                                                                method: .passkey, networkUp: true, now: at)
        else { Issue.record("expected passkeyFailed"); return }
        #expect(detail?.contains("1004") == true)
    }

    @Test func retryAfterHeaders() {
        func response(_ headers: [String: String]) -> HTTPURLResponse {
            HTTPURLResponse(url: URL(string: "https://verder.example")!, statusCode: 429, httpVersion: nil, headerFields: headers)!
        }
        #expect(AuthRefusal.retryAfter(response(["X-Retry-After": "37"])) == 37)
        #expect(AuthRefusal.retryAfter(response(["Retry-After": "12"])) == 12)
        #expect(AuthRefusal.retryAfter(response(["Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"])) == nil)
        #expect(AuthRefusal.retryAfter(response([:])) == nil)
        #expect(AuthRefusal.code(in: Data(#"{"code":"PASSKEY_NOT_FOUND","message":"x"}"#.utf8)) == "PASSKEY_NOT_FOUND")
    }
}

@MainActor
struct SignInFlowTests {
    static func defaults() -> UserDefaults { UserDefaults(suiteName: "verder.tests.\(UUID().uuidString)")! }

    /// An attempt that never left the phone is sent ONCE more when the network
    /// returns — never a second time, and never for a toegangssleutel.
    @Test func offlinePasswordIsRetriedOnceWhenTheNetworkReturns() async {
        let server = StubServer()
        server.on { _ in .failure(.notConnectedToInternet) }
        let store = InMemorySessionStore()
        let model = AuthModel(client: server.client(store: store), store: store)
        model.networkIsUp = { false }
        await model.signInWithPassword(email: "a@b.example", password: "x")
        #expect(model.notice?.cause == .offline)
        #expect(model.networkReturned())
        #expect(!model.networkReturned(), "once")
    }

    @Test func offlinePasskeyIsNeverRetriedByItself() async {
        let server = StubServer()
        server.on { _ in .failure(.notConnectedToInternet) }
        let store = InMemorySessionStore()
        let client = server.client(store: store)
        let model = AuthModel(client: client, store: store,
                              passkeys: PasskeyAuth(client: client, store: store, authenticator: PasskeyAuthTests.FakeAuthenticator()),
                              defaults: Self.defaults())
        model.networkIsUp = { false }
        await model.signInWithPasskey()
        #expect(model.notice?.cause == .offline)
        #expect(!model.networkReturned())
    }

    /// better-auth's PASSKEY_NOT_FOUND: the screen offers only the password,
    /// and the password sign-in then offers a NEW toegangssleutel even though
    /// the account still holds others (the Mac's), and even after the
    /// once-per-install offer was spent.
    @Test func aRemovedPasskeyLeadsToANewOne() async {
        let server = StubServer()
        server.on { req in
            switch req.url?.path() {
            case PasskeyAuth.Endpoint.authenticateOptions?:
                .status(200, headers: ["Set-Cookie": PasskeyAuthTests.challengeSetCookie], body: PasskeyAuthTests.authOptions)
            case PasskeyAuth.Endpoint.verifyAuthentication?:
                .status(401, body: Data(#"{"code":"PASSKEY_NOT_FOUND","message":"Passkey not found"}"#.utf8))
            case PasskeyAuth.Endpoint.listPasskeys?:
                .status(200, body: Data(#"[{"id":"mac"}]"#.utf8))
            default:
                .status(200, headers: ["Set-Cookie": AuthModelTests.setCookie], body: Data("{}".utf8))
            }
        }
        let store = InMemorySessionStore()
        let client = server.client(store: store)
        let defaults = Self.defaults()
        defaults.set(true, forKey: "passkeyOfferShown")
        let model = AuthModel(client: client, store: store,
                              passkeys: PasskeyAuth(client: client, store: store, authenticator: PasskeyAuthTests.FakeAuthenticator()),
                              defaults: defaults)
        await model.signInWithPasskey()
        #expect(model.notice?.cause == .passkeyNotOnAccount)
        await model.signInWithPassword(email: "a@b.example", password: "x")
        #expect(model.isSignedIn)
        #expect(model.passkeyOffer == .offer)
    }

    @Test func aRejectedSessionIsStampedAndNamed() async {
        let store = InMemorySessionStore(SessionCookie(name: "better-auth.session_token", value: "live", expires: nil))
        let at = SignInNoticeTests.at
        let model = AuthModel(client: StubServer().client(store: store), store: store, defaults: Self.defaults(), now: { at })
        model.sessionRejected()
        #expect(model.sessionExpired)
        #expect(model.sessionExpiredAt == at)
        #expect(model.notice?.cause == .sessionExpired)
        // Moving to the password step keeps "Log opnieuw in" and its notice.
        model.clearNotice()
        #expect(model.notice?.cause == .sessionExpired)
    }
}

@MainActor
struct UnlockSheetTests {
    final class Answer: DeviceOwnerAuthenticator, @unchecked Sendable {
        var error: DeviceOwnerAuthError?
        init(_ error: DeviceOwnerAuthError?) { self.error = error }
        func authenticate(reason: String) async throws(DeviceOwnerAuthError) { if let error { throw error } }
    }

    /// A cancelled Face ID never leaves Martin at a dead end: the sheet with
    /// three ways on follows, and choosing one leaves the lock as it was.
    @Test func aCancelOffersEveryWayOn() async {
        let lock = AppLock(authenticator: Answer(.cancelled))
        await lock.unlock()
        #expect(lock.unlockSheet == .cancelled)
        #expect(lock.isLocked)
        lock.dismissUnlockSheet()
        #expect(lock.unlockSheet == nil)
        #expect(lock.isLocked)
    }

    @Test func noPasscodeSaysHowToFixIt() async {
        let lock = AppLock(authenticator: Answer(.unavailable))
        await lock.unlock()
        #expect(lock.unlockSheet == .noPasscode)
    }

    @Test func aFailureOrSuccessShowsNoSheet() async {
        let failed = AppLock(authenticator: Answer(.failed))
        await failed.unlock()
        #expect(failed.unlockSheet == nil)
        let ok = AppLock(authenticator: Answer(nil))
        await ok.unlock()
        #expect(ok.unlockSheet == nil && !ok.isLocked)
    }

    /// The lock names a waiting item's KIND and never anything of its content.
    @Test func aWaitingLinkIsNamedByKindOnly() {
        let id = UUID()
        #expect(LockedTarget(.proposal(id))?.waitingLine == "Een voorstel wacht na ontgrendelen")
        #expect(LockedTarget(.proposal(id))?.tab == .voorJou)
        #expect(LockedTarget(.document(id))?.tab == .dossier)
        #expect(LockedTarget(.inbox) == nil)
        #expect(LockedTarget(.scan) == nil)
    }
}

#if DEBUG
@Suite struct AuthFixtureLaunchTests {
    @Test func parsesTheAuthCaptureFlags() throws {
        let launch = try #require(try FixtureLaunch.parse(["-fixtures", "calm", "-fixtures-signin", "rate-limited",
                                                           "-fixtures-cover", "-fixtures-mic", "denied",
                                                           "-fixtures-push-preprompt"]))
        #expect(launch.signIn == .rateLimited)
        #expect(launch.cover && launch.pushPrePrompt)
        #expect(launch.mic == .denied)
        #expect(throws: FixtureLaunch.ParseError.unknownValue("-fixtures-signin", "nope")) {
            try FixtureLaunch.parse(["-fixtures", "calm", "-fixtures-signin", "nope"])
        }
    }

    /// capture.sh's --signin grammar, spelled the same.
    @Test func signInStatesMatchCaptureScript() {
        #expect(FixtureLaunch.SignInState.allCases.map(\.rawValue) ==
                ["default", "keyboard", "busy", "cancelled", "no-passkey", "wrong-password", "rate-limited",
                 "server", "not-on-account", "expired", "offline", "offer", "already-on"])
    }
}
#endif
