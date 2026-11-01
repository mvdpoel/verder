import Foundation

/// A screen on the Meer stack. Held as RootView's path (lock-gated tab), so a
/// link that lands on the lock screen opens once the app is unlocked: the
/// Weekoverzicht from the Sunday push (`DeepLink.weekly`), Geld from
/// `DeepLink.money`.
enum MoreRoute: Hashable, Sendable {
    case weekly
    case money
    case account
    case notifications
    case widgets
    case about
    case developer
}

/// Meer as a settings screen (plan 3 Task GAP; design brief "Meer +
/// settings"): what it lists, in which order, and what each row says.
/// Decided here so the view only draws it.
enum MoreMenu {
    enum Item: CaseIterable, Hashable, Sendable {
        case account, notifications, money, voice, weekly, widgets, about, developer
    }

    struct Section: Equatable, Sendable {
        let label: String
        let items: [Item]
    }

    /// Account and Meldingen first (who, and how verder reaches you), then
    /// the case's extras, then the app. Ontwikkelaar is last and one level
    /// down: "advanced a few taps away".
    static let sections: [Section] = [
        Section(label: "Jij", items: [.account, .notifications]),
        Section(label: "Dossier", items: [.money, .voice, .weekly]),
        Section(label: "App", items: [.widgets, .about, .developer]),
    ]

    static func title(_ item: Item) -> String {
        switch item {
        case .account: "Account"
        case .notifications: "Meldingen"
        case .money: "Geld"
        case .voice: "Gesprek vastleggen"
        case .weekly: WeeklyScreen.title
        case .widgets: "Widgets toevoegen"
        case .about: "Over verder"
        case .developer: "Ontwikkelaar"
        }
    }

    /// SF Symbol beside the row.
    static func symbol(_ item: Item) -> String {
        switch item {
        case .account: "person.crop.circle"
        case .notifications: "bell"
        case .money: "eurosign"
        case .voice: "mic"
        case .weekly: "calendar"
        case .widgets: "square.grid.2x2"
        case .about: "info.circle"
        case .developer: "wrench.and.screwdriver"
        }
    }

    /// The Meer screen a row opens; nil for voice, which is RootView's sheet
    /// (the home screen quick action opens the same one).
    static func route(_ item: Item) -> MoreRoute? {
        switch item {
        case .account: .account
        case .notifications: .notifications
        case .money: .money
        case .voice: nil
        case .weekly: .weekly
        case .widgets: .widgets
        case .about: .about
        case .developer: .developer
        }
    }

    /// The state under a row's title, where there is one to state.
    static func subtitle(_ item: Item, email: String?, permission: PushPermission?) -> String? {
        switch item {
        case .account: email
        case .notifications:
            switch permission {
            case .allowed?: "Aan"
            case .denied?: "Uit"
            case .notDetermined?: "Nog niet aangezet"
            case nil: nil
            }
        default: nil
        }
    }
}

/// Meer → Account.
enum AccountCopy {
    static let emailLabel = "Ingelogd als"
    static let passkeyLabel = "Passkey"
    static let devicesLink = "Apparaten op het web"
    static let devicesNote = "Daar zie je elke iPhone en browser die is ingelogd, en log je er een uit."
    static let signOutQuestion = "Uitloggen op deze iPhone?"
    static let signOutMessage = "Het dossier op deze iPhone wordt gewist. Daarna log je opnieuw in met Face ID of je wachtwoord."
    static let signOutConfirm = "Uitloggen"
    static let cancel = "Annuleren"
    static let unknownEmail = "Account wordt opgehaald…"

    /// The server's count (`/me`), never a guess: nil is "not known yet".
    static func passkeyLine(_ count: Int?) -> String {
        switch count {
        case nil: "Passkeys worden opgehaald…"
        case 0?: "Nog geen passkey. Je logt in met je wachtwoord."
        case 1?: "1 passkey op je account."
        case let n?: "\(n) passkeys op je account."
        }
    }

    /// "Passkey toevoegen" only when the account provably has none; an
    /// unknown count offers nothing (an offer is never worth an error).
    static func offersPasskey(_ count: Int?) -> Bool { count == 0 }

    /// /settings/security on the server the app talks to.
    static func devicesURL(base: URL) -> URL {
        base.appending(path: "settings/security")
    }
}

/// Meer → Meldingen: the permission state, what to do about it, and what
/// each kind of push verder sends means.
enum NotificationsCopy {
    enum Action: Equatable { case ask, openSettings }

    struct Kind: Equatable, Sendable {
        /// The category id (`NotificationCategories.ids`).
        let category: String
        let name: String
        let explanation: String
    }

    static let openSettings = "Open Instellingen"
    static let kindsLabel = "Wat verder je laat weten"
    static let quietNote = "Stille meldingen komen in je meldingencentrum zonder geluid of scherm aan."

    static func permissionLine(_ p: PushPermission?) -> String {
        switch p {
        case .allowed?: "Meldingen staan aan."
        case .denied?: "Meldingen staan uit. Zet ze aan in Instellingen om te horen wanneer Verder iets vraagt."
        case .notDetermined?: "Meldingen zijn nog niet aangezet."
        case nil: "Meldingen worden gecontroleerd…"
        }
    }

    static func action(_ p: PushPermission?) -> Action? {
        switch p {
        case .notDetermined?: .ask
        case .denied?: .openSettings
        case .allowed?, nil: nil
        }
    }

    /// One per category, in `NotificationCategories.ids` order. The levels
    /// stated are the ones the worker sets (apps/worker/src): Verder's mail
    /// is time-sensitive, filing and the Sunday summary are passive.
    static let kinds: [Kind] = [
        Kind(category: "VERDER_MAIL", name: "Mail van Verder",
             explanation: "Elke mail of brief van je bewindvoerder. Komt ook door een focus heen."),
        Kind(category: "CREDITOR_MAIL", name: "Mail van een schuldeiser",
             explanation: "Een schuldeiser of deurwaarder heeft je geschreven."),
        Kind(category: "PROPOSAL", name: "Voorstel",
             explanation: "verder heeft een antwoord of een vraag voor je klaargezet. Er gaat niets weg zonder jouw akkoord."),
        Kind(category: "REMINDER", name: "Herinnering",
             explanation: "Een voorstel wacht al een tijd op je."),
        Kind(category: "FOLLOW_UP", name: "Navragen",
             explanation: "Iemand heeft nog niet geantwoord; verder stelt voor om na te vragen."),
        Kind(category: "TASK_DUE", name: "Deadline",
             explanation: "De deadline van een taak komt eraan."),
        Kind(category: "FILING", name: "Opgeborgen",
             explanation: "Wat verder zelf deed: een samengevoegde scan, een nieuwe loonstrook, het overzicht van Door verder gedaan. Stil."),
        Kind(category: "SYSTEM", name: "Systeem",
             explanation: "Als er in verder iets hapert, of als het zichzelf heeft hersteld."),
        Kind(category: "WEEKLY", name: "Weekoverzicht",
             explanation: "Zondag om 18:00: wat er die week gebeurde. Stil."),
    ]
}

/// Meer → Widgets toevoegen: an in-app guide (the brief's "Structured").
enum WidgetGuide {
    struct Size: Equatable, Sendable {
        let name: String
        let shows: String
    }

    static let homeLabel = "Op je beginscherm"
    static let lockLabel = "Op je toegangsscherm"
    static let sizesLabel = "Formaten"

    static let homeSteps = [
        "Houd je vinger op een lege plek van je beginscherm tot de apps bewegen.",
        "Tik op Wijzig en kies Voeg widget toe.",
        "Zoek verder en kies een formaat.",
        "Tik op Voeg widget toe en zet hem waar je wilt.",
    ]

    static let lockSteps = [
        "Houd je vinger op je toegangsscherm en tik op Pas aan.",
        "Kies Toegangsscherm en tik op het vak onder de klok.",
        "Kies verder.",
    ]

    static let sizes = [
        Size(name: "Klein", shows: "Hoeveel er op je wacht."),
        Size(name: "Middel", shows: "Hoeveel er wacht, en de bovenste twee."),
        Size(name: "Groot", shows: "De bovenste vijf, en waar het nu op wacht."),
        Size(name: "Toegangsscherm", shows: "Hoeveel er wacht, en hoe oud het oudste is."),
    ]

    static let privacy = "Op je toegangsscherm toont verder alleen aantallen, nooit titels."
}

/// Meer → Over verder: version, build and the server this build talks to.
struct AboutInfo: Equatable {
    struct Line: Equatable, Hashable, Sendable {
        let label: String
        let value: String
    }

    let lines: [Line]

    init(info: [String: Any], server: URL) {
        let version = info["CFBundleShortVersionString"] as? String
        let build = info["CFBundleVersion"] as? String
        let versionText = switch (version, build) {
        case let (v?, b?): "\(v) (\(b))"
        case let (v?, nil): v
        default: "onbekend"
        }
        lines = [
            Line(label: "Versie", value: versionText),
            Line(label: "Server", value: server.host() ?? server.absoluteString),
        ]
    }

    static let note = "verder is gemaakt voor één dossier: het jouwe. Alles wat de app laat zien, komt van je eigen server."
}
