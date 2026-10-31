// Background input rules: which way an input action goes, and the event
// sequence of a background click. The posting itself is in
// Sources/wmux-computer-use/Background.swift; this part is pure, so it is
// unit-tested without a TCC grant.

import CoreGraphics

/// What the helper found it can call (protocol HelperInputCapabilities).
public struct BackgroundSupport: Equatable {
    public var backgroundPointer: Bool
    public var focusWithoutRaise: Bool
    public var keyAuth: Bool

    public init(backgroundPointer: Bool, focusWithoutRaise: Bool, keyAuth: Bool) {
        self.backgroundPointer = backgroundPointer
        self.focusWithoutRaise = focusWithoutRaise
        self.keyAuth = keyAuth
    }
}

/// What the helper knows about the target window and its app.
public struct BackgroundTarget: Equatable {
    /// On screen on the current Space: not minimized, hidden or on another Space.
    public var windowOnScreen: Bool
    /// Chromium-based (a browser or an Electron app): it takes posted keys
    /// only with the authentication message.
    public var chromium: Bool
    public var electron: Bool
    /// The toolkit places a click where the real pointer is (Tk, LibreOffice).
    public var readsPointer: Bool

    public init(windowOnScreen: Bool, chromium: Bool, electron: Bool, readsPointer: Bool) {
        self.windowOnScreen = windowOnScreen
        self.chromium = chromium
        self.electron = electron
        self.readsPointer = readsPointer
    }
}

public enum BackgroundInput: Equatable {
    /// `button` 0 is left.
    case click(button: Int, count: Int)
    case scroll
    case keys
}

/// Nil when the input can go to the target alone; otherwise why it goes as
/// real input instead (the result then says `delivery: foreground`).
public func foregroundReason(_ input: BackgroundInput, support: BackgroundSupport, target: BackgroundTarget) -> String? {
    guard support.backgroundPointer else { return "this macOS lacks the calls background input needs" }
    guard target.windowOnScreen else { return "the window is not on screen on this Space (minimized, hidden or on another Space)" }
    switch input {
    case let .click(button, count):
        guard support.focusWithoutRaise else { return "this macOS lacks the call that focuses a window without raising it" }
        guard button == 0 else { return "only a left click goes in the background" }
        guard count <= 2 else { return "a triple click goes as real input" }
        guard !target.readsPointer else { return "the app places clicks where the real pointer is" }
    case .scroll:
        guard !target.electron else { return "Electron apps do not scroll from background events" }
        guard !target.readsPointer else { return "the app places the scroll where the real pointer is" }
    case .keys:
        guard support.keyAuth || !target.chromium else {
            return "Chromium-based apps need key authentication, which macOS has from version 15"
        }
    }
    return nil
}

/// One event of a background left click.
public struct BackgroundMouseEvent: Equatable {
    public enum Kind: Equatable { case move, down, up }
    public let kind: Kind
    /// The screen point, used as both the event and the window location.
    public let point: CGPoint
    /// kCGMouseEventClickState.
    public let clickState: Int64
    /// Field 0, the gesture phase: move 2, primer down 1, primer up 2, target 3.
    public let phase: Int64
    public let delayAfterMs: UInt32
}

/// A mouseMoved at the target, a primer click off screen (Chromium's
/// user-activation check), then one or two down/up pairs at the target.
///
/// Adapted from Cua Driver (MIT) libs/cua-driver/rust/crates/platform-macos/src/input/mouse.rs@a9902d27
public func backgroundClickPlan(at point: CGPoint, count: Int) -> [BackgroundMouseEvent] {
    let offScreen = CGPoint(x: -1, y: -1)
    var plan: [BackgroundMouseEvent] = [
        BackgroundMouseEvent(kind: .move, point: point, clickState: 0, phase: 2, delayAfterMs: 15),
        BackgroundMouseEvent(kind: .down, point: offScreen, clickState: 1, phase: 1, delayAfterMs: 1),
        BackgroundMouseEvent(kind: .up, point: offScreen, clickState: 1, phase: 2, delayAfterMs: 100),
    ]
    let pairs = min(max(count, 1), 2)
    for n in 1...pairs {
        plan.append(BackgroundMouseEvent(kind: .down, point: point, clickState: Int64(n), phase: 3, delayAfterMs: 1))
        plan.append(BackgroundMouseEvent(kind: .up, point: point, clickState: Int64(n), phase: 3, delayAfterMs: n < pairs ? 80 : 0))
    }
    return plan
}

/// Focusing the target in the background brought its app to the front: it
/// was not frontmost when the action started and is now. The action then
/// goes on as real input.
public func cameForward(_ pid: pid_t, start: pid_t?, now: pid_t?) -> Bool {
    start != pid && now == pid
}

/// Where a background click gives an element focus: the centre of the part
/// of its frame inside the window, or nil when none of it is inside.
public func backgroundFocusPoint(frame: CGRect, window: CGRect) -> CGPoint? {
    let visible = frame.intersection(window)
    guard !visible.isNull, !visible.isEmpty else { return nil }
    return CGPoint(x: visible.midX, y: visible.midY)
}
