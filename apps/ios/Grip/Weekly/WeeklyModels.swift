import Foundation

/// `GET /api/mobile/v1/weekly`: the Sunday summary exactly as the worker
/// stored it (`WeeklySummary` in packages/api/src/weekly-summary.ts, the
/// contract written under Plan 3 Task 26).
///
/// `from`/`to` are INSTANTS, the half-open window `[from, to)` = previous
/// Sunday 18:00 to this Sunday 18:00 Amsterdam — never Monday–Sunday day keys.
/// `waiting`/`topWaiting` are a snapshot taken at that Sunday 18:00.
///
/// The decode is strict the way the server's `isWeeklySummary` is: a missing
/// field, a malformed week key or a negative count fails the whole answer,
/// which `APIClient.decode` reports as no usable answer — never a default.
///
/// TWO OPTIONAL FIELDS the "weekly · final" frames need and the route does
/// not serve yet: `history` (the previous ≤ 7 stored summaries, the chart and
/// every "vorige week: N") and `renamedByGrip` (auto-name's renames that
/// week, "1 scan een naam gegeven"). ABSENT MEANS NOT KNOWN, and the screen
/// then draws no chart, no comparison and no rename row — it never invents a
/// figure. Present, they are checked as strictly as the rest.
struct WeeklyDTO: Codable, Equatable, Sendable {
    let week: String
    let from: Date
    let to: Date
    let sent: Int
    let received: Int
    let filedByMartin: Int
    let filedByGrip: Int
    let tasksDone: Int
    let waiting: Int
    let topWaiting: [WaitingItem]
    /// The earlier summaries, any order; nil when the server sent none.
    let history: [WeeklyPastWeek]?
    /// Scans auto-name renamed in the window; nil when not served.
    let renamedByGrip: Int?

    private enum CodingKeys: String, CodingKey {
        case week, from, to, sent, received, filedByMartin, filedByGrip, tasksDone, waiting, topWaiting
        case history, renamedByGrip
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        week = try c.decode(String.self, forKey: .week)
        guard WeeklyFormat.weekNumber(week) != nil else {
            throw DecodingError.dataCorruptedError(forKey: .week, in: c, debugDescription: "not an ISO week key: \(week)")
        }
        from = try c.decode(Date.self, forKey: .from)
        to = try c.decode(Date.self, forKey: .to)
        func count(_ key: CodingKeys) throws -> Int {
            let n = try c.decode(Int.self, forKey: key)
            guard n >= 0 else {
                throw DecodingError.dataCorruptedError(forKey: key, in: c, debugDescription: "a count is never negative")
            }
            return n
        }
        sent = try count(.sent)
        received = try count(.received)
        filedByMartin = try count(.filedByMartin)
        filedByGrip = try count(.filedByGrip)
        tasksDone = try count(.tasksDone)
        waiting = try count(.waiting)
        topWaiting = try c.decode([WaitingItem].self, forKey: .topWaiting)
        history = try c.decodeIfPresent([WeeklyPastWeek].self, forKey: .history)
        renamedByGrip = try c.decodeIfPresent(Int.self, forKey: .renamedByGrip)
        if let r = renamedByGrip, r < 0 {
            throw DecodingError.dataCorruptedError(forKey: .renamedByGrip, in: c, debugDescription: "a count is never negative")
        }
    }

    /// The steps Martin took himself: what he sent, filed and finished.
    var steps: Int { sent + filedByMartin + tasksDone }
}

/// One earlier stored summary, counts only.
struct WeeklyPastWeek: Codable, Equatable, Sendable {
    let week: String
    let sent: Int
    let received: Int
    let filedByMartin: Int
    let filedByGrip: Int
    let tasksDone: Int
    let waiting: Int

    private enum CodingKeys: String, CodingKey {
        case week, sent, received, filedByMartin, filedByGrip, tasksDone, waiting
    }

    init(week: String, sent: Int, received: Int, filedByMartin: Int, filedByGrip: Int, tasksDone: Int, waiting: Int) {
        self.week = week
        self.sent = sent
        self.received = received
        self.filedByMartin = filedByMartin
        self.filedByGrip = filedByGrip
        self.tasksDone = tasksDone
        self.waiting = waiting
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        week = try c.decode(String.self, forKey: .week)
        guard WeeklyFormat.weekNumber(week) != nil else {
            throw DecodingError.dataCorruptedError(forKey: .week, in: c, debugDescription: "not an ISO week key: \(week)")
        }
        func count(_ key: CodingKeys) throws -> Int {
            let n = try c.decode(Int.self, forKey: key)
            guard n >= 0 else {
                throw DecodingError.dataCorruptedError(forKey: key, in: c, debugDescription: "a count is never negative")
            }
            return n
        }
        sent = try count(.sent)
        received = try count(.received)
        filedByMartin = try count(.filedByMartin)
        filedByGrip = try count(.filedByGrip)
        tasksDone = try count(.tasksDone)
        waiting = try count(.waiting)
    }

    var steps: Int { sent + filedByMartin + tasksDone }
    var filed: Int { filedByMartin + filedByGrip }
}

/// How the summary's week reads. Locale-free, like `MoneyFormat`: the words
/// are spelled here so an English simulator renders what Martin's phone does.
enum WeeklyFormat {
    static let weekdaysLong = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"]
    static let monthsLong = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus",
                             "september", "oktober", "november", "december"]

    /// ISO 8601 weeks on Amsterdam's clock: Monday first, week 1 holds 4 Jan.
    static var calendar: Calendar {
        var cal = Calendar(identifier: .iso8601)
        cal.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
        return cal
    }

    /// "2026-W44" → 44; nil for anything not `^\d{4}-W\d{2}$` with a week 1…53.
    static func weekNumber(_ key: String) -> Int? {
        let parts = key.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].count == 4, parts[0].allSatisfy(\.isASCII), Int(parts[0]) != nil,
              parts[1].count == 3, parts[1].first == "W",
              parts[1].dropFirst().allSatisfy({ $0.isASCII && $0.isNumber }),
              let n = Int(parts[1].dropFirst()), (1...53).contains(n) else { return nil }
        return n
    }

    /// "2026-W44" → "week 44".
    static func weekLabel(_ key: String) -> String {
        weekNumber(key).map { "week \($0)" } ?? key
    }

    /// The ISO week key an instant falls in, in Amsterdam: Sun 1 nov → "2026-W44".
    static func weekKey(_ date: Date) -> String {
        let c = calendar.dateComponents([.yearForWeekOfYear, .weekOfYear], from: date)
        let w = c.weekOfYear ?? 0
        return "\(c.yearForWeekOfYear ?? 0)-W\(w < 10 ? "0" : "")\(w)"
    }

    /// The newest Sunday 18:00 Amsterdam at or before `now`: when the summary
    /// the phone should hold was composed.
    static func lastClose(atOrBefore now: Date) -> Date {
        let cal = calendar
        let weekday = cal.component(.weekday, from: now) // 1 = Sunday
        let back = (weekday - 1) % 7
        let day = cal.date(byAdding: .day, value: -back, to: now) ?? now
        let close = cal.date(bySettingHour: 18, minute: 0, second: 0, of: day) ?? day
        return close <= now ? close : (cal.date(byAdding: .day, value: -7, to: close) ?? close)
    }

    /// The first Sunday 18:00 Amsterdam after `now`: when the next summary comes.
    static func nextClose(after now: Date) -> Date {
        let last = lastClose(atOrBefore: now)
        return calendar.date(byAdding: .day, value: 7, to: last) ?? last
    }

    /// An instant on Amsterdam's clock → "zo 25 okt 18:00".
    static func instant(_ date: Date) -> String {
        "\(day(date)) \(clock(date))"
    }

    /// "vr 30 okt".
    static func day(_ date: Date) -> String {
        let c = calendar.dateComponents([.weekday, .day, .month], from: date)
        return "\(MoneyFormat.weekdays[(c.weekday ?? 1) - 1]) \(c.day ?? 0) \(MoneyFormat.months[(c.month ?? 1) - 1])"
    }

    /// "31 okt".
    static func dayMonth(_ date: Date) -> String {
        let c = calendar.dateComponents([.day, .month], from: date)
        return "\(c.day ?? 0) \(MoneyFormat.months[(c.month ?? 1) - 1])"
    }

    /// "8 november".
    static func dayMonthLong(_ date: Date) -> String {
        let c = calendar.dateComponents([.day, .month], from: date)
        return "\(c.day ?? 0) \(monthsLong[(c.month ?? 1) - 1])"
    }

    /// "zondag 1 november 18:00", for VoiceOver.
    static func spokenInstant(_ date: Date) -> String {
        let c = calendar.dateComponents([.weekday], from: date)
        return "\(weekdaysLong[(c.weekday ?? 1) - 1]) \(dayMonthLong(date)) \(clock(date))"
    }

    /// "19:02".
    static func clock(_ date: Date) -> String {
        let c = calendar.dateComponents([.hour, .minute], from: date)
        return "\(two(c.hour ?? 0)):\(two(c.minute ?? 0))"
    }

    /// "zo 18:00": the weekday and time of the snapshot.
    static func weekdayClock(_ date: Date) -> String {
        let c = calendar.dateComponents([.weekday], from: date)
        return "\(MoneyFormat.weekdays[(c.weekday ?? 1) - 1]) \(clock(date))"
    }

    /// The window as the two instants it is: "zo 25 okt 18:00 – zo 1 nov 18:00".
    /// `to` is NOT inclusive and is never turned into the day before.
    static func window(from: Date, to: Date) -> String {
        "\(instant(from)) – \(instant(to))"
    }

    /// The header: "WEEK 44" and "T/M ZO 1 NOV 18:00" (two lines at AX sizes).
    static func eyebrow(week: String, closesAt: Date) -> [String] {
        [weekLabel(week).uppercased(), "t/m \(instant(closesAt))".uppercased()]
    }

    private static func two(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }
}

/// What waits on Martin NOW (`InboxStore`): the screen's only amber.
struct WeeklyLive: Equatable, Sendable {
    /// Nil until Voor jou has loaded once.
    var count: Int?
    /// The oldest waiting item's moment: "de oudste sinds 31 okt".
    var oldestAt: Date?
    /// When the last waiting item was dealt with (the calm ending).
    var lastClearedAt: Date?
    /// Set when the count is a kept one (the last refresh failed): its stand.
    var keptAt: Date?

    init(count: Int? = nil, oldestAt: Date? = nil, lastClearedAt: Date? = nil, keptAt: Date? = nil) {
        self.count = count
        self.oldestAt = oldestAt
        self.lastClearedAt = lastClearedAt
        self.keptAt = keptAt
    }
}

/// Everything the Weekoverzicht's SUMMARY says, decided outside the view.
///
/// COMPARED WITH MARTIN'S OWN PAST WEEKS ONLY, and only with weeks the server
/// counted (`history`): without it there is no chart, no average and no
/// "vorige week". Never a red deficit: a week below the average is "een
/// rustige week — en dat mag" (Gentler Streak, brief §7).
///
/// AMBER IS LIVE OR NOT AT ALL. Everything the stored summary says — the
/// counts AND Sunday's waiting snapshot ("4 wachtten op je") — is history: the
/// screen opens any day of the week, and an item that waited on Sunday may
/// have been decided since. The only amber is the live card's (`LiveCard`),
/// the same count as Voor jou, the badge and the dashboard (`loadWaiting`).
struct WeeklyScreen: Equatable, Sendable {
    /// How a line is drawn; the view switches on it and decides no colour itself.
    enum Tone: Hashable, Sendable {
        /// The ink scale: information, including what waited on Sunday.
        case history
        /// Amber: waits on Martin NOW, by the live count.
        case waitsOnMartin
    }

    struct Hero: Equatable, Sendable {
        let value: Int
        /// "stappen door jou" / "stap door jou".
        let words: String
        /// "3 verstuurd", "3 door jou opgeborgen", "2 taken klaar" — one per line.
        let parts: [String]
        var accessibilityLabel: String { "\(value) \(words): \(parts.joined(separator: ", "))" }
    }

    /// The sentence under the hero, and its AX-size spelling (one short clause).
    struct Sentence: Equatable, Sendable {
        let full: String
        let compact: String
    }

    struct Chart: Equatable, Sendable {
        struct Bar: Equatable, Sendable, Identifiable {
            var id: String { week }
            let week: String
            /// "W37".
            let label: String
            /// Nil: no summary for that week (a dashed slot).
            let value: Int?
            let isCurrent: Bool
        }

        /// Where a bar's value sits, so it never touches the dashed average.
        enum Placement: Equatable, Sendable {
            /// 4 above its bar.
            case above
            /// Inside the bar, 8 below its top, in ink-bright.
            case inside
            /// 8 above the average line (a bar too short to hold it).
            case aboveLine
        }

        static let plotHeight: Double = 64
        static let minBar: Double = 8
        static let labelHeight: Double = 16
        static let labelGap: Double = 4
        static let lineClearance: Double = 8

        let title: String
        let bars: [Bar]
        let average: Int?
        let caption: String?
        let accessibilityLabel: String

        var scaleMax: Int { max(bars.compactMap(\.value).max() ?? 0, average ?? 0, 1) }

        func height(_ value: Int) -> Double {
            max(Self.minBar, Self.plotHeight * Double(value) / Double(scaleMax))
        }

        var averageHeight: Double? { average.map { Self.plotHeight * Double($0) / Double(scaleMax) } }

        func placement(_ value: Int) -> Placement {
            guard let line = averageHeight else { return .above }
            let h = height(value)
            let bottom = h + Self.labelGap, top = bottom + Self.labelHeight
            if bottom >= line + Self.lineClearance || top <= line - Self.lineClearance { return .above }
            return h >= Self.labelHeight + 2 * Self.labelGap + 4 ? .inside : .aboveLine
        }
    }

    struct Row: Equatable, Sendable, Identifiable {
        enum Destination: Hashable, Sendable {
            /// The Dossier (mail, scans, filed documents).
            case dossier
            /// Voor jou's "Door Grip gedaan" list.
            case doneByGrip
        }
        let id: String
        let title: String
        /// Lines of parts: joined with " · " at ordinary sizes, one part per
        /// line at accessibility sizes.
        let lines: [[String]]
        let destination: Destination?
        var accessibilityLabel: String {
            ([title] + lines.flatMap { $0 }).joined(separator: ", ")
        }
    }

    static let title = "Weekoverzicht"
    var title: String { Self.title }
    static let retry = "Opnieuw proberen"
    static let happenedLabel = "WAT ER GEBEURDE"
    static let gripLabel = "DOOR GRIP GEDAAN"

    let week: String
    let closesAt: Date
    let eyebrow: [String]
    let eyebrowSpoken: String
    let windowLine: String
    let hero: Hero
    let sentence: Sentence?
    let chart: Chart?
    let rows: [Row]
    let grip: [Row]
    /// Meer's Weekoverzicht row: "week 44 · 3 verstuurd · 5 opgeborgen".
    let meer: MoreMenu.State.WeeklyLine

    init(_ d: WeeklyDTO) {
        meer = MoreMenu.weekly(d)
        week = d.week
        closesAt = d.to
        eyebrow = WeeklyFormat.eyebrow(week: d.week, closesAt: d.to)
        eyebrowSpoken = "\(WeeklyFormat.weekLabel(d.week).capitalized), tot en met \(WeeklyFormat.spokenInstant(d.to))"
        windowLine = "\(WeeklyFormat.weekLabel(d.week)) · \(WeeklyFormat.window(from: d.from, to: d.to))"

        let steps = d.steps
        hero = Hero(value: steps, words: steps == 1 ? "stap door jou" : "stappen door jou", parts: [
            d.sent == 0 ? "niets verstuurd" : "\(d.sent) verstuurd",
            d.filedByMartin == 0 ? "niets door jou opgeborgen" : "\(d.filedByMartin) door jou opgeborgen",
            Self.tasks(d.tasksDone, zero: "geen taken klaar"),
        ])

        // The eight weeks ending with this one, oldest first.
        let cal = WeeklyFormat.calendar
        let keys = (0..<8).reversed().map { k in
            WeeklyFormat.weekKey(cal.date(byAdding: .day, value: -7 * k, to: d.to) ?? d.to)
        }
        let past = Dictionary((d.history ?? []).map { ($0.week, $0) }, uniquingKeysWith: { a, _ in a })
        let previous = keys.dropLast().last.flatMap { past[$0] }

        if d.history != nil {
            let earlier = keys.dropLast().compactMap { past[$0]?.steps }
            let covered = earlier.count + 1
            let average = covered >= 3 ? Int((Double(earlier.reduce(0, +)) / Double(earlier.count)).rounded()) : nil
            let bars = keys.map { key in
                Chart.Bar(week: key, label: "W\(WeeklyFormat.weekNumber(key) ?? 0)",
                          value: key == d.week || key == keys.last ? steps : past[key]?.steps,
                          isCurrent: key == keys.last)
            }
            let firstCovered = bars.firstIndex { $0.value != nil } ?? 7
            let gaps = bars.filter { $0.value == nil }.count
            let caption: String? = gaps == 0 ? nil
                : (bars.prefix(firstCovered).count == gaps
                   ? "geen data vóór week \(WeeklyFormat.weekNumber(bars[firstCovered].week) ?? 0)"
                   : "geen data voor \(gaps) \(gaps == 1 ? "week" : "weken")")
            let spokenBars = bars.compactMap { b in
                b.value.map { "week \(b.label.dropFirst()), \($0) \($0 == 1 ? "stap" : "stappen")" }
            }
            let spoken = (["Jouw stappen, \(covered) weken"] + spokenBars
                          + [average.map { "gemiddeld \($0)" }, caption].compactMap { $0 }).joined(separator: "; ")
            chart = Chart(title: "JOUW STAPPEN · \(covered) \(covered == 1 ? "WEEK" : "WEKEN")", bars: bars,
                          average: average, caption: caption, accessibilityLabel: spoken)
            switch average {
            case let avg? where steps > avg:
                sentence = Sentence(full: "Meer dan je gemiddelde van \(avg) per week. Goed bezig.",
                                    compact: "Meer dan je gemiddelde (\(avg)). Goed bezig.")
            case let avg? where steps == avg:
                sentence = Sentence(full: "Precies je gemiddelde van \(avg) per week.",
                                    compact: "Precies je gemiddelde (\(avg)).")
            case .some:
                sentence = Sentence(full: "Een rustige week — en dat mag.", compact: "Een rustige week — en dat mag.")
            case nil:
                let nth = covered == 1 ? "eerste" : "tweede"
                sentence = Sentence(full: "Je \(nth) week met Grip. Een gemiddelde volgt vanaf 3 weken.",
                                    compact: "Je \(nth) week met Grip.")
            }
        } else {
            chart = nil
            sentence = nil
        }

        func before(_ value: Int, _ old: Int?) -> String? {
            old.map { $0 == value ? "vorige week: ook \($0)" : "vorige week: \($0)" }
        }
        let filed = d.filedByMartin + d.filedByGrip
        let filedLines: [[String]] = filed == 0 ? [] : [["\(d.filedByMartin) door jou", "\(d.filedByGrip) door Grip"]]
        rows = [
            Row(id: "sent", title: d.sent == 0 ? "Niets verstuurd" : "\(d.sent) verstuurd",
                lines: [before(d.sent, previous?.sent)].compactMap { $0 }.map { [$0] }, destination: nil),
            Row(id: "received", title: d.received == 0 ? "Niets ontvangen" : "\(d.received) ontvangen",
                lines: [["mail en scans"] + [before(d.received, previous?.received)].compactMap { $0 }],
                destination: d.received == 0 ? nil : .dossier),
            Row(id: "filed", title: filed == 0 ? "Niets opgeborgen" : "\(filed) opgeborgen",
                lines: filedLines + [before(filed, previous?.filed)].compactMap { $0 }.map { [$0] },
                destination: filed == 0 ? nil : .dossier),
            Row(id: "tasks", title: Self.tasks(d.tasksDone, zero: "Geen taken klaar"),
                lines: [before(d.tasksDone, previous?.tasksDone)].compactMap { $0 }.map { [$0] }, destination: nil),
            Row(id: "waiting",
                title: d.waiting == 0 ? "Niets wachtte op je"
                    : d.waiting == 1 ? "1 wachtte op je" : "\(d.waiting) wachtten op je",
                lines: [["momentopname \(WeeklyFormat.weekdayClock(d.to))"]
                        + [before(d.waiting, previous?.waiting)].compactMap { $0 }],
                destination: nil),
        ]

        var grip: [Row] = []
        if d.filedByGrip > 0 {
            grip.append(Row(id: "grip-filed",
                              title: d.filedByGrip == 1 ? "1 stuk opgeborgen" : "\(d.filedByGrip) stukken opgeborgen",
                              lines: [[d.filedByGrip == 1
                                       ? "Klopt het niet? In de lijst maak je het met één tik ongedaan."
                                       : "Klopt er één niet? In de lijst maak je het met één tik ongedaan."]],
                              destination: .doneByGrip))
        }
        if let renamed = d.renamedByGrip, renamed > 0 {
            grip.append(Row(id: "grip-renamed",
                              title: renamed == 1 ? "1 scan een naam gegeven" : "\(renamed) scans een naam gegeven",
                              lines: [["Die naam staat ook op de NAS, dus terugzetten kan niet in de app."]],
                              destination: nil))
        }
        self.grip = grip
    }

    private static func tasks(_ n: Int, zero: String) -> String {
        n == 0 ? zero : n == 1 ? "1 taak klaar" : "\(n) taken klaar"
    }

    /// Every word the summary shows (the live card is apart), for the tests
    /// and VoiceOver.
    var allText: String {
        (eyebrow + [title, hero.accessibilityLabel, sentence?.full, chart?.title, chart?.caption]
            .compactMap { $0 }
         + rows.map(\.accessibilityLabel) + grip.map(\.accessibilityLabel)).joined(separator: "\n")
    }
}

/// The live card at the end of every state: what waits on Martin NOW.
enum LiveCard: Equatable, Sendable {
    /// Amber: "4 wachten nog op je — de oudste sinds 31 okt." + Open Voor jou.
    case waiting(String)
    /// Nothing waits: the calm badge and when the last one was dealt with.
    case calm(caption: String?)
    /// Voor jou has not loaded: no number, no amber, just the way there.
    case unknown

    static let label = "WACHT OP JE"
    static let open = "Open Voor jou"
    static let calmBadge = "Niets wacht op je"

    /// Where the card stands: under a summary ("nog"), before the first
    /// Sunday ("nu"), or under "staat klaar zodra je weer online bent", which
    /// already says Voor jou works offline.
    enum Context: Sendable { case summary, notYet, notFetched }

    static func make(_ live: WeeklyLive, _ context: Context) -> LiveCard {
        guard let n = live.count else { return .unknown }
        if let kept = live.keptAt {
            guard n > 0 else { return .calm(caption: "stand van \(WeeklyFormat.clock(kept))") }
            let head = "\(n) \(n == 1 ? "wacht" : "wachten") op je — stand van \(WeeklyFormat.clock(kept))."
            return .waiting(context == .notFetched ? head : head + " Voor\u{00A0}jou laat zien wat er bewaard is.")
        }
        guard n > 0 else { return .calm(caption: live.lastClearedAt.map { "laatst afgehandeld: \(WeeklyFormat.day($0))" }) }
        let still = context == .notYet ? "nu" : "nog"
        let head = n == 1 ? "1 wacht \(still) op je" : "\(n) wachten \(still) op je"
        guard let oldest = live.oldestAt else { return .waiting(head + ".") }
        let since = WeeklyFormat.dayMonth(oldest)
        return .waiting(n == 1 ? "\(head) — sinds \(since)." : "\(head) — de oudste sinds \(since).")
    }
}

/// A state with no summary to show: before the first Sunday, offline, failed.
struct WeeklyEmpty: Equatable, Sendable {
    let symbol: String
    let title: String
    let body: String
    let retry: Bool
    /// "Bekijk week 43 (bewaard)": an older summary the phone kept.
    let older: String?
}

/// The whole page per state — header, status row, body and live card —
/// decided here so `WeeklyView` only draws it.
struct WeeklyPage: Equatable, Sendable {
    struct Status: Equatable, Sendable {
        /// "GEEN VERBINDING".
        let badge: String
        /// "stand van zo 1 nov 19:02".
        let stand: String?
        /// A trailing "Opnieuw proberen" (the kept summary; elsewhere the
        /// retry sits in the body).
        let retry: Bool
    }

    enum Body: Equatable, Sendable {
        case skeleton
        case summary(WeeklyScreen)
        /// Before the first Sunday: the message and the ghost of the chart.
        case notYet(WeeklyEmpty, preview: WeeklyScreen.Chart)
        case empty(WeeklyEmpty)
    }

    let eyebrow: [String]
    let status: Status?
    let body: Body
    /// Nil while loading: nothing is offered before anything is known.
    let live: LiveCard?

    static func make(_ state: WeeklyStore.State, now: Date, live: WeeklyLive) -> WeeklyPage {
        let close = WeeklyFormat.lastClose(atOrBefore: now)
        let expected = WeeklyFormat.weekKey(close)
        switch state {
        case .loading:
            return WeeklyPage(eyebrow: [WeeklyFormat.weekLabel(expected).uppercased()], status: nil, body: .skeleton,
                              live: nil)
        case .loaded(let s):
            return WeeklyPage(eyebrow: s.eyebrow, status: nil, body: .summary(s), live: .make(live, .summary))
        case .kept(let kept, let cause):
            return WeeklyPage(eyebrow: kept.screen.eyebrow,
                              status: Status(badge: badge(cause), stand: "stand van \(WeeklyFormat.instant(kept.savedAt))",
                                             retry: true),
                              body: .summary(kept.screen), live: .make(live, .summary))
        case .notYet:
            let next = WeeklyFormat.nextClose(after: now)
            let first = WeeklyFormat.weekKey(next)
            let cal = WeeklyFormat.calendar
            let bars = (0..<8).reversed().map { k in
                let key = WeeklyFormat.weekKey(cal.date(byAdding: .day, value: -7 * k, to: next) ?? next)
                return WeeklyScreen.Chart.Bar(week: key, label: "W\(WeeklyFormat.weekNumber(key) ?? 0)", value: nil,
                                              isCurrent: k == 0)
            }
            let label = "W\(WeeklyFormat.weekNumber(first) ?? 0)"
            let preview = WeeklyScreen.Chart(title: "ZO ZIET HET ERUIT", bars: bars, average: nil,
                                             caption: "eerste balk: \(label) · \(WeeklyFormat.day(next))",
                                             accessibilityLabel: "")
            let empty = WeeklyEmpty(
                symbol: "calendar",
                // "8 november om 18:00" is one unit: non-breaking spaces keep the
                // day from being stranded at a line end, away from its month.
                title: "Je eerste weekoverzicht komt zondag "
                    + "\(WeeklyFormat.dayMonthLong(next)) om 18:00".replacingOccurrences(of: " ", with: "\u{00A0}"),
                body: "Elke zondag zet Grip je week op een rij: wat je verstuurde, wat je ontving, wat je opborg en wat nog op je wacht.",
                retry: false, older: nil)
            return WeeklyPage(eyebrow: ["EERSTE WEEK"], status: nil, body: .notYet(empty, preview: preview),
                              live: .make(live, .notYet))
        case .missing(let cause, let older):
            let olderLink = older.map { "Bekijk \(WeeklyFormat.weekLabel($0.screen.week)) (bewaard)" }
            if case .transport = cause {
                let stand = (older?.savedAt ?? live.keptAt).map { "stand van \(WeeklyFormat.instant($0))" }
                let empty = WeeklyEmpty(
                    symbol: "wifi.slash",
                    title: "Je weekoverzicht van \(WeeklyFormat.weekLabel(expected)) staat klaar zodra je weer online bent",
                    body: "Wat er nu op je wacht, zie je ook zonder verbinding.", retry: true, older: olderLink)
                return WeeklyPage(eyebrow: WeeklyFormat.eyebrow(week: expected, closesAt: close),
                                  status: Status(badge: "GEEN VERBINDING", stand: stand, retry: false),
                                  body: .empty(empty), live: .make(live, .notFetched))
            }
            let empty = WeeklyEmpty(symbol: "exclamationmark.circle", title: "Je weekoverzicht kon niet worden opgehaald",
                                    body: failureBody(cause), retry: cause != .unauthorized, older: olderLink)
            return WeeklyPage(eyebrow: [WeeklyFormat.weekLabel(expected).uppercased()], status: nil, body: .empty(empty),
                              live: .make(live, .summary))
        }
    }

    static func badge(_ cause: APIError) -> String {
        if case .transport = cause { return "GEEN VERBINDING" }
        return "NIET BIJGEWERKT"
    }

    static func failureBody(_ cause: APIError) -> String {
        switch cause {
        case .unauthorized: "Je bent uitgelogd. Log opnieuw in; er is niets verloren."
        case .server(let code): "Er is niets verloren. De server is even niet bereikbaar (fout \(code)); probeer het zo opnieuw."
        case .rateLimited: "Er is niets verloren. Er werd even te vaak gevraagd; probeer het zo opnieuw."
        case .rejected(let code): "Er is niets verloren. De server weigerde de vraag (fout \(code)); probeer het zo opnieuw."
        case .transport: "Er is niets verloren. Er is geen verbinding; probeer het zo opnieuw."
        }
    }
}
