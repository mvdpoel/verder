import Testing
import Foundation
import WidgetKit
@testable import Grip

/// Meer is a settings screen (Figma "meer · final"): the account card, Snel
/// naar (Geld, Gesprek vastleggen, Weekoverzicht), Instellingen (Meldingen,
/// Widgets toevoegen), Over (Over verder, with Ontwikkelaar one level down).
/// Every word is decided here, outside the views.
@MainActor
struct MoreMenuTests {
    static let today = Date(timeIntervalSince1970: 1_793_522_460) // Sun 1 nov 2026 09:41 Amsterdam
    static let me = AccountDTO(email: "jij@thuis.example", name: nil, passkeys: 1,
                               sessionExpiresAt: Date(timeIntervalSince1970: 1_796_115_600), // 1 dec 09:00 CET
                               devices: 3)

    static func state(_ edit: (inout MoreMenu.State) -> Void = { _ in }) -> MoreMenu.State {
        var s = MoreMenu.State()
        s.account = me
        s.permission = .allowed
        s.kinds = .init(on: 8, of: 9)
        s.version = "1.0"
        s.build = "31"
        s.weekly = .loaded(week: 44, sent: 3, filed: 5)
        s.geld = MeerGeld(phrases: ["leefgeld ··3210", "deze week"], value: "€ 37,60", caption: "over",
                          spoken: "leefgeldrekening eindigend op 3210, € 37,60 over deze week")
        s.now = today
        edit(&s)
        return s
    }

    @Test func theMenuIsInTheFramesOrder() {
        #expect(MoreMenu.sections.map(\.label) == [nil, "Snel naar", "Instellingen", "Over"])
        #expect(MoreMenu.sections.flatMap(\.items) == [.account, .money, .voice, .weekly, .notifications, .widgets, .about])
    }

    /// Every row goes somewhere: a screen on the Meer stack, or (voice) the
    /// sheet RootView holds. Ontwikkelaar is reached from Over verder.
    @Test func everyRowLeadsSomewhere() {
        for item in MoreMenu.Item.allCases {
            if item == .voice { #expect(MoreMenu.route(item) == nil) } else { #expect(MoreMenu.route(item) != nil, "\(item)") }
        }
        #expect(Set(MoreMenu.Item.allCases.compactMap(MoreMenu.route)).count == MoreMenu.Item.allCases.count - 1)
    }

    /// The developer tools live one level further down, never on Meer itself.
    @Test func developerIsOneLevelDown() {
        #expect(!MoreMenu.sections.flatMap(\.items).contains(.developer))
        #expect(MoreMenu.route(.developer) == .developer)
    }

    @Test func theRowsSayTheFramesWords() {
        let rows = MoreMenu.rows(Self.state())
        #expect(rows[.account]?.title == "jij@thuis.example")
        #expect(rows[.account]?.lines == [.mono("ingelogd tot 1\u{00A0}dec")], "the day and its month never part")
        #expect(rows[.account]?.accessibilityLabel == "Account, jij@thuis.example, ingelogd tot 1 december")
        #expect(rows[.money]?.value == "€ 37,60")
        #expect(rows[.money]?.valueCaption == "over")
        #expect(rows[.voice]?.lines == [.phrases(["inspreken", "komt in Voor jou"])])
        #expect(rows[.voice]?.chevron == false)
        #expect(rows[.weekly]?.lines == [.phrases(["week 44", "3 verstuurd", "5 opgeborgen"])])
        #expect(rows[.notifications]?.lines == [.phrases(["8 van 9 soorten"])])
        #expect(rows[.notifications]?.value == "aan")
        #expect(rows[.widgets]?.lines == [.phrases(["beginscherm en toegangsscherm"])])
        #expect(MoreMenu.rows(Self.state(), ax: true)[.widgets]?.lines == [.phrases(["begin- en toegangs\u{00AD}scherm"])])
        #expect(rows[.about]?.lines == [.phrases(["versie 1.0", "build 31"])])
    }

    @Test func loadingDrawsBarsNeverWords() {
        let rows = MoreMenu.rows(Self.state {
            $0.account = nil; $0.geld = nil; $0.weekly = .loading; $0.kinds = nil
        })
        #expect(rows[.account]?.title == nil)
        for item in [MoreMenu.Item.account, .money, .weekly, .notifications, .about] {
            guard case .skeleton? = rows[item]?.lines.first else { Issue.record("\(item) is not a bar"); continue }
        }
        // What the phone knows itself stays words.
        #expect(rows[.voice]?.lines == [.phrases(["inspreken", "komt in Voor jou"])])
        #expect(rows[.notifications]?.value == "aan")
    }

    @Test func offlineSaysHowOldTheStandIs() {
        let stand = Date(timeIntervalSince1970: 1_793_538_120) // 1 nov 14:02 Amsterdam
        let rows = MoreMenu.rows(Self.state { $0.offline = true; $0.stand = stand; $0.now = stand.addingTimeInterval(600) })
        #expect(rows[.account]?.lines.last == .offline("offline · bijgewerkt 14:02"))
        #expect(rows[.about]?.lines == [.phrases(["versie 1.0", "server offline"])])
    }

    @Test func deniedNotificationsSayWhereToTurnThemOn() {
        let row = MoreMenu.row(.notifications, Self.state { $0.permission = .denied })
        #expect(row.symbol == "bell.slash")
        #expect(row.value == "uit")
        #expect(row.lines == [.phrases(["uit in iOS"]), .phrases(["zet ze aan via Instellingen"])])
    }

    // MARK: - Geld row

    static func figure(left: Int, partial: Bool = false) -> LeefgeldWeek {
        .figure(.init(partial: partial, accountIban: "NL00TEST9876543210", accountReason: .configured,
                      week: .init(from: "2026-10-26", to: "2026-11-01"), coveredThrough: "2026-10-29",
                      budgetCents: 10_000, spentCents: 10_000 - left, leftCents: left, spentRows: [],
                      depositCents: 10_000, depositRows: []))
    }

    /// Figma "Geld-rij varianten": complete · partial · geen data · leeg ·
    /// overspent (ink, never amber).
    @Test func theGeldRowHasOneWordingPerState() {
        let complete = MeerGeld.make(Self.figure(left: 3_760), newestBooking: "2026-10-31", accounts: 2)
        #expect(complete.phrases == ["leefgeld ··3210", "deze week"])
        #expect(complete.value == "€ 37,60")
        #expect(complete.caption == "over")
        #expect(complete.spoken.contains("eindigend op 3210"))
        let partial = MeerGeld.make(Self.figure(left: 5_210, partial: true), newestBooking: nil, accounts: 2)
        #expect(partial.phrases == ["t/m do 29 okt", "deze week"])
        let geen = MeerGeld.make(.geenData(accountIban: "NL00TEST9876543210", accountReason: .configured,
                                           week: .init(from: "2026-10-26", to: "2026-11-01"),
                                           newestBooking: "2026-10-18"), newestBooking: "2026-10-18", accounts: 2)
        #expect(geen.phrases == ["geen data", "laatste afschrift t/m 18 okt"])
        #expect(geen.value == nil)
        let leeg = MeerGeld.make(.noAccount(candidates: []), newestBooking: nil, accounts: 0)
        #expect(leeg.phrases == ["nog geen afschriften"])
        let over = MeerGeld.make(Self.figure(left: -1_240), newestBooking: nil, accounts: 2)
        #expect(over.phrases == ["meer dan het weekbedrag"])
        #expect(over.value == "−€ 12,40")
        #expect(over.caption == nil)
    }

    // MARK: - Account

    @Test func theToegangssleutelIsTheServersCount() {
        #expect(AccountCopy.passkeyState(1, failed: false) == .on)
        #expect(AccountCopy.passkeyState(0, failed: false) == .off)
        #expect(AccountCopy.passkeyState(nil, failed: true) == .unknown)
        #expect(AccountCopy.passkeyState(nil, failed: false) == .loading)
        #expect(AccountCopy.passkeyLines(.on) == ["inloggen met Face ID", "andere apparaten via de website"])
        #expect(AccountCopy.passkeyLines(.off) == ["niet ingesteld", "inloggen met wachtwoord"])
        // AX5 (Figma "Account / AX5 · midden"): the website line goes; the
        // Apparaten card right below is that website.
        #expect(AccountCopy.passkeyLines(.on, compact: true) == ["inloggen met Face ID"])
        #expect(AccountCopy.passkeyBadge(.on) == "aan")
        #expect(AccountCopy.passkeyBadge(.off) == "uit")
        #expect(AccountCopy.passkeyBadge(.unknown) == nil, "an unknown count shows no state")
        #expect(AccountCopy.offersPasskey(.off))
        #expect(!AccountCopy.offersPasskey(.on))
        #expect(!AccountCopy.offersPasskey(.unknown), "an unknown count offers nothing")
    }

    /// "Toegangs-" / "sleutel" at AX5: a word with a soft hyphen breaks there
    /// and nowhere else (word joiners bind its other letters); words without
    /// one are untouched.
    @Test func aCompoundBreaksOnlyAtItsSoftHyphen() {
        let out = MoreText.onlyAtSoftHyphens(AccountCopy.addPasskey)
        #expect(out.replacingOccurrences(of: "\u{2060}", with: "") == AccountCopy.addPasskey)
        #expect(out.hasSuffix(" toevoegen"), "a word without a soft hyphen is left alone")
        let word = out.split(separator: " ")[0]
        #expect(word.components(separatedBy: "\u{00AD}").count == 2)
        #expect(!word.contains("\u{2060}\u{00AD}") && !word.contains("\u{00AD}\u{2060}"),
                "nothing binds the soft hyphen itself")
        #expect(MoreText.hyphenate(AccountCopy.passkeyTitle) == MoreText.onlyAtSoftHyphens(AccountCopy.passkeyTitle))
    }

    /// The UI never says the English "passkey" (design brief).
    @Test func noScreenSaysPasskey() {
        var words = [AccountCopy.passkeyLabel, AccountCopy.passkeyTitle, AccountCopy.addPasskey,
                     AccountCopy.addPasskeyLine(offline: false)]
        words += [.on, .off, .unknown, .loading].flatMap { AccountCopy.passkeyLines($0) }
        words += [AuthModel.Copy.passkeyAdded, AuthModel.Copy.passkeyAddFailed,
                  AuthModel.Copy.passkeyAlreadyOnDevice, AuthModel.Copy.passkeyNeedsFreshSignIn]
        words += SignInNoticeTests.everyNotice.flatMap { [$0.title, $0.body, $0.label] + [$0.caption(now: $0.at)].compactMap { $0 } }
        words += [SignInView.Copy.passkey, SignInView.Copy.retryPasskey, SignInView.Copy.cancelled,
                  PasskeyOfferView.Copy.title, PasskeyOfferView.Copy.body, PasskeyOfferView.Copy.add,
                  PasskeyOfferView.Copy.worksTitle, PasskeyOfferView.Copy.worksBody, PasskeyOfferView.Copy.later]
        for word in words { #expect(!word.lowercased().contains("passkey"), "\(word)") }
    }

    @Test func accountLinesSayTheSessionAndTheDevices() {
        // NBSP binds "1 dec" and "deze iPhone", and keeps the dot at a line's end.
        #expect(AccountCopy.sessionLine(Self.me.sessionExpiresAt) == "sessie tot 1\u{00A0}dec\u{00A0}· deze\u{00A0}iPhone")
        #expect(AccountCopy.sessionLine(nil) == "deze\u{00A0}iPhone")
        #expect(AccountCopy.devicesLine(3, offline: false) == "3 ingelogd\u{00A0}· beheer op de website")
        #expect(AccountCopy.devicesLine(nil, offline: false) == "beheer op de website")
        #expect(AccountCopy.devicesLine(3, offline: true) == "3 ingelogd\u{00A0}· kan weer als je online bent")
        #expect(AccountCopy.addPasskeyLine(offline: true) == "kan weer als je online bent")
        let at = Date(timeIntervalSince1970: 1_793_538_120)
        #expect(AccountCopy.failureCause(.transport("x"), at: at, now: at) == "verder was niet bereikbaar · 14:02")
    }

    @Test func devicesLiveOnTheWeb() {
        let url = AccountCopy.devicesURL(base: URL(string: "https://grip.example")!)
        #expect(url.absoluteString == "https://grip.example/settings/security")
        #expect(AccountCopy.devicesURL(base: APIClient.production).absoluteString
                == "https://grip.vanderpoel.pro/settings/security")
    }

    /// Signing out asks first, and says what it costs — in that moment's words.
    @Test func theSignOutSheetSaysWhatItCosts() {
        let plain = SignOutSheet.make(offline: false, queued: 0, stand: nil)
        #expect(plain.title == "Uitloggen op deze iPhone?")
        #expect(plain.leads.isEmpty)
        #expect(plain.body.contains("Je dossier zelf blijft bewaard."))
        #expect(plain.uploadFirst == nil)
        #expect(plain.confirm == "Uitloggen")

        let queue = SignOutSheet.make(offline: false, queued: 2, stand: nil)
        #expect(queue.leads.map(\.text) == ["Er staan nog 2 scans in de wachtrij."])
        #expect(queue.body == "Ze worden verstuurd zodra je weer inlogt. Upload ze eerst, dan weet je zeker dat ze in je dossier staan.")
        #expect(queue.uploadFirst == "Eerst uploaden")
        #expect(queue.confirm == "Toch uitloggen")
        #expect(SignOutSheet.make(offline: false, queued: 1, stand: nil).leads.first?.text
                == "Er staat nog 1 scan in de wachtrij.")

        let off = SignOutSheet.make(offline: true, queued: 0, stand: "14:02")
        #expect(off.leads.map(\.text) == ["Deze iPhone is offline · bijgewerkt 14:02"])
        #expect(off.uploadFirst == nil, "nothing uploads offline")
        #expect(off.body.contains("zodra deze iPhone weer online is"))

        let both = SignOutSheet.make(offline: true, queued: 2, stand: "14:02")
        #expect(both.leads.map(\.text) == ["Deze iPhone is offline.", "Er staan nog 2 scans in de wachtrij."])
        #expect(both.body == "Deze iPhone wist zijn kopie van je dossier. De 2 scans worden verstuurd zodra je weer inlogt. Je sessie wordt ingetrokken zodra deze iPhone weer online is; tot dan kunnen er nog meldingen binnenkomen.")
        #expect(both.uploadFirst == nil)
    }

    // MARK: - Meldingen

    @Test func everyKindTheWorkerSendsIsExplained() {
        #expect(Set(NotificationsCopy.kinds.map(\.category)) == Set(NotificationCategories.ids))
        #expect(NotificationsCopy.kinds.count == NotificationCategories.ids.count)
        for kind in NotificationsCopy.kinds {
            #expect(!kind.name.isEmpty && !(kind.explanation.isEmpty && kind.detail == nil), "\(kind.category)")
            #expect(["tijdgevoelig", "gewoon", "stil"].contains(kind.level), "\(kind.category)")
        }
        #expect(NotificationsCopy.groups.map(\.label) == ["Post", "Wat op je wacht", "Wat verder deed"])
    }

    /// Figma "Meldingen / normaal": the level and its short fact on line 1,
    /// the sentence on a line of its own — never joined by " · ".
    @Test func aKindsSentenceHasItsOwnLine() throws {
        func kind(_ c: String) throws -> NotificationsCopy.Kind {
            try #require(NotificationsCopy.kinds.first { $0.category == c })
        }
        #expect(NotificationsCopy.lines(try kind("PROPOSAL"), denied: false)
                == [.kind(level: "gewoon", ["een voorstel staat klaar"]), .phrases(["er gaat niets weg zonder jou"])])
        #expect(NotificationsCopy.lines(try kind("REMINDER"), denied: false)
                == [.kind(level: "gewoon", []), .phrases(["een voorstel wacht al een tijd op je"])])
        #expect(NotificationsCopy.lines(try kind("WEEKLY"), denied: false)
                == [.kind(level: "stil", ["zondag 18:00"]), .phrases(["wat er die week gebeurde"])])
        #expect(NotificationsCopy.lines(try kind("CREDITOR_MAIL"), denied: false)
                == [.kind(level: "gewoon", ["een schuldeiser of deurwaarder stuurde je iets"])])
        #expect(NotificationsCopy.lines(try kind("VERDER_MAIL"), denied: true)
                == [.kind(level: "tijdgevoelig", [NotificationsCopy.verderMailWhileDenied])])
        #expect(NotificationsCopy.spoken(try kind("PROPOSAL"), denied: false)
                == "Voorstel, gewoon, een voorstel staat klaar, er gaat niets weg zonder jou")
    }

    /// The frames' glyphs: an outline calendar and person, a sun for Systeem.
    @Test func theGlyphsAreTheFrames() throws {
        #expect(MoreMenu.symbol(.weekly) == MoreGlyphName.calendar)
        #expect(MoreMenu.symbol(.account) == MoreGlyphName.personCircle)
        #expect(try #require(NotificationsCopy.kinds.first { $0.category == "SYSTEM" }).symbol == "sun.max")
        #expect(try #require(NotificationsCopy.kinds.first { $0.category == "WEEKLY" }).symbol == MoreGlyphName.calendar)
    }

    /// The levels the copy names are the ones the worker sets
    /// (apps/worker/src: priority-notify.ts, clocks.ts, the digests).
    @Test func theLevelsAreTheWorkers() throws {
        func level(_ c: String) throws -> String { try #require(NotificationsCopy.kinds.first { $0.category == c }).level }
        #expect(try level("VERDER_MAIL") == "tijdgevoelig")
        #expect(try level("CREDITOR_MAIL") == "gewoon")
        #expect(try level("TASK_DUE") == "tijdgevoelig")
        #expect(try level("FILING") == "stil")
        #expect(try level("WEEKLY") == "stil")
    }

    /// DELIBERATELY NOT THE FRAME: "meer · final" draws Termijn as "gewoon"
    /// and its two footnotes without these sentences, but the worker sends
    /// task-due time-sensitive (clocks.ts, `kind: "task-due"`), reminders and
    /// follow-ups about Verder's mail time-sensitive (clocks.ts LEVEL), and a
    /// failed send as a time-sensitive Systeem alert (proposals/send.ts). The
    /// copy follows what arrives; the design is to be brought to it.
    @Test func theFootnotesSayWhatIsTimeSensitive() {
        let foot = NotificationsCopy.groups.map(\.footnote)
        #expect(foot[1].contains("08:00 en 22:00") && foot[1].contains("post van je bewindvoerder, dan zijn ze tijdgevoelig"))
        #expect(foot[2].contains("meldt Systeem dat tijdgevoelig"))
    }

    /// Breaking through a focus is NOT measured (CLAUDE.md, iPhone push): the
    /// copy says iOS decides it per focus, no more.
    @Test func verderMailClaimsNoFocusBreakthrough() throws {
        let post = try #require(NotificationsCopy.groups.first)
        #expect(post.footnote.contains("per focus"))
        #expect(!post.footnote.contains("Komt ook door"))
        #expect(NotificationsCopy.always == ["VERDER_MAIL"])
    }

    @Test func permissionStatesSayWhatToDo() {
        #expect(NotificationsCopy.permissionLine(.allowed) == "Meldingen staan aan.")
        #expect(NotificationsCopy.permissionLine(.denied) == "Meldingen staan uit.")
        #expect(NotificationsCopy.permissionDetail(.denied)?.contains("Instellingen") == true)
        #expect(NotificationsCopy.permissionDetail(.allowed) == nil)
        #expect(NotificationsCopy.permissionLine(nil) == "Meldingen worden gecontroleerd…")
        #expect(NotificationsCopy.action(.denied) == .openSettings)
        #expect(NotificationsCopy.action(.notDetermined) == .ask)
        #expect(NotificationsCopy.action(.allowed) == nil)
        #expect(NotificationsCopy.countLine(8, of: 9) == "8 van 9 soorten aan")
        #expect(NotificationsCopy.saveFailed(offline: false) == "Niet opgeslagen · verder niet bereikbaar.")
    }

    // MARK: - Widgets, Over verder, Ontwikkelaar

    @Test func theWidgetGuideNamesEveryPlaceAWidgetGoes() {
        #expect(WidgetGuide.homeSteps.count == 3)
        #expect(WidgetGuide.lockSteps.count == 3)
        // The lock screen shows counts only: the guide says so rather than
        // letting Martin find out by putting one there.
        #expect(WidgetGuide.privacy.contains("nooit titels"))
        #expect(WidgetGuideScreen.step("Tik op **Wijzig**.").runs.count == 3)
    }

    /// The illustration draws what the widgets really draw: the small one
    /// and the lock-screen rectangle both show the age of the oldest, and the
    /// two previews state the same age.
    @Test func theWidgetPreviewIsTrue() {
        #expect(WidgetContent.showsOldest(.systemSmall))
        #expect(WidgetContent.showsOldest(.accessoryRectangular))
        #expect(!WidgetContent.showsOldest(.systemMedium))
        let now = Date(timeIntervalSince1970: 1_793_530_800)
        #expect(WidgetGuide.sampleOldest
                == WidgetContent.oldest(since: now.addingTimeInterval(-Double(WidgetGuide.sampleDays) * 86_400), now: now))
        #expect(WidgetGuide.sampleOldest == "oudste 2 dagen")
        #expect(WidgetGuide.sampleLock == "4 wachten · oudste 2 d")
    }

    /// Adding a toegangssleutel and the web's device list need verder: offline
    /// both are drawn unavailable and cannot be tapped.
    @Test func onlineOnlyAccountActionsAreUnavailableOffline() {
        #expect(AccountCopy.onlineOnlyAvailable(offline: false))
        #expect(!AccountCopy.onlineOnlyAvailable(offline: true))
    }

    @Test func aboutReadsTheBundleAndTheServer() {
        let about = AboutInfo(info: ["CFBundleShortVersionString": "0.1", "CFBundleVersion": "7"],
                              server: URL(string: "https://grip.vanderpoel.pro")!)
        #expect(about.lines.map(\.value) == ["0.1 (7)", "grip.vanderpoel.pro"])
        #expect(about.version == "0.1" && about.build == "7")
        // A hostname that must wrap breaks after a dot, never at its hyphen.
        #expect(AboutInfo.breakableHost("voorjou-few.fixtures.grip.invalid")
                == "voorjou-\u{2060}few.\u{200B}fixtures.\u{200B}grip.\u{200B}invalid")
        let bare = AboutInfo(info: [:], server: URL(string: "https://x.example")!)
        #expect(bare.lines.first?.value == "onbekend")
        #expect(AboutInfo.connection(offline: true, accountLoaded: true, lastError: nil) == .offline)
        #expect(AboutInfo.connection(offline: false, accountLoaded: true, lastError: nil) == .reachable)
        #expect(AboutInfo.connection(offline: false, accountLoaded: true, lastError: .server(503)) == .unreachable)
        #expect(AboutInfo.badge(.reachable) == "bereikbaar")
    }

    @Test func developerReadoutsAreShortAndSecretFree() {
        #expect(DeveloperCopy.token(tail: "a41f", at: Date(timeIntervalSince1970: 1_793_440_000)) == "…a41f · 31 okt")
        #expect(DeveloperCopy.token(tail: nil, at: nil) == "nog niet aangemeld")
        let at = Date(timeIntervalSince1970: 1_793_538_120)
        #expect(DeveloperCopy.answer(.init(duplicate: true, at: at), failure: nil, now: at)
                == "duplicate: true · 14:02 · geen nieuw document")
        #expect(DeveloperCopy.answer(nil, failure: nil, now: at) == "nog niet getest")
    }

    /// Nothing in Meer promises something that is not there.
    @Test func noWordInMeerIsAPromise() {
        var words = MoreMenu.Item.allCases.map(MoreMenu.title)
        words += NotificationsCopy.kinds.flatMap { [$0.name] + $0.explanation + [$0.detail].compactMap { $0 } }
        words += NotificationsCopy.groups.map(\.footnote)
        words += WidgetGuide.homeSteps + WidgetGuide.lockSteps + [WidgetGuide.privacy]
        for word in words { #expect(!word.lowercased().contains("binnenkort"), "\(word)") }
    }
}

/// `GET` / `POST /api/mobile/v1/push/preferences`.
@MainActor
struct NotificationPrefsModelTests {
    @Test func readsWhatThisIPhoneDoesNotWant() async {
        let server = StubServer()
        server.on { _ in .status(200, body: Data(#"{"muted":["FILING"]}"#.utf8)) }
        let model = NotificationPrefsModel(client: server.client())
        await model.refresh()
        #expect(model.availability == .available)
        #expect(!model.isOn("FILING"))
        #expect(model.isOn("PROPOSAL"))
        #expect(model.count?.on == 8 && model.count?.of == 9)
    }

    /// Post van je bewindvoerder is always on, whatever the server says.
    @Test func verderMailCannotBeMuted() async {
        let server = StubServer()
        server.on { _ in .status(200, body: Data(#"{"muted":["VERDER_MAIL"]}"#.utf8)) }
        let model = NotificationPrefsModel(client: server.client())
        await model.refresh()
        #expect(model.isOn("VERDER_MAIL"))
        await model.set("VERDER_MAIL", on: false)
        #expect(server.requests.filter { $0.httpMethod == "POST" }.isEmpty)
    }

    /// A server older than the phone: every kind is sent, no switches.
    @Test func aServerWithoutTheRouteSendsEverything() async {
        let server = StubServer()
        server.on { _ in .status(404) }
        let model = NotificationPrefsModel(client: server.client())
        await model.refresh()
        #expect(model.availability == .unsupported)
        #expect(model.count?.on == 9)
        await model.set("FILING", on: false)
        #expect(server.requests.filter { $0.httpMethod == "POST" }.isEmpty)
    }

    @Test func aSwitchSendsTheWholeList() async throws {
        let server = StubServer()
        server.on { req in
            req.httpMethod == "POST" ? .status(200, body: Data("{}".utf8))
                                     : .status(200, body: Data(#"{"muted":["FILING"]}"#.utf8))
        }
        let model = NotificationPrefsModel(client: server.client())
        await model.refresh()
        await model.set("WEEKLY", on: false)
        let post = try #require(server.requests.last { $0.httpMethod == "POST" })
        let body = try JSONDecoder().decode(PushPreferencesDTO.self, from: try #require(post.httpBody))
        #expect(body.muted == ["FILING", "WEEKLY"])
        #expect(!model.isOn("WEEKLY"))
        #expect(model.failed == nil)
    }

    /// A failed save keeps the switch where Martin put it and says so; it
    /// never snaps back silently, and a retry sends it again.
    @Test func aFailedSaveIsSaidAndRetried() async {
        let server = StubServer()
        let posts = WeeklyDTOTests.Calls()
        server.on { req in
            if req.httpMethod == "POST" { return posts.count() == 0 ? .status(503) : .status(200, body: Data("{}".utf8)) }
            return .status(200, body: Data(#"{"muted":["CREDITOR_MAIL"]}"#.utf8))
        }
        let model = NotificationPrefsModel(client: server.client())
        await model.refresh()
        await model.set("CREDITOR_MAIL", on: true)
        #expect(model.failed == "CREDITOR_MAIL")
        #expect(model.saveFailures == 1)
        #expect(model.isOn("CREDITOR_MAIL"))
        await model.retry()
        #expect(model.failed == nil)
        #expect(model.muted.isEmpty)
    }

    @Test func theFixturesAnswerThePreferences() throws {
        let dto = try FixtureTests.decode(PushPreferencesDTO.self, "voorjou-few", "push/preferences")
        #expect(dto.muted == ["FILING"])
    }
}

/// An offline sign-out is revoked once verder answers again (Meer's offline
/// sheet promises it).
@MainActor
struct PendingSignOutTests {
    static let cookie = SessionCookie(name: SessionCookie.names[0], value: "old-session", expires: nil)

    @Test func anOfflineSignOutIsRevokedLater() async {
        let server = StubServer()
        let online = WeeklyDTOTests.Calls()
        server.on { _ in online.count() == 0 ? .failure(.notConnectedToInternet) : .status(200) }
        let store = InMemorySessionStore(Self.cookie)
        let pending = InMemorySessionStore()
        let auth = AuthModel(client: server.client(store: store), store: store, pendingSignOut: pending)
        await auth.signOut()
        #expect(!auth.isSignedIn)
        #expect(auth.signOutPending)
        #expect(pending.load() == Self.cookie)
        await auth.retryPendingSignOut()
        #expect(!auth.signOutPending)
        #expect(pending.load() == nil)
        let last = server.requests.last
        #expect(last?.url?.path() == "/api/auth/sign-out")
        #expect(last?.value(forHTTPHeaderField: "Cookie") == "\(Self.cookie.name)=old-session")
    }

    @Test func stillOfflineKeepsWaiting() async {
        let server = StubServer()
        server.on { _ in .failure(.notConnectedToInternet) }
        let store = InMemorySessionStore(Self.cookie)
        let pending = InMemorySessionStore()
        let auth = AuthModel(client: server.client(store: store), store: store, pendingSignOut: pending)
        await auth.signOut()
        await auth.retryPendingSignOut()
        #expect(auth.signOutPending)
        #expect(pending.load() == Self.cookie)
    }

    /// Any HTTP answer ends the wait: the server revoked it, or never knew it.
    @Test func anOnlineSignOutLeavesNothingWaiting() async {
        let server = StubServer()
        server.on { _ in .status(500) }
        let store = InMemorySessionStore(Self.cookie)
        let pending = InMemorySessionStore()
        let auth = AuthModel(client: server.client(store: store), store: store, pendingSignOut: pending)
        await auth.signOut()
        #expect(!auth.signOutPending)
        #expect(pending.load() == nil)
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

    /// Nothing cached and /me fails: the screen says why and offers a retry,
    /// never a forever "wordt opgehaald…". The retry reads again.
    @Test func aFailureWithNothingCachedSaysSoAndRetries() async {
        let server = StubServer()
        let calls = WeeklyDTOTests.Calls()
        server.on { _ in calls.count() == 0 ? .failure(.notConnectedToInternet) : .status(200, body: Self.me) }
        let model = AccountModel(client: server.client())
        #expect(model.display == .loading)
        await model.refresh()
        guard case .unavailable(let why) = model.display else {
            Issue.record("still \(model.display)"); return
        }
        #expect(!why.isEmpty)
        #expect(!why.contains("opgehaald"))
        #expect(AccountCopy.retry == "Opnieuw proberen")
        await model.refresh()
        #expect(model.display == .shown(AccountDTO(email: "martin@example.test", name: "Martin", passkeys: 1)))
    }

    /// A failed refresh over a cached account keeps showing it.
    @Test func aFailureOverACachedAccountKeepsIt() async {
        let server = StubServer()
        let calls = WeeklyDTOTests.Calls()
        server.on { _ in calls.count() == 0 ? .status(200, body: Self.me) : .failure(.notConnectedToInternet) }
        let model = AccountModel(client: server.client())
        await model.refresh()
        await model.refresh()
        #expect(model.display == .shown(AccountDTO(email: "martin@example.test", name: "Martin", passkeys: 1)))
    }

    @Test func theFixtureAnswersTheAccount() throws {
        let dto = try FixtureTests.decode(AccountDTO.self, "voorjou-few", "me")
        #expect(dto.email.hasSuffix(".example"))
    }
}
