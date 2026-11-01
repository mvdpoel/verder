import SwiftUI
import UIKit

/// The screens behind Meer's rows. Thin: every word is `AccountCopy`,
/// `NotificationsCopy`, `WidgetGuide` or `AboutInfo`, so they can be aligned
/// to the Figma frames without touching what they say.
private struct MorePage<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        ZStack {
            Color.void.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    MoreText.title(title)
                    content
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 26)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .preferredColorScheme(.dark)
    }
}

private struct Panel<Content: View>: View {
    let label: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let label { MoreText.label(label) }
            VStack(alignment: .leading, spacing: 12) { content }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassPanel()
        }
    }
}

// MARK: - Account

struct AccountScreen: View {
    let auth: AuthModel
    let account: AccountModel
    let signOut: () async -> Void

    @State private var confirmSignOut = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        MorePage(title: MoreMenu.title(.account)) {
            Panel(label: AccountCopy.emailLabel) {
                switch account.display {
                case .loading:
                    MoreText.body(AccountCopy.unknownEmail, color: .inkBright)
                case .shown(let dto):
                    MoreText.body(dto.email, color: .inkBright)
                case .unavailable(let why):
                    MoreText.body(why, color: .inkBright)
                    AuthButton(title: AccountCopy.retry, weight: .secondary, enabled: true) {
                        Task { await account.refresh() }
                    }
                }
            }
            Panel(label: AccountCopy.passkeyLabel) {
                if case .unavailable = account.display {
                    MoreText.body(AccountCopy.passkeyUnknown)
                } else {
                    MoreText.body(AccountCopy.passkeyLine(account.passkeys))
                }
                if let message = auth.passkeyMessage { MoreText.body(message) }
                if AccountCopy.offersPasskey(account.passkeys) {
                    AuthButton(title: "Passkey toevoegen", weight: .secondary, enabled: !auth.isBusy) {
                        Task { await auth.addPasskey() }
                    }
                }
            }
            Panel(label: nil) {
                Button {
                    openURL(AccountCopy.devicesURL(base: auth.client.base))
                } label: {
                    HStack {
                        Text(AccountCopy.devicesLink)
                            .font(.display(17, relativeTo: .body, weight: .regular))
                            .foregroundStyle(Color.signalLink)
                        Spacer(minLength: 8)
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color.inkFaint)
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                MoreText.body(AccountCopy.devicesNote, color: .inkSoft)
            }
            AuthButton(title: AccountCopy.signOutConfirm, weight: .secondary, enabled: !auth.isBusy) {
                confirmSignOut = true
            }
        }
        .confirmationDialog(AccountCopy.signOutQuestion, isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button(AccountCopy.signOutConfirm, role: .destructive) { Task { await signOut() } }
            Button(AccountCopy.cancel, role: .cancel) {}
        } message: {
            Text(AccountCopy.signOutMessage)
        }
        .task { await account.refresh() }
    }
}

// MARK: - Meldingen

struct NotificationsScreen: View {
    let push: PushRegistrar

    var body: some View {
        MorePage(title: MoreMenu.title(.notifications)) {
            Panel(label: nil) {
                MoreText.body(NotificationsCopy.permissionLine(push.permission), color: .inkBright)
                if let error = push.lastError { MoreText.readout(error) }
                switch NotificationsCopy.action(push.permission) {
                case .ask?:
                    AuthButton(title: PushRegistrar.Copy.allow, weight: .secondary, enabled: true) {
                        Task { await push.acceptPrePrompt() }
                    }
                case .openSettings?:
                    AuthButton(title: NotificationsCopy.openSettings, weight: .secondary, enabled: true) {
                        if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    }
                case nil:
                    EmptyView()
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                MoreText.label(NotificationsCopy.kindsLabel)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(NotificationsCopy.kinds.enumerated()), id: \.element.category) { i, kind in
                        if i > 0 { Rectangle().fill(Color.hairline).frame(height: 1) }
                        VStack(alignment: .leading, spacing: 3) {
                            Text(kind.name)
                                .font(.display(17, relativeTo: .body, weight: .regular))
                                .foregroundStyle(Color.inkBright)
                            MoreText.body(kind.explanation, color: .inkSoft)
                        }
                        .padding(.vertical, 12)
                    }
                }
                .padding(.horizontal, 16)
                .glassPanel()
                MoreText.body(NotificationsCopy.quietNote, color: .inkDim)
            }
        }
        .task { await push.refresh() }
    }
}

// MARK: - Widgets toevoegen

struct WidgetGuideScreen: View {
    var body: some View {
        MorePage(title: MoreMenu.title(.widgets)) {
            Panel(label: WidgetGuide.homeLabel) { steps(WidgetGuide.homeSteps) }
            Panel(label: WidgetGuide.lockLabel) { steps(WidgetGuide.lockSteps) }
            Panel(label: WidgetGuide.sizesLabel) {
                ForEach(WidgetGuide.sizes, id: \.name) { size in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(size.name)
                            .font(.display(17, relativeTo: .body, weight: .regular))
                            .foregroundStyle(Color.inkBright)
                        MoreText.body(size.shows, color: .inkSoft)
                    }
                }
            }
            MoreText.body(WidgetGuide.privacy, color: .inkDim)
        }
    }

    private func steps(_ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text("\(i + 1)")
                        .font(.mono(12, relativeTo: .footnote, weight: .medium))
                        .foregroundStyle(Color.signal)
                        .frame(width: 16, alignment: .leading)
                    MoreText.body(line)
                }
            }
        }
    }
}

// MARK: - Over verder

struct AboutScreen: View {
    let server: URL

    var body: some View {
        let about = AboutInfo(info: Bundle.main.infoDictionary ?? [:], server: server)
        MorePage(title: MoreMenu.title(.about)) {
            Panel(label: nil) {
                ForEach(about.lines, id: \.self) { line in
                    HStack {
                        MoreText.body(line.label, color: .inkSoft)
                        Spacer(minLength: 8)
                        Text(line.value)
                            .font(.mono(12, relativeTo: .footnote))
                            .foregroundStyle(Color.inkBright)
                            .textSelection(.enabled)
                    }
                }
            }
            MoreText.body(AboutInfo.note, color: .inkDim)
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

    @State private var confirmResend = false

    var body: some View {
        MorePage(title: MoreMenu.title(.developer)) {
            Panel(label: "Meldingen") {
                MoreText.readout("omgeving: \(push.registeredEnvironment ?? "nog niet aangemeld")")
            }
            // Send the newest sent scan AGAIN with its own clientId; the
            // server must answer `duplicate: true` and store nothing. Behind a
            // confirmation, because it is a real upload to the real dossier.
            Panel(label: "Scans") {
                if let item = center.lastSent { MoreText.readout(item.fileName) }
                AuthButton(title: "Opnieuw versturen (zelfde clientId)", weight: .secondary,
                           enabled: center.lastSent != nil && !center.isResending) {
                    confirmResend = true
                }
                if let result = center.resendResult {
                    Text(result)
                        .font(.mono(12, relativeTo: .footnote))
                        .foregroundStyle(Color.ink)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .confirmationDialog("Laatste scan opnieuw versturen met dezelfde clientId?",
                            isPresented: $confirmResend, titleVisibility: .visible) {
            Button("Opnieuw versturen") { Task { await center.resendLastSent() } }
            Button("Annuleren", role: .cancel) {}
        } message: {
            Text("verder hoort te antwoorden met duplicate: true, zonder een nieuw document.")
        }
    }
}
