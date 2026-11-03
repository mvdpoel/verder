import Foundation

/// How Martin signs in: the toegangssleutel (Face ID) first, the password second.
enum SignInMethod: Equatable, Sendable { case passkey, password }

/// One failed (or ended) sign-in, as the sign-in screen's notice draws it
/// (Figma "auth · final", FEATURES 3.10–3.16): a label naming the KIND and the
/// moment of the attempt ("WACHTWOORD · 14:02"), a one-line title naming the
/// cause, and one line saying what to do next. The time matters because the
/// screen may be looked at again minutes later, and a "lukte niet" without a
/// time reads as current.
///
/// It also decides what the screen offers around it — which step, which
/// button, which line under it — so every layout decision is pinned by
/// `SignInNoticeTests` and the view only draws it.
///
/// No amber anywhere here: a failed sign-in is not something in the dossier
/// that waits on Martin.
struct SignInNotice: Equatable, Sendable {
    enum Cause: Equatable, Sendable {
        /// 401 on the password path.
        case wrongPassword
        /// iOS holds no toegangssleutel for verder on this phone. NOT mapped
        /// from any iOS error yet: which `ASAuthorizationError` an empty
        /// allow-list with no credential produces is unmeasured, and a wrong
        /// mapping would hide a real failure behind "use your password".
        case noPasskeyOnDevice
        /// The phone still holds one, the server no longer knows it
        /// (better-auth 401 `PASSKEY_NOT_FOUND`: removed at Beveiliging).
        case passkeyNotOnAccount
        /// Any other passkey failure, with a short secret-free cause.
        case passkeyFailed(String?)
        /// 429; the button comes back by itself at `until`.
        case rateLimited(until: Date)
        /// The phone is online, verder is not answering (5xx, a timeout).
        case serverDown
        /// The phone itself has no network.
        case offline
        /// Any other refusal.
        case failed(String?)
        /// The SERVER ended the session (a 401 anywhere).
        case sessionExpired
    }

    enum Kind: String, Sendable { case wachtwoord, toegangssleutel, server, netwerk, beveiliging, uitgelogd }

    /// What the screen's single primary button does.
    enum Action: Equatable, Sendable {
        /// "Inloggen met toegangssleutel": the passkey ceremony.
        case passkey
        /// "Inloggen met wachtwoord": submits the fields (or opens them).
        case password
        /// "Probeer opnieuw": the last method again — a passkey retry is a new
        /// Face ID, so it only ever runs on a tap.
        case retry
    }

    let cause: Cause
    let at: Date
    /// The method that was tried.
    let method: SignInMethod

    var kind: Kind {
        switch cause {
        case .wrongPassword: .wachtwoord
        case .noPasskeyOnDevice, .passkeyNotOnAccount, .passkeyFailed: .toegangssleutel
        case .rateLimited: .beveiliging
        case .serverDown, .failed: .server
        case .offline: .netwerk
        case .sessionExpired: .uitgelogd
        }
    }

    /// "WACHTWOORD · 14:02"; the expiry carries its day ("UITGELOGD · 1 NOV 09:12"),
    /// because it may be read the next morning.
    var label: String {
        let stamp = cause == .sessionExpired ? Self.dayTime(at) : Self.time(at)
        return "\(kind.rawValue.uppercased()) · \(stamp)"
    }

    var title: String {
        switch cause {
        case .wrongPassword: "E-mailadres of wachtwoord klopt niet."
        case .noPasskeyOnDevice: "Geen toegangssleutel gevonden op deze iPhone."
        case .passkeyNotOnAccount: "Deze toegangssleutel hoort niet meer bij je account."
        case .passkeyFailed: "Inloggen met toegangssleutel lukte niet."
        case .rateLimited: "Te veel pogingen."
        case .serverDown: "De server reageert niet."
        case .offline: "Geen verbinding."
        case .failed: "Inloggen lukte niet."
        case .sessionExpired: "Je sessie is verlopen."
        }
    }

    var body: String {
        switch cause {
        case .wrongPassword: "Controleer je wachtwoord, of log in met je toegangssleutel."
        case .noPasskeyOnDevice: "Log in met je wachtwoord. Daarna kun je er een toegangssleutel bij zetten."
        case .passkeyNotOnAccount:
            "Misschien is hij verwijderd bij Beveiliging. Log in met je wachtwoord en zet daarna een nieuwe toegangssleutel aan."
        case .passkeyFailed: "Probeer het opnieuw, of log in met je wachtwoord."
        case .rateLimited(let until):
            "\(Self.wait(until.timeIntervalSince(at))) · daarna kun je het opnieuw proberen."
        case .serverDown:
            "Het ligt niet aan jou · probeer het over een paar minuten opnieuw. Scans in de wachtrij blijven bewaard."
        case .offline:
            // Only the password is retried by itself (one attempt, when the
            // network returns): a toegangssleutel retry is a Face ID sheet,
            // which must never open without a tap.
            method == .password
                ? "Inloggen kan pas als deze iPhone online is. We proberen het zelf opnieuw zodra er netwerk is."
                : "Inloggen kan pas als deze iPhone online is. Probeer het opnieuw zodra er netwerk is."
        case .failed: "Probeer het over een moment opnieuw."
        case .sessionExpired: "Daarom vragen we opnieuw wie je bent. Niets is verloren: scans in de wachtrij blijven bewaard."
        }
    }

    /// A short, secret-free cause under the body (`AuthModel.diagnostic`).
    var detail: String? {
        switch cause {
        case .passkeyFailed(let d), .failed(let d): d
        default: nil
        }
    }

    /// The fields show (step two) — the cause is about the password, or the
    /// password is the way on.
    var showsFields: Bool {
        switch cause {
        case .wrongPassword, .noPasskeyOnDevice: true
        case .failed: method == .password
        default: false
        }
    }

    var primary: Action {
        switch cause {
        case .serverDown, .offline: .retry
        case .rateLimited: method == .password ? .password : .passkey
        case .wrongPassword, .noPasskeyOnDevice, .passkeyNotOnAccount: .password
        case .failed: method == .password ? .password : .passkey
        case .passkeyFailed, .sessionExpired: .passkey
        }
    }

    /// The line under the primary button; nil leaves the step's own line.
    func caption(now: Date) -> String? {
        switch cause {
        case .rateLimited(let until): now < until ? "Weer mogelijk om \(Self.time(until))" : nil
        case .serverDown: "Laatste poging \(Self.time(at))"
        case .offline: method == .password ? "Ook inloggen met toegangssleutel wacht op netwerk." : nil
        case .passkeyNotOnAccount: "Daarna vragen we of je een nieuwe wilt."
        default: nil
        }
    }

    /// The link under it. `nil` draws none (a frame with one way on).
    enum Ghost: Equatable, Sendable { case toPassword, toPasskey, retryPasskey }
    var ghost: Ghost? {
        switch cause {
        case .wrongPassword: .toPasskey
        case .noPasskeyOnDevice: .retryPasskey
        case .passkeyFailed, .sessionExpired: .toPassword
        case .failed: method == .password ? .toPasskey : .toPassword
        case .rateLimited, .serverDown, .offline, .passkeyNotOnAccount: nil
        }
    }

    /// Whether the primary button can be pressed at `now`.
    func primaryEnabled(now: Date) -> Bool {
        if case .rateLimited(let until) = cause { return now >= until }
        return true
    }

    // MARK: - Formatting

    static let amsterdam = TimeZone(identifier: "Europe/Amsterdam") ?? .current

    static func time(_ date: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = amsterdam
        let c = cal.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    private static let months = ["JAN", "FEB", "MRT", "APR", "MEI", "JUN", "JUL", "AUG", "SEP", "OKT", "NOV", "DEC"]

    static func dayTime(_ date: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = amsterdam
        let c = cal.dateComponents([.day, .month], from: date)
        return "\(c.day ?? 1) \(months[((c.month ?? 1) - 1) % 12]) \(time(date))"
    }

    /// "Wacht een minuut" for better-auth's usual minute; longer waits in minutes.
    static func wait(_ seconds: TimeInterval) -> String {
        let minutes = Int((seconds / 60).rounded(.up))
        return minutes <= 1 ? "Wacht een minuut" : "Wacht \(minutes) minuten"
    }

    /// The fallback when a 429 carries no retry hint (the Cloudflare WAF's
    /// answer may carry none): one minute after the attempt.
    static let defaultRetryAfter: TimeInterval = 60
}
