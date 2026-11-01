import Testing
import Foundation
@testable import Verder

/// Meer is a settings screen (plan 3 Task GAP): Account, Meldingen, Geld,
/// Gesprek vastleggen, Weekoverzicht, Widgets toevoegen, Over verder and,
/// one level down, Ontwikkelaar. Every word is decided here, outside the
/// views, so the screens can be aligned to the Figma frames without
/// touching what they say.
@MainActor
struct MoreMenuTests {
    @Test func theMenuIsInTheBriefsOrder() {
        #expect(MoreMenu.sections.flatMap(\.items) == [
            .account, .notifications, .money, .voice, .weekly, .widgets, .about, .developer,
        ])
        #expect(MoreMenu.sections.flatMap(\.items).map(MoreMenu.title) == [
            "Account", "Meldingen", "Geld", "Gesprek vastleggen", "Weekoverzicht",
            "Widgets toevoegen", "Over verder", "Ontwikkelaar",
        ])
    }

    /// Every row goes somewhere: a screen on the Meer stack, or (voice) the
    /// sheet RootView holds.
    @Test func everyRowLeadsSomewhere() {
        for item in MoreMenu.Item.allCases {
            if item == .voice { #expect(MoreMenu.route(item) == nil) } else { #expect(MoreMenu.route(item) != nil, "\(item)") }
        }
        #expect(MoreMenu.route(.weekly) == .weekly)
        #expect(MoreMenu.route(.money) == .money)
        #expect(MoreMenu.route(.developer) == .developer)
        #expect(Set(MoreMenu.Item.allCases.compactMap(MoreMenu.route)).count == MoreMenu.Item.allCases.count - 1)
    }

    /// The developer tools live ONE level down, last, never at the top.
    @Test func developerIsLastAndOneLevelDown() {
        #expect(MoreMenu.sections.last?.items.last == .developer)
        #expect(MoreMenu.route(.developer) == .developer)
    }

    @Test func rowSubtitlesSayTheState() {
        #expect(MoreMenu.subtitle(.account, email: "m@example.test", permission: nil) == "m@example.test")
        #expect(MoreMenu.subtitle(.account, email: nil, permission: nil) == nil)
        #expect(MoreMenu.subtitle(.notifications, email: nil, permission: .allowed) == "Aan")
        #expect(MoreMenu.subtitle(.notifications, email: nil, permission: .denied) == "Uit")
        #expect(MoreMenu.subtitle(.notifications, email: nil, permission: .notDetermined) == "Nog niet aangezet")
        #expect(MoreMenu.subtitle(.notifications, email: nil, permission: nil) == nil)
        #expect(MoreMenu.subtitle(.weekly, email: "x", permission: .allowed) == nil)
    }

    // MARK: - Account

    @Test func passkeyStatusIsTheServersCount() {
        #expect(AccountCopy.passkeyLine(nil) == "Passkeys worden opgehaald…")
        #expect(AccountCopy.passkeyLine(0) == "Nog geen passkey. Je logt in met je wachtwoord.")
        #expect(AccountCopy.passkeyLine(1) == "1 passkey op je account.")
        #expect(AccountCopy.passkeyLine(3) == "3 passkeys op je account.")
        #expect(AccountCopy.offersPasskey(nil) == false, "an unknown count offers nothing")
        #expect(AccountCopy.offersPasskey(0))
        #expect(!AccountCopy.offersPasskey(1))
    }

    @Test func devicesLiveOnTheWeb() {
        let url = AccountCopy.devicesURL(base: URL(string: "https://verder.example")!)
        #expect(url.absoluteString == "https://verder.example/settings/security")
        #expect(AccountCopy.devicesURL(base: APIClient.production).absoluteString
                == "https://verder.vanderpoel.pro/settings/security")
    }

    /// Signing out asks first, and says what it costs.
    @Test func signingOutIsConfirmed() {
        #expect(AccountCopy.signOutQuestion == "Uitloggen op deze iPhone?")
        #expect(AccountCopy.signOutMessage.contains("dossier"))
        #expect(AccountCopy.signOutConfirm == "Uitloggen")
    }

    // MARK: - Meldingen

    @Test func everyKindTheWorkerSendsIsExplained() {
        #expect(NotificationsCopy.kinds.map(\.category) == NotificationCategories.ids)
        for kind in NotificationsCopy.kinds {
            #expect(!kind.name.isEmpty && !kind.explanation.isEmpty, "\(kind.category)")
        }
    }

    @Test func permissionStatesSayWhatToDo() {
        #expect(NotificationsCopy.permissionLine(.allowed) == "Meldingen staan aan.")
        #expect(NotificationsCopy.permissionLine(.denied).contains("Instellingen"))
        #expect(NotificationsCopy.permissionLine(.notDetermined) == "Meldingen zijn nog niet aangezet.")
        #expect(NotificationsCopy.permissionLine(nil) == "Meldingen worden gecontroleerd…")
        #expect(NotificationsCopy.action(.denied) == .openSettings)
        #expect(NotificationsCopy.action(.notDetermined) == .ask)
        #expect(NotificationsCopy.action(.allowed) == nil)
        #expect(NotificationsCopy.action(nil) == nil)
        #expect(NotificationsCopy.openSettings == "Open Instellingen")
    }

    // MARK: - Widgets, Over verder

    @Test func theWidgetGuideNamesEveryPlaceAWidgetGoes() {
        #expect(WidgetGuide.homeSteps.count >= 3)
        #expect(WidgetGuide.lockSteps.count >= 2)
        #expect(WidgetGuide.sizes.map(\.name) == ["Klein", "Middel", "Groot", "Toegangsscherm"])
        // The lock screen shows counts only: the guide says so rather than
        // letting Martin find out by putting one there.
        #expect(WidgetGuide.privacy.contains("nooit"))
    }

    @Test func aboutReadsTheBundleAndTheServer() {
        let about = AboutInfo(info: ["CFBundleShortVersionString": "0.1", "CFBundleVersion": "7"],
                              server: URL(string: "https://verder.vanderpoel.pro")!)
        #expect(about.lines == [
            .init(label: "Versie", value: "0.1 (7)"),
            .init(label: "Server", value: "verder.vanderpoel.pro"),
        ])
        let bare = AboutInfo(info: [:], server: URL(string: "https://x.example")!)
        #expect(bare.lines.first?.value == "onbekend")
    }

    /// Nothing in Meer promises something that is not there.
    @Test func noWordInMeerIsAPromise() {
        var words = MoreMenu.Item.allCases.map(MoreMenu.title)
        words += NotificationsCopy.kinds.flatMap { [$0.name, $0.explanation] }
        words += WidgetGuide.homeSteps + WidgetGuide.lockSteps + [WidgetGuide.privacy]
        words += WidgetGuide.sizes.flatMap { [$0.name, $0.shows] }
        for word in words { #expect(!word.lowercased().contains("binnenkort"), "\(word)") }
    }
}

/// `GET /api/mobile/v1/me` (apps/web/src/lib/mobile-account.ts).
@MainActor
struct AccountModelTests {
    nonisolated static let me = Data(#"{"email":"martin@example.test","name":"Martin","passkeys":1}"#.utf8)

    @Test func readsTheAccount() async {
        let server = StubServer()
        server.on { req in req.url?.path() == AccountModel.path ? .status(200, body: Self.me) : .status(404) }
        let model = AccountModel(client: server.client())
        await model.refresh()
        #expect(model.state == .loaded(AccountDTO(email: "martin@example.test", name: "Martin", passkeys: 1)))
        #expect(model.email == "martin@example.test")
        #expect(model.passkeys == 1)
    }

    @Test func refusesAnAnswerWithoutAnEmail() async {
        let server = StubServer()
        server.on { _ in .status(200, body: Data(#"{"name":"x","passkeys":1}"#.utf8)) }
        let model = AccountModel(client: server.client())
        await model.refresh()
        guard case .failed = model.state else { Issue.record("decoded a default"); return }
        #expect(model.passkeys == nil)
    }

    @Test func unauthorizedEndsTheSession() async {
        let server = StubServer()
        server.on { _ in .status(401) }
        var ended = 0
        let model = AccountModel(client: server.client(), onUnauthorized: { ended += 1 })
        await model.refresh()
        #expect(ended == 1)
        #expect(model.state == .failed(.unauthorized))
    }

    @Test func aFailedRefreshKeepsWhatIsShown() async {
        let server = StubServer()
        let calls = WeeklyDTOTests.Calls()
        server.on { _ in calls.count() == 0 ? .status(200, body: Self.me) : .failure(.notConnectedToInternet) }
        let model = AccountModel(client: server.client())
        await model.refresh()
        await model.refresh()
        #expect(model.email == "martin@example.test")
    }

    @Test func theFixtureAnswersTheAccount() throws {
        let dto = try FixtureTests.decode(AccountDTO.self, "voorjou-few", "me")
        #expect(dto.email.hasSuffix(".example"))
    }
}
