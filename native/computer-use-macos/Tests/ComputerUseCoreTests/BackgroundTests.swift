import CoreGraphics
import XCTest
@testable import ComputerUseCore

final class BackgroundTests: XCTestCase {
    private let all = BackgroundSupport(backgroundPointer: true, focusWithoutRaise: true, keyAuth: true)
    private let plainWindow = BackgroundTarget(windowOnScreen: true, chromium: false, electron: false, readsPointer: false)

    func testEverythingGoesInTheBackgroundWhenTheCallsAndTheWindowAllowIt() {
        for input in [BackgroundInput.click(button: 0, count: 1), .click(button: 0, count: 2), .scroll, .keys] {
            XCTAssertNil(foregroundReason(input, support: all, target: plainWindow), "\(input)")
        }
    }

    func testMissingCallsOrAWindowOffThisSpaceGoAsRealInput() {
        var noCalls = all
        noCalls.backgroundPointer = false
        XCTAssertNotNil(foregroundReason(.keys, support: noCalls, target: plainWindow))
        var noFocus = all
        noFocus.focusWithoutRaise = false
        XCTAssertNotNil(foregroundReason(.click(button: 0, count: 1), support: noFocus, target: plainWindow))
        XCTAssertNil(foregroundReason(.keys, support: noFocus, target: plainWindow))
        var minimized = plainWindow
        minimized.windowOnScreen = false
        for input in [BackgroundInput.click(button: 0, count: 1), .scroll, .keys] {
            XCTAssertNotNil(foregroundReason(input, support: all, target: minimized), "\(input)")
        }
    }

    func testOnlyALeftSingleOrDoubleClickGoesInTheBackground() {
        XCTAssertNotNil(foregroundReason(.click(button: 1, count: 1), support: all, target: plainWindow))
        XCTAssertNotNil(foregroundReason(.click(button: 0, count: 3), support: all, target: plainWindow))
    }

    func testAPointerReadingToolkitGetsRealPointerInputButBackgroundKeys() {
        var tk = plainWindow
        tk.readsPointer = true
        XCTAssertNotNil(foregroundReason(.click(button: 0, count: 1), support: all, target: tk))
        XCTAssertNotNil(foregroundReason(.scroll, support: all, target: tk))
        XCTAssertNil(foregroundReason(.keys, support: all, target: tk))
    }

    func testElectronScrollsAsRealInput() {
        let electron = BackgroundTarget(windowOnScreen: true, chromium: true, electron: true, readsPointer: false)
        XCTAssertNotNil(foregroundReason(.scroll, support: all, target: electron))
        XCTAssertNil(foregroundReason(.click(button: 0, count: 1), support: all, target: electron))
    }

    func testChromiumKeysNeedKeyAuthentication() {
        var macOS14 = all
        macOS14.keyAuth = false
        let chrome = BackgroundTarget(windowOnScreen: true, chromium: true, electron: false, readsPointer: false)
        XCTAssertNotNil(foregroundReason(.keys, support: macOS14, target: chrome))
        XCTAssertNil(foregroundReason(.keys, support: macOS14, target: plainWindow))
        XCTAssertNil(foregroundReason(.keys, support: all, target: chrome))
    }

    func testTheClickPlanPrimesOffScreenThenClicksTheTarget() {
        let p = CGPoint(x: 300, y: 200)
        let single = backgroundClickPlan(at: p, count: 1)
        XCTAssertEqual(single.map(\.kind), [.move, .down, .up, .down, .up])
        XCTAssertEqual(single.map(\.point), [p, CGPoint(x: -1, y: -1), CGPoint(x: -1, y: -1), p, p])
        XCTAssertEqual(single.map(\.phase), [2, 1, 2, 3, 3])
        let double = backgroundClickPlan(at: p, count: 2)
        XCTAssertEqual(double.suffix(4).map(\.clickState), [1, 1, 2, 2])
        XCTAssertEqual(double[4].delayAfterMs, 80)
        XCTAssertEqual(backgroundClickPlan(at: p, count: 5).count, double.count)
    }

    func testTheTargetCameForwardOnlyWhenItWasBehindAndIsNowInFront() {
        let user: pid_t = 100, other: pid_t = 200, target: pid_t = 300
        XCTAssertTrue(cameForward(target, start: user, now: target))
        XCTAssertFalse(cameForward(target, start: user, now: other))
        XCTAssertFalse(cameForward(target, start: user, now: user))
        XCTAssertFalse(cameForward(target, start: target, now: target))
    }

    func testTheFocusClickLandsInsideTheWindowOrNotAtAll() {
        let window = CGRect(x: 0, y: 0, width: 400, height: 300)
        let partlyBelow = CGRect(x: 100, y: 250, width: 200, height: 100)
        XCTAssertEqual(backgroundFocusPoint(frame: partlyBelow, window: window), CGPoint(x: 200, y: 275))
        XCTAssertNil(backgroundFocusPoint(frame: CGRect(x: 100, y: 320, width: 200, height: 40), window: window))
    }
}
