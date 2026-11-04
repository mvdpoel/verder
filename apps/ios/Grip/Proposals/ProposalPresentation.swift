import Foundation

/// What the proposal screen says, as pure functions of what the server served
/// (Figma "proposal · final"). No SwiftUI here, so every word and number the
/// screen shows is unit-tested (`ProposalPresentationTests`).
enum ProposalText {
    static let amsterdam = ProposalFormat.amsterdam

    static let nbsp = "\u{00A0}"

    // MARK: - Header

    /// "Antwoord", "Opvolging", "Vraag".
    static func kindTitle(_ kind: String) -> String {
        let k = ProposalFormat.kind(kind)
        return k.prefix(1).uppercased() + k.dropFirst()
    }

    /// "Antwoord aan Noordkust": the kind and whom it goes to, by the party's
    /// short name (`VoorJouList.shortParty`). Without a party, the kind alone.
    static func title(kind: String, partyName: String?) -> String {
        guard let party = partyName?.trimmingCharacters(in: .whitespaces), !party.isEmpty, kind != "question" else {
            return kindTitle(kind)
        }
        return "\(kindTitle(kind)) aan \(VoorJouList.shortParty(party))"
    }

    /// "VOORSTEL · ANTWOORD".
    static func eyebrow(kind: String) -> String {
        "Voorstel · \(ProposalFormat.kind(kind))"
    }

    /// "09:20" today, "2 nov 09:20" on another day — Amsterdam.
    static func stamp(_ date: Date, now: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = amsterdam
        let time = clock(date)
        return cal.isDate(date, inSameDayAs: now) ? time : "\(dayMonthName(date)) \(time)"
    }

    static func clock(_ date: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = amsterdam
        let c = cal.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    static let monthNames = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"]

    /// "2 nov", on the Amsterdam calendar.
    static func dayMonthName(_ date: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = amsterdam
        let c = cal.dateComponents([.day, .month], from: date)
        return "\(c.day ?? 0) \(monthNames[max(0, min(11, (c.month ?? 1) - 1))])"
    }

    /// The badge beside the status ("WACHT OP JOU", "VERSTUURD", …). Nil for a
    /// status that needs none (its bar says what happened).
    enum Badge: Equatable {
        /// Amber: the one thing on this screen waiting on Martin.
        case waiting
        case sent
        case drafting
        /// The drafter stopped without a draft: it happened, it waits on nobody.
        case draftFailed
    }

    static func badge(status: String) -> Badge? {
        switch status {
        case "pending": .waiting
        case "sent": .sent
        case "drafting": .drafting
        case "draft-failed": .draftFailed
        default: nil
        }
    }

    static func badgeText(_ b: Badge) -> String {
        switch b {
        case .waiting: "Wacht op jou"
        case .sent: "Verstuurd"
        case .drafting: "Wordt opgesteld"
        case .draftFailed: "Geen concept"
        }
    }

    /// The words after the badge: when the draft was made, or since when it is
    /// being made. Offline, the bar's reason is named here too.
    static func badgeNote(status: String, createdAt: Date, now: Date, offline: Bool) -> String? {
        let at = stamp(createdAt, now: now)
        if offline && status == "pending" { return "Geen verbinding · \(at)" }
        switch status {
        case "pending": return "Opgesteld \(at)"
        case "drafting": return "Sinds \(at)"
        default: return nil
        }
    }

    // MARK: - Trigger

    /// "AANLEIDING · MAIL · 2 NOV 09:14", or for a follow-up "AANLEIDING · 26 DAGEN STIL".
    static func triggerMeta(kind: String, trigger: ProposalDetail.Trigger, now: Date) -> String {
        triggerMetaGroups(kind: kind, trigger: trigger, now: now).joined(separator: " · ")
            .replacingOccurrences(of: nbsp, with: " ")
    }

    /// The same line as groups that never break inside: "Aanleiding · Mail"
    /// and "2 nov 09:14". Where the line does not fit, it wraps BETWEEN
    /// groups and the dot between them goes, so no line ends on a "·". Inside
    /// a group the spaces are NO-BREAK spaces: a group is one word to the
    /// layout (and to `wholeWords`, which steps the size down before it breaks).
    static func triggerMetaGroups(kind: String, trigger: ProposalDetail.Trigger, now: Date) -> [String] {
        if kind == "follow-up", let date = trigger.date, let days = daysSilent(since: date, now: now) {
            return ["Aanleiding", "\(days)\(nbsp)\(days == 1 ? "dag" : "dagen")\(nbsp)stil"]
        }
        var head = "Aanleiding"
        switch trigger.type {
        case "email", "external": head += "\(nbsp)·\(nbsp)Mail"
        case "document": head += "\(nbsp)·\(nbsp)Brief"
        case "task": head += "\(nbsp)·\(nbsp)Taak"
        case "proposal": head += "\(nbsp)·\(nbsp)Eerder\(nbsp)antwoord"
        default: break
        }
        var groups = [head]
        if let date = trigger.date { groups.append("\(dayMonthName(date))\(nbsp)\(clock(date))".replacingOccurrences(of: " ", with: nbsp)) }
        return groups
    }

    /// Whole Amsterdam calendar days from `date` to `now` (the clock's own
    /// rule for silence, `clocks.ts`). Nil for a date in the future.
    static func daysSilent(since date: Date, now: Date) -> Int? {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = amsterdam
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: date), to: cal.startOfDay(for: now)).day
        guard let days, days >= 0 else { return nil }
        return days
    }

    /// "Ilse" from "Ilse <ilse@noordkust.example>"; nil for a bare address or "verder".
    static func displayName(_ from: String?) -> String? {
        guard let from else { return nil }
        guard let lt = from.firstIndex(of: "<") else { return nil }
        let name = from[..<lt].trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        return name.isEmpty ? nil : name
    }

    /// "Ilse" from a draft that opens "Beste Ilse,": the one person the
    /// letter is written to. Nil for "Geachte heer …", "Beste allen" or no
    /// greeting — a name is only taken when it is one capitalised word.
    static func greetedName(_ body: String) -> String? {
        let first = body.replacingOccurrences(of: "\r\n", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: true).first
            .map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        guard let r = first.range(of: #"^(Beste|Hallo|Hoi|Dag)\s+(\p{Lu}[\p{L}'-]*)\s*,?$"#, options: .regularExpression)
        else { return nil }
        let words = first[r].split(separator: " ")
        guard words.count == 2 else { return nil }
        return String(words[1]).trimmingCharacters(in: CharacterSet(charactersIn: ","))
    }

    /// "ilse@noordkust.example" from "Ilse <ilse@noordkust.example>".
    static func address(_ from: String?) -> String? {
        guard let from, let lt = from.firstIndex(of: "<"), let gt = from.lastIndex(of: ">"), lt < gt else { return nil }
        return String(from[from.index(after: lt)..<gt]).lowercased()
    }

    /// The trigger card's sentence, as (bold lead, the rest): "**Ilse** vraagt
    /// om je loonstrook van oktober." A follow-up: "**Jouw vraag van 7 okt**
    /// staat nog open bij Ilse." — the person the draft greets, else the
    /// party's short name. The lead is bold only when the ask really starts
    /// with the sender's name; nothing is reworded.
    static func triggerLine(kind: String, ask: String?, trigger: ProposalDetail.Trigger,
                            partyName: String?, draftBody: String? = nil) -> (lead: String?, rest: String)? {
        if kind == "follow-up", let date = trigger.date {
            let who = draftBody.flatMap(greetedName) ?? partyName.map(VoorJouList.shortParty) ?? "de ander"
            return ("Jouw vraag van \(dayMonthName(date))", " staat nog open bij \(who).")
        }
        guard let ask = ask?.trimmingCharacters(in: .whitespacesAndNewlines), !ask.isEmpty else { return nil }
        let sentence = ask.last.map { ".?!".contains($0) } == true ? ask : ask + "."
        if let name = displayName(trigger.from), sentence.hasPrefix(name + " ") {
            return (name, String(sentence.dropFirst(name.count)))
        }
        return (nil, sentence)
    }

    /// The sheet the trigger card opens: "Mail van Ilse", "Jouw vraag van 7 okt".
    static func triggerSheetTitle(_ t: ProposalDetail.Trigger) -> String {
        if t.type == "proposal" { return t.date.map { "Jouw vraag van \(dayMonthName($0))" } ?? "Jouw eerdere vraag" }
        if let name = displayName(t.from) { return "Mail van \(name)" }
        return t.subject ?? "De mail"
    }

    /// The ⋯ menu's way to what started the proposal.
    static func openTriggerLabel(_ t: ProposalDetail.Trigger) -> String {
        t.type == "proposal" ? "Jouw eerdere vraag openen" : "Originele mail openen"
    }

    // MARK: - Draft

    /// The draft's paragraphs (a blank line apart), each without its own
    /// trailing whitespace; empty paragraphs dropped.
    static func paragraphs(_ body: String) -> [String] {
        body.replacingOccurrences(of: "\r\n", with: "\n")
            .components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    /// "Loonstrook oktober" from "Re: Loonstrook oktober" (the thread's name).
    static func threadName(_ subject: String) -> String {
        var s = subject.trimmingCharacters(in: .whitespaces)
        while let r = s.range(of: #"^(re|aw|fw|fwd|antw)\s*:\s*"#, options: [.regularExpression, .caseInsensitive]) {
            s.removeSubrange(r)
        }
        return s
    }

    /// The draft section's head: "CONCEPT · VERSIE 2", or once Martin has
    /// changed it "CONCEPT · AANGEPAST DOOR JOU"; "VERSTUURD BERICHT" after.
    static func conceptLabel(status: String, edited: Bool, version: Int?) -> String {
        if status == "sent" { return "Verstuurd bericht" }
        if edited { return "Concept · Aangepast door jou" }
        if let version, status != "drafting" { return "Concept · Versie \(version)" }
        return "Concept"
    }

    /// The two lines under an edited draft: "1 ZIN TOEGEVOEGD DOOR JOU" over
    /// "VERSIE 2 VAN VERDER BEWAARD". Nil when nothing changed.
    static func editSummary(_ changes: DraftChanges?, version: Int?) -> (what: String, kept: String)? {
        guard let summary = changes?.summary else { return nil }
        let kept = version.map { "Versie \($0) van verder bewaard" } ?? "Het concept van verder blijft bewaard"
        return ("\(summary) door jou", kept)
    }

    /// The ⋯ menu's copy item, the frame's words.
    static let copyLabel = "Kopieer concepttekst"

    /// `copyLabel` as the system menu may draw it: WORD JOINERs inside
    /// "concepttekst", so iOS wraps the item at its space ("Kopieer" /
    /// "concepttekst") and never hyphenates it to "concept-/tekst"
    /// (measured 2026-11-04). VoiceOver reads `copyLabel`.
    static var copyMenuTitle: String { unbreakable(copyLabel) }

    /// Every word of `s` with a WORD JOINER (U+2060) between its letters.
    static func unbreakable(_ s: String) -> String {
        s.split(separator: " ", omittingEmptySubsequences: false)
            .map { $0.map(String.init).joined(separator: "\u{2060}") }
            .joined(separator: " ")
    }

    /// "Kopieer concepttekst": the subject, a blank line, the body.
    static func copyText(_ d: ReplyDraft) -> String {
        "\(d.subject)\n\n\(d.body.trimmingCharacters(in: .whitespacesAndNewlines))"
    }

    // MARK: - Send

    /// Whom a send goes to, in a sentence: "Ilse" when the one recipient is
    /// the trigger's sender, else the address(es).
    static func recipientName(to: [String], triggerFrom: String?) -> String {
        if to.count == 1, let name = displayName(triggerFrom), address(triggerFrom) == to[0].lowercased() {
            return name
        }
        return to.joined(separator: ", ")
    }

    /// "1 bijlage", "6 bijlagen", "geen bijlage".
    static func attachmentCount(_ n: Int) -> String {
        switch n {
        case 0: "geen bijlage"
        case 1: "1 bijlage"
        default: "\(n) bijlagen"
        }
    }

    /// "Naar Ilse, 1 bijlage. Annuleren stuurt niets."
    static func faceIDLine(to: [String], triggerFrom: String?, attachments: Int) -> String {
        "Naar \(recipientName(to: to, triggerFrom: triggerFrom)), \(attachmentCount(attachments)). Annuleren stuurt niets."
    }

    /// "Staat in je logboek en in de draad Loonstrook oktober."
    static func sentLine(subject: String?) -> String {
        guard let s = subject.map(threadName), !s.isEmpty else { return "Staat in je logboek." }
        return "Staat in je logboek en in de draad \(s)."
    }

    /// What a failed send says: the headline, and the worker's reason without
    /// its raw status code. "Er is niets verstuurd" only when that is known —
    /// a send that could not be found in Verzonden may have gone out.
    static func failure(_ error: String?) -> (title: String, detail: String) {
        guard let error = error?.trimmingCharacters(in: .whitespacesAndNewlines), !error.isEmpty else {
            return (SendCopy.failed, SendCopy.failedDetail)
        }
        let unsure = error.localizedCaseInsensitiveContains("verzonden")
        var reason = error.replacingOccurrences(of: #"\s*\(\d{3}\)"#, with: "", options: .regularExpression)
        reason = reason.prefix(1).uppercased() + reason.dropFirst()
        if let last = reason.last, !".?!".contains(last) { reason += "." }
        return (unsure ? SendCopy.failed : SendCopy.failedNothingSent, reason)
    }

    // MARK: - Attachments and sources

    /// Decimal units, Dutch decimal comma, as the frames: 184 320 → "184 KB",
    /// 1 100 000 → "1,1 MB".
    static func bytes(_ n: Int) -> String {
        if n < 1_000 { return "\(n) B" }
        if n < 1_000_000 { return "\(Int((Double(n) / 1_000).rounded())) KB" }
        let mb = (Double(n) / 1_000_000 * 10).rounded() / 10
        return String(format: "%.1f MB", mb).replacingOccurrences(of: ".", with: ",")
    }

    /// "PDF" from "Loonstrook.2026-10.pdf"; nil without a short extension.
    static func fileKind(_ title: String) -> String? {
        guard let dot = title.lastIndex(of: "."), dot != title.startIndex else { return nil }
        let ext = title[title.index(after: dot)...]
        guard (2...4).contains(ext.count), ext.allSatisfy({ $0.isLetter }) else { return nil }
        return ext.uppercased()
    }

    /// The list's head from three attachments up: "6 bijlagen · 4,2 MB samen".
    static func attachmentsTotal(_ rows: [ProposalDetail.Attachment]) -> String? {
        guard rows.count >= 3 else { return nil }
        return "\(rows.count) bijlagen · \(bytes(rows.reduce(0) { $0 + $1.sizeBytes })) samen"
    }

    /// One source row: its title and its meta line. The email the proposal
    /// answers reads "Mail van Ilse · MAIL · 2 NOV 09:14".
    static func source(_ c: ProposalDetail.Citation, trigger: ProposalDetail.Trigger) -> (title: String, meta: String) {
        if c.type == "email", c.id == trigger.id {
            let title = displayName(trigger.from).map { "Mail van \($0)" } ?? "De mail"
            let date = trigger.date.map { " · \(dayMonthName($0)) \(clock($0))" } ?? ""
            return (title, "Mail\(date)")
        }
        var meta: String
        switch c.type {
        case "email": meta = "Mail"
        case "document": meta = "Dossier"
        case "stop": meta = "Kaart · Halte"
        case "task": meta = "Taak"
        case "debt": meta = "Vordering"
        case "entry": meta = "Logboek"
        case "party": meta = "Partij"
        case "proposal": meta = "Eerder antwoord"
        case "kb": meta = "Kennisbank"
        default: meta = c.type
        }
        if c.type == "document", let soort = c.docType?.trimmingCharacters(in: .whitespaces), !soort.isEmpty {
            meta += " · \(soort)"
        }
        if c.type == "stop" || c.type == "task", let state = c.state.flatMap(stateName) { meta += " · \(state)" }
        return (c.label, meta)
    }

    /// "Open", "Afgerond", "Wacht": a stop's or task's state in Dutch; nil
    /// for one this build does not know (never shown raw).
    static func stateName(_ state: String) -> String? {
        switch state {
        case "open": "Open"
        case "done": "Afgerond"
        case "waiting": "Wacht"
        case "in-progress", "in_progress": "Bezig"
        case "ended": "Beëindigd"
        default: nil
        }
    }

    /// Breaks an address or a file name may take when it does not fit one
    /// line: after "@" and after each ".", never inside a word part
    /// ("Loonstrook." / "2026-10.pdf", "ilse@" / "noordkust." / "example").
    /// For DISPLAY only — the zero-width spaces must never reach a field.
    static func softBreaks(_ s: String) -> String {
        var out = ""
        for (i, ch) in s.enumerated() {
            out.append(ch)
            if (ch == "@" || ch == "."), i < s.count - 1 { out.append("\u{200B}") }
        }
        return out
    }

    static func sourcesCount(_ n: Int) -> String { n == 1 ? "1 bron" : "\(n) bronnen" }

    // MARK: - Reject

    static let rejectReasons = ["Klopt inhoudelijk niet", "Toon past niet", "Ik regel het zelf", "Niet meer nodig"]

    /// The one free-text `reason` the route takes: the chosen reason, then
    /// Martin's own words. Nil when he gave neither.
    static func rejectReason(choice: String?, free: String) -> String? {
        let words = free.trimmingCharacters(in: .whitespacesAndNewlines)
        switch (choice, words.isEmpty) {
        case (nil, true): return nil
        case (nil, false): return words
        case (let c?, true): return c
        case (let c?, false): return "\(c). \(words)"
        }
    }
}

/// What Martin changed against verder's draft, paragraph by paragraph — the
/// golden rule made visible before approving (brief §3). The server keeps its
/// own diff at approval (`proposalDiff`); this one only draws.
struct DraftChanges: Equatable {
    enum Line: Equatable {
        case same(String)
        case added(String)
    }

    /// The current body's paragraphs, each marked same or added.
    let lines: [Line]
    let addedCount: Int
    let removedCount: Int
    let subjectChanged: Bool
    let recipientsChanged: Bool
    let attachmentsAdded: Int
    let attachmentsRemoved: Int
    let summaryChanged: Bool

    init(original o: ReplyDraft, current c: ReplyDraft) {
        let a = ProposalText.paragraphs(o.body), b = ProposalText.paragraphs(c.body)
        let kept = Self.commonSubsequence(a, b)
        var lines: [Line] = []
        var k = 0
        for p in b {
            if k < kept.count, kept[k] == p { lines.append(.same(p)); k += 1 } else { lines.append(.added(p)) }
        }
        self.lines = lines
        addedCount = b.count - kept.count
        removedCount = a.count - kept.count
        subjectChanged = o.subject.trimmingCharacters(in: .whitespaces) != c.subject.trimmingCharacters(in: .whitespaces)
        recipientsChanged = Set(o.to.map { $0.lowercased() }) != Set(c.to.map { $0.lowercased() })
            || Set(o.cc.map { $0.lowercased() }) != Set(c.cc.map { $0.lowercased() })
        attachmentsAdded = Set(c.attachmentDocumentIds).subtracting(o.attachmentDocumentIds).count
        attachmentsRemoved = Set(o.attachmentDocumentIds).subtracting(c.attachmentDocumentIds).count
        summaryChanged = o.entrySummary.trimmingCharacters(in: .whitespaces) != c.entrySummary.trimmingCharacters(in: .whitespaces)
    }

    var isEmpty: Bool {
        addedCount == 0 && removedCount == 0 && !subjectChanged && !recipientsChanged
            && attachmentsAdded == 0 && attachmentsRemoved == 0 && !summaryChanged
    }

    /// "1 zin toegevoegd · onderwerp gewijzigd"; nil when nothing changed.
    var summary: String? {
        func n(_ count: Int, _ one: String, _ many: String) -> String { "\(count) \(count == 1 ? one : many)" }
        var parts: [String] = []
        if addedCount > 0 { parts.append("\(n(addedCount, "zin", "zinnen")) toegevoegd") }
        if removedCount > 0 { parts.append("\(n(removedCount, "zin", "zinnen")) weggehaald") }
        if subjectChanged { parts.append("onderwerp gewijzigd") }
        if recipientsChanged { parts.append("ontvangers gewijzigd") }
        if attachmentsAdded > 0 { parts.append("\(n(attachmentsAdded, "bijlage", "bijlagen")) erbij") }
        if attachmentsRemoved > 0 { parts.append("\(n(attachmentsRemoved, "bijlage", "bijlagen")) weg") }
        if summaryChanged { parts.append("logboekregel gewijzigd") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Longest common subsequence of two paragraph lists (small: a letter).
    static func commonSubsequence(_ a: [String], _ b: [String]) -> [String] {
        guard !a.isEmpty, !b.isEmpty else { return [] }
        var t = Array(repeating: Array(repeating: 0, count: b.count + 1), count: a.count + 1)
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            for j in stride(from: b.count - 1, through: 0, by: -1) {
                t[i][j] = a[i] == b[j] ? t[i + 1][j + 1] + 1 : max(t[i + 1][j], t[i][j + 1])
            }
        }
        var out: [String] = []
        var i = 0, j = 0
        while i < a.count, j < b.count {
            if a[i] == b[j] { out.append(a[i]); i += 1; j += 1 } else if t[i + 1][j] >= t[i][j + 1] { i += 1 } else { j += 1 }
        }
        return out
    }
}

/// Press and HOLD to send (brief §2.6, F-24): only a hold that lasted the
/// whole `duration` opens Face ID; releasing earlier cancels and nothing is
/// posted. The view feeds it touches and a clock; this decides.
struct SendHold: Equatable {
    static let duration: TimeInterval = 0.6
    /// Moments into the hold that tick a haptic, each a little firmer.
    static let ticks: [TimeInterval] = [0.15, 0.3, 0.45]

    private(set) var startedAt: Date?
    private(set) var completed = false

    var isHolding: Bool { startedAt != nil && !completed }

    mutating func press(at now: Date) {
        guard startedAt == nil else { return }
        startedAt = now
        completed = false
    }

    /// 0…1 of the way through the hold.
    func progress(at now: Date) -> Double {
        guard let s = startedAt else { return 0 }
        if completed { return 1 }
        return min(1, max(0, now.timeIntervalSince(s) / Self.duration))
    }

    /// True exactly once: the hold has lasted its whole duration.
    mutating func complete(at now: Date) -> Bool {
        guard let s = startedAt, !completed, now.timeIntervalSince(s) >= Self.duration - 0.0001 else { return false }
        completed = true
        return true
    }

    /// The finger left. Before completion that is a cancel — nothing is sent.
    /// Returns whether the hold had completed.
    @discardableResult
    mutating func release() -> Bool {
        let done = completed
        startedAt = nil
        completed = false
        return done
    }
}

/// The pinned bar under the proposal (at the accessibility sizes, the
/// "Versturen" section in the scroll): what a send would do, where it stands,
/// and the one button that moves it on. Pure: `ProposalModel.sendBar`.
struct SendBar: Equatable {
    enum Tone: Equatable { case plain, ok, problem }
    enum Button: Equatable {
        /// Press and hold; the label changes while held.
        case hold(String)
        /// Shown, not pressable, with the reason above it.
        case disabled(String)
        /// "Lees het concept": scrolls to the end of the draft.
        case readDraft
        /// "Terug naar Voor jou".
        case back
    }

    var icon: String? = nil
    var tone: Tone = .plain
    /// A spinner instead of an icon: the worker is on it.
    var spinning = false
    var title: String? = nil
    var detail: String? = nil
    /// The mono line: "NAAR ilse@noordkust.example · 1 BIJLAGE".
    var meta: String? = nil
    /// The mono moment under the words: "09:31" when the send landed.
    var stamp: String? = nil
    /// `meta` and `stamp` only in the accessibility sizes' "Versturen"
    /// section; the 402 bar leaves them out (frame "uitkomst onbekend").
    var extrasOnlyInSection = false
    var button: Button? = nil
}

enum SendCopy {
    static let hint = "Houd vast om te versturen — daarna Face ID."
    static let holding = "Loslaten stopt — er gaat dan niets weg."
    static let keepHolding = "Blijf vasthouden"
    static let send = "Versturen"
    static let confirm = "Bevestig met Face ID"
    static let waitingFaceID = "Wacht op Face ID…"
    static let cancelled = "Face ID afgebroken."
    static let cancelledDetail = "Er is niets verstuurd. Houd opnieuw vast."
    static let offline = "Versturen kan weer zodra je verbinding hebt."
    static let offlineDetail = "Aanpassen kan wel; je wijzigingen blijven staan zolang dit scherm openstaat."
    static let readGate = "Versturen wordt actief zodra je het hele concept hebt gezien."
    static let readDraft = "Lees het concept"
    static let notReady = "Vul een ontvanger, een onderwerp, de tekst en de logboekregel in om te versturen."
    static let approvedHere = "Goedgekeurd met Face ID"
    static let approved = "Goedgekeurd"
    static let approvedMeta = "Gmail bevestigt meestal binnen 1 minuut"
    static let sending = "Wordt verstuurd…"
    static let failed = "Versturen mislukt."
    static let failedNothingSent = "Versturen mislukt. Er is niets verstuurd."
    static let failedDetail = "verder kon de mail niet versturen."
    static let unknown = "Nog onbekend of het is aangekomen."
    static let unknownDetail = "Gmail gaf geen antwoord. In je Verzonden mail wordt nu gekeken; dit scherm werkt zichzelf bij."
    static let resendNotYet = "Opnieuw versturen kan nog niet"
    /// "Controle sinds 09:32".
    static func checkingSince(_ clock: String) -> String { "Controle sinds \(clock)" }
    static let rejected = "Afgewezen."
    static let rejectedDetail = "Er is niets verstuurd."
    static let superseded = "Vervangen door een nieuwer voorstel."
    static let answered = "Beantwoord."
    static let drafting = "Versturen kan zodra er een concept staat."
    static let draftFailed = "Er gaat niets weg tot jij een concept goedkeurt."
    static let back = "Terug naar Voor jou"
    static let accessibilityConfirm = "Nu versturen?"
}
