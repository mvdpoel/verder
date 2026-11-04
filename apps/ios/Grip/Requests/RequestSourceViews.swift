import SwiftUI

/// A source the phone has no screen of its own for: a live Gmail message
/// (frame "antwoord · bron Gmail-bericht" — read-only, "niet in je dossier"),
/// a dossier mail, a party or a stop. It shows what the answer relied on and
/// why; it acts on nothing.
struct RequestSourceScreen: View {
    let requestId: String
    let index: Int
    let store: RequestStore
    @State private var detail: RequestDetail?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            if let s = detail?.sources[safe: index] {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        ProposalLabel(s.type == "gmail" ? RequestText.gmailEyebrow : eyebrow(s))
                        Text(s.gmail?.subject ?? s.label)
                            .wholeWords(s.gmail?.subject ?? s.label, font: .display(28, relativeTo: .title))
                            .foregroundStyle(Color.inkBright)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.isHeader)
                        if !s.inDossier { notInDossier(s) }
                        if let g = s.gmail { headers(g); body(g.body) }
                        else if !s.why.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                ProposalLabel("Waarom Grip dit gebruikte")
                                Text(s.why).font(.display(17, relativeTo: .body)).foregroundStyle(Color.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .padding(.bottom, 32)
                }
            } else {
                ProgressView().tint(Color.signal)
            }
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .task {
            detail = try? await store.client.getJSON("\(RequestStore.path)/\(requestId.lowercased())")
        }
        .accessibilityElement(children: .contain)
    }

    private func eyebrow(_ s: RequestDetail.Source) -> String {
        switch s.type {
        case "mail": "Mail · in je dossier"
        case "party": "Partij"
        case "stop": "Halte"
        case "debt": "Vordering"
        case "entry": "Logboek"
        default: "Bron"
        }
    }

    private func notInDossier(_ s: RequestDetail.Source) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ProposalLabel(RequestText.notInDossier)
            Text(s.gmail == nil ? RequestText.notInDossierUnread : RequestText.notInDossierBody)
                .font(.display(15, relativeTo: .callout))
                .foregroundStyle(Color.inkMute)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
        .accessibilityElement(children: .combine)
    }

    private func headers(_ g: RequestDetail.Source.Gmail) -> some View {
        let date = parseISODate(g.date)
        let rows: [(String, String)] = [
            ("Van", Self.from(g.from)),
            ("Aan", g.to),
            ("Datum", date.map { "\(HomeSummary.day($0)) \(HomeSummary.calendar.component(.year, from: $0)) · \(HomeSummary.clock($0))" } ?? g.date),
        ]
        return VStack(alignment: .leading, spacing: 10) {
            ForEach(rows, id: \.0) { label, value in
                if typeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 2) {
                        ProposalLabel(label)
                        Text(value).font(.display(15, relativeTo: .callout)).foregroundStyle(Color.ink)
                    }
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        ProposalLabel(label).frame(width: 120, alignment: .leading)
                        Text(value).font(.display(15, relativeTo: .callout)).foregroundStyle(Color.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(.top, 8)
    }

    private func body(_ text: String) -> some View {
        Text(text)
            .font(.display(17, relativeTo: .body))
            .foregroundStyle(Color.ink)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .padding(.top, 12)
    }

    /// "Ilse <ilse@noordkust.example>" → "Ilse · ilse@noordkust.example".
    static func from(_ raw: String) -> String {
        guard let name = ProposalText.displayName(raw), let addr = ProposalText.address(raw) else { return raw }
        return "\(name) · \(addr)"
    }
}

/// "Bankregel" (frame "antwoord · bron bankregel"): one row of a statement,
/// read-only, with the way to Geld. This account is Martin's own, so the
/// sheet says where cancelling happens: in his bank app.
struct RequestBankSheet: View {
    let source: RequestDetail.Source
    let accountName: (String) -> String?
    let now: Date
    let openGeld: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let t = source.transaction
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(RequestText.bankTitle)
                        .font(.display(17, relativeTo: .headline, weight: .medium))
                        .foregroundStyle(Color.inkBright)
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.inkSoft)
                            .frame(width: 36, height: 36).background(Circle().fill(Color.glassA))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(RequestText.close)
                }
                .padding(.top, 18)
                if let t {
                    Text(MoneyFormat.euro(cents: t.amountCents))
                        .font(.display(34, relativeTo: .largeTitle, weight: .light))
                        .foregroundStyle(Color.inkBright)
                        .monospacedDigit()
                        .padding(.top, 10)
                    Text(t.counterparty ?? source.label)
                        .font(.display(17, relativeTo: .body))
                        .foregroundStyle(Color.ink)
                    VStack(alignment: .leading, spacing: 8) {
                        line("Datum", "\(HomeSummary.day(t.bookedAt)) \(HomeSummary.calendar.component(.year, from: t.bookedAt))")
                        if let iban = t.accountIban {
                            line("Rekening", [accountName(iban), MoneyFormat.ibanDots(iban)].compactMap { $0 }.joined(separator: " "))
                        }
                        line("Soort", t.mandate ? "Incasso · machtiging" : (t.amountCents < 0 ? "Afschrijving" : "Bijschrijving"))
                        if let d = t.description { line("Omschrijving", d) }
                    }
                    .padding(.top, 6)
                }
                AuthButton(title: RequestText.bankOpenGeld, weight: .outline, action: openGeld)
                    .padding(.top, 6)
                Text(RequestText.bankFootnote)
                    .font(.display(15, relativeTo: .callout))
                    .foregroundStyle(Color.inkMute)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
        }
        .background(Color.plate.ignoresSafeArea())
        .presentationBackground(Color.plate)
        .presentationDragIndicator(.visible)
        .preferredColorScheme(.dark)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private func line(_ label: String, _ value: String) -> some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 2) {
                ProposalLabel(label)
                Text(value).font(.display(17, relativeTo: .body)).foregroundStyle(Color.ink)
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                ProposalLabel(label).frame(width: 120, alignment: .leading)
                Text(value).font(.display(17, relativeTo: .body)).foregroundStyle(Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// "Eerdere vragen" (frame "Voor jou · eerdere vragen"): questions that are
/// done — answered and ticked off, put away, or stopped. Calm: no amber, no
/// count in Voor jou. A tap reads the answer again.
struct EarlierRequestsScreen: View {
    let store: RequestStore
    let push: (InboxRoute) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let now = store.now()
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(RequestText.earlierTitle)
                        .wholeWords(RequestText.earlierTitle, font: .display(28, relativeTo: .title))
                        .foregroundStyle(Color.inkBright)
                        .accessibilityAddTraits(.isHeader)
                    Text(RequestText.earlierBody)
                        .font(.display(15, relativeTo: .callout))
                        .foregroundStyle(Color.inkMute)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 6)
                    ForEach(RequestText.earlierGroups(store.earlier, now: now), id: \.label) { group in
                        ProposalLabel(group.label)
                            .padding(.top, 28)
                            .padding(.bottom, 4)
                        ForEach(group.items) { item in
                            Button { push(.request(item.id)) } label: {
                                RequestRowView(symbol: "doc.text.magnifyingglass", amber: false, title: item.title,
                                               meta: RequestText.doneMeta(item), when: RequestText.when(item.at, now: now),
                                               chevron: true)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(RequestText.rowLabel(title: "\(RequestText.title), \(item.title)",
                                                                     meta: RequestText.doneMeta(item).lowercased(),
                                                                     when: RequestText.when(item.at, now: now), waits: false))
                        }
                    }
                    if store.earlier.isEmpty {
                        Text("Nog geen eerdere vragen.")
                            .font(.display(15, relativeTo: .callout))
                            .foregroundStyle(Color.inkMute)
                            .padding(.top, 24)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
            }
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.refresh() }
    }
}

/// One Vraag Grip row, the anatomy every Voor jou row shares: the glyph in
/// the 36 pt gutter (with its marker), the title at x 52, the meta under it
/// and the time on the right before the chevron. At the accessibility sizes
/// the gutter goes and the meta stacks one fact per line.
struct RequestRowView: View {
    let symbol: String
    /// Amber dot: this waits on Martin.
    let amber: Bool
    var marker: Marker = .none
    let title: String
    let meta: String
    let when: String?
    var chevron = true

    enum Marker: Equatable { case none, ring, dashedRing }

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let ax = typeSize.isAccessibilitySize
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 0) {
                if !ax {
                    Image(systemName: symbol)
                        .font(.system(size: 16))
                        .foregroundStyle(Color.inkLabel)
                        .frame(width: 22, height: 22)
                        .overlay(alignment: .topTrailing) { markerView }
                        .frame(width: VoorJouMetrics.gutter, alignment: .leading)
                        .padding(.top, 3)
                }
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(title)
                            .wholeWords(title, font: VoorJouMetrics.title)
                            .foregroundStyle(Color.inkBright)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        RowMeta(lead: meta.components(separatedBy: " · "), trailing: when)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if chevron && !ax {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color.inkDim)
                    }
                }
            }
            .padding(.vertical, 14)
            RowHairlineShape(leading: ax ? 0 : VoorJouMetrics.gutter)
        }
        .background(Color.void)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var markerView: some View {
        if amber {
            Circle().fill(Color.attn).frame(width: 8, height: 8)
                .overlay(Circle().stroke(Color.void, lineWidth: 1.5))
                .glow(Glow.attn)
                .offset(x: 3, y: -3)
        } else if marker == .ring {
            Circle().strokeBorder(Color.steel, lineWidth: 1.2).frame(width: 8, height: 8)
                .background(Circle().fill(Color.void))
                .offset(x: 3, y: -3)
        } else if marker == .dashedRing {
            Circle().strokeBorder(Color.inkFaint, style: StrokeStyle(lineWidth: 1.2, dash: [1.5, 1.5])).frame(width: 8, height: 8)
                .background(Circle().fill(Color.void))
                .offset(x: 3, y: -3)
        }
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
