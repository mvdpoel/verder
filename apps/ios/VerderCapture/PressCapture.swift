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
        let text = try XCTUnwrap(env["CAPTURE_PRESS"], "CAPTURE_PRESS: the text to long-press")
        let out = try XCTUnwrap(env["CAPTURE_OUT"], "CAPTURE_OUT: where the PNG goes")
        let args = try XCTUnwrap(env["CAPTURE_ARGS"], "CAPTURE_ARGS: the app's launch arguments")
        let app = XCUIApplication()
        app.launchArguments = args.split(separator: "\n").map(String.init)
        app.launch()
        let target = app.staticTexts[text].firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 10), "nothing on screen reads '\(text)'")
        target.press(forDuration: 1.0)
        // The menu's lift and spring settle well inside a second.
        Thread.sleep(forTimeInterval: 1.5)
        let png = XCUIScreen.main.screenshot().pngRepresentation
        try png.write(to: URL(fileURLWithPath: out))
    }
}
