import SwiftUI

/// "Koppel een stuk" (frame "opstellen · koppel een stuk"): the newest mail,
/// document, party, stop and task, and a search over the dossier. A tap
/// attaches the item and goes back to the sheet. One item per question.
struct RequestPicker: View {
    let store: RequestStore
    let pick: (RequestAbout) -> Void
    @State private var recent: [RequestAbout] = []
    @State private var query = ""
    @State private var hits: [RequestAbout] = []
    @State private var searching = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        ZStack {
            Color.plate.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 14) {
                        Button { dismiss() } label: {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(Color.signal)
                                .frame(width: 32, height: 44, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Terug")
                        Text(RequestText.attach)
                            .font(.display(17, relativeTo: .headline, weight: .medium))
                            .foregroundStyle(Color.inkBright)
                            .accessibilityAddTraits(.isHeader)
                        Spacer()
                    }
                    .padding(.top, 20)
                    .padding(.bottom, 12)
                    searchField
                        .padding(.bottom, 24)
                    ProposalLabel(query.isEmpty ? RequestText.recent : "Gevonden")
                        .padding(.bottom, 6)
                    let rows = query.isEmpty ? recent : hits
                    ForEach(rows) { item in
                        Button { pick(item) } label: { row(item) }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(RequestText.kind(about: item.type)), \(item.label)")
                            .accessibilityHint("Koppel")
                    }
                    if !query.isEmpty && hits.isEmpty && !searching {
                        Text("Niets gevonden in je dossier.")
                            .font(.display(15, relativeTo: .callout))
                            .foregroundStyle(Color.inkMute)
                            .padding(.vertical, 14)
                    }
                }
                .padding(.horizontal, 16)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .sensoryFeedback(.selection, trigger: recent.count)
        .task { recent = await store.attachable() }
        .task(id: query) { await search() }
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(Color.inkMute)
            TextField("", text: $query, prompt: Text(RequestText.attachSearch).foregroundStyle(Color.inkMute))
                .font(.display(17, relativeTo: .body))
                .foregroundStyle(Color.inkBright)
                .submitLabel(.search)
                .autocorrectionDisabled()
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 44)
        .background(Color.field, in: RoundedRectangle(cornerRadius: Radius.chip))
        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.edgeStrong, lineWidth: 1))
    }

    private func row(_ item: RequestAbout) -> some View {
        let meta = RequestText.aboutMeta(item, now: store.now())
        let when = meta.count > 1 && item.at != nil ? meta.last : nil
        let lead = when == nil ? meta : Array(meta.dropLast())
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 0) {
                Image(systemName: RequestText.symbol(about: item.type))
                    .font(.system(size: 15))
                    .foregroundStyle(Color.inkSoft)
                    .frame(width: 36, alignment: .leading)
                    .padding(.top, 3)
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.label)
                            .font(.display(17, relativeTo: .body, weight: .medium))
                            .foregroundStyle(Color.inkBright)
                            .fixedSize(horizontal: false, vertical: true)
                            .multilineTextAlignment(.leading)
                        RowMeta(lead: lead, trailing: when)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if !typeSize.isAccessibilitySize {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color.inkDim)
                    }
                }
            }
            .padding(.vertical, 12)
            RowHairlineShape(leading: 36)
        }
        .contentShape(Rectangle())
    }

    private func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { hits = []; return }
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        searching = true
        defer { searching = false }
        let encoded = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
        guard let r: SearchResults = try? await store.client.getJSON("/api/mobile/v1/search?q=\(encoded)") else { return }
        hits = r.hits.compactMap(Self.about)
    }

    /// A search hit as something a question can be about; nil for a kind a
    /// request cannot name (a log entry, a debt).
    static func about(_ h: SearchHit) -> RequestAbout? {
        let type: String
        switch h.entityType {
        case "email": type = "mail"
        case "document": type = "document"
        case "party": type = "party"
        case "stop": type = "stop"
        case "task": type = "task"
        default: return nil
        }
        return RequestAbout(type: type, id: h.entityId, label: h.title, meta: [h.from].compactMap { $0 },
                            at: h.occurredAt.flatMap(parseISODate))
    }
}

/// A row's meta with its time on the right, one line beside the title's
/// width when it fits; otherwise (and at AX) one fact per line.
struct RowMeta: View {
    let lead: [String]
    let trailing: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if typeSize.isAccessibilitySize {
            RequestMetaLine(parts: lead + [trailing].compactMap { $0 })
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(HomeSummary.metaLine(lead).uppercased()).lineLimit(1)
                    Spacer(minLength: 0)
                    if let trailing { Text(trailing.uppercased()).fixedSize() }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(HomeSummary.metaLine(lead).uppercased()).fixedSize(horizontal: false, vertical: true)
                    if let trailing { Text(trailing.uppercased()) }
                }
            }
            .font(.mono(12, relativeTo: .caption))
            .tracking(VoorJouMetrics.metaTracking)
            .foregroundStyle(Color.inkLabel)
            .dynamicTypeSize(...DynamicTypeSize.accessibility3)
        }
    }
}
