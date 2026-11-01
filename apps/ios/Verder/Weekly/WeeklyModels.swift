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
struct WeeklyDTO: Decodable, Equatable, Sendable {
    let week: String
    let from: Date
    let to: Date
    let sent: Int
    let received: Int
    let filedByMartin: Int
    let filedByVerder: Int
    let tasksDone: Int
    let waiting: Int
    let topWaiting: [WaitingItem]

    private enum CodingKeys: String, CodingKey {
        case week, from, to, sent, received, filedByMartin, filedByVerder, tasksDone, waiting, topWaiting
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
        filedByVerder = try count(.filedByVerder)
        tasksDone = try count(.tasksDone)
        waiting = try count(.waiting)
        topWaiting = try c.decode([WaitingItem].self, forKey: .topWaiting)
    }
}

/// How the summary's week reads. Locale-free, like `MoneyFormat`: the words
/// are spelled here so an English simulator renders what Martin's phone does.
enum WeeklyFormat {
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

    /// An instant on Amsterdam's clock → "zo 25 okt 18:00".
    static func instant(_ date: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
        let c = cal.dateComponents([.weekday, .day, .month, .hour, .minute], from: date)
        let weekday = MoneyFormat.weekdays[(c.weekday ?? 1) - 1]
        let month = MoneyFormat.months[(c.month ?? 1) - 1]
        return "\(weekday) \(c.day ?? 0) \(month) \(two(c.hour ?? 0)):\(two(c.minute ?? 0))"
    }

    /// The window as the two instants it is: "zo 25 okt 18:00 – zo 1 nov 18:00".
    /// `to` is NOT inclusive and is never turned into the day before.
    static func window(from: Date, to: Date) -> String {
        "\(instant(from)) – \(instant(to))"
    }

    private static func two(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }
}

/// Everything the Weekoverzicht screen says, decided outside the view.
///
/// THE SCREEN COMPARES WITH NOTHING. The brief's "compared with Martin's own
/// past weeks" needs past weeks, and `/weekly` serves one: a "meer dan vorige
/// week" here would be a number the server never counted. The counts are the
/// push's counts, and the screen ends with ONE next step, to Voor jou.
///
/// AMBER IS LIVE OR NOT AT ALL. Everything the stored summary says — the
/// counts AND Sunday's waiting snapshot — is history: the screen opens any day
/// of the week, and an item that waited on Sunday may have been decided since.
/// Painting it amber would contradict Voor jou, the badge and the dashboard,
/// which share ONE live definition (`loadWaiting`). The only amber here is the
/// next step's, and it is the LIVE count (`InboxStore`), never Sunday's.
struct WeeklyScreen: Equatable, Sendable {
    /// How a line is drawn; the view switches on it and decides no colour itself.
    enum Tone: Equatable, Sendable {
        /// The ink scale: information, including what waited on Sunday.
        case history
        /// Amber: waits on Martin NOW, by the live count.
        case waitsOnMartin
    }

    struct Count: Equatable, Sendable, Identifiable {
        var id: String { words }
        let value: Int
        let words: String
        /// A second line, e.g. who filed: "3 door jou · 2 door verder zelf".
        let detail: String?
        /// What moved is information, not something waiting.
        var tone: Tone { .history }
        var text: String { "\(value) \(words)" }
    }

    struct Item: Equatable, Sendable, Identifiable {
        let id: String
        /// The Dutch kind ("voorstel", "taak", …).
        let kind: String
        let title: String
    }

    struct Waiting: Equatable, Sendable {
        let headline: String
        /// Sunday's snapshot: history, never amber.
        var tone: Tone { .history }
        let items: [Item]
    }

    struct NextStep: Equatable, Sendable {
        let title: String
        let detail: String
        let tone: Tone
    }

    static let title = "Weekoverzicht"
    var title: String { Self.title }

    /// The one next step, on every state of the screen: to Voor jou, saying
    /// how many wait on Martin NOW (the brief's "2 wachten nog op je → Voor
    /// jou"). `liveWaiting` is `InboxStore`'s count; nil while Voor jou has not
    /// loaded, and then no number is shown and nothing is amber.
    static func nextStep(liveWaiting: Int?) -> NextStep {
        let title = "Naar Voor jou"
        switch liveWaiting {
        case nil: return NextStep(title: title, detail: "Kijk wat er nu op je wacht.", tone: .history)
        case 0?: return NextStep(title: title, detail: "Niets wacht nu op je.", tone: .history)
        case 1?: return NextStep(title: title, detail: "1 wacht nog op je", tone: .waitsOnMartin)
        case let n?: return NextStep(title: title, detail: "\(n) wachten nog op je", tone: .waitsOnMartin)
        }
    }

    let windowLine: String
    let counts: [Count]
    let waiting: Waiting

    init(_ d: WeeklyDTO) {
        windowLine = "\(WeeklyFormat.weekLabel(d.week)) · \(WeeklyFormat.window(from: d.from, to: d.to))"
        let filed = d.filedByMartin + d.filedByVerder
        counts = [
            Count(value: d.sent, words: "verstuurd", detail: nil),
            Count(value: d.received, words: "binnen", detail: nil),
            Count(value: filed, words: "opgeborgen",
                  detail: filed == 0 ? nil : "\(d.filedByMartin) door jou · \(d.filedByVerder) door verder zelf"),
            Count(value: d.tasksDone, words: d.tasksDone == 1 ? "taak klaar" : "taken klaar", detail: nil),
        ]
        let headline = switch d.waiting {
        case 0: "Op zondag wachtte er niets op je"
        case 1: "Op zondag wachtte er 1 op je"
        default: "Op zondag wachtten er \(d.waiting) op je"
        }
        waiting = Waiting(headline: headline,
                          items: d.topWaiting.prefix(3).map {
                              Item(id: $0.id, kind: KindLabel.dutch($0.kind.rawValue), title: $0.title)
                          })
    }

    /// Every word the summary shows (the next step is live and apart), for the
    /// tests and VoiceOver.
    var allText: String {
        ([title, windowLine] + counts.flatMap { [$0.text, $0.detail].compactMap { $0 } }
         + [waiting.headline] + waiting.items.map { "\($0.kind) \($0.title)" }).joined(separator: "\n")
    }
}
