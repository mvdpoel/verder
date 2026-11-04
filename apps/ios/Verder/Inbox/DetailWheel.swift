import SwiftUI

/// The wheel a date field is set on (frames "datum kiezen", "Gesprek"): a
/// day column named as the cards name a day ("wo 4 nov", never the system's
/// "Vandaag", which follows the phone's real clock and not the screen's), and
/// hours and minutes in steps of five. Pure functions on the Amsterdam
/// calendar, unit-tested in `DetailWheelTests`; the view only draws them.
enum DetailWheel {
    static let minuteStep = 5
    /// How many days either side of today the day column offers.
    static let span = 366

    private static var calendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = ProposalFormat.amsterdam
        return cal
    }

    /// The day, hour and minute of an instant in Amsterdam.
    static func parts(of date: Date) -> (day: Date, hour: Int, minute: Int) {
        let cal = calendar
        let c = cal.dateComponents([.hour, .minute], from: date)
        return (cal.startOfDay(for: date), c.hour ?? 0, c.minute ?? 0)
    }

    /// The instant of that Amsterdam day at that time.
    static func compose(day: Date, hour: Int, minute: Int) -> Date {
        let cal = calendar
        return cal.date(bySettingHour: hour, minute: minute, second: 0, of: cal.startOfDay(for: day)) ?? day
    }

    /// Every day from `span` days before today to `span` after, widened so
    /// the selected day is always one of them.
    static func days(selected: Date, now: Date) -> [Date] {
        let cal = calendar
        let today = cal.startOfDay(for: now), chosen = cal.startOfDay(for: selected)
        let first = min(cal.date(byAdding: .day, value: -span, to: today) ?? today, chosen)
        let last = max(cal.date(byAdding: .day, value: span, to: today) ?? today, chosen)
        var out: [Date] = []
        var d = first
        while d <= last {
            out.append(d)
            guard let next = cal.date(byAdding: .day, value: 1, to: d) else { break }
            d = next
        }
        return out
    }

    /// 00, 05 … 55, plus the selected minute when it is off the step, so a
    /// proposal's own "17:02" stays what the wheel shows until it is moved.
    static func minutes(including minute: Int) -> [Int] {
        var out = Array(stride(from: 0, to: 60, by: minuteStep))
        if !out.contains(minute) { out.append(minute); out.sort() }
        return out
    }

    static func two(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }
}

/// The wheel itself: a day column, and with `showsTime` the hours and
/// minutes beside it.
struct DetailWheelPicker: View {
    let selection: Date
    let showsTime: Bool
    let now: Date
    let label: String
    let onChange: @MainActor (Date) -> Void

    var body: some View {
        let p = DetailWheel.parts(of: selection)
        HStack(spacing: 0) {
            column("\(label), dag", selection: p.day, values: DetailWheel.days(selected: selection, now: now),
                   text: DetailText.dayName) { onChange(DetailWheel.compose(day: $0, hour: p.hour, minute: p.minute)) }
                .frame(maxWidth: .infinity)
            if showsTime {
                column("\(label), uur", selection: p.hour, values: Array(0..<24), text: DetailWheel.two) {
                    onChange(DetailWheel.compose(day: p.day, hour: $0, minute: p.minute))
                }
                .frame(width: 72)
                column("\(label), minuten", selection: p.minute, values: DetailWheel.minutes(including: p.minute),
                       text: DetailWheel.two) {
                    onChange(DetailWheel.compose(day: p.day, hour: p.hour, minute: $0))
                }
                .frame(width: 72)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func column<V: Hashable>(_ name: String, selection: V, values: [V], text: @escaping (V) -> String,
                                     set: @escaping @MainActor (V) -> Void) -> some View {
        Picker(name, selection: Binding(get: { selection }, set: set)) {
            ForEach(values, id: \.self) { v in Text(text(v)).tag(v) }
        }
        .pickerStyle(.wheel)
        .labelsHidden()
        // Side by side, each wheel keeps its touches to its own column.
        .compositingGroup()
        .clipped()
        .accessibilityLabel(name)
    }
}

/// Edits on a suggestion whose approval met an expired session: kept IN
/// MEMORY for the next sign-in, as the voice log keeps an unsent log
/// (`VoiceLogSession`), and put back when that suggestion is opened again.
/// An explicit sign-out forgets them.
@MainActor
final class KeptSuggestionEdits {
    static let shared = KeptSuggestionEdits()
    private var kept: [String: [String: String]] = [:]

    func keep(_ values: [String: String], for id: String) {
        if values.isEmpty { kept[id.lowercased()] = nil } else { kept[id.lowercased()] = values }
    }

    /// The kept edits for `id`, handed over once.
    func take(_ id: String) -> [String: String]? { kept.removeValue(forKey: id.lowercased()) }

    func peek(_ id: String) -> [String: String]? { kept[id.lowercased()] }

    func forgetAll() { kept = [:] }
}
