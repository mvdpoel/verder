import Testing
import Foundation
import Synchronization
@testable import Verder

/// Answers for the system permission sheet.
final class FakePermission: NotificationPermission, @unchecked Sendable {
    private let state: Mutex<(status: PushPermission, grant: Bool, requests: Int)>

    init(_ status: PushPermission, grant: Bool = true) {
        state = Mutex((status, grant, 0))
    }

    var requests: Int { state.withLock { $0.requests } }

    func status() async -> PushPermission { state.withLock { $0.status } }

    func request() async -> Bool {
        state.withLock {
            $0.requests += 1
            $0.status = $0.grant ? .allowed : .denied
            return $0.grant
        }
    }
}

@MainActor
struct PushRegistrarTests {
    static let cookie = SessionCookie(name: "__Secure-better-auth.session_token", value: "tok.sig", expires: nil)
    static let token = Data([0x00, 0x0A, 0xFF, 0x7b] + Array(repeating: 0xAB, count: 28))

    final class Box { var registerCalls = 0 }

    struct Rig {
        let server: StubServer
        let store: InMemorySessionStore
        let auth: AuthModel
        let permission: FakePermission
        let box: Box
        let registrar: PushRegistrar
    }

    func rig(_ status: PushPermission = .notDetermined, grant: Bool = true,
             reply: @escaping StubProtocol.Handler = { _ in .status(200, body: Data(#"{"id":"d1"}"#.utf8)) }) -> Rig {
        let server = StubServer()
        server.on(reply)
        let store = InMemorySessionStore(Self.cookie)
        let client = server.client(store: store)
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let auth = AuthModel(client: client, store: store, defaults: defaults)
        let permission = FakePermission(status, grant: grant)
        let box = Box()
        let registrar = PushRegistrar(client: client, auth: auth, permission: permission,
                                      environment: "development", appVersion: "0.1 (1)", defaults: defaults,
                                      registerRemote: { box.registerCalls += 1 })
        return Rig(server: server, store: store, auth: auth, permission: permission, box: box, registrar: registrar)
    }

    @Test func hexTokenIsLowercaseNoSpaces() {
        let hex = hexToken(Self.token)
        #expect(hex.hasPrefix("000aff7b"))
        #expect(hex.count == 64)
        #expect(hex == hex.lowercased())
        #expect(!hex.contains(" ") && !hex.contains("<") && !hex.contains(">"))
        #expect(hex.wholeMatch(of: /[0-9a-f]{64}/) != nil)
    }

    /// The body the server's zod schema takes — and NO sessionId: the route
    /// takes the session from the validated cookie.
    @Test func registrationBodyShape() async throws {
        let r = rig()
        await r.registrar.didRegister(deviceToken: Self.token)

        #expect(r.server.requests.count == 1)
        let req = try #require(r.server.requests.first)
        #expect(req.httpMethod == "POST")
        #expect(req.url?.path() == "/api/mobile/v1/push/register")
        #expect(req.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(req.value(forHTTPHeaderField: "Cookie") == "__Secure-better-auth.session_token=tok.sig")
        let body = try #require(try JSONSerialization.jsonObject(with: req.httpBody ?? Data()) as? [String: Any])
        #expect(Set(body.keys) == ["token", "environment", "bundleId", "appVersion"])
        #expect(body["token"] as? String == hexToken(Self.token))
        #expect(body["environment"] as? String == "development")
        #expect(body["bundleId"] as? String == "pro.vanderpoel.verder")
        #expect(body["appVersion"] as? String == "0.1 (1)")

        #expect(r.registrar.registeredEnvironment == "development")
        #expect(r.registrar.lastError == nil)
    }

    @Test("401OnRegisterSignsOut") func unauthorizedOnRegisterSignsOut() async {
        let r = rig(reply: { _ in .status(401) })
        #expect(r.auth.isSignedIn)
        await r.registrar.didRegister(deviceToken: Self.token)
        #expect(!r.auth.isSignedIn)
        #expect(r.store.load() == nil)
        #expect(r.registrar.registeredEnvironment == nil)
        // Signing out on a dead session asks the server nothing more.
        #expect(r.server.requests.count == 1)
    }

    @Test func serverErrorKeepsTheSession() async {
        let r = rig(reply: { _ in .status(500) })
        await r.registrar.didRegister(deviceToken: Self.token)
        #expect(r.auth.isSignedIn)
        #expect(r.registrar.registeredEnvironment == nil)
        #expect(r.registrar.lastError != nil)
    }

    @Test func noSessionSendsNothing() async {
        let r = rig()
        await r.auth.signOut()
        let before = r.server.requests.count
        await r.registrar.didRegister(deviceToken: Self.token)
        #expect(r.server.requests.count == before)
    }

    /// Step 3: the Dutch pre-prompt first, ONCE; the system sheet only on yes.
    @Test func undecidedShowsThePrePromptOnce() async {
        let r = rig(.notDetermined)
        await r.registrar.requestPermissionIfNeeded()
        #expect(r.registrar.prePromptPending)
        #expect(r.permission.requests == 0)
        #expect(r.box.registerCalls == 0)

        r.registrar.declinePrePrompt()
        #expect(!r.registrar.prePromptPending)
        await r.registrar.requestPermissionIfNeeded()
        #expect(!r.registrar.prePromptPending)
        #expect(r.permission.requests == 0)
    }

    @Test func acceptingAsksTheSystemAndRegisters() async {
        let r = rig(.notDetermined, grant: true)
        await r.registrar.requestPermissionIfNeeded()
        await r.registrar.acceptPrePrompt()
        #expect(!r.registrar.prePromptPending)
        #expect(r.permission.requests == 1)
        #expect(r.registrar.permission == .allowed)
        #expect(r.box.registerCalls == 1)
    }

    @Test func refusingTheSystemSheetRegistersNothing() async {
        let r = rig(.notDetermined, grant: false)
        await r.registrar.requestPermissionIfNeeded()
        await r.registrar.acceptPrePrompt()
        #expect(r.registrar.permission == .denied)
        #expect(r.box.registerCalls == 0)
    }

    @Test func alreadyAllowedRegistersWithoutAsking() async {
        let r = rig(.allowed)
        await r.registrar.requestPermissionIfNeeded()
        #expect(!r.registrar.prePromptPending)
        #expect(r.permission.requests == 0)
        #expect(r.box.registerCalls == 1)
    }

    @Test func deniedNeverPrompts() async {
        let r = rig(.denied)
        await r.registrar.requestPermissionIfNeeded()
        #expect(!r.registrar.prePromptPending)
        #expect(r.box.registerCalls == 0)
    }

    /// Step 3: every launch with a session re-registers (tokens change), and
    /// never prompts — the cold launch belongs to the camera.
    @Test func launchRegistersWhenAllowedAndNeverPrompts() async {
        let allowed = rig(.allowed)
        await allowed.registrar.registerIfAllowed()
        #expect(allowed.box.registerCalls == 1)

        let undecided = rig(.notDetermined)
        await undecided.registrar.registerIfAllowed()
        #expect(undecided.box.registerCalls == 0)
        #expect(!undecided.registrar.prePromptPending)
        #expect(undecided.registrar.permission == .notDetermined)
    }

    @Test func signedOutNeverPromptsOrRegisters() async {
        let r = rig(.allowed)
        await r.auth.signOut()
        await r.registrar.requestPermissionIfNeeded()
        await r.registrar.registerIfAllowed()
        #expect(r.box.registerCalls == 0)
        #expect(!r.registrar.prePromptPending)
    }
}
