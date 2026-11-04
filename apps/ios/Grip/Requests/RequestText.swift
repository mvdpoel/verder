import Foundation

/// Vraag Grip's words (Figma "Vraag Grip · it6", the final frames), decided
/// outside the views so they are testable. Dutch, sentence case: the views set
/// mono labels in capitals.
///
/// THREE RULES THE FRAMES SETTLED IN REVIEW, kept here so no view can drift:
/// 1. every undo toast's button reads "Ongedaan maken", never "Ongedaan";
/// 2. the "Eerdere vragen" row counts with "klaar" ("3 KLAAR"); "afgerond" is
///    only the per-row status of a question whose steps are done;
/// 3. an ENABLED 17 pt placeholder is ink-mute (≥ 7:1); the disabled "Vraag
///    door kan zodra Grip klaar is" bar is marked by a dimmed glyph and edge,
///    and its words never read brighter than the enabled placeholder's.
enum RequestText {
    static let title = "Vraag Grip"
    static let followUpTitle = "Vraag door"
    static let aboutLabel = "Over"
    static let placeholder = "Wat wil je weten of geregeld hebben?"
    static let followUpPlaceholder = "Vraag door…"
    static let followUpWaiting = "Vraag door kan zodra Grip klaar is"
    static let exampleLabel = "Voorbeeld · tik om te gebruiken"
    static let example = "Wat moet ik antwoorden op de boedelbeschrijving van Noordkust? Check de feiten."
    static let send = "Versturen"
    static let privacy = "Grip leest je dossier, ook je mail daarin, en zoekt zo nodig live in Gmail. Er gaat niets weg zonder jou."
    static let offlineNote = "Wordt verstuurd zodra je online bent."
    static let dictationNote = "Dicteren gebeurt op je iPhone. Er gaat geen geluid naar Grip."
    static let dictationStop = "Tik om te stoppen"
    static let dictationMeta = "Nederlands · op je iPhone"
    static let discardTitle = "Vraag weggooien?"
    static let discardBody = "Wat je typte of dicteerde, is dan weg. Er is nog niets naar Grip gestuurd."
    static let discard = "Weggooien"
    static let keepTyping = "Verder typen"
    static let attach = "Koppel een stuk"
    static let attachSearch = "Zoek in je dossier"
    static let recent = "Recent"
    static let close = "Sluiten"
    static let entry = "Vraag Grip hierover"
    static let saved = "Bewaard. Wordt verstuurd zodra je online bent."
    static let sent = "Vraag verstuurd. In de wachtrij."

    // The answer screen.
    static let yourQuestion = "Jouw vraag"
    static let askedFurther = "Vraag door"
    static let firstQuestion = "Eerste vraag"
    static let whatGripDoes = "Wat Grip nu doet"
    static let whatGripDid = "Wat Grip deed"
    static let whatHappened = "Wat er gebeurde"
    static let yourSteps = "Wat jij nog moet doen"
    static let sources = "Bronnen"
    static let expectation = "Meestal binnen een paar minuten. Je mag de app sluiten: je krijgt een melding als het klaar is, ook als het niet lukt."
    static let stoppedBody = "Je hebt deze vraag gestopt. Wat Grip al gevonden had, is niet bewaard, en er is niets verstuurd."
    static let stop = "Stop deze vraag"
    static let retry = "Opnieuw proberen"
    static let edit = "Vraag aanpassen"
    static let askAgain = "Vraag opnieuw stellen"
    static let letGo = "Laat maar"
    static let letGoNote = "Haalt de vraag uit Voor jou"
    static let letGoKeepsProposal = "Het voorstel blijft als eigen rij in Nu"
    static let copyAnswer = "Kopieer antwoord"
    static let shareAnswer = "Deel antwoord…"
    static let sendInProposal = "Versturen doe je daar, met Face ID."
    static let answerNav = "Antwoord"
    static let more = "Meer"

    /// Finding 1 of the last review: the undo button's whole word, everywhere.
    static let undo = "Ongedaan maken"
    static let putAwayToast = "Vraag weggelegd."
    static let putAwayReleasedToast = "Vraag weggelegd. Het voorstel staat nu los in Nu."
    static let allDoneToast = "Alles gedaan. Deze vraag staat nu bij Eerdere vragen."

    // Eerdere vragen.
    static let earlierTitle = "Eerdere vragen"
    static let earlierBody = "Klaar: beantwoord en afgevinkt, weggelegd of gestopt. Tik om terug te lezen."

    // Gmail / bank.
    static let gmailEyebrow = "Gmail · live · alleen lezen"
    static let notInDossier = "Niet in je dossier"
    static let notInDossierBody = "Grip las dit bericht live in Gmail voor je vraag. Het staat niet in je dossier en Grip bewaart het niet."
    static let notInDossierUnread = "Grip las dit bericht live in Gmail voor je vraag. Het staat niet in je dossier en Grip bewaart het niet, dus de tekst is hier niet meer te lezen."
    static let bankTitle = "Bankregel"
    static let bankFootnote = "Alleen lezen. Deze rekening beheer je zelf: opzeggen of terugboeken doe je in je bank-app."
    static let bankOpenGeld = "Bekijk op Geld"

    // MARK: - Voor jou

    /// "JOUW VRAAG" for one open question, "JOUW VRAGEN" otherwise.
    static func groupLabel(open: Int) -> String { open == 1 ? "Jouw vraag" : "Jouw vragen" }

    /// Finding 2: the earlier row counts with "klaar", never "afgerond".
    static func earlierCount(_ n: Int) -> String { "\(n) klaar" }

    /// A JOUW VRAAG row's meta, by phase: what Grip is doing with it.
    static func openMeta(_ item: RequestListItem, now: Date) -> String {
        switch item.phase {
        case .queued: return "Vraag Grip · in de wachtrij"
        case .working: return "Grip zoekt het uit · \(minutes(from: item.createdAt, to: now)) min"
        case .updating: return "Voorstel wordt bijgewerkt"
        default: return item.meta ?? "Vraag Grip"
        }
    }

    static let waitingOnNetwork = "Wacht op netwerk"

    /// Whole minutes, at least 1: "Grip zoekt het uit · 2 min".
    static func minutes(from: Date, to: Date) -> Int { max(1, Int(to.timeIntervalSince(from) / 60)) }

    /// The time column: "14:03" today, else "30 okt".
    static func when(_ date: Date, now: Date) -> String {
        HomeSummary.calendar.isDate(date, inSameDayAs: now) ? HomeSummary.clock(date) : HomeSummary.day(date)
    }

    // MARK: - Eerdere vragen

    /// "Afgerond · 1 stap gedaan", "Weggelegd · voorstel in Nu",
    /// "Beantwoord · geen stappen", "Gestopt door jou".
    static func doneMeta(_ item: RequestListItem) -> String {
        switch item.doneReason {
        case "afgerond":
            return "Afgerond · \(item.stepsDone) \(item.stepsDone == 1 ? "stap" : "stappen") gedaan"
        case "weggelegd":
            return item.proposal?.status == "pending" ? "Weggelegd · voorstel in Nu" : "Weggelegd"
        case "gestopt":
            return "Gestopt door jou"
        default:
            return item.stepsTotal == 0 ? "Beantwoord · geen stappen" : "Beantwoord"
        }
    }

    /// The group a finished question sits in: "Vandaag", else its month.
    static func earlierGroup(_ date: Date, now: Date) -> String {
        let cal = HomeSummary.calendar
        if cal.isDate(date, inSameDayAs: now) { return "Vandaag" }
        let m = cal.component(.month, from: date)
        return HomeSummary.sentence(monthsLong[m - 1])
    }

    static let monthsLong = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus",
                             "september", "oktober", "november", "december"]

    /// Finished questions, newest first, grouped by `earlierGroup`.
    static func earlierGroups(_ items: [RequestListItem], now: Date) -> [(label: String, items: [RequestListItem])] {
        var out: [(label: String, items: [RequestListItem])] = []
        for item in items.sorted(by: { $0.at > $1.at }) {
            let label = earlierGroup(item.at, now: now)
            if let i = out.firstIndex(where: { $0.label == label }) { out[i].items.append(item) }
            else { out.append((label, [item])) }
        }
        return out
    }

    // MARK: - The answer screen

    /// The small line above the title: "Vraag Grip · 14:03"; once answered just "Vraag Grip".
    static func eyebrow(_ d: RequestDetail) -> String {
        d.status == "answered" ? title : "\(title) · \(HomeSummary.clock(d.createdAt))"
    }

    /// The outcome, the screen's title.
    static func headline(_ d: RequestDetail) -> String {
        switch d.status {
        case "queued": return "In de wachtrij"
        case "working": return "Grip zoekt het uit"
        case "failed": return "Dit lukte niet"
        case "cancelled": return "Gestopt"
        default: return d.headline ?? "Beantwoord"
        }
    }

    enum StatusDot: Equatable { case ring, steel, okay, dim }

    /// The status line under the title, and its dot.
    static func status(_ d: RequestDetail, now: Date) -> (dot: StatusDot, text: String) {
        switch d.status {
        case "queued": return (.ring, "Nog niet begonnen · Grip begint zo")
        case "working": return (.steel, "Bezig · \(minutes(from: d.claimedAt ?? d.createdAt, to: now)) min")
        case "failed": return (.dim, "Lukte niet · \(HomeSummary.clock(d.updatedAt))")
        case "cancelled": return (.dim, "Gestopt door jou · \(HomeSummary.clock(d.updatedAt))")
        default:
            let answered = d.answeredAt ?? d.updatedAt
            if allDone(d), let last = d.steps.compactMap(\.doneAt).max() {
                return (.okay, "Afgerond · \(HomeSummary.clock(last))")
            }
            var parts = ["Beantwoord", HomeSummary.clock(answered)]
            // How long Grip looked, for a first question (a follow-up is quick).
            if d.parentRequestId == nil, let claimed = d.claimedAt {
                parts.append("\(minutes(from: claimed, to: answered)) min gezocht")
            }
            return (.okay, parts.joined(separator: " · "))
        }
    }

    /// Every step ticked (and at least one).
    static func allDone(_ d: RequestDetail) -> Bool { !d.steps.isEmpty && d.steps.allSatisfy { $0.doneAt != nil } }

    /// "Jouw vraag · 14:03", or for a follow-up "Vraag door · 14:12".
    static func questionLabel(_ d: RequestDetail) -> String {
        "\(d.parentRequestId == nil ? yourQuestion : askedFurther) · \(HomeSummary.clock(d.createdAt))"
    }

    /// The answer split into paragraphs and bullet lines ("• …" / "- …").
    enum Block: Equatable { case paragraph(String), bullet(String) }

    static func blocks(_ answer: String) -> [Block] {
        // "€ 10,00" never breaks between the sign and the amount.
        answer.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "€ ", with: "€\u{00A0}").split(separator: "\n", omittingEmptySubsequences: true)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .map { line in
                for mark in ["• ", "- ", "* ", "· "] where line.hasPrefix(mark) {
                    return .bullet(String(line.dropFirst(mark.count)))
                }
                return .paragraph(line)
            }
    }

    // MARK: - Proposal card

    /// Which number this thread's proposal is: 1 for the first drafted, 2
    /// when an earlier answer drafted one before it.
    static func version(_ d: RequestDetail) -> Int {
        d.thread.filter { $0.proposal != nil }.count + 1
    }

    /// Whether an earlier answer's proposal already went out.
    static func earlierSent(_ d: RequestDetail) -> Bool { d.thread.contains { $0.proposal?.status == "sent" } }

    struct Card: Equatable {
        let label: String
        let amber: Bool
        let title: String
        let meta: String?
        let caption: String?
        let opens: Bool
    }

    static func card(_ d: RequestDetail) -> Card? {
        guard let p = d.proposal, p.status != "superseded" else { return nil }
        let name = p.title ?? "Voorstel"
        let files = p.attachmentCount == 1 ? "1 bijlage" : "\(p.attachmentCount) bijlagen"
        if d.proposalUpdating {
            return Card(label: "Voorstel · wordt bijgewerkt", amber: false, title: name,
                        meta: "Versie \(version(d)) wordt opgesteld", caption: nil, opens: false)
        }
        let v = version(d)
        let meta: String
        if v > 1 && !earlierSent(d) { meta = "Versie \(v) · \(files)" }
        else { meta = [p.subject, files].compactMap { $0 }.joined(separator: " · ") }
        switch p.status {
        case "pending":
            return Card(label: earlierSent(d) ? "Nieuw voorstel · wacht op jou" : "Voorstel · wacht op jou", amber: true,
                        title: name, meta: meta, caption: sendInProposal, opens: true)
        case "sent":
            let when = p.sentAt.map { " om \(HomeSummary.clock($0))" } ?? ""
            return Card(label: "Voorstel · verstuurd", amber: false, title: name, meta: meta,
                        caption: "Verstuurd\(when).", opens: true)
        default:
            return Card(label: "Voorstel", amber: false, title: name, meta: meta, caption: nil, opens: true)
        }
    }

    /// The collapsed earlier answer: "Er ontbreken twee dingen. Antwoord aan Ilse klaargezet."
    static func earlierSummary(_ e: RequestDetail.Earlier) -> String {
        let head = e.headline.map { $0.hasSuffix(".") ? $0 : "\($0)." }
        let proposal: String? = switch e.proposal?.status {
        case "sent"?: e.proposal?.sentAt.map { "Antwoord verstuurd om \(HomeSummary.clock($0))." } ?? "Antwoord verstuurd."
        case nil: nil
        default: "Antwoord klaargezet."
        }
        return [head, proposal].compactMap { $0 }.joined(separator: " ")
    }

    // MARK: - Sources

    /// The words before the date on a source row, Dutch: "Dossier · contract",
    /// "Mail · in dossier · Ilse", "Gmail · niet in je dossier". A document's
    /// soort comes in the model's English and is shown in the app's Dutch.
    static func sourceMeta(_ s: RequestDetail.Source, accountName: (String) -> String?) -> [String] {
        if let t = s.transaction {
            let account = t.accountIban.map { iban in
                let name = accountName(iban).map { $0.replacingOccurrences(of: "rekening", with: "") }
                return [name, MoneyFormat.ibanDots(iban)].compactMap { $0 }.joined(separator: " · ")
            }
            return [account].compactMap { $0 }.filter { !$0.isEmpty }
        }
        var meta = s.meta
        if s.type == "document", meta.count > 1, let soort = DoneByGripList.soort(meta[1]) { meta[1] = soort }
        return meta
    }

    /// A source row's date column: "2 nov" this year, else the year.
    static func sourceWhen(_ date: Date?, now: Date) -> String? {
        guard let date else { return nil }
        let cal = HomeSummary.calendar
        if cal.component(.year, from: date) != cal.component(.year, from: now) { return String(cal.component(.year, from: date)) }
        return HomeSummary.day(date)
    }

    static func symbol(source type: String) -> String {
        switch type {
        case "mail": "envelope"
        case "gmail": "envelope.badge"
        case "document": "doc.text"
        case "transaction": "building.columns"
        case "party": "person"
        case "stop": "smallcircle.filled.circle"
        case "task": "checkmark.square"
        default: "doc"
        }
    }

    static func symbol(about type: String) -> String {
        switch type {
        case "mail": "envelope"
        case "document": "doc.text"
        case "party": "person"
        case "stop": "mappin.and.ellipse"
        default: "checkmark.square"
        }
    }

    /// The kind, in the picker's and the chip's words.
    static func kind(about type: String) -> String {
        switch type {
        case "mail": "Mail"
        case "document": "Document"
        case "party": "Partij"
        case "stop": "Halte"
        default: "Taak"
        }
    }

    /// The chip's meta: "Mail · Ilse · 2 nov".
    static func aboutMeta(_ a: RequestAbout, now: Date) -> [String] {
        var parts = [kind(about: a.type)]
        parts += a.meta.map { a.type == "document" ? (DoneByGripList.soort($0) ?? $0) : $0 }
        if let at = a.at { parts.append(sourceWhen(at, now: now) ?? "") }
        return parts.filter { !$0.isEmpty }
    }

    // MARK: - VoiceOver

    static func rowLabel(title: String, meta: String, when: String, waits: Bool) -> String {
        [title, meta, waits ? "wacht op jou" : nil, when].compactMap { $0 }.joined(separator: ", ")
    }
}
