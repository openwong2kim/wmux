import CoreGraphics
import XCTest
@testable import ComputerUseCore

final class BackgroundTests: XCTestCase {
    private let all = BackgroundSupport(backgroundPointer: true, focusWithoutRaise: true, keyAuth: true)
    private let plainWindow = BackgroundTarget(windowOnScreen: true, chromium: false, electron: false, readsPointer: false)

    func testEverythingGoesInTheBackgroundWhenTheCallsAndTheWindowAllowIt() {
        for input in [BackgroundInput.click(button: 0, count: 1), .click(button: 0, count: 2), .scroll, .keys(command: false)] {
            XCTAssertNil(foregroundReason(input, support: all, target: plainWindow), "\(input)")
        }
    }

    func testMissingCallsOrAWindowOffThisSpaceGoAsRealInput() {
        var noCalls = all
        noCalls.backgroundPointer = false
        XCTAssertNotNil(foregroundReason(.keys(command: false), support: noCalls, target: plainWindow))
        var noFocus = all
        noFocus.focusWithoutRaise = false
        XCTAssertNotNil(foregroundReason(.click(button: 0, count: 1), support: noFocus, target: plainWindow))
        XCTAssertNil(foregroundReason(.keys(command: false), support: noFocus, target: plainWindow))
        var minimized = plainWindow
        minimized.windowOnScreen = false
        for input in [BackgroundInput.click(button: 0, count: 1), .scroll, .keys(command: false)] {
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
        XCTAssertNil(foregroundReason(.keys(command: false), support: all, target: tk))
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
        XCTAssertNotNil(foregroundReason(.keys(command: false), support: macOS14, target: chrome))
        XCTAssertNil(foregroundReason(.keys(command: false), support: macOS14, target: plainWindow))
        XCTAssertNil(foregroundReason(.keys(command: false), support: all, target: chrome))
    }

    func testAnotherFocusedWindowOfTheFrontmostAppKeepsClicksAndKeysInTheForeground() {
        var front = plainWindow
        front.frontmost = true
        front.focusedWindow = false
        XCTAssertNotNil(foregroundReason(.keys(command: false), support: all, target: front))
        XCTAssertNotNil(foregroundReason(.click(button: 0, count: 1), support: all, target: front))
        // A scroll sends no focus record, so it still goes in the background.
        XCTAssertNil(foregroundReason(.scroll, support: all, target: front))
        // The target window focused in the frontmost app, or a background app: background.
        front.focusedWindow = true
        XCTAssertNil(foregroundReason(.keys(command: false), support: all, target: front))
        var behind = plainWindow
        behind.focusedWindow = false
        XCTAssertNil(foregroundReason(.keys(command: false), support: all, target: behind))
    }

    func testCommandShortcutsToChromiumGoAsRealInput() {
        let chrome = BackgroundTarget(windowOnScreen: true, chromium: true, electron: false, readsPointer: false)
        let electron = BackgroundTarget(windowOnScreen: true, chromium: true, electron: true, readsPointer: false)
        XCTAssertNotNil(foregroundReason(.keys(command: true), support: all, target: chrome))
        XCTAssertNotNil(foregroundReason(.keys(command: true), support: all, target: electron))
        XCTAssertNil(foregroundReason(.keys(command: false), support: all, target: chrome))
        XCTAssertNil(foregroundReason(.keys(command: true), support: all, target: plainWindow))
    }

    func testTerminalsThatCanTurnOnSecureEntryGetRealKeys() {
        XCTAssertTrue(secureKeyboardEntryApp(bundleID: "com.apple.Terminal"))
        XCTAssertTrue(secureKeyboardEntryApp(bundleID: "com.googlecode.iterm2"))
        XCTAssertFalse(secureKeyboardEntryApp(bundleID: "com.apple.TextEdit"))
        XCTAssertFalse(secureKeyboardEntryApp(bundleID: nil))
        var terminal = plainWindow
        terminal.secureEntry = true
        XCTAssertNotNil(foregroundReason(.keys(command: false), support: all, target: terminal))
        XCTAssertNil(foregroundReason(.click(button: 0, count: 1), support: all, target: terminal))
    }

    func testTheRecordPathIsOnlyForKnownMacOSMajors() {
        for major in [14, 15, 26] { XCTAssertTrue(recordLayoutKnown(major: major), "\(major)") }
        for major in [13, 16, 27] { XCTAssertFalse(recordLayoutKnown(major: major), "\(major)") }
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

    func testTheUserMovingThePointerElsewhereMidTypeIsNoSideEffect() {
        let start = UserState(front: 100, pointer: CGPoint(x: 900, y: 500), space: 1)
        var now = start
        now.pointer = CGPoint(x: 40, y: 700)
        XCTAssertNil(sideEffect(start: start, now: now, pid: 300, point: nil, targetOnScreen: true))
        XCTAssertNil(sideEffect(start: start, now: now, pid: 300, point: CGPoint(x: 300, y: 200), targetOnScreen: true))
        now.front = 200
        XCTAssertNil(sideEffect(start: start, now: now, pid: 300, point: nil, targetOnScreen: true))
        now.space = 2
        XCTAssertNil(sideEffect(start: start, now: now, pid: 300, point: nil, targetOnScreen: false))
    }

    func testThePointerLandingOnTheTargetEndsTheCallWithoutASecondClick() {
        let target = CGPoint(x: 300, y: 200)
        let start = UserState(front: 100, pointer: CGPoint(x: 900, y: 500), space: 1)
        var now = start
        now.pointer = CGPoint(x: 303, y: 204)
        XCTAssertEqual(sideEffect(start: start, now: now, pid: 300, point: target, targetOnScreen: true), .pointerAtTarget)
        // Posted already: the call ends (delivered_unverified), no real click follows.
        XCTAssertEqual(afterStop(posted: true), .end)
        XCTAssertEqual(afterStop(posted: false), .realInput)
        // A pointer that was there before is the user's, not ours.
        XCTAssertNil(sideEffect(start: now, now: now, pid: 300, point: target, targetOnScreen: true))
    }

    func testTheTargetComingForwardOrTakingTheSpaceIsASideEffect() {
        let start = UserState(front: 100, pointer: .zero, space: 1)
        var now = start
        now.front = 300
        XCTAssertEqual(sideEffect(start: start, now: now, pid: 300, point: nil, targetOnScreen: true), .targetCameForward)
        now = start
        now.space = 2
        XCTAssertEqual(sideEffect(start: start, now: now, pid: 300, point: nil, targetOnScreen: true), .spaceSwitchedToTarget)
    }

    func testAChangeAfterRealUserInputIsTheUsersNotOurs() {
        let target = CGPoint(x: 300, y: 200)
        let start = UserState(front: 100, pointer: CGPoint(x: 900, y: 500), space: 1, time: 10, idle: 30)
        var now = start
        now.time = 12
        now.front = 300
        now.pointer = target
        now.space = 2
        // No input for 5 s, 2 s into the action: the changes are ours.
        now.idle = 5
        XCTAssertFalse(userActed(start: start, now: now))
        XCTAssertNotNil(sideEffect(start: start, now: now, pid: 300, point: target, targetOnScreen: true))
        XCTAssertEqual(frontToRestore(start: start, now: now, pid: 300), 100)
        // Input 0.5 s ago, after the start: the user did it.
        now.idle = 0.5
        XCTAssertTrue(userActed(start: start, now: now))
        XCTAssertNil(sideEffect(start: start, now: now, pid: 300, point: target, targetOnScreen: true))
        XCTAssertNil(frontToRestore(start: start, now: now, pid: 300))
    }

    func testAHIDResetFromOurOwnPostIsNotTheUsersInput() {
        let start = UserState(front: 100, pointer: .zero, space: 1, time: 10, idle: 30)
        var now = start
        now.time = 10.5
        now.front = 300
        // Our mouse event posted at 10.2 reset the HID idle time: the last
        // input reads as 10.21. The app came forward on its own, so it goes back.
        now.ownPosts.note(10.2)
        now.idle = 0.29
        XCTAssertFalse(userActed(start: start, now: now))
        XCTAssertEqual(frontToRestore(start: start, now: now, pid: 300), 100)
        // Input at 10.45, after the post settled: the user's, so their front app stays.
        now.idle = 0.05
        XCTAssertTrue(userActed(start: start, now: now))
        XCTAssertNil(frontToRestore(start: start, now: now, pid: 300))
        // Input at 10.1, after the start but before the post: the user's too.
        now.idle = 0.4
        XCTAssertTrue(userActed(start: start, now: now))
    }

    func testPostsCloseTogetherMakeOneSpan() {
        var posts = OwnPosts()
        posts.note(1.0)
        posts.note(1.05)
        posts.note(1.12)
        posts.note(3.0)
        XCTAssertEqual(posts.spans, [1.0...1.12, 3.0...3.0])
        XCTAssertTrue(posts.explain(1.2))
        XCTAssertFalse(posts.explain(1.25))
        XCTAssertFalse(posts.explain(2.9))
        XCTAssertTrue(posts.explain(3.05))
    }

    func testOnlyATargetThatCameForwardIsPutBack() {
        let start = UserState(front: 100, pointer: .zero, space: 1)
        XCTAssertNil(frontToRestore(start: start, now: start, pid: 300))
        var now = start
        now.front = 200
        XCTAssertNil(frontToRestore(start: start, now: now, pid: 300))
    }

    func testTheFocusClickLandsInsideTheWindowOrNotAtAll() {
        let window = CGRect(x: 0, y: 0, width: 400, height: 300)
        let partlyBelow = CGRect(x: 100, y: 250, width: 200, height: 100)
        XCTAssertEqual(backgroundFocusPoint(frame: partlyBelow, window: window), CGPoint(x: 200, y: 275))
        XCTAssertNil(backgroundFocusPoint(frame: CGRect(x: 100, y: 320, width: 200, height: 40), window: window))
    }
}
