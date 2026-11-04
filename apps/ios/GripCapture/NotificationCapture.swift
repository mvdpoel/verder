import XCTest

/// Not a test: `scripts/capture.sh --notify <state>` runs this to screenshot a
/// notification as iOS itself draws it — on the lock screen, as a banner over
/// the app, on the home screen's badge, or opened by a long press with its
/// actions. The PUSH comes from the shell (`xcrun simctl push`), because a UI
/// test cannot send one: this test gets the phone into place, writes
/// `<out>.ready`, waits for the shell's push to appear, and then presses.
///
/// Env (TEST_RUNNER_ prefixed by capture.sh):
///   CAPTURE_ARGS      the app's launch arguments, one per line
///   CAPTURE_OUT       where the PNG goes
///   CAPTURE_SCENE     lock | app | home — where the phone is when the push lands
///   CAPTURE_PREVIEWS  never: Settings → Meldingen → Toon voorvertoning → Nooit for
///                     this shot (put back to "Indien ontgrendeld" afterwards)
///   CAPTURE_WAIT      text the arrived notification holds (empty: wait 4 s)
///   CAPTURE_GESTURE   none | press | press-scroll | act:<action title>
///   CAPTURE_RESULT    with act: the title of the notice the action leads to
final class NotificationCapture: XCTestCase {
    @MainActor var springboard: XCUIApplication { XCUIApplication(bundleIdentifier: "com.apple.springboard") }

    @MainActor
    private func notification(reading text: String) -> XCUIElement {
        springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    @MainActor
    private func shoot(_ out: String) throws {
        try XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: out))
    }

    @MainActor
    private func lock() {
        XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
        Thread.sleep(forTimeInterval: 1.5)
    }

    /// Settings → Notifications → Show Previews. The row titles are read in
    /// either language the simulator may run in.
    /// Settings → Apps → verder → Meldingen → Toon voorvertoningen: the
    /// simulator has no system-wide Notifications pane, only the per-app one,
    /// which is the same setting for verder's notifications.
    @MainActor
    private func setPreviews(_ choices: [String], debug: String) {
        let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        settings.launch()
        func row(_ labels: [String]) -> XCUIElement {
            settings.descendants(matching: .any).matching(NSPredicate(format: "label IN %@", labels)).firstMatch
        }
        func open(_ labels: [String], step: Int) -> Bool {
            let r = row(labels)
            var tries = 0
            while !(r.exists && r.isHittable) && tries < 6 { settings.swipeUp(); tries += 1 }
            guard r.waitForExistence(timeout: 3) else { try? shoot(debug + ".settings\(step).png"); return false }
            r.tap()
            Thread.sleep(forTimeInterval: 0.8)
            return true
        }
        guard open(["Apps"], step: 1), open(["verder"], step: 2), open(["Meldingen", "Notifications"], step: 3) else { return }
        let previews = settings.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Show Previews", "Toon voorvertoning")).firstMatch
        var tries = 0
        while !(previews.exists && previews.isHittable) && tries < 4 { settings.swipeUp(); tries += 1 }
        guard previews.waitForExistence(timeout: 3) else { try? shoot(debug + ".settings4.png"); return }
        previews.tap()
        guard open(choices, step: 5) else { return }
        settings.terminate()
    }

    @MainActor
    func testNotificationCapture() throws {
        let env = ProcessInfo.processInfo.environment
        // The scheme's other capture (`--press`) runs in the same target.
        try XCTSkipIf(env["CAPTURE_SCENE"] == nil, "not a --notify capture")
        let out = try XCTUnwrap(env["CAPTURE_OUT"], "CAPTURE_OUT: where the PNG goes")
        let args = try XCTUnwrap(env["CAPTURE_ARGS"], "CAPTURE_ARGS: the app's launch arguments")
        let scene = env["CAPTURE_SCENE"] ?? "lock"
        let wait = env["CAPTURE_WAIT"] ?? ""
        let gesture = env["CAPTURE_GESTURE"] ?? "none"
        let hidden = env["CAPTURE_PREVIEWS"] == "never"

        if hidden { setPreviews(["Never", "Nooit"], debug: out) }
        defer { if hidden { setPreviews(["Always (Default)", "Altijd (Standaard)", "Altijd (standaard)", "Altijd", "Always"], debug: out) } }

        let app = XCUIApplication()
        app.launchArguments = args.split(separator: "\n").map(String.init)
        app.launch()
        // `-fixtures-notify-allow` asks for the real permission once per install.
        let allow = springboard.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["Allow", "Sta toe", "Toestaan"])).firstMatch
        if allow.waitForExistence(timeout: 4) { allow.tap() }
        Thread.sleep(forTimeInterval: 1.5)

        switch scene {
        case "home": XCUIDevice.shared.press(.home); Thread.sleep(forTimeInterval: 1.5)
        case "app": break
        default: lock()
        }
        // The shell pushes once this file exists.
        try Data().write(to: URL(fileURLWithPath: out + ".ready"))

        guard !wait.isEmpty else {
            Thread.sleep(forTimeInterval: 4)
            try shoot(out)
            return
        }
        let arrived = notification(reading: wait)
        guard arrived.waitForExistence(timeout: 90) else {
            try? shoot(out + ".debug.png")
            XCTFail("no notification reading '\(wait)' arrived"); return
        }
        // A home-button phone (the SE) keeps its screen dark for a notification
        // that arrives locked; one press of the home button lights it.
        if env["CAPTURE_WAKE"] == "1" { XCUIDevice.shared.press(.home) }
        // The banner's slide-in, or the lock screen waking, settles in a second.
        Thread.sleep(forTimeInterval: 1.5)

        if gesture == "none" { try shoot(out); return }

        arrived.press(forDuration: 1.2)
        Thread.sleep(forTimeInterval: 1.8)
        if gesture == "press-scroll" {
            springboard.swipeUp(velocity: .slow)
            Thread.sleep(forTimeInterval: 1.5)
        }
        if gesture.hasPrefix("act:") {
            let title = String(gesture.dropFirst(4))
            let action = springboard.buttons.matching(NSPredicate(format: "label == %@", title)).firstMatch
            guard action.waitForExistence(timeout: 5) else {
                try? shoot(out + ".debug.png")
                XCTFail("no action '\(title)' on the notification"); return
            }
            action.tap()
            let result = try XCTUnwrap(env["CAPTURE_RESULT"].flatMap { $0.isEmpty ? nil : $0 }, "CAPTURE_RESULT")
            // The action runs in the app in the background; its notice is a
            // new notification. Lock again so it lands where the frame draws it.
            lock()
            XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
            Thread.sleep(forTimeInterval: 1)
            // A notice that arrived before the lock sits in the notification
            // centre's history, one swipe up on the lock screen.
            if !notification(reading: result).waitForExistence(timeout: 6) {
                let mid = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.62))
                mid.press(forDuration: 0.05, thenDragTo: mid.withOffset(CGVector(dx: 0, dy: -260)))
                Thread.sleep(forTimeInterval: 1)
            }
            guard notification(reading: result).waitForExistence(timeout: 20) else {
                try? shoot(out + ".debug.png")
                XCTFail("no notice '\(result)'"); return
            }
            Thread.sleep(forTimeInterval: 1.5)
        }
        try shoot(out)
    }
}
