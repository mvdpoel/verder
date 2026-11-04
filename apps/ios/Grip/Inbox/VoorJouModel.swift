import Foundation

/// The words of the Voor jou tab (Figma "voorjou · final").
enum VoorJouCopy {
    static let title = "Voor jou"
    static let select = "Selecteer"
    static let cancel = "Annuleer"
    static let nuNote = "Alleen suggesties kun je samen afhandelen. Voorstellen, vragen en taken beslis je één voor één."
    static let emptyHeadline = "Niets wacht op je"
    static let emptyLater = "Komt er iets nieuws binnen, dan krijg je een melding."
    static let onlyOne = "Meer wacht er nu niet op je."
    static let retry = "Opnieuw proberen"
    static let readOnly = "alleen lezen · offline"
    static let offlineLabel = "offline"
    static let offlineBody = "Je ziet je laatste stand. Goedkeuren en afronden kan weer zodra je verbinding hebt."
    static let failureLabel = "storing"
    static let failureBody = "De server van Grip heeft een storing. Je ziet je laatste stand; er is niets verloren gegaan."
    static let failedHeadline = "Voor jou laadt nu niet"
    static let failedServer = "De server van Grip heeft een storing. Er is niets verloren gegaan."
    static let failedOffline = "Er is geen verbinding. Zodra die er weer is, haalt Grip je lijst op. Er is niets verloren gegaan."
    static let sendOnlyInProposal = "Versturen kan alleen in het voorstel zelf, met Face\u{00A0}ID."
    static let offlineMenu = "Offline: beslissen kan weer zodra je verbinding hebt."
    static let view = "Bekijken"
    static let undo = "Ongedaan maken"
    static let notSaved = "niet opgeslagen"
}

/// What the list draws, decided outside the view so it is testable.
///
/// THE PHONE NEVER RE-RANKS: rows come in exactly the server's order
/// (`waitingOnMartin` in packages/api/src/waiting.ts), and the split into Nu
/// and Kan wachten moves nothing, because that order already puts every
/// proposal and question before every suggestion, task and stop.
///
/// AMBER MEANS WAITING ON MARTIN NOW: the dot sits on the Nu rows (proposals
/// and questions) and beside the header's count, never on its own without
/// words. "Door Grip gedaan" is what Grip already did: never amber.
enum VoorJouList {
    static let emptyText = "Niets wacht op je."
    /// A long section shows this many rows, then "Toon alle N" (brief §3).
    static let sectionLimit = 20

    enum SectionKind: String, Sendable { case nu, kanWachten }

    struct Row: Identifiable, Equatable {
        let item: WaitingItem
        let route: InboxRoute?
        let amber: Bool
        /// A document an undo of "Door Grip gedaan" is putting back, drawn
        /// in Kan wachten while that undo is on the phone (`restoredItem`).
        /// It carries no suggestion id yet, so it offers no decision: no
        /// swipe, no menu step, no tick. A tap opens the document itself.
        var restored = false
        var id: String { VoorJouList.key(item) }
        var section: SectionKind { VoorJouList.section(item.kind) }
        /// A suggestion the server says can be approved unchanged.
        var approvable: Bool { item.kind == .suggestion && item.approvable == true && !restored }
        /// The statuses a task may move to from here (the server's `validNext`).
        var taskNext: [String] { item.kind == .task ? (item.validNext ?? []) : [] }
        var canDone: Bool { taskNext.contains("done") }
        /// Suggestions only: proposals, questions and tasks are decided one at a time.
        var selectable: Bool { item.kind == .suggestion && !restored }
    }

    struct Section: Identifiable, Equatable {
        let kind: SectionKind
        /// The rows drawn: the first `sectionLimit` unless expanded.
        let rows: [Row]
        /// Every row of this section on the list.
        let total: Int
        var id: SectionKind { kind }
        var truncated: Bool { rows.count < total }
        var label: String { kind == .nu ? "nu" : "kan wachten" }
    }

    struct DoneRow: Identifiable, Equatable {
        let action: GripAction
        let amber: Bool
        var id: String { action.id }
    }

    /// The row's identity, also the key a held decision hides it by.
    static func key(_ item: WaitingItem) -> String { "\(item.kind.rawValue):\(item.id)" }

    static func section(_ kind: WaitingKind) -> SectionKind {
        switch kind {
        case .proposal, .question: .nu
        case .suggestion, .task, .stop, .other: .kanWachten
        }
    }

    static func rows(_ inbox: InboxDTO, hiding hidden: Set<String> = []) -> [Row] {
        inbox.items
            .filter { !hidden.contains(key($0)) }
            .map { Row(item: $0, route: InboxRoute($0), amber: section($0.kind) == .nu) }
    }

    /// Nu, then Kan wachten, each in the server's order; an empty section is
    /// not drawn. ONLY Kan wachten is ever cut short: a limit never hides
    /// something that waits on Martin now.
    ///
    /// `restoring`: "Door Grip gedaan" actions whose undo the phone holds
    /// or is posting. Each document is back at the top of Kan wachten AT
    /// ONCE, as the frame draws it, so the toast's "Terug in Kan wachten"
    /// is never contradicted by the list under it; the next refresh puts the
    /// server's own row in its place.
    static func sections(_ inbox: InboxDTO, hiding hidden: Set<String> = [], expanded: Bool = false,
                         restoring: [GripAction] = []) -> [Section] {
        var all = rows(inbox, hiding: hidden)
        for a in restoring {
            let back = Row(item: restoredItem(a), route: .document(id: a.documentId, title: restoredItem(a).title),
                           amber: false, restored: true)
            all.insert(back, at: restoredIndex(back.item.at, in: all))
        }
        return [SectionKind.nu, .kanWachten].compactMap { kind in
            let mine = all.filter { $0.section == kind }
            guard !mine.isEmpty else { return nil }
            let shown = kind == .nu || expanded ? mine : Array(mine.prefix(sectionLimit))
            return Section(kind: kind, rows: shown, total: mine.count)
        }
    }

    /// Where a restored document goes: among the suggestions, by its own
    /// date, newest first — where the server will put it on the next
    /// refresh, so the row does not jump when the real one replaces it.
    static func restoredIndex(_ at: Date, in rows: [Row]) -> Int {
        if let i = rows.firstIndex(where: { $0.section == .kanWachten && ($0.item.kind != .suggestion || $0.item.at < at) }) {
            return i
        }
        return rows.count
    }

    /// The header's number: the SERVER's count, less only the decisions the
    /// phone is holding in their undo window (they are gone from the list,
    /// and the count follows them down; an undo puts both back).
    /// An undo of "Door Grip gedaan" adds its document back (`restored`).
    static func count(_ inbox: InboxDTO, hidden: Int, restored: Int = 0) -> Int { max(0, inbox.count - hidden + restored) }

    /// The undoable "Door Grip gedaan" actions among `keys` (the held and
    /// posting decisions): the documents on their way back to Kan wachten.
    static func restoring(_ inbox: InboxDTO, keys: Set<String>) -> [GripAction] {
        inbox.doneByGrip.filter { $0.undoable && !$0.undone && keys.contains(ListDecision.key(grip: $0.changeId)) }
    }

    /// The document an undo puts back, as the suggestion it returns as.
    static func restoredItem(_ a: GripAction) -> WaitingItem {
        WaitingItem(kind: .suggestion, id: "restored:\(a.changeId)", title: a.documentTitle ?? a.after.title ?? "Document",
                    subtitle: "Document", priority: 3, at: a.at, dueAt: nil, verder: false)
    }

    /// "Door Grip gedaan"'s count, less what is on its way back.
    static func doneCount(_ inbox: InboxDTO, restored: Int) -> Int { max(0, inbox.doneByGrip.count - restored) }

    /// Selection mode pays off only on a list with several suggestions: with
    /// two, two swipes are quicker than Selecteer · tick · tick · Keur goed
    /// (the frames show it on the long list and the SE, never on five items).
    static let selectMinimum = 3

    /// "Selecteer": enough suggestions, a connection, and no decision in its
    /// undo window — the toast owns the bottom of the screen until it ends.
    static func canSelect(selectable: Int, readOnly: Bool, holding: Bool) -> Bool {
        selectable >= selectMinimum && !readOnly && !holding
    }

    static func doneRows(_ inbox: InboxDTO) -> [DoneRow] {
        inbox.doneByGrip.map { DoneRow(action: $0, amber: false) }
    }

    static func kindLabel(_ kind: WaitingKind) -> String {
        KindLabel.dutch(kind.rawValue)
    }

    /// The list's own word for a kind: the frames call the map's stop a "halte".
    static func rowKindLabel(_ kind: WaitingKind) -> String {
        kind == .stop ? "halte" : kindLabel(kind)
    }

    // MARK: - Header

    /// "wacht op jou" for one, "wachten op jou" for the rest (zero included).
    static func countCaption(_ n: Int) -> String { n == 1 ? "wacht op jou" : "wachten op jou" }
    static func countLine(_ n: Int) -> String { "\(n) \(countCaption(n))" }

    /// "MAANDAG 2 NOV".
    static func eyebrow(_ now: Date) -> String { HomeSummary.longDay(now).uppercased() }

    /// How fresh the list is: "bijgewerkt 14:02"; offline "offline ·
    /// bijgewerkt 14:02"; after a server failure "laatste stand 14:02" (the
    /// stand on screen is the last good one, not a current one).
    static func freshness(now: Date, fetchedAt: Date?, error: APIError?) -> String? {
        guard let fetchedAt else { return nil }
        let stand = HomeSummary.stamp(fetchedAt, now: now)
        switch error {
        case nil, .unauthorized?: return "bijgewerkt \(stand)"
        case .transport?: return "offline · bijgewerkt \(stand)"
        default: return "laatste stand \(stand)"
        }
    }

    /// The card above a kept list; nil when the list is current.
    enum Notice: Equatable { case offline, failure }

    static func notice(_ error: APIError?, hasList: Bool) -> Notice? {
        guard hasList, let error, error != .unauthorized else { return nil }
        if case .transport = error { return .offline }
        return .failure
    }

    /// "laatste poging 14:02 · serverfout 502" under the no-list failure.
    static func lastAttempt(_ error: APIError, attemptedAt: Date?, now: Date) -> String {
        let cause: String = switch error {
        case .transport: "offline"
        case .server(let code), .rejected(let code): "serverfout \(code)"
        case .rateLimited: "te veel verzoeken"
        case .unauthorized: "niet ingelogd"
        }
        guard let attemptedAt else { return cause }
        return "laatste poging \(HomeSummary.stamp(attemptedAt, now: now)) · \(cause)"
    }

    /// "Goed bezig. Je rondde zaterdag 31 okt het laatste af. Komt er …"; the
    /// middle sentence only when the server said when.
    static func emptyBody(lastClearedAt: Date?, now: Date) -> String {
        guard let at = lastClearedAt else { return "Goed bezig. \(VoorJouCopy.emptyLater)" }
        let when: String
        switch age(at, now: now) {
        case "vandaag": when = "vandaag"
        case "gisteren": when = "gisteren"
        default:
            let wd = HomeSummary.calendar.component(.weekday, from: at)
            when = "\(HomeSummary.weekdaysLong[wd - 1]) \(HomeSummary.day(at))"
        }
        return "Goed bezig. Je rondde \(when) het laatste af. \(VoorJouCopy.emptyLater)"
    }

    /// "0 wachten · bijgewerkt 14:02".
    static func emptyReadout(_ freshness: String?) -> String {
        ["0 wachten", freshness].compactMap { $0 }.joined(separator: " · ")
    }

    // MARK: - Rows

    static let notSent = "niet verstuurd"

    /// The row's age column. A failed send gives the moment it failed —
    /// "09:32" today, else its day as `age` says it — rather than when the
    /// proposal was made.
    static func rowAge(_ item: WaitingItem, now: Date) -> String {
        guard let failed = item.failedAt, item.kind == .proposal else { return age(item.at, now: now) }
        guard HomeSummary.calendar.isDate(failed, inSameDayAs: now) else { return age(failed, now: now) }
        return HomeSummary.clock(failed)
    }

    /// The age column: "vandaag", "gisteren", else "31 okt" — the item's
    /// `at` on Amsterdam's calendar, worked out against `now` on display.
    static func age(_ date: Date, now: Date) -> String {
        let cal = HomeSummary.calendar
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: date), to: cal.startOfDay(for: now)).day ?? 0
        switch days {
        case 0: return "vandaag"
        case 1: return "gisteren"
        default: return HomeSummary.day(date)
        }
    }

    /// A `dueAt` as an Amsterdam day: a plain "2026-11-07" or an ISO instant.
    static func dueDay(_ s: String) -> Date? {
        let cal = HomeSummary.calendar
        let plain = s.split(separator: "-", omittingEmptySubsequences: false)
        if plain.count == 3, plain[0].count == 4, plain[1].count == 2, plain[2].count == 2,
           let y = Int(plain[0]), let m = Int(plain[1]), let d = Int(plain[2]) {
            return cal.date(from: DateComponents(year: y, month: m, day: d))
        }
        return parseISODate(s).map { cal.startOfDay(for: $0) }
    }

    /// "uiterlijk vandaag", "uiterlijk morgen", else "uiterlijk 7 nov".
    static func deadline(_ dueAt: String?, now: Date) -> String? {
        guard let dueAt, let due = dueDay(dueAt) else { return nil }
        let cal = HomeSummary.calendar
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: now), to: due).day ?? 0
        switch days {
        case 0: return "uiterlijk vandaag"
        case 1: return "uiterlijk morgen"
        default: return "uiterlijk \(HomeSummary.day(due))"
        }
    }

    /// The meta line's parts before the age: kind, then who (the server's
    /// subtitle) or, for a task, its deadline; a stop says how many tasks
    /// hang off it when the server says so.
    ///
    /// `short` (the row): a party by its short display name ("Noordkust",
    /// "Kade & Partners"), so "VOORSTEL · NOORDKUST" keeps one line beside
    /// the age as the frames draw it; VoiceOver reads the whole name.
    static func meta(_ item: WaitingItem, now: Date, short: Bool = true) -> [String] {
        var parts = [rowKindLabel(item.kind)]
        // A send that failed says so in place of the party (frame "Voor jou ·
        // niet verstuurd in de lijst": "VOORSTEL · NIET VERSTUURD · 09:32").
        if item.kind == .proposal, item.failedAt != nil { return parts + [notSent] }
        switch item.kind {
        case .stop:
            if let n = item.taskCount, n > 0 { parts.append(n == 1 ? "1 taak" : "\(n) taken") }
        default:
            if let who = who(item, short: short) { parts.append(who) }
            if let due = deadline(item.dueAt, now: now) { parts.append(due) }
        }
        return parts
    }

    /// The meta line's second slot. A proposal or question: its party. A
    /// suggestion: the party it concerns when the server names one, else
    /// what it suggests ("Logboek", "Document"). A task: its subtitle (the
    /// map stop it serves), never shortened — that is a title, not a party.
    static func who(_ item: WaitingItem, short: Bool = true) -> String? {
        func party(_ name: String?) -> String? {
            guard let name, !name.isEmpty else { return nil }
            return short ? shortParty(name) : name
        }
        switch item.kind {
        case .proposal, .question: return party(item.subtitle)
        case .suggestion: return party(item.party) ?? suggestionKind(item.subtitle)
        default:
            guard let s = item.subtitle, !s.isEmpty else { return nil }
            return s
        }
    }

    /// What a suggestion suggests, in the list's word: the server's
    /// "Logboekregel" is "Logboek" on the phone (the frames' word).
    static func suggestionKind(_ subtitle: String?) -> String? {
        guard let s = subtitle, !s.isEmpty else { return nil }
        return s == "Logboekregel" ? "Logboek" : s
    }

    /// Words that say WHAT KIND of organisation a party is, not which one.
    /// The row names a party without them: "Bewindkantoor Noordkust" →
    /// "Noordkust". A municipality keeps its word ("Gemeente Westerlaan"):
    /// "Westerlaan" alone reads as a street.
    static let organisationWords: Set<String> = [
        "bewindkantoor", "incassobureau", "woonstichting", "woningcorporatie", "zorgverzekeraar",
        "deurwaarderskantoor", "gerechtsdeurwaarders", "gerechtsdeurwaarder", "advocatenkantoor",
        "notariskantoor", "administratiekantoor",
    ]

    /// "Bewindkantoor Noordkust" → "Noordkust"; a name that is only the
    /// organisation word, or does not start with one, stays whole.
    static func shortParty(_ name: String) -> String {
        let words = name.split(separator: " ", omittingEmptySubsequences: true)
        guard words.count >= 2, organisationWords.contains(words[0].lowercased()) else { return name }
        return words.dropFirst().joined(separator: " ")
    }

    /// A party a title names after an organisation word: "Telefoongesprek met
    /// Woonstichting Lindehof over …" → "Lindehof". The name runs while its
    /// words are capitalised (or "&"); nil when the title names none.
    static func partyMentioned(in title: String) -> String? {
        let words = title.split(separator: " ").map(String.init)
        guard let i = words.firstIndex(where: { organisationWords.contains($0.lowercased()) }) else { return nil }
        var name: [String] = []
        for w in words[(i + 1)...] {
            guard w == "&" || w.first?.isUppercase == true else { break }
            name.append(w.trimmingCharacters(in: CharacterSet(charactersIn: ":,.;?!")))
        }
        while name.last == "&" { name.removeLast() }
        return name.isEmpty ? nil : name.joined(separator: " ")
    }

    /// The toast's subject at the accessibility sizes, where it wraps whole:
    /// "Logboek · Lindehof" (what it is · whom it concerns). Nil when the
    /// item names no party — the short title then stands in.
    static func toastSubject(_ item: WaitingItem) -> String? {
        guard item.kind == .suggestion else { return nil }
        let party = item.party.map(shortParty) ?? partyMentioned(in: item.title)
        guard let party, let kind = suggestionKind(item.subtitle) else { return nil }
        // A no-break space before the "·": wrapped, the separator ends the
        // first line ("Logboek ·" / "Lindehof") and never starts the second.
        return "\(kind)\u{00A0}· \(party)"
    }

    /// The meta line, whole ("VRAAG · INCASSOBUREAU KADE & PARTNERS"), and
    /// — when that does not fit beside the age — stacked: the kind on the
    /// age's line and the rest under it. A separator never ends a line.
    struct MetaLines: Equatable {
        let oneLine: String
        let kind: String
        let rest: String?
    }

    static func metaLines(_ parts: [String]) -> MetaLines {
        MetaLines(oneLine: HomeSummary.metaLine(parts), kind: parts.first ?? "",
                  rest: parts.count > 1 ? HomeSummary.metaLine(Array(parts.dropFirst())) : nil)
    }

    /// A title without its "over …" tail: "Brief Gemeente Westerlaan over de
    /// woonkostentoeslag" → "Brief Gemeente Westerlaan". Where a sentence
    /// names several items (the bulk confirmation) or must fit a small card
    /// at AX5 (the toast), the full title would push the point off screen.
    /// Kept whole when the cut would leave fewer than two words.
    static func shortTitle(_ title: String) -> String {
        guard let r = title.range(of: " over ") else { return title }
        let head = String(title[..<r.lowerBound])
        return head.split(separator: " ").count >= 2 ? head : title
    }

    /// The symbol in the row's gutter, by kind (and, for a suggestion, by the
    /// server's subtitle, which names what it suggests).
    static func symbol(_ item: WaitingItem) -> String {
        switch item.kind {
        case .proposal: "arrowshape.turn.up.left"
        case .question: "questionmark.bubble"
        case .task: "checkmark.circle"
        case .stop: "smallcircle.filled.circle"
        case .other: "circle.dashed"
        case .suggestion:
            switch item.subtitle {
            case "Document"?: "doc.text"
            case "Vaste last"?: "repeat"
            case "Vordering"?: "eurosign.circle"
            case "Taak"?: "checklist"
            default: "book.closed"
            }
        }
    }

    /// A title that is a file name ("Loonstrook.2026-10.….pdf") is cut in the
    /// middle, so its date and extension stay; prose is cut at its end.
    static func looksLikeFileName(_ title: String) -> Bool {
        title.range(of: #"^\S+\.[A-Za-z0-9]{2,4}$"#, options: .regularExpression) != nil
    }

    /// One row, read whole: kind, title, who, "wacht op jou", age.
    static func accessibilityLabel(_ item: WaitingItem, now: Date) -> String {
        var parts = [HomeSummary.sentence(rowKindLabel(item.kind)), item.title]
        parts += meta(item, now: now, short: false).dropFirst()
        parts += ["wacht op jou", rowAge(item, now: now)]
        return parts.joined(separator: ", ")
    }

    // MARK: - Selection

    /// "a, b en c".
    static func listing(_ titles: [String]) -> String {
        guard titles.count > 1 else { return titles.first ?? "" }
        return titles.dropLast().joined(separator: ", ") + " en " + (titles.last ?? "")
    }

    static func confirmTitle(_ n: Int) -> String { n == 1 ? "1 suggestie goedkeuren?" : "\(n) suggesties goedkeuren?" }

    /// Names EVERY item it will approve, and says how long the undo lasts.
    static func confirmMessage(_ titles: [String], window: TimeInterval) -> String {
        "\(listing(titles.map(shortTitle))). Daarna heb je \(Int(window)) seconden om het ongedaan te maken."
    }

    static func selectedLine(_ n: Int) -> String { "\(n) geselecteerd" }
    static func allHere(_ n: Int) -> String { "Alle \(n) hier" }
    static func approveMany(_ n: Int) -> String { "Keur \(n) goed" }
    static func rejectMany(_ n: Int) -> String { "Niet relevant (\(n))" }
    static func suggestionsCount(_ n: Int) -> String { n == 1 ? "1 suggestie" : "\(n) suggesties" }
}

/// "Door Grip gedaan" as the list draws it (Figma "voorjou · final"):
/// a sentence per action, its soort or "hernoemd" and the day underneath.
enum DoneByGripList {
    /// The model's English soort vocabulary in the app's Dutch; a soort
    /// Martin typed himself is already Dutch and passes through.
    static func soort(_ docType: String?) -> String? {
        guard let t = docType?.trimmingCharacters(in: .whitespaces), !t.isEmpty else { return nil }
        switch t {
        case "bank-statement": return "bankafschrift"
        case "letter": return "brief"
        case "payslip": return "loonstrook"
        case "invoice": return "factuur"
        case "contract": return "contract"
        case "id-document": return "identiteitsbewijs"
        case "other": return "overig"
        default: return t.lowercased()
        }
    }

    /// "Opgeborgen als bankafschrift: Afschrift september",
    /// "Hernoemd: Scan 2026-10-30 → Brief Gemeente Westerlaan 30 okt".
    static func title(_ a: GripAction) -> String {
        let doc = a.documentTitle ?? a.after.title ?? "Document"
        switch a.kind {
        case "auto-file":
            if let s = soort(a.after.docType) { return "Opgeborgen als \(s): \(doc)" }
            return "Opgeborgen: \(doc)"
        case "auto-name":
            if let before = a.before.title, let after = a.after.title, before != after {
                return "Hernoemd: \(before) → \(after)"
            }
            return "Hernoemd: \(doc)"
        default:
            return "\(DoneByGripCopy.headline(a)): \(doc)"
        }
    }

    /// "BANKAFSCHRIFT · 30 OKT" / "HERNOEMD · 30 OKT".
    static func meta(_ a: GripAction) -> [String] {
        let what = a.kind == "auto-name" ? "hernoemd" : (soort(a.after.docType) ?? "opgeborgen")
        return [what, HomeSummary.day(a.at)]
    }

    /// Why there is no undo button, in the list's words.
    static func note(_ a: GripAction) -> String? {
        if !a.undone, a.notUndoableReason == "naam staat ook op de NAS" {
            return "Hier niet terug te draaien: de naam staat ook op de NAS. Terugdraaien gaat op de server."
        }
        return DoneByGripCopy.note(a)
    }

    /// The collapsed section's sentence (and the empty list's).
    static func summary(_ n: Int) -> String {
        let what = n == 1 ? "1 ding deed Grip deze week zelf." : "\(n) dingen deed Grip deze week zelf."
        return "\(what) Klopt iets niet? Wat hier kan, maak je met één tik ongedaan."
    }
}
