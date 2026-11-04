import Foundation
import UIKit

/// What the Dossier tab and the viewer SAY, decided outside the views
/// ("dossier · final", 2026-11-03): the soort chips, every mono readout line,
/// the sync's progress, the server's hits grouped by kind. Pure, so each rule
/// is tested as text.

/// One soort chip: "BRIEF 4".
struct DossierKind: Equatable, Identifiable, Sendable {
    /// Folded like the web's `docTypeKey` (case and whitespace), on the Dutch label.
    let key: String
    /// "brief", as the rows say it.
    let label: String
    let count: Int
    var id: String { key }
}

enum DossierKinds {
    /// A document with no soort counts as "overig", the vocabulary's own catch-all.
    static let otherLabel = "overig"

    static func label(_ docType: String?) -> String {
        DossierCopy.docTypeLabel(docType) ?? otherLabel
    }

    static func key(_ docType: String?) -> String {
        label(docType).lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Most common first, then alphabetical; counted on the phone's own copy,
    /// so the filter works offline.
    static func counts(_ docs: [IndexedDoc]) -> [DossierKind] {
        var seen: [String: (label: String, count: Int)] = [:]
        for d in docs {
            let k = key(d.doc.docType)
            seen[k, default: (label(d.doc.docType).lowercased(), 0)].count += 1
        }
        return seen.map { DossierKind(key: $0.key, label: $0.value.label, count: $0.value.count) }
            .sorted { $0.count != $1.count ? $0.count > $1.count : $0.label < $1.label }
    }

    static func filter(_ docs: [IndexedDoc], kind: String?) -> [IndexedDoc] {
        guard let kind else { return docs }
        return docs.filter { key($0.doc.docType) == kind }
    }

    /// The chips a regular size shows: Alles, the most common soort, the
    /// chosen one when it is not that, and "Meer soorten" for the rest.
    static func visible(_ kinds: [DossierKind], selected: String?) -> (shown: [DossierKind], more: [DossierKind]) {
        guard let top = kinds.first else { return ([], []) }
        var shown = [top]
        if let selected, selected != top.key, let chosen = kinds.first(where: { $0.key == selected }) {
            shown.append(chosen)
        }
        let keys = Set(shown.map(\.key))
        return (shown, kinds.filter { !keys.contains($0.key) })
    }

    /// The SF Symbol for a soort (envelope for a letter, bank for a statement).
    static func symbol(_ docType: String?) -> String {
        switch key(docType) {
        case "brief": "envelope"
        case "loonstrook": "doc.text"
        case "bankafschrift": "building.columns"
        case "id-bewijs": "person.text.rectangle"
        case "contract": "doc.badge.ellipsis"
        case "factuur": "eurosign.square"
        default: "doc"
        }
    }
}

enum DossierLine {
    private static var amsterdam: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
        return cal
    }

    /// "28 okt"; with the year when it is not this year ("1 mrt 2025").
    static func day(_ date: Date, now: Date) -> String {
        let cal = amsterdam
        let year = cal.component(.year, from: date)
        return year == cal.component(.year, from: now) ? MoneyFormat.day(date) : "\(MoneyFormat.day(date)) \(year)"
    }

    /// "di 3 nov".
    static func weekdayDay(_ date: Date, now: Date) -> String {
        let names = ["zo", "ma", "di", "wo", "do", "vr", "za"]
        return "\(names[amsterdam.component(.weekday, from: date) - 1]) \(day(date, now: now))"
    }

    /// "0,4 MB", "9,8 MB"; under a tenth of a megabyte in kB ("2 kB").
    static func size(_ bytes: Int) -> String {
        if bytes < 100_000 { return "\(max(1, Int((Double(bytes) / 1000).rounded()))) kB" }
        let tenths = Int((Double(bytes) / 100_000).rounded())
        return "\(tenths / 10),\(tenths % 10) MB"
    }

    /// "4,1 van 9,8 MB".
    static func sizes(_ done: Int, of total: Int) -> String {
        let a = size(done), b = size(total)
        let unit = b.hasSuffix(" MB") ? " MB" : " kB"
        if a.hasSuffix(unit) && b.hasSuffix(unit) { return "\(a.dropLast(unit.count)) van \(b)" }
        return "\(a) van \(b)"
    }

    /// Whether the title already says the day ("Sommatie Kade & Partners 14 okt").
    static func titleSaysDay(_ title: String, date: Date) -> Bool {
        title.lowercased().contains(MoneyFormat.day(date).lowercased())
    }

    static func pages(_ n: Int) -> String { "\(n) blz" }

    /// A document row's readout: soort and day, the pages filling in when the
    /// filter already names the soort or the title already says the day,
    /// then "foto-scan" and "niet opgeborgen" when they apply. "overig" says
    /// nothing in the list and is left out there; a search hit names it.
    static func row(_ d: IndexedDoc, filtered: Bool = false, inSearch: Bool = false, now: Date) -> [String] {
        let doc = d.doc
        var soort: String? = filtered ? nil : DossierKinds.label(doc.docType)
        if soort == DossierKinds.otherLabel && !inSearch { soort = nil }
        let day = titleSaysDay(doc.title, date: doc.receivedAt) ? nil : day(doc.receivedAt, now: now)
        var parts = [soort, day].compactMap { $0 }
        if filtered || day == nil, let n = d.pages { parts.append(pages(n)) }
        if doc.source == "phone-scan" { parts.append("foto-scan") }
        if doc.status != "filed" && !inSearch { parts.append("niet opgeborgen") }
        return parts
    }

    /// The viewer's line above the title: "brief · 2 blz · opgeborgen",
    /// "id-bewijs · 12 sep · foto-scan", and for a document not on the
    /// phone "loonstrook · 28 okt · 0,4 MB".
    static func viewer(_ doc: DossierDoc, pages: Int?, held: Bool, now: Date) -> [String] {
        var parts = [DossierKinds.label(doc.docType)]
        if let pages, pages > 1 { parts.append(Self.pages(pages)) } else { parts.append(day(doc.receivedAt, now: now)) }
        if doc.source == "phone-scan" { parts.append("foto-scan") }
        else if held { parts.append(doc.status == "filed" ? "opgeborgen" : "niet opgeborgen") }
        else { parts.append(size(doc.sizeBytes)) }
        return parts
    }

    /// An open task's readout, all of it waiting on Martin: "wacht op jou ·
    /// te laat · 30 okt", "wacht op jou · uiterlijk di 3 nov", "… · morgen
    /// 17:00", on Amsterdam's calendar.
    static func task(dueAt: Date?, now: Date) -> [String] {
        let lead = "wacht op jou"
        guard let due = dueAt else { return [lead] }
        let cal = amsterdam
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: now), to: cal.startOfDay(for: due)).day ?? 0
        if due < now { return [lead, "te laat", day(due, now: now)] }
        if days == 0 { return [lead, "vandaag \(HomeSummary.clock(due))"] }
        if days == 1 { return [lead, "morgen \(HomeSummary.clock(due))"] }
        return [lead, "uiterlijk \(weekdayDay(due, now: now))"]
    }

    /// "wacht op jou · 28 okt": the open stop waits on Martin by definition
    /// (every open stop is his work — case-history.test.ts).
    static func headline(happenedAt: Date?, now: Date) -> [String] {
        ["wacht op jou"] + [happenedAt.map { day($0, now: now) }].compactMap { $0 }
    }

    /// Mono readout parts on one line: uppercase, joined so a wrap falls
    /// after a " ·", never before (`HomeSummary.metaLine`).
    static func joined(_ parts: [String]) -> String {
        HomeSummary.metaLine(parts.map { $0.uppercased() })
    }
}

/// The first sync's card, and a later sync's eyebrow.
enum DossierProgressCopy {
    struct Card: Equatable, Sendable {
        let label: String
        let headline: String
        /// 0…1 when the whole is known.
        let fraction: Double?
        let meta: String
        let body: String
        let interrupted: Bool
    }

    static let label = "dossier ophalen"
    static let interruptedLabel = "dossier ophalen · onderbroken"
    static let promise = "Daarna staat alles op deze iPhone, ook zonder verbinding — handig aan de balie."
    static let kept = "De verbinding viel weg. Wat al binnen is, blijft op deze iPhone staan."
    static let keptNoServer = "verder was even niet bereikbaar. Wat al binnen is, blijft op deze iPhone staan."
    static let resume = "Haal de rest op"
    static let waiting = "wacht op verbinding"

    /// `held`: documents on the phone; `heldBytes` their size. `eta` in seconds.
    static func card(held: Int, heldBytes: Int, total: Int?, totalBytes: Int?, interrupted: Bool,
                     offline: Bool, eta: TimeInterval?) -> Card {
        let headline = total.map { "\(held) van \($0) documenten" } ?? "\(held) \(held == 1 ? "document" : "documenten") binnen"
        let fraction: Double? = {
            if let totalBytes, totalBytes > 0 { return min(1, Double(heldBytes) / Double(totalBytes)) }
            if let total, total > 0 { return min(1, Double(held) / Double(total)) }
            return nil
        }()
        var meta = [totalBytes.map { DossierLine.sizes(heldBytes, of: $0) } ?? "\(DossierLine.size(heldBytes)) binnen"]
        if interrupted { if offline { meta.append(waiting) } }
        else if let eta, let e = remaining(eta) { meta.append(e) }
        return Card(label: interrupted ? interruptedLabel : label, headline: headline, fraction: fraction,
                    meta: meta.joined(separator: " · "), body: interrupted ? (offline ? kept : keptNoServer) : promise,
                    interrupted: interrupted)
    }

    /// "nog ongeveer 20 seconden"; nil before there is a rate to trust.
    static func remaining(_ seconds: TimeInterval) -> String? {
        guard seconds.isFinite, seconds >= 0 else { return nil }
        if seconds < 15 { return "nog een paar seconden" }
        if seconds < 90 { return "nog ongeveer \(Int((seconds / 10).rounded()) * 10) seconden" }
        let minutes = Int((seconds / 60).rounded())
        return "nog ongeveer \(minutes) \(minutes == 1 ? "minuut" : "minuten")"
    }

    /// The estimate from what this run moved so far; nil in its first two
    /// seconds or before any byte arrived (the first answers are no rate).
    static func eta(bytesThisRun: Int, elapsed: TimeInterval, bytesLeft: Int) -> TimeInterval? {
        guard elapsed >= 2, bytesThisRun > 0, bytesLeft >= 0 else { return nil }
        return Double(bytesLeft) / (Double(bytesThisRun) / elapsed)
    }

    /// The eyebrow while a later sync runs: "bijwerken… · 2 van 3 nieuw".
    static func updating(done: Int, due: Int) -> String {
        due > 0 ? "bijwerken… · \(min(done, due)) van \(due) nieuw" : "bijwerken…"
    }

    /// "documenten · 5 van 12 binnen".
    static func documentsLabel(held: Int, total: Int?) -> String {
        total.map { "documenten · \(held) van \($0) binnen" } ?? "documenten · \(held) binnen"
    }
}

/// The server's hits, grouped by kind under "OP DE SERVER" (frame
/// "Zoeken / op de server · resultaten"): mails, documents, tasks, log.
struct ServerHitGroup: Equatable, Identifiable, Sendable {
    let entityType: String
    let label: String
    let hits: [SearchHit]
    var id: String { entityType }
}

enum ServerHits {
    static let order = ["email", "document", "task", "entry"]

    static func label(_ entityType: String) -> String {
        switch entityType {
        case "email": "mails"
        case "document": "documenten"
        case "task": "taken"
        case "entry": "logboek"
        default: entityType
        }
    }

    /// Documents the phone already holds are left out: they are listed
    /// under "OP DEZE IPHONE" already, so every server hit shown is new.
    static func fresh(_ hits: [SearchHit], held: Set<String>) -> [SearchHit] {
        hits.filter { !($0.entityType == "document" && held.contains($0.entityId)) }
    }

    static func groups(_ hits: [SearchHit]) -> [ServerHitGroup] {
        let kinds = order + hits.map(\.entityType).filter { !order.contains($0) }.reduce(into: [String]()) {
            if !$0.contains($1) { $0.append($1) }
        }
        return kinds.compactMap { kind in
            let these = hits.filter { $0.entityType == kind }
            return these.isEmpty ? nil : ServerHitGroup(entityType: kind, label: label(kind), hits: these)
        }
    }

    /// A task waits on Martin by the one definition (open or in progress);
    /// only then is its line amber.
    static func waitsOnMartin(_ hit: SearchHit) -> Bool {
        hit.entityType == "task" && (hit.status == "open" || hit.status == "in-progress")
    }

    /// "ILSE, NOORDKUST · 28 OKT", "WACHT OP JOU · 3 NOV", "WACHT OP
    /// GEMEENTE WESTERLAAN", "TELEFOON · 27 OKT".
    static func detail(_ hit: SearchHit, now: Date) -> [String] {
        let day = hit.occurredAt.flatMap(parseISODate).map { DossierLine.day($0, now: now) }
        switch hit.entityType {
        case "email":
            return [hit.from ?? "mail", day].compactMap { $0 }
        case "task":
            if waitsOnMartin(hit) { return ["wacht op jou", day].compactMap { $0 } }
            if hit.status == "waiting" { return ["wacht op \(hit.assigneeName ?? "een ander")"] }
            if hit.status == "done" { return ["gedaan", day].compactMap { $0 } }
            return ["taak", day].compactMap { $0 }
        case "entry":
            return [channel(hit.channel) ?? "logboek", day].compactMap { $0 }
        case "document":
            return ["document", day].compactMap { $0 }
        default:
            return [hit.entityType, day].compactMap { $0 }
        }
    }

    static func channel(_ raw: String?) -> String? {
        switch raw {
        case nil: nil
        case "phone"?: "telefoon"
        case "email"?: "mail"
        case "letter"?: "brief"
        case "in-person"?, "visit"?: "gesprek"
        case let other?: other
        }
    }

    static func symbol(_ hit: SearchHit) -> String {
        switch hit.entityType {
        case "email": "envelope"
        case "task": "checkmark.circle"
        case "entry": "book.closed"
        default: "doc"
        }
    }
}

/// Local search's words, beyond `DossierSearch`.
enum DossierSearchCopy {
    static let localLabel = "op deze iphone"
    static let serverLabel = "op de server"
    static let serverWhy = "Op de server zoek je ook in je mails, taken en logboek."
    static let serverButton = "Zoek op de server"
    static let serverRetry = "Zoek opnieuw op de server"
    static let serverBusy = "Zoekt op de server…"
    static let serverOffline = "Zoeken op de server kan weer zodra je online bent."
    static let unreachableLabel = "server niet bereikbaar"
    static let timedOut = "De server gaf binnen 10 seconden geen antwoord. Je zoekterm staat nog klaar."
    static let nothingHere = "Niets gevonden op deze iPhone"
    static let alsoNothingThere = "Ook op de server niets gevonden."
    static let clear = "Wis zoekopdracht"
    static let cancel = "Annuleer"
    static let new = "nieuw"
    static let filterApplies = "Het filter geldt ook als je zoekt."
    static let clearFilter = "Wis filter"
    static let moreKinds = "meer soorten"
    static let all = "alles"
    static let newestFirst = "nieuwste eerst"
    static let axHint = "Zoekt in titel en tekst"
    static let axPrompt = "Zoek"

    /// "1 document zonder herkende tekst is alleen op de titel doorzocht."
    static func titleOnly(_ n: Int) -> String? {
        switch n {
        case ..<1: nil
        case 1: "1 document zonder herkende tekst is alleen op de titel doorzocht."
        default: "\(n) documenten zonder herkende tekst zijn alleen op de titel doorzocht."
        }
    }

    static func nothingAnywhere(_ query: String) -> String {
        "Niets gevonden voor “\(query.trimmingCharacters(in: .whitespacesAndNewlines))”"
    }

    /// "Niet op deze iPhone, en ook niet in je mails, taken en logboek op de
    /// server. Probeer een kortere zoekterm, zoals “huur”."
    static func nothingAnywhereBody(shorter: String?) -> String {
        let tip = shorter.map { " Probeer een kortere zoekterm, zoals “\($0)”." } ?? " Probeer een kortere zoekterm."
        return "Niet op deze iPhone, en ook niet in je mails, taken en logboek op de server." + tip
    }

    /// A shorter term that DOES occur: the longest beginning (at least three
    /// letters) of the query's first word that starts a word in a document on
    /// the phone ("huurtoeslag" → "huur", which "Huurcontract" starts with).
    /// Nil when the word is short or no beginning occurs.
    static func shorterTerm(_ query: String, in docs: [IndexedDoc]) -> String? {
        guard let word = DossierSearch.words(query).first, word.count > 3 else { return nil }
        let starts: Set<Substring> = docs.reduce(into: []) { set, d in
            for w in d.haystack.split(whereSeparator: { !$0.isLetter && !$0.isNumber }) { set.insert(w) }
        }
        for n in stride(from: word.count - 1, through: 3, by: -1) {
            let prefix = word.prefix(n)
            if starts.contains(where: { $0.hasPrefix(prefix) }) { return String(prefix) }
        }
        return nil
    }

    /// The query's words, marked in a title or snippet (bold "bijstand"), on
    /// the ORIGINAL text: case-, diacritic- and width-insensitive, like the
    /// search that found it.
    static func marked(_ text: String, query: String) -> [SearchSnippet.Segment] {
        let words = DossierSearch.words(query)
        guard !words.isEmpty else { return [SearchSnippet.Segment(text: text, marked: false)] }
        let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]
        var ranges: [Range<String.Index>] = []
        for w in words {
            var from = text.startIndex
            while from < text.endIndex,
                  let r = text.range(of: w, options: options, range: from..<text.endIndex, locale: Locale(identifier: "nl_NL")) {
                ranges.append(r)
                from = r.upperBound
            }
        }
        ranges.sort { $0.lowerBound < $1.lowerBound }
        var out: [SearchSnippet.Segment] = []
        var at = text.startIndex
        for r in ranges where r.lowerBound >= at {
            if r.lowerBound > at { out.append(.init(text: String(text[at..<r.lowerBound]), marked: false)) }
            out.append(.init(text: String(text[r]), marked: true))
            at = r.upperBound
        }
        if at < text.endIndex { out.append(.init(text: String(text[at...]), marked: false)) }
        return out
    }
}

/// The viewer's page readout: "PAGINA 1 VAN 2" under the page, "1 van 2" at
/// the accessibility sizes, "1 / 2" at the counter.
enum PageIndicator {
    enum Style { case full, short, counter }

    static func label(page: Int, of count: Int, style: Style) -> String {
        let p = min(max(page, 1), max(count, 1))
        switch style {
        case .full: return "pagina \(p) van \(count)"
        case .short: return "\(p) van \(count)"
        case .counter: return "\(p) / \(count)"
        }
    }

    static func canGoBack(page: Int) -> Bool { page > 1 }
    static func canGoForward(page: Int, of count: Int) -> Bool { page < count }

    /// "230 %": the zoom against the fitted page.
    static func zoom(scale: CGFloat, fit: CGFloat) -> String {
        guard fit > 0 else { return "100 %" }
        return "\(Int((scale / fit * 100 / 10).rounded()) * 10) %"
    }

    /// Zoomed in far enough to say so (and to offer "dubbeltik: hele pagina").
    static func isZoomed(scale: CGFloat, fit: CGFloat) -> Bool { fit > 0 && scale > fit * 1.05 }
}

/// "Toon aan de balie": the screen at full brightness while it shows, and
/// back to what it was the moment it closes — by ×, by the swipe, or by the
/// app leaving the foreground. The screen never dims or locks meanwhile.
/// The brightness is injected, so the restore is tested without a screen.
@MainActor
final class BrightnessGuard {
    private let read: () -> CGFloat
    private let write: (CGFloat) -> Void
    private let keepAwake: (Bool) -> Void
    /// What it was before the counter took over; nil while not raised.
    private(set) var saved: CGFloat?

    init(read: @escaping () -> CGFloat, write: @escaping (CGFloat) -> Void, keepAwake: @escaping (Bool) -> Void) {
        self.read = read
        self.write = write
        self.keepAwake = keepAwake
    }

    /// The phone's own screen (the first window scene's), and its idle timer.
    static func live() -> BrightnessGuard {
        func screen() -> UIScreen? {
            UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.screen }.first
        }
        return BrightnessGuard(read: { screen()?.brightness ?? 0.5 },
                               write: { screen()?.brightness = $0 },
                               keepAwake: { UIApplication.shared.isIdleTimerDisabled = $0 })
    }

    var isRaised: Bool { saved != nil }

    /// Raises once: a second call keeps the ORIGINAL level to go back to.
    func raise() {
        guard saved == nil else { return }
        saved = read()
        write(1)
        keepAwake(true)
    }

    func restore() {
        guard let level = saved else { return }
        write(level)
        keepAwake(false)
        saved = nil
    }
}
