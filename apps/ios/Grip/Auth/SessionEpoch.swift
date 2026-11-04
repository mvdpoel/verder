import Foundation

/// ONE sign-out epoch for every store that holds case content.
///
/// A refresh or a sync that is suspended at an `await` when the session ends
/// (Meer → Uitloggen, or a 401 anywhere) resumes AFTER the case was wiped,
/// and without this would write it straight back: Voor jou's widget snapshot
/// and the icon badge, the money glance, and the pocket dossier (an actor is
/// reentrant, so its `wipe()` runs while a `sync` waits on the network).
///
/// The rule every store follows: read `current` BEFORE the first await, and
/// check `isCurrent` after EVERY await before writing anything — memory,
/// disk, widget or badge. `AuthModel` owns the one instance and `end()`s it
/// on every way out (sign-out, sign-out without a network, a rejected
/// session); each store registers with `whenEnded` what it forgets, so the
/// forgetting happens in one place and no caller can leave one store out.
///
/// Only an ENDING moves the epoch, not a sign-in: anything started before
/// the end belongs to the old session whatever happens after it.
@MainActor
final class SessionEpoch {
    private(set) var current = 0
    private var enders: [@MainActor () -> Void] = []

    init() {}

    func isCurrent(_ epoch: Int) -> Bool { epoch == current }

    /// Runs on every `end()`, after the epoch has moved, so anything the
    /// ender starts already sees the new epoch.
    func whenEnded(_ ender: @escaping @MainActor () -> Void) {
        enders.append(ender)
    }

    func end() {
        current += 1
        for ender in enders { ender() }
    }
}
