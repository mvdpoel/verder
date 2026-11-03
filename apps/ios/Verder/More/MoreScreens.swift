import SwiftUI
import UIKit

/// The screens behind Meer's rows (Figma "meer · final"). Thin: every word
/// is `AccountCopy`, `SignOutSheet`, `NotificationsCopy`, `WidgetGuide`,
/// `AboutInfo` or `DeveloperCopy`.

// MARK: - Account

struct AccountScreen: View {
    let auth: AuthModel
    let account: AccountModel
    let center: UploadCenter
    let now: @Sendable () -> Date
    let signOut: () async -> Void

    @State private var confirmSignOut = false
    @State private var retries = 0
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var typeSize

    private var offline: Bool { center.isOffline }
    private var failed: Bool { if case .unavailable = account.display { return true }; return false }
    private var passkey: AccountCopy.PasskeyState { AccountCopy.passkeyState(account.passkeys, failed: failed) }

    var body: some View {
        MorePage(title: MoreMenu.title(.account)) {
            if offline { MoreOfflineStrip(stamp: MoreMenu.offlineStamp(account.fetchedAt, now: now())) }
            whoCard
            MoreGroup(label: AccountCopy.passkeyLabel) { passkeyCard }.id(MorePageAnchor.middle)
            MoreGroup(label: AccountCopy.devicesLabel) { devicesCard }
            VStack(alignment: .leading, spacing: 8) {
                MoreButton(title: AccountCopy.signOutConfirm, tint: .inkBright, enabled: !auth.isBusy) {
                    confirmSignOut = true
                }
                MoreText.footnote(offline ? AccountCopy.signOutNoteOffline : AccountCopy.signOutNote)
            }
            .padding(.top, 8)
        }
        // iOS 26 leaves a sheet at a custom detent undimmed; the frames dim
        // the page behind it (as Scan does).
        .overlay {
            Color.black.opacity(confirmSignOut ? 0.6 : 0)
                .ignoresSafeArea()
                .allowsHitTesting(false)
                .accessibilityHidden(true)
                .animation(.easeInOut(duration: 0.25), value: confirmSignOut)
        }
        .sheet(isPresented: $confirmSignOut) {
            SignOutSheetView(center: center, offline: offline,
                             stand: account.fetchedAt.map { HomeSummary.stamp($0, now: now()) },
                             signOut: { confirmSignOut = false; Task { await signOut() } },
                             cancel: { confirmSignOut = false })
        }
        .sensoryFeedback(.success, trigger: auth.passkeyAddedCount)
        .sensoryFeedback(.error, trigger: retries) { _, _ in failed }
        .task { await account.refresh() }
        #if DEBUG
        .task {
            if FixtureLaunch.current?.more == .signOut {
                // After `offlineAfter` (2 s), so an offline sheet opens offline.
                try? await Task.sleep(for: .seconds(3))
                confirmSignOut = true
            }
        }
        #endif
    }

    @ViewBuilder private var whoCard: some View {
        switch account.display {
        case .unavailable:
            MoreCard {
                VStack(alignment: .leading, spacing: 12) {
                    labelled(AccountCopy.failedLabel, symbol: "exclamationmark.circle") {
                        Text(AccountCopy.failedTitle)
                            .font(MoreType.rowTitle)
                            .foregroundStyle(Color.inkBright)
                            .fixedSize(horizontal: false, vertical: true)
                        MoreText.readout(AccountCopy.failureCause(failure, at: account.failedAt, now: now()))
                    }
                    MoreButton(title: AccountCopy.retry) {
                        retries += 1
                        Task { await account.refresh() }
                    }
                }
                .padding(16)
            }
        case .loading:
            MoreCard {
                labelled(AccountCopy.emailLabel, symbol: MoreGlyphName.personCircle) {
                    MoreSkeleton(fraction: 0.7).padding(.vertical, 6)
                    MoreSkeleton(fraction: 0.5).padding(.vertical, 4)
                }
                .padding(16)
            }
        case .shown(let dto):
            MoreCard {
                labelled(AccountCopy.emailLabel, symbol: MoreGlyphName.personCircle) {
                    Text(typeSize.isAccessibilitySize ? MoreText.breakableAddress(dto.email) : dto.email)
                        .font(MoreType.rowTitle)
                        .foregroundStyle(Color.inkBright)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                    MoreText.readout(AccountCopy.sessionLine(dto.sessionExpiresAt))
                }
                .padding(16)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var failure: APIError? {
        if case .failed(let e) = account.state { return e }
        return nil
    }

    /// The label inside the card, then glyph and text (Figma "INGELOGD ALS").
    private func labelled<C: View>(_ label: String, symbol: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(MoreType.label)
                .tracking(1)
                .foregroundStyle(Color.inkLabel)
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .padding(.leading, typeSize.isAccessibilitySize ? 0 : 32)
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                if !typeSize.isAccessibilitySize { MoreGlyph(name: symbol) }
                VStack(alignment: .leading, spacing: 2) { content() }
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var passkeyCard: some View {
        MoreCard {
            let badge = AccountCopy.passkeyBadge(passkey)
            MoreRowView(symbol: "key.horizontal", title: AccountCopy.passkeyTitle,
                        lines: AccountCopy.passkeyLines(passkey, compact: typeSize.isAccessibilitySize)
                            .map { .phrases([$0]) }) {
                if let badge { MoreBadge(text: badge, tone: passkey == .on ? .okay : .mute) }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(([AccountCopy.passkeyTitle, badge].compactMap { $0 }
                                 + AccountCopy.passkeyLines(passkey)).joined(separator: ", "))
            if AccountCopy.offersPasskey(passkey) {
                MoreDivider()
                Button { Task { await auth.addPasskey() } } label: {
                    MoreRowView(symbol: "plus", title: AccountCopy.addPasskey,
                                titleColor: offline ? .inkBright : .signal,
                                lines: [.phrases([AccountCopy.addPasskeyLine(offline: offline)])], dimmed: offline)
                }
                .buttonStyle(MoreRowButtonStyle())
                .disabled(offline || auth.isBusy)
            }
            if let message = auth.passkeyMessage {
                MoreText.body(message).padding(.horizontal, 16).padding(.bottom, 12)
            }
        }
    }

    private var devicesCard: some View {
        MoreCard {
            Button { openURL(AccountCopy.devicesURL(base: auth.client.base)) } label: {
                MoreRowView(symbol: "laptopcomputer", title: AccountCopy.devicesLink,
                            lines: [.phrases([AccountCopy.devicesLine(account.account?.devices, offline: offline)])],
                            chevron: .external, dimmed: offline)
            }
            .buttonStyle(MoreRowButtonStyle())
            .disabled(offline)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([AccountCopy.devicesLink,
                                 AccountCopy.devicesLine(account.account?.devices, offline: offline),
                                 "opent de website"].joined(separator: ", "))
            .accessibilityAddTraits(.isLink)
        }
    }
}

/// The confirm sheet behind Uitloggen. Its bottom sits at the screen's
/// bottom and a longer body grows it upward (Figma final), so the sheet is
/// sized to its content.
struct SignOutSheetView: View {
    let center: UploadCenter
    let offline: Bool
    let stand: String?
    let signOut: () -> Void
    let cancel: () -> Void

    @State private var height: CGFloat = 300
    @State private var uploading = false
    @State private var drained = 0

    private var queued: Int { center.summary.underway }
    private var sheet: SignOutSheet { SignOutSheet.make(offline: offline, queued: queued, stand: stand) }

    var body: some View {
        let s = sheet
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(s.title)
                    .font(MoreType.rowTitle)
                    .foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                ForEach(s.leads, id: \.text) { lead in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Image(systemName: lead.symbol)
                            .font(.system(size: 15))
                            .foregroundStyle(Color.ink)
                            .frame(width: 20)
                            .accessibilityHidden(true)
                        Text(MoreText.mixed(lead.text, color: .ink))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                MoreText.body(s.body, color: .ink)
                VStack(spacing: 12) {
                    if let first = s.uploadFirst {
                        MoreButton(title: first, weight: .primary, busy: uploading) {
                            uploading = true
                            Task {
                                await center.drain()
                                uploading = false
                                if center.summary.underway == 0 { drained += 1 }
                            }
                        }
                    }
                    MoreButton(title: s.confirm, tint: .inkBright, action: signOut)
                    MoreButton(title: AccountCopy.cancel, weight: .plain, action: cancel)
                }
                .padding(.top, 4)
            }
            .padding(.horizontal, 16)
            .padding(.top, 24)
            .padding(.bottom, 8)
            .lineHeight(.multiple(factor: MoreType.lineFactor))
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .presentationDetents([.height(height)])
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.plate)
        .sensoryFeedback(.success, trigger: drained)
        .preferredColorScheme(.dark)
    }
}

// MARK: - Meldingen

struct NotificationsScreen: View {
    let push: PushRegistrar
    let prefs: NotificationPrefsModel
    let offline: Bool
    let stand: Date?
    let now: @Sendable () -> Date

    @Environment(\.dynamicTypeSize) private var typeSize

    /// Switches only when iOS lets pushes through, the server stores choices
    /// and the phone is online; otherwise each kind says "aan"/"uit"/"altijd".
    private var switchable: Bool {
        push.permission == .allowed && prefs.availability == .available && !offline
    }

    var body: some View {
        MorePage(title: MoreMenu.title(.notifications)) {
            if offline {
                MoreOfflineStrip(stamp: MoreMenu.offlineStamp(stand, now: now()), hint: NotificationsCopy.offlineHint)
            }
            header
            ForEach(NotificationsCopy.groups, id: \.label) { group in
                VStack(alignment: .leading, spacing: 8) {
                    MoreGroup(label: group.label) {
                        MoreCard {
                            ForEach(Array(group.kinds.enumerated()), id: \.element.category) { i, kind in
                                // The capture anchor of "Meldingen / AX5 · onderaan".
                                if i > 0 { MoreDivider().id(kind.category == "CREDITOR_MAIL" ? MorePageAnchor.middle : kind.category) }
                                row(kind)
                            }
                        }
                    }
                    if push.permission != .denied || group.label != "Post" {
                        MoreText.footnote(group.footnote)
                    }
                }
            }
        }
        .sensoryFeedback(.error, trigger: prefs.saveFailures)
        .task { await push.refresh() }
        .task { await prefs.refresh() }
        #if DEBUG
        .task {
            // `-fixtures-more savefail`: the switch moved, the save failed.
            guard FixtureLaunch.current?.more == .saveFail else { return }
            try? await Task.sleep(for: .seconds(1))
            await prefs.set("CREDITOR_MAIL", on: true)
        }
        #endif
    }

    private var header: some View {
        MoreCard {
            VStack(alignment: .leading, spacing: 4) {
                Text(NotificationsCopy.headerLabel.uppercased())
                    .font(MoreType.label)
                    .tracking(1)
                    .foregroundStyle(Color.inkLabel)
                    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                    .padding(.leading, typeSize.isAccessibilitySize ? 0 : 32)
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    if !typeSize.isAccessibilitySize {
                        Image(systemName: push.permission == .allowed ? "bell" : "bell.slash")
                            .font(.system(size: 18))
                            .foregroundStyle(Color.inkMute)
                            .frame(width: 20)
                            .accessibilityHidden(true)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(NotificationsCopy.permissionLine(push.permission))
                            .font(MoreType.rowTitle)
                            .foregroundStyle(Color.inkBright)
                            .fixedSize(horizontal: false, vertical: true)
                        if let detail = NotificationsCopy.permissionDetail(push.permission) {
                            MoreText.body(detail, color: .ink)
                        } else if let c = prefs.count {
                            MoreText.readout(NotificationsCopy.countLine(c.on, of: c.of))
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .combine)
                if let error = push.lastError { MoreText.readout(error).padding(.top, 4) }
                switch NotificationsCopy.action(push.permission) {
                case .ask?:
                    MoreButton(title: PushRegistrar.Copy.allow) { Task { await push.acceptPrePrompt() } }
                        .padding(.top, 12)
                case .openSettings?:
                    MoreButton(title: NotificationsCopy.openSettings) {
                        if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    }
                    .padding(.top, 12)
                case nil:
                    EmptyView()
                }
            }
            .padding(16)
        }
    }

    @ViewBuilder private func row(_ kind: NotificationsCopy.Kind) -> some View {
        let always = NotificationsCopy.always.contains(kind.category)
        let on = prefs.isOn(kind.category)
        let denied = push.permission == .denied
        let lines = NotificationsCopy.lines(kind, denied: denied)
        let spoken = NotificationsCopy.spoken(kind, denied: denied)
        VStack(alignment: .leading, spacing: 0) {
            if always {
                MoreRowView(symbol: kind.symbol, title: kind.name, lines: lines) {
                    if switchable { MoreBadge(text: NotificationsCopy.alwaysWord) } else { word(NotificationsCopy.alwaysWord) }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(spoken), altijd aan")
            } else if switchable {
                MoreRowView(symbol: kind.symbol, title: kind.name, lines: lines) {
                    Toggle(kind.name, isOn: Binding(get: { on },
                                                    set: { new in Task { await prefs.set(kind.category, on: new) } }))
                        .labelsHidden()
                        .tint(.signal)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(spoken)
            } else {
                MoreRowView(symbol: kind.symbol, title: kind.name, lines: lines) { word(on ? "aan" : "uit") }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(spoken), \(on ? "aan" : "uit")")
            }
            if prefs.failed == kind.category { saveFailure }
        }
    }

    private func word(_ text: String) -> some View {
        Text(text)
            .font(MoreType.value)
            .foregroundStyle(Color.inkBright)
            .fixedSize()
    }

    private var saveFailure: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Image(systemName: "exclamationmark.circle")
                    .font(.system(size: 15))
                    .foregroundStyle(Color.ink)
                    .frame(width: 20)
                    .accessibilityHidden(true)
                MoreText.body(NotificationsCopy.saveFailed(offline: offline), color: .ink)
            }
            Button(AccountCopy.retry) { Task { await prefs.retry() } }
                .font(MoreType.rowTitle)
                .foregroundStyle(Color.signal)
                .buttonStyle(.plain)
                .frame(minHeight: 44)
                .padding(.leading, typeSize.isAccessibilitySize ? 0 : 32)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
    }
}

// MARK: - Widgets toevoegen

struct WidgetGuideScreen: View {
    var body: some View {
        MorePage(title: MoreMenu.title(.widgets)) {
            MoreCard {
                VStack(alignment: .leading, spacing: 12) {
                    Text(WidgetGuide.previewLabel.uppercased())
                        .font(MoreType.label)
                        .tracking(1)
                        .foregroundStyle(Color.inkLabel)
                        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                    homeMock
                    lockMock
                    MoreText.body(WidgetGuide.privacy)
                }
                .padding(16)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Voorbeeld: verder op je beginscherm, 4 wachten op jou, en op je toegangsscherm, 4 wachten, oudste 2 dagen. \(WidgetGuide.privacy)")
            MoreGroup(label: WidgetGuide.homeLabel) { steps(WidgetGuide.homeSteps) }
            MoreGroup(label: WidgetGuide.lockLabel) { steps(WidgetGuide.lockSteps) }
        }
    }

    private static let mockShape = RoundedRectangle(cornerRadius: 18, style: .continuous)

    /// A home screen: verder's small widget beside its icon and three
    /// neighbouring apps (ghost tiles).
    private var homeMock: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("verder").font(.mono(13, relativeTo: .caption)).foregroundStyle(Color.inkMute)
                Spacer(minLength: 4)
                Text(WidgetGuide.sampleCount)
                    .font(.display(40, relativeTo: .largeTitle, weight: .light))
                    .foregroundStyle(Color.inkBright)
                Text(WidgetGuide.sampleWords).font(MoreType.body).foregroundStyle(Color.ink)
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 140, alignment: .topLeading)
            .background(Color.glassA, in: Self.mockShape)
            .overlay(Self.mockShape.strokeBorder(Color.edgeStrong, lineWidth: 1))
            Grid(horizontalSpacing: 18, verticalSpacing: 18) {
                GridRow { AppIconTile(); GhostTile() }
                GridRow { GhostTile(); GhostTile() }
            }
        }
        .padding(14)
        .background(Color.void.opacity(0.6), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.edge, lineWidth: 1))
    }

    /// A lock screen: the date, the clock and verder's rectangular widget.
    private var lockMock: some View {
        VStack(spacing: 4) {
            Text(WidgetGuide.sampleDate).font(.mono(13, relativeTo: .caption)).foregroundStyle(Color.ink)
            Text("9:41").font(.display(64, relativeTo: .largeTitle, weight: .light)).foregroundStyle(Color.inkBright)
            VStack(alignment: .leading, spacing: 2) {
                Text("verder").font(MoreType.rowTitle).foregroundStyle(Color.inkBright)
                Text(WidgetGuide.sampleLock).font(.mono(13, relativeTo: .caption)).foregroundStyle(Color.ink)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.glassA.opacity(3), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .padding(.top, 4)
        }
        .padding(.vertical, 16)
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity)
        .background(Color.void.opacity(0.6), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.edge, lineWidth: 1))
    }

    private func steps(_ lines: [String]) -> some View {
        MoreCard {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                    HStack(alignment: .firstTextBaseline, spacing: 16) {
                        Text("\(i + 1)")
                            .font(MoreType.value)
                            .foregroundStyle(Color.inkMute)
                            .frame(minWidth: 16, alignment: .leading)
                        Text(Self.step(line))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(16)
        }
    }

    /// `**Wijzig**` in bold ink-bright, the rest Saira in ink.
    static func step(_ line: String) -> AttributedString {
        var out = AttributedString()
        for (i, part) in line.components(separatedBy: "**").enumerated() {
            var piece = AttributedString(part)
            piece.font = i % 2 == 1 ? Font.display(17, relativeTo: .body, weight: .semibold)
                                    : Font.display(17, relativeTo: .body)
            piece.foregroundColor = i % 2 == 1 ? Color.inkBright : Color.ink
            out += piece
        }
        return out
    }
}

/// verder's own icon in the home-screen mock: the app's AppIcon.
private struct AppIconTile: View {
    var body: some View {
        Group {
            if let icon = Self.image {
                Image(uiImage: icon).resizable().scaledToFill()
            } else {
                Color.plate
            }
        }
        .frame(width: 58, height: 58)
        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
        .accessibilityHidden(true)
    }

    static let image: UIImage? = {
        let icons = Bundle.main.infoDictionary?["CFBundleIcons"] as? [String: Any]
        let primary = icons?["CFBundlePrimaryIcon"] as? [String: Any]
        let files = primary?["CFBundleIconFiles"] as? [String]
        return files?.last.flatMap(UIImage.init(named:)) ?? UIImage(named: "AppIcon")
    }()
}

private struct GhostTile: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 13, style: .continuous)
            .fill(Color.steelDim.opacity(0.14))
            .frame(width: 58, height: 58)
            .accessibilityHidden(true)
    }
}

// MARK: - Over verder

struct AboutScreen: View {
    let server: URL
    let about: AboutInfo
    let connection: AboutInfo.Connection
    let openDeveloper: () -> Void

    var body: some View {
        MorePage(title: MoreMenu.title(.about)) {
            VStack(alignment: .leading, spacing: 8) {
                MoreGroup(label: AboutInfo.label) {
                    MoreCard {
                        ForEach(Array(about.lines.enumerated()), id: \.element) { i, line in
                            if i > 0 { MoreDivider() }
                            valueRow(line)
                                .accessibilityElement(children: .combine)
                                .contextMenu {
                                    Button("Kopieer") { UIPasteboard.general.string = line.value }
                                }
                        }
                        MoreDivider()
                        MoreRowView(symbol: "wifi", title: AboutInfo.connectionLabel) {
                            MoreBadge(text: AboutInfo.badge(connection), tone: connection == .reachable ? .okay : .mute)
                        }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(AboutInfo.connectionLabel), \(AboutInfo.badge(connection))")
                    }
                }
                MoreText.footnote(AboutInfo.note)
            }
            MoreGroup(label: AboutInfo.extraLabel) {
                MoreCard {
                    let row = MoreMenu.row(.developer, MoreMenu.State())
                    Button(action: openDeveloper) {
                        MoreRowView(symbol: row.symbol, title: row.title, lines: row.lines, chevron: .push)
                    }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(row.accessibilityLabel)
                    .accessibilityAddTraits(.isButton)
                }
            }
        }
    }

    /// The value beside its label on one line when it fits ("Server ·
    /// verder.example"); otherwise under the label at the full row width,
    /// breaking only after a dot — never squeezed into a right-aligned
    /// column that splits a hostname mid-word.
    private func valueRow(_ line: AboutInfo.Line) -> some View {
        ViewThatFits(in: .horizontal) {
            MoreRowView(symbol: line.symbol, title: line.label) {
                Text(line.value)
                    .font(MoreType.value)
                    .foregroundStyle(Color.inkBright)
                    .lineLimit(1)
                    .fixedSize()
                    .textSelection(.enabled)
            }
            MoreRowView(symbol: line.symbol, title: line.label) {
                Text(AboutInfo.breakableHost(line.value))
                    .font(MoreType.value)
                    .foregroundStyle(Color.inkBright)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .environment(\.moreValueBelow, true)
        }
    }
}

// MARK: - Ontwikkelaar

/// The developer tools, one level down: the APNs environment verder stored
/// for this phone (the first thing to read when a push does not arrive — a
/// sandbox token on the production host is the classic silent failure, spec
/// §6.3), and Plan 1 Task 12's resend check.
struct DeveloperScreen: View {
    let center: UploadCenter
    let push: PushRegistrar
    let now: @Sendable () -> Date

    @State private var confirmResend = false

    var body: some View {
        MorePage(title: MoreMenu.title(.developer)) {
            MoreGroup(label: DeveloperCopy.pushLabel) {
                MoreCard {
                    pair("bell", "APNs-omgeving", push.registeredEnvironment ?? DeveloperCopy.notRegistered)
                    MoreDivider()
                    pair("iphone", "Apparaat-token", DeveloperCopy.token(tail: push.registeredTokenTail,
                                                                        at: push.registeredAt))
                    MoreDivider()
                    pair("exclamationmark.circle", "Laatste fout", push.lastError ?? "geen")
                }
            }
            // Send the newest sent scan AGAIN with its own clientId; the
            // server must answer `duplicate: true` and store nothing. Behind a
            // confirmation, because it is a real upload to the real dossier.
            MoreGroup(label: DeveloperCopy.uploadLabel) {
                MoreCard {
                    MoreRowView(symbol: "doc.text", title: "Laatste scan",
                                lines: [.mono(center.lastSent?.fileName ?? "nog geen scan verstuurd")])
                        .accessibilityElement(children: .combine)
                    MoreDivider()
                    MoreRowView(symbol: "checkmark.square", title: "Laatste antwoord",
                                titleColor: .inkBright,
                                lines: [.mono(DeveloperCopy.answer(center.resendAnswer,
                                                                   failure: center.resendAnswer == nil ? center.resendResult : nil,
                                                                   now: now()))])
                        .accessibilityElement(children: .combine)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                MoreButton(title: DeveloperCopy.resend, tint: .inkBright,
                           enabled: center.lastSent != nil, busy: center.isResending) {
                    confirmResend = true
                }
                MoreText.footnote(DeveloperCopy.note)
            }
            .padding(.top, 8)
        }
        .sensoryFeedback(.success, trigger: center.resendAnswer) { _, new in new?.duplicate == true }
        .confirmationDialog("Laatste scan opnieuw versturen met dezelfde clientId?",
                            isPresented: $confirmResend, titleVisibility: .visible) {
            Button("Opnieuw versturen") { Task { await center.resendLastSent() } }
            Button("Annuleren", role: .cancel) {}
        } message: {
            Text("verder hoort te antwoorden met duplicate: true, zonder een nieuw document.")
        }
    }

    private func pair(_ symbol: String, _ label: String, _ value: String) -> some View {
        MoreRowView(symbol: symbol, title: label) {
            Text(value)
                .font(MoreType.value)
                .foregroundStyle(Color.inkBright)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }
}
