import XCTest

/// Not a test: `scripts/capture.sh --press <text>` runs this to screenshot a
/// state only a long press reaches (the Wachtrij row menu, frame
/// "Wachtrij / rij-acties"). It launches the app with the very launch
/// arguments capture.sh built (CAPTURE_ARGS, one per line), so the state is
/// the one every other capture reaches. Lives in its own scheme
/// (VerderCapture), never in `Verder`'s test action: it writes a file.
final class PressCapture: XCTestCase {
    @MainActor
    func testPressAndCapture() throws {
        let env = ProcessInfo.processInfo.environment
        let tap = env["CAPTURE_TAP"].flatMap { $0.isEmpty ? nil : $0 }
        let text = env["CAPTURE_PRESS"] ?? ""
        XCTAssertTrue(tap != nil || !text.isEmpty, "CAPTURE_PRESS or CAPTURE_TAP: the gesture")
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
        let target = app.staticTexts[text].firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 10), "nothing on screen reads '\(text)'")
        target.press(forDuration: 1.0)
        // The menu's lift and spring settle well inside a second.
        Thread.sleep(forTimeInterval: 1.5)
        let png = XCUIScreen.main.screenshot().pngRepresentation
        try png.write(to: URL(fileURLWithPath: out))
    }
}
