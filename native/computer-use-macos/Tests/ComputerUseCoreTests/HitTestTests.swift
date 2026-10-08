import ComputerUseCore
import CoreGraphics
import XCTest

final class HitTestTests: XCTestCase {
    let target: Int32 = 100
    let targetWindow: UInt32 = 7
    let me: Int32 = 50
    let dock: Int32 = 30
    let other: Int32 = 200
    let point = CGPoint(x: 400, y: 300)

    let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let targetFrame = CGRect(x: 200, y: 100, width: 800, height: 600)

    var dockWindow: HitWindow { HitWindow(pid: dock, windowID: 1, layer: 20, bounds: screen) }
    var targetWin: HitWindow { HitWindow(pid: target, windowID: targetWindow, layer: 0, bounds: targetFrame) }
    var overlay: HitWindow { HitWindow(pid: me, windowID: 900, layer: 3, bounds: screen) }

    func verdict(_ ax: AXHit?, _ windows: [HitWindow]) -> PointerVerdict {
        pointerVerdict(targetPid: target, targetWindowID: targetWindow, ownPid: me, ax: ax, windows: windows, point: point)
    }

    func testDockFullScreenWindowDoesNotCoverWithoutAX() {
        XCTAssertEqual(verdict(nil, [dockWindow, targetWin]), .target)
    }

    func testDockFullScreenWindowDoesNotCoverEvenWhenAXNamesTheDock() {
        // AX may answer with the Dock's element; the Dock owns no normal window there.
        XCTAssertEqual(verdict(AXHit(pid: dock, windowID: 1), [dockWindow, targetWin]), .target)
    }

    func testNormalWindowOfAnotherAppOnTopRefuses() {
        let cover = HitWindow(pid: other, windowID: 8, layer: 0, bounds: CGRect(x: 300, y: 200, width: 300, height: 300))
        XCTAssertEqual(verdict(nil, [dockWindow, cover, targetWin]), .covered(by: other))
        XCTAssertEqual(verdict(AXHit(pid: other, windowID: 8), [dockWindow, cover, targetWin]), .covered(by: other))
    }

    func testOwnOverlayIsIgnored() {
        XCTAssertEqual(verdict(nil, [overlay, dockWindow, targetWin]), .target)
        XCTAssertEqual(verdict(AXHit(pid: me, windowID: 900), [overlay, targetWin]), .target)
    }

    func testAXOnTargetWindowAllows() {
        // Even with a list that would be wrong, a direct AX answer on the target wins.
        XCTAssertEqual(verdict(AXHit(pid: target, windowID: targetWindow), [dockWindow, targetWin]), .target)
    }

    func testMenuOfTheSameAppAllows() {
        let menu = HitWindow(pid: target, windowID: 9, layer: 101, bounds: CGRect(x: 380, y: 280, width: 200, height: 300))
        XCTAssertEqual(verdict(nil, [menu, targetWin]), .target)
        XCTAssertEqual(verdict(AXHit(pid: target, windowID: nil, inTransient: true), [menu, targetWin]), .target)
        XCTAssertEqual(verdict(AXHit(pid: target, windowID: 9), [menu, targetWin]), .target)
    }

    func testAnotherNormalWindowOfTheSameAppRefuses() {
        let second = HitWindow(pid: target, windowID: 11, layer: 0, bounds: CGRect(x: 300, y: 200, width: 300, height: 300))
        XCTAssertEqual(verdict(nil, [second, targetWin]), .covered(by: target))
        XCTAssertEqual(verdict(AXHit(pid: target, windowID: 11), [second, targetWin]), .covered(by: target))
    }

    func testTransparentWindowsAndMissesAreSkipped() {
        let ghost = HitWindow(pid: other, windowID: 12, layer: 0, bounds: screen, alpha: 0)
        XCTAssertEqual(verdict(nil, [ghost, targetWin]), .target)
        XCTAssertEqual(verdict(nil, [dockWindow]), .covered(by: nil))
    }

    func testFlipBetweenTopLeftAndBottomLeft() {
        let r = CGRect(x: 10, y: 20, width: 100, height: 50)
        XCTAssertEqual(flipRect(r, primaryHeight: 1000), CGRect(x: 10, y: 930, width: 100, height: 50))
        XCTAssertEqual(flipRect(flipRect(r, primaryHeight: 1000), primaryHeight: 1000), r)
    }

    func testLocalPointOnASecondScreen() {
        // A 1920×1080 display above-right of a 1512×982 primary (AppKit frame).
        let secondary = CGRect(x: 1512, y: 982, width: 1920, height: 1080)
        // Its top-left is at (1512, -1080) in global top-left coordinates.
        XCTAssertEqual(localPoint(CGPoint(x: 1600, y: -1000), screenFrame: secondary, primaryHeight: 982), CGPoint(x: 88, y: 80))
        XCTAssertEqual(localPoint(CGPoint(x: 5, y: 6), screenFrame: CGRect(x: 0, y: 0, width: 1512, height: 982), primaryHeight: 982), CGPoint(x: 5, y: 6))
    }
}
