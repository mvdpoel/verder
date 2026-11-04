import XCTest

/// Not a test: `scripts/capture.sh --press <text>` runs this to screenshot a
/// state only a long press reaches (the Wachtrij row menu, frame
/// "Wachtrij / rij-acties"). It launches the app with the very launch
/// arguments capture.sh built (CAPTURE_ARGS, one per line), so the state is
/// the one every other capture reaches. Lives in its own scheme
/// (GripCapture), never in `Verder`'s test action: it writes a file.
final class PressCapture: XCTestCase {
    /// The text itself, or — where a row reads as ONE element (Voor jou's
    /// rows combine kind, title and age into one sentence) — the element
    /// whose label holds it.
    @MainActor
    private func element(_ app: XCUIApplication, reading text: String) -> XCUIElement {
        let exact = app.staticTexts[text].firstMatch
        if exact.waitForExistence(timeout: 6) { return exact }
        return app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    @MainActor
    func testPressAndCapture() throws {
        let env = ProcessInfo.processInfo.environment
        // The scheme's other capture (`--notify`) runs in the same target.
        try XCTSkipIf(env["CAPTURE_SCENE"] != nil, "a --notify capture")
        let tap = env["CAPTURE_TAP"].flatMap { $0.isEmpty ? nil : $0 }
        let text = env["CAPTURE_PRESS"] ?? ""
        let swipe = env["CAPTURE_SWIPE"].flatMap { $0.isEmpty ? nil : $0 }
        XCTAssertTrue(tap != nil || swipe != nil || !text.isEmpty, "CAPTURE_PRESS, CAPTURE_TAP or CAPTURE_SWIPE: the gesture")
        let out = try XCTUnwrap(env["CAPTURE_OUT"], "CAPTURE_OUT: where the PNG goes")
        let args = try XCTUnwrap(env["CAPTURE_ARGS"], "CAPTURE_ARGS: the app's launch arguments")
        let app = XCUIApplication()
        app.launchArguments = args.split(separator: "\n").map(String.init)
        app.launch()
        if let tap {
            // `--tap`: a button by its accessibility label (a toolbar Menu).
            let button = app.buttons[tap].firstMatch
            XCTAssertTrue(button.waitForExistence(timeout: 10), "no button labelled '\(tap)'")
            Thread.sleep(forTimeInterval: 2)
            button.tap()
            Thread.sleep(forTimeInterval: 1.5)
            try XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: out))
            return
        }
        if let swipe, let colon = swipe.lastIndex(of: ":") {
            // `--swipe <text>:<left|right>`: drag the row part-way, slowly, so
            // it stays open on its action instead of completing a full swipe.
            let label = String(swipe[..<colon])
            let right = swipe[swipe.index(after: colon)...] == "right"
            let row = element(app, reading: label)
            XCTAssertTrue(row.waitForExistence(timeout: 10), "nothing on screen reads '\(label)'")
            Thread.sleep(forTimeInterval: 2)
            let start = row.coordinate(withNormalizedOffset: CGVector(dx: right ? 0.1 : 0.8, dy: 0.5))
            let end = start.withOffset(CGVector(dx: right ? 170 : -200, dy: 0))
            start.press(forDuration: 0.05, thenDragTo: end, withVelocity: 200, thenHoldForDuration: 0.3)
            Thread.sleep(forTimeInterval: 1.2)
            try XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: out))
            return
        }
        let target = element(app, reading: text)
        XCTAssertTrue(target.waitForExistence(timeout: 10), "nothing on screen reads '\(text)'")
        target.press(forDuration: 1.0)
        // The menu's lift and spring settle well inside a second.
        Thread.sleep(forTimeInterval: 1.5)
        let png = XCUIScreen.main.screenshot().pngRepresentation
        try png.write(to: URL(fileURLWithPath: out))
    }
}
