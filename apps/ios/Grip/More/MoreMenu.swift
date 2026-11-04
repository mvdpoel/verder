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

/// Meer as a settings screen (design brief "Meer + settings"; Figma "meer ·
/// final"): what it lists, in which order, and what each row says. Decided
/// here so the view only draws it.
enum MoreMenu {
    enum Item: CaseIterable, Hashable, Sendable {
        case account, money, voice, weekly, notifications, widgets, about, developer
    }

    struct Section: Equatable, Sendable {
        /// Nil for the account card at the top, which needs no label.
        let label: String?
        let items: [Item]
    }

    /// Who you are first, then the case's shortcuts, the settings, and the
    /// app. Ontwikkelaar is one level further down, inside Over verder
    /// (Halide: "advanced a few taps away").
    static let sections: [Section] = [
        Section(label: nil, items: [.account]),
        Section(label: "Snel naar", items: [.money, .voice, .weekly]),
        Section(label: "Instellingen", items: [.notifications, .widgets]),
        Section(label: "Over", items: [.about]),
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

    /// SF Symbol beside the row, or one of `MoreGlyphName`'s outline glyphs
    /// where SF has none (the frames' outline calendar and person).
    static func symbol(_ item: Item) -> String {
        switch item {
        case .account: MoreGlyphName.personCircle
        case .notifications: "bell"
        case .money: "eurosign.circle"
        case .voice: "mic"
        case .weekly: MoreGlyphName.calendar
        case .widgets: "square.grid.2x2"
        case .about: "info.circle"
        case .developer: "wrench.adjustable"
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

    // MARK: - The rows' state

    /// One line under a row's title.
    enum Line: Equatable, Sendable {
        /// Phrases of one line, joined by " · "; where they do not fit beside
        /// the trailing value they break AT a phrase, never inside one.
        case phrases([String])
        /// A push's level, set apart in a brighter ink, then its phrases.
        case kind(level: String, [String])
        /// A measured readout in mono: "ingelogd tot 1 dec".
        case mono(String)
        /// The offline readout, with its glyph: "offline · bijgewerkt 14:02".
        case offline(String)
        /// Not known yet: a bar where the line will be, this wide (0…1).
        case skeleton(Double)
    }

    struct Row: Equatable, Sendable {
        let item: Item
        /// Nil while not known: a skeleton bar instead.
        let title: String?
        let symbol: String
        let lines: [Line]
        /// "€ 37,60", "aan": mono, at the trailing edge.
        let value: String?
        /// Under the value: "over".
        let valueCaption: String?
        let chevron: Bool
        let accessibilityLabel: String
    }

    /// Everything Meer's rows are read from, so the words are tested
    /// without a view.
    struct State: Equatable, Sendable {
        var account: AccountDTO?
        /// /me failed with nothing cached.
        var accountFailed = false
        /// The phone has no network (`UploadCenter.isOffline`).
        var offline = false
        /// When the account shown was fetched.
        var stand: Date?
        /// Nil while the money summary has not answered.
        var geld: MeerGeld?
        var weekly: WeeklyLine = .loading
        var permission: PushPermission?
        var kinds: Kinds?
        var version: String?
        var build: String?
        var now = Date()

        struct Kinds: Equatable, Sendable { let on: Int; let of: Int }

        enum WeeklyLine: Equatable, Sendable {
            case loading
            case notYet
            case failed
            case loaded(week: Int?, sent: Int, filed: Int)
        }
    }

    static func rows(_ s: State, ax: Bool = false) -> [Item: Row] {
        var out: [Item: Row] = [:]
        for item in Item.allCases { out[item] = row(item, s, ax: ax) }
        return out
    }

    static func row(_ item: Item, _ s: State, ax: Bool = false) -> Row {
        let title = title(item)
        let symbol = symbol(item)
        let chevron = route(item) != nil
        func make(_ lines: [Line], title: String? = title, symbol: String = symbol, value: String? = nil,
                  caption: String? = nil, spoken: [String]) -> Row {
            Row(item: item, title: title, symbol: symbol, lines: lines, value: value, valueCaption: caption,
                chevron: chevron, accessibilityLabel: spoken.joined(separator: ", "))
        }
        switch item {
        case .account:
            let offline = s.offline ? [Line.offline(offlineStamp(s.stand, now: s.now))] : []
            if let a = s.account {
                let until = a.sessionExpiresAt.map {
                    "ingelogd tot \(MoneyFormat.day($0).replacingOccurrences(of: " ", with: "\u{00A0}"))"
                }
                return make(until.map { [Line.mono($0)] }.map { $0 + offline } ?? offline, title: a.email,
                            spoken: ["Account", a.email] + [a.sessionExpiresAt.map { "ingelogd tot \(spokenDay($0))" }]
                                .compactMap { $0 } + (s.offline ? [offlineStamp(s.stand, now: s.now)] : []))
            }
            if s.accountFailed {
                return make([.phrases(["niet opgehaald"])] + offline, spoken: ["Account", "niet opgehaald"])
            }
            return make([.skeleton(0.5)], title: nil, spoken: ["Account wordt geladen"])
        case .money:
            guard let g = s.geld else { return make([.skeleton(0.55)], spoken: ["Geld wordt geladen"]) }
            return make([.phrases(g.phrases)], value: g.value, caption: g.caption,
                        spoken: ["Geld", g.spoken])
        case .voice:
            let p = ["inspreken", "komt in Voor jou"]
            return make([.phrases(p)], spoken: [title] + p)
        case .weekly:
            switch s.weekly {
            case .loading: return make([.skeleton(0.65)], spoken: ["Weekoverzicht wordt geladen"])
            case .notYet:
                let p = ["het eerste komt zondag 18:00"]
                return make([.phrases(p)], spoken: [title] + p)
            case .failed:
                let p = ["niet opgehaald"]
                return make([.phrases(p)], spoken: [title] + p)
            case .loaded(let week, let sent, let filed):
                let p = [week.map { "week \($0)" }, "\(sent) verstuurd", "\(filed) opgeborgen"].compactMap { $0 }
                return make([.phrases(p)], spoken: [title] + p)
            }
        case .notifications:
            switch s.permission {
            case .allowed?:
                guard let k = s.kinds else { return make([.skeleton(0.4)], value: "aan", spoken: [title, "aan"]) }
                let p = "\(k.on) van \(k.of) soorten"
                return make([.phrases([p])], value: "aan", spoken: [title, "aan", p])
            case .denied?:
                return make([.phrases(["uit in iOS"]), .phrases(["zet ze aan via Instellingen"])],
                            symbol: "bell.slash", value: "uit",
                            spoken: [title, "uit in iOS", "zet ze aan via Instellingen"])
            case .notDetermined?:
                return make([.phrases(["nog niet aangezet"])], symbol: "bell.slash", value: "uit",
                            spoken: [title, "nog niet aangezet"])
            case nil:
                return make([.skeleton(0.4)], spoken: [title])
            }
        case .widgets:
            let p = ax ? "begin- en toegangs\u{00AD}scherm" : "beginscherm en toegangsscherm"
            return make([.phrases([p])], spoken: [title, "beginscherm en toegangsscherm"])
        case .about:
            let version = s.version.map { "versie \($0)" }
            if s.offline {
                let p = [version, "server offline"].compactMap { $0 }
                return make([.phrases(p)], spoken: [title] + p)
            }
            if s.account == nil && !s.accountFailed {
                return make([.skeleton(0.4)], spoken: [title])
            }
            let p = [version, s.build.map { "build \($0)" }].compactMap { $0 }
            return make([.phrases(p)], spoken: [title] + p)
        case .developer:
            let p = ["meldingen-omgeving en uploadtest"]
            return make([.phrases(p)], spoken: [title] + p)
        }
    }

    /// "offline · bijgewerkt 14:02" — the age of what is shown.
    static func offlineStamp(_ stand: Date?, now: Date) -> String {
        stand.map { "offline · bijgewerkt \(HomeSummary.stamp($0, now: now))" } ?? "offline"
    }

    /// "1 december" for VoiceOver, where "1 dec" would be read as letters.
    static func spokenDay(_ date: Date) -> String {
        let full = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september",
                    "oktober", "november", "december"]
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
        let c = cal.dateComponents([.day, .month], from: date)
        return "\(c.day ?? 0) \(full[(c.month ?? 1) - 1])"
    }

    /// "week 44" from the route's ISO week key "2026-W44".
    static func weekNumber(_ key: String) -> Int? {
        guard let w = key.split(separator: "W").last, let n = Int(w), (1...53).contains(n) else { return nil }
        return n
    }

    static func weekly(_ dto: WeeklyDTO) -> State.WeeklyLine {
        .loaded(week: weekNumber(dto.week), sent: dto.sent, filed: dto.filedByMartin + dto.filedByGrip)
    }
}

/// Meer's Geld row, from the money summary's leefgeld week (Figma "Geld-rij
/// varianten"). The amount and "over" sit at the trailing edge; the phrases
/// say which account and which week. An overspent week is ink, never amber.
struct MeerGeld: Equatable, Sendable {
    let phrases: [String]
    let value: String?
    let caption: String?
    let spoken: String

    static func make(_ week: LeefgeldWeek, newestBooking: String?, accounts: Int) -> MeerGeld {
        switch week {
        case .figure(let f):
            let tail = MoneyFormat.ibanDots(f.accountIban)
            let spokenTail = "leefgeldrekening eindigend op \(f.accountIban.suffix(4))"
            if f.leftCents < 0 {
                let amount = "−" + MoneyFormat.euro(cents: -f.leftCents)
                return MeerGeld(phrases: ["meer dan het weekbedrag"], value: amount, caption: nil,
                                spoken: "\(spokenTail), \(MoneyFormat.euro(cents: -f.leftCents)) meer uitgegeven dan het weekbedrag")
            }
            let amount = MoneyFormat.euro(cents: f.leftCents)
            let through = f.partial ? MoneyFormat.dayWithWeekday(f.coveredThrough).map { "t/m \($0)" } : nil
            return MeerGeld(phrases: [through ?? "leefgeld \(tail)", "deze week"], value: amount, caption: "over",
                            spoken: "\(spokenTail), \(amount) over deze week" + (through.map { ", \($0)" } ?? ""))
        case .geenData(_, _, _, let newest):
            let last = newest.flatMap(MoneyFormat.day).map { "laatste afschrift t/m \($0)" }
            let p = ["geen data", last].compactMap { $0 }
            return MeerGeld(phrases: p, value: nil, caption: nil, spoken: p.joined(separator: ", "))
        case .noAccount:
            let p = newestBooking == nil ? "nog geen afschriften" : "leefgeldrekening niet herkend"
            return MeerGeld(phrases: [p], value: nil, caption: nil, spoken: p)
        case .noBudget:
            let p = accounts == 1 ? "1 rekening" : "\(accounts) rekeningen"
            return MeerGeld(phrases: [p], value: nil, caption: nil, spoken: p)
        }
    }
}

// MARK: - Account

/// Meer → Account.
enum AccountCopy {
    static let emailLabel = "Ingelogd als"
    static let failedLabel = "Account"
    static let failedTitle = "Account niet opgehaald."
    static let passkeyLabel = "Toegangssleutel"
    /// The soft hyphen is where AX5 breaks it: "Toegangs-" / "sleutel".
    static let passkeyTitle = "Toegangs\u{00AD}sleutel"
    /// Soft-hyphened like `passkeyTitle`: as a title it breaks "Toegangs-".
    static let addPasskey = "Toegangs\u{00AD}sleutel toevoegen"
    static let devicesLabel = "Apparaten"
    static let devicesLink = "Apparaten op het web"
    static let signOutQuestion = "Uitloggen op deze iPhone?"
    static let signOutConfirm = "Uitloggen"
    static let signOutAnyway = "Toch uitloggen"
    static let uploadFirst = "Eerst uploaden"
    static let cancel = "Annuleren"
    static let retry = "Opnieuw proberen"
    static let laterOnline = "kan weer als je online bent"

    static let signOutNote = "Deze iPhone logt uit, wist zijn kopie van je dossier en krijgt geen meldingen meer. Je dossier zelf blijft bewaard."
    static let signOutNoteOffline = "Uitloggen werkt ook offline. Je sessie wordt ingetrokken zodra deze iPhone weer online is."

    /// "sessie tot 1 dec · deze iPhone". The day and its month never part,
    /// and the dot stays at a line's end (AX5: "sessie tot" / "1 dec ·" /
    /// "deze iPhone").
    static func sessionLine(_ until: Date?) -> String {
        let nb = { (s: String) in s.replacingOccurrences(of: " ", with: "\u{00A0}") }
        return [until.map { "sessie tot \(nb(MoneyFormat.day($0)))" }, nb("deze iPhone")].compactMap { $0 }
            .joined(separator: "\u{00A0}· ")
    }

    /// Why /me has no answer, with the minute it was asked.
    static func failureCause(_ error: APIError?, at: Date?, now: Date) -> String {
        // 502–504 is the tunnel answering for a verder that is down.
        let why = switch error {
        case .transport?, .server(502)?, .server(503)?, .server(504)?: "verder was niet bereikbaar"
        case .server?: "verder gaf een fout"
        case .rateLimited?: "te veel pogingen"
        default: "verder gaf geen antwoord"
        }
        return [why, at.map { HomeSummary.stamp($0, now: now) }].compactMap { $0 }.joined(separator: " · ")
    }

    enum PasskeyState: Equatable, Sendable { case on, off, unknown, loading }

    static func passkeyState(_ count: Int?, failed: Bool) -> PasskeyState {
        switch count {
        case let n? where n > 0: .on
        case .some: .off
        case nil: failed ? .unknown : .loading
        }
    }

    /// The lines under "Toegangssleutel". `compact` (the accessibility
    /// sizes, Figma "Account / AX5 · midden") keeps only the first: the
    /// website is the Apparaten card right below, and at AX5 the second line
    /// alone is three lines tall. VoiceOver always hears both.
    static func passkeyLines(_ state: PasskeyState, compact: Bool = false) -> [String] {
        switch state {
        case .on: compact ? ["inloggen met Face ID"] : ["inloggen met Face ID", "andere apparaten via de website"]
        case .off: ["niet ingesteld", "inloggen met wachtwoord"]
        case .unknown: ["onbekend tot je account is opgehaald"]
        case .loading: ["wordt opgehaald…"]
        }
    }

    /// The badge beside it: "AAN" (okay) or "UIT" (muted); nothing unknown.
    static func passkeyBadge(_ state: PasskeyState) -> String? {
        switch state {
        case .on: "aan"
        case .off: "uit"
        case .unknown, .loading: nil
        }
    }

    /// "Toegangssleutel toevoegen" only while the account has none (Figma
    /// "Account / geen toegangssleutel"): one that synced through iCloud
    /// already signs this iPhone in, and one on another device is added on
    /// the website, as the row's own line says.
    static func offersPasskey(_ state: PasskeyState) -> Bool { state == .off }

    /// Adding a toegangssleutel and the web's device list both need verder:
    /// offline they are drawn unavailable (muted title, glyph and arrow) and
    /// cannot be tapped, while their line says when they come back.
    static func onlineOnlyAvailable(offline: Bool) -> Bool { !offline }

    static func addPasskeyLine(offline: Bool) -> String {
        offline ? laterOnline : "inloggen met Face ID in plaats van je wachtwoord"
    }

    /// "3 ingelogd · beheer op de website". The dot is bound to the word
    /// before it, so a wrapped line ends on it and never starts with it (the
    /// one rule for a " · " run, `PhraseFlow`).
    static func devicesLine(_ devices: Int?, offline: Bool) -> String {
        [devices.map { "\($0) ingelogd" }, offline ? laterOnline : "beheer op de website"]
            .compactMap { $0 }.joined(separator: "\u{00A0}· ")
    }

    /// /settings/security on the server the app talks to.
    static func devicesURL(base: URL) -> URL {
        base.appending(path: "settings/security")
    }
}

/// The confirm sheet behind Uitloggen (Figma "Account / uitloggen ·
/// bevestigen", "· scans in wachtrij", "· offline", "· offline met
/// wachtrij"). What it costs, in that moment's words.
struct SignOutSheet: Equatable, Sendable {
    struct Lead: Equatable, Sendable {
        let symbol: String
        let text: String
    }

    let title: String
    let leads: [Lead]
    let body: String
    /// "Eerst uploaden": only online with scans waiting.
    let uploadFirst: String?
    let confirm: String

    static func make(offline: Bool, queued: Int, stand: String?) -> SignOutSheet {
        let scans = queued == 1 ? "Er staat nog 1 scan in de wachtrij." : "Er staan nog \(queued) scans in de wachtrij."
        let queue = Lead(symbol: "doc.text", text: scans)
        switch (offline, queued > 0) {
        case (false, false):
            return SignOutSheet(
                title: AccountCopy.signOutQuestion, leads: [],
                body: "Deze iPhone wist zijn kopie van je dossier en krijgt geen meldingen meer. Je dossier zelf blijft bewaard. Daarna log je weer in met Face ID of je wachtwoord.",
                uploadFirst: nil, confirm: AccountCopy.signOutConfirm)
        case (false, true):
            let they = queued == 1 ? "Hij wordt" : "Ze worden"
            let them = queued == 1 ? "hem" : "ze"
            let sits = queued == 1 ? "hij in je dossier staat" : "ze in je dossier staan"
            return SignOutSheet(
                title: AccountCopy.signOutQuestion, leads: [queue],
                body: "\(they) verstuurd zodra je weer inlogt. Upload \(them) eerst, dan weet je zeker dat \(sits).",
                uploadFirst: AccountCopy.uploadFirst, confirm: AccountCopy.signOutAnyway)
        case (true, false):
            let line = ["Deze iPhone is offline", stand.map { "bijgewerkt \($0)" }].compactMap { $0 }
                .joined(separator: " · ")
            return SignOutSheet(
                title: AccountCopy.signOutQuestion, leads: [Lead(symbol: "wifi.slash", text: line)],
                body: "Hij logt nu uit en wist zijn kopie. verder trekt je sessie in zodra deze iPhone weer online is; tot dan kunnen er nog meldingen binnenkomen.",
                uploadFirst: nil, confirm: AccountCopy.signOutAnyway)
        case (true, true):
            let these = queued == 1 ? "De scan wordt" : "De \(queued) scans worden"
            return SignOutSheet(
                title: AccountCopy.signOutQuestion,
                leads: [Lead(symbol: "wifi.slash", text: "Deze iPhone is offline."), queue],
                body: "Deze iPhone wist zijn kopie van je dossier. \(these) verstuurd zodra je weer inlogt. Je sessie wordt ingetrokken zodra deze iPhone weer online is; tot dan kunnen er nog meldingen binnenkomen.",
                uploadFirst: nil, confirm: AccountCopy.signOutAnyway)
        }
    }
}

// MARK: - Meldingen

/// Meer → Meldingen: the permission, and per kind of push what it means, how
/// loud it is, and whether THIS iPhone hears it.
enum NotificationsCopy {
    enum Action: Equatable { case ask, openSettings }

    struct Kind: Equatable, Sendable {
        /// The category id (`NotificationCategories.ids`).
        let category: String
        let name: String
        let symbol: String
        /// How loud the worker sends it (apps/worker/src): "tijdgevoelig",
        /// "gewoon", "stil".
        let level: String
        /// Short facts, run on after the level on its first line
        /// ("gewoon · een voorstel staat klaar"). May be empty: the level
        /// then stands alone ("gewoon").
        let explanation: [String]
        /// The explanatory sentence, on a line of its own under the level
        /// (Figma "Meldingen / normaal": "er gaat niets weg zonder jou").
        var detail: String? = nil
    }

    struct Group: Equatable, Sendable {
        let label: String
        let kinds: [Kind]
        let footnote: String
    }

    static let headerLabel = "Op deze iPhone"
    static let openSettings = "Open Instellingen"
    static let always = ["VERDER_MAIL"]
    static let alwaysWord = "altijd"
    static let notSaved = "Niet opgeslagen"
    static let offlineHint = "wijzigen kan weer zodra je online bent"
    /// VERDER_MAIL's line while iOS holds every push back.
    static let verderMailWhileDenied = "komt weer zodra meldingen aanstaan"

    static func permissionLine(_ p: PushPermission?) -> String {
        switch p {
        case .allowed?: "Meldingen staan aan."
        case .denied?: "Meldingen staan uit."
        case .notDetermined?: "Meldingen staan nog niet aan."
        case nil: "Meldingen worden gecontroleerd…"
        }
    }

    /// The sentence under a permission that keeps pushes away.
    static func permissionDetail(_ p: PushPermission?) -> String? {
        switch p {
        case .denied?: "verder kan je nu niets laten weten. Zet ze aan in Instellingen; je keuzes hieronder gelden weer zodra ze aanstaan."
        case .notDetermined?: "Zet ze aan om te horen wanneer Verder iets vraagt; je keuzes hieronder gelden zodra ze aanstaan."
        case .allowed?, nil: nil
        }
    }

    static func countLine(_ on: Int, of: Int) -> String { "\(on) van \(of) soorten aan" }

    static func action(_ p: PushPermission?) -> Action? {
        switch p {
        case .notDetermined?: .ask
        case .denied?: .openSettings
        case .allowed?, nil: nil
        }
    }

    /// "Niet opgeslagen · verder niet bereikbaar."
    static func saveFailed(offline: Bool) -> String {
        offline ? "\(notSaved) · je bent offline." : "\(notSaved) · verder niet bereikbaar."
    }

    /// The levels are the ones the worker sets. Verder's mail is
    /// time-sensitive; whether that breaks through a focus is iOS's call per
    /// focus and was never measured, so the copy promises no breakthrough.
    /// Proposals, reminders and follow-ups are as loud as the mail they are
    /// about (`clocks.ts` LEVEL, `proposals-store.ts`): "gewoon" for most,
    /// time-sensitive for Verder's — the group's footnote says so.
    static let groups: [Group] = [
        Group(label: "Post", kinds: [
            Kind(category: "VERDER_MAIL", name: "Post van je bewind\u{00AD}voerder", symbol: "envelope",
                 level: "tijdgevoelig", explanation: ["elke mail of brief van je bewindvoerder"]),
            Kind(category: "CREDITOR_MAIL", name: "Post van een schuld\u{00AD}eiser", symbol: "doc.text",
                 level: "gewoon", explanation: ["een schuldeiser of deurwaarder stuurde je iets"]),
        ], footnote: "Post van je bewindvoerder staat altijd aan, zodat je niets van je bewind mist.\nOf een tijdgevoelige melding door een focus komt, kies je in iOS per focus."),
        Group(label: "Wat op je wacht", kinds: [
            Kind(category: "PROPOSAL", name: "Voorstel", symbol: "arrowshape.turn.up.left",
                 level: "gewoon", explanation: ["een voorstel staat klaar"], detail: "er gaat niets weg zonder jou"),
            Kind(category: "REMINDER", name: "Herinnering", symbol: "clock",
                 level: "gewoon", explanation: [], detail: "een voorstel wacht al een tijd op je"),
            Kind(category: "FOLLOW_UP", name: "Navragen", symbol: "arrow.triangle.2.circlepath",
                 level: "gewoon", explanation: ["iemand antwoordde nog niet", "verder stelt navragen voor"]),
            Kind(category: "TASK_DUE", name: "Termijn", symbol: "checkmark.square",
                 level: "tijdgevoelig", explanation: ["de uiterste datum van een taak komt eraan"]),
        ], footnote: "Herinneringen, navragen en termijnen komen alleen tussen 08:00 en 22:00. Gaat het om post van je bewindvoerder, dan zijn ze tijdgevoelig."),
        Group(label: "Wat verder deed", kinds: [
            Kind(category: "FILING", name: "Opgeborgen", symbol: "archivebox",
                 level: "stil", explanation: ["wat verder zelf opborg, samenvoegde of ophaalde"]),
            Kind(category: "WEEKLY", name: "Weekoverzicht", symbol: MoreGlyphName.calendar,
                 level: "stil", explanation: ["zondag 18:00"], detail: "wat er die week gebeurde"),
            Kind(category: "SYSTEM", name: "Systeem", symbol: "sun.max",
                 level: "gewoon", explanation: ["als er in verder iets hapert, of weer hersteld is"]),
        ], footnote: "Stille meldingen komen in je meldingencentrum, zonder geluid en zonder dat je scherm aangaat. Lukt het versturen van een antwoord niet, dan meldt Systeem dat tijdgevoelig."),
    ]

    static var kinds: [Kind] { groups.flatMap(\.kinds) }

    /// The lines under a kind's name: the level with its short facts, then
    /// the sentence on its own line — never joined into one wrapped run.
    /// While iOS holds every push back, the always-on kind says when it
    /// comes back instead.
    static func lines(_ kind: Kind, denied: Bool) -> [MoreMenu.Line] {
        if denied && always.contains(kind.category) { return [.kind(level: kind.level, [verderMailWhileDenied])] }
        return [.kind(level: kind.level, kind.explanation)] + (kind.detail.map { [MoreMenu.Line.phrases([$0])] } ?? [])
    }

    /// What VoiceOver reads for a kind: name, level and every line.
    static func spoken(_ kind: Kind, denied: Bool) -> String {
        let words = denied && always.contains(kind.category)
            ? [verderMailWhileDenied] : kind.explanation + [kind.detail].compactMap { $0 }
        return ([kind.name, kind.level] + words).joined(separator: ", ")
    }
}

// MARK: - Widgets toevoegen

/// Meer → Widgets toevoegen: an in-app guide (the brief's "Structured").
enum WidgetGuide {
    static let previewLabel = "Zo ziet hij eruit"
    static let homeLabel = "Op je beginscherm"
    static let lockLabel = "Op je toegangsscherm"

    /// Words in `**…**` are what iOS's own buttons say, set in bold.
    static let homeSteps = [
        "Houd een lege plek op je beginscherm vast tot de apps bewegen.",
        "Tik op **Wijzig** en kies **Voeg widget toe**.",
        "Zoek **verder** en kies een formaat.",
    ]

    static let lockSteps = [
        "Houd je toegangsscherm vast en tik op **Pas aan**.",
        "Kies **Toegangsscherm** en tik op het vak onder de klok.",
        "Kies **verder**.",
    ]

    /// The illustration's numbers: an example, drawn the way the real
    /// families draw it (`WidgetContent`) — the small one shows the count,
    /// its words and the age of the oldest; the lock-screen rectangle the
    /// count and the same age, shortened. One age for both, so the two
    /// previews never disagree.
    static let sampleCount = "4"
    static let sampleDays = 2
    static let sampleWords = "wachten op jou"
    static let sampleOldest = "oudste \(sampleDays) dagen"
    static let sampleLock = "\(sampleCount) wachten · oudste \(sampleDays) d"
    static let sampleDate = "maandag 2 november"

    static let privacy = "Op je toegangsscherm staan nooit titels: alleen hoeveel er wacht en hoe lang al."
}

// MARK: - Over verder

/// Meer → Over verder: version, build, the server this build talks to, and
/// whether it answers.
struct AboutInfo: Equatable {
    struct Line: Equatable, Hashable, Sendable {
        let label: String
        let value: String
        let symbol: String
    }

    let lines: [Line]
    let version: String?
    let build: String?

    /// `server` is the host shown, which a fixture run sets to the frames'
    /// "grip.example" (`FixtureEnvironment.displayServer`).
    init(info: [String: Any], server: URL) {
        version = info["CFBundleShortVersionString"] as? String
        build = info["CFBundleVersion"] as? String
        let versionText = switch (version, build) {
        case let (v?, b?): "\(v) (\(b))"
        case let (v?, nil): v
        default: "onbekend"
        }
        lines = [
            Line(label: "Versie", value: versionText, symbol: "info.circle"),
            Line(label: "Server", value: server.host() ?? server.absoluteString, symbol: "server.rack"),
        ]
    }

    /// A host that may wrap breaks only after a dot, never inside a label:
    /// "voorjou-few." / "fixtures." / "grip.invalid".
    static func breakableHost(_ host: String) -> String {
        host.replacingOccurrences(of: ".", with: ".\u{200B}").replacingOccurrences(of: "-", with: "-\u{2060}")
    }

    static let label = "Over deze app"
    static let extraLabel = "Extra"
    static let connectionLabel = "Verbinding"

    enum Connection: Equatable, Sendable { case reachable, offline, unreachable, checking }

    static func connection(offline: Bool, accountLoaded: Bool, lastError: APIError?) -> Connection {
        if offline { return .offline }
        switch lastError {
        case .transport?, .server?: return .unreachable
        default: return accountLoaded ? .reachable : .checking
        }
    }

    static func badge(_ c: Connection) -> String {
        switch c {
        case .reachable: "bereikbaar"
        case .offline: "offline"
        case .unreachable: "niet bereikbaar"
        case .checking: "controleren…"
        }
    }

    static let note = "verder is gemaakt voor één dossier: het jouwe. Alles wat de app laat zien, komt van je eigen server."
}

// MARK: - Ontwikkelaar

enum DeveloperCopy {
    static let pushLabel = "Meldingen"
    static let uploadLabel = "Uploadtest"
    static let resend = "Scan opnieuw uploaden (test)"
    static let note = "Uploadt dezelfde scan nog eens met dezelfde clientId. De server hoort duplicate: true te antwoorden, zonder nieuw document."
    static let notRegistered = "nog niet aangemeld"

    /// "…a41f · 31 okt".
    static func token(tail: String?, at: Date?) -> String {
        guard let tail else { return notRegistered }
        return ["…\(tail)", at.map(MoneyFormat.day)].compactMap { $0 }.joined(separator: " · ")
    }

    /// "duplicate: true · 14:02 · geen nieuw document".
    static func answer(_ a: UploadCenter.ResendAnswer?, failure: String?, now: Date) -> String {
        guard let a else { return failure ?? "nog niet getest" }
        return ["duplicate: \(a.duplicate)", HomeSummary.stamp(a.at, now: now),
                a.duplicate ? "geen nieuw document" : "LET OP: nieuw document"].joined(separator: " · ")
    }
}
