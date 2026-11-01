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
    /// The target app is the user's frontmost app.
    public var frontmost: Bool
    /// The target window is its app's focused window.
    public var focusedWindow: Bool
    /// A terminal that can turn on Secure Keyboard Entry (secureKeyboardEntryApp).
    public var secureEntry: Bool

    public init(windowOnScreen: Bool, chromium: Bool, electron: Bool, readsPointer: Bool,
                frontmost: Bool = false, focusedWindow: Bool = true, secureEntry: Bool = false) {
        self.windowOnScreen = windowOnScreen
        self.chromium = chromium
        self.electron = electron
        self.readsPointer = readsPointer
        self.frontmost = frontmost
        self.focusedWindow = focusedWindow
        self.secureEntry = secureEntry
    }
}

public enum BackgroundInput: Equatable {
    /// `button` 0 is left.
    case click(button: Int, count: Int)
    case scroll
    /// `command`: the keys carry the Command modifier (a shortcut).
    case keys(command: Bool)
}

/// Terminals that can turn on Secure Keyboard Entry. Their keys go as real
/// input, where the secure-input check applies; posted keys would skip it.
/// Read from the bundle id, which errs toward real input.
public let secureKeyboardEntryApps: Set<String> = [
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "com.mitchellh.ghostty",
    "dev.warp.Warp-Stable",
    "dev.warp.Warp",
    "net.kovidgoyal.kitty",
    "org.alacritty",
    "com.github.wez.wezterm",
    "co.zeit.hyper",
]

public func secureKeyboardEntryApp(bundleID: String?) -> Bool {
    bundleID.map(secureKeyboardEntryApps.contains) ?? false
}

/// The macOS major versions whose event-record layout (the 0xF8-byte record
/// SLPSPostEventRecordTo takes, and the one inside a CGEvent) the helper
/// knows. On any other major the record path stays off.
public let knownRecordLayoutMajors: Set<Int> = [14, 15, 26]

public func recordLayoutKnown(major: Int) -> Bool {
    knownRecordLayoutMajors.contains(major)
}

/// Nil when the input can go to the target alone; otherwise why it goes as
/// real input instead (the result then says `delivery: foreground`).
public func foregroundReason(_ input: BackgroundInput, support: BackgroundSupport, target: BackgroundTarget) -> String? {
    guard support.backgroundPointer else { return "this macOS lacks the calls background input needs" }
    guard target.windowOnScreen else { return "the window is not on screen on this Space (minimized, hidden or on another Space)" }
    switch input {
    case .click, .keys:
        // Focusing the target window would take key status from the window
        // the user is typing in, and the user's keys would go to the target.
        guard !target.frontmost || target.focusedWindow else {
            return "the app is in front with another of its windows focused, and the user's typing would move to this one"
        }
    case .scroll:
        break
    }
    switch input {
    case let .click(button, count):
        guard support.focusWithoutRaise else { return "this macOS lacks the call that focuses a window without raising it" }
        guard button == 0 else { return "only a left click goes in the background" }
        guard count <= 2 else { return "a triple click goes as real input" }
        guard !target.readsPointer else { return "the app places clicks where the real pointer is" }
    case .scroll:
        guard !target.electron else { return "Electron apps do not scroll from background events" }
        guard !target.readsPointer else { return "the app places the scroll where the real pointer is" }
    case let .keys(command):
        guard !target.secureEntry else { return "the app can turn on Secure Keyboard Entry, so its keys go where secure input is checked" }
        guard !(command && target.chromium) else { return "Chromium-based apps drop a posted Command shortcut" }
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

/// The target app is frontmost now and was not when the action started.
public func cameForward(_ pid: pid_t, start: pid_t?, now: pid_t?) -> Bool {
    start != pid && now == pid
}

/// The user's side of the screen at one moment.
public struct UserState: Equatable {
    public var front: pid_t?
    public var pointer: CGPoint
    public var space: UInt64?
    /// When it was read, in seconds on a monotonic clock.
    public var time: Double
    /// Seconds since the last HID input, when it was read. An event the
    /// helper posts can reset it too (`ownPosts`).
    public var idle: Double
    /// When the helper itself posted input, on the clock of `time`.
    public var ownPosts: OwnPosts

    public init(front: pid_t?, pointer: CGPoint, space: UInt64?, time: Double = 0, idle: Double = .infinity,
                ownPosts: OwnPosts = OwnPosts()) {
        self.front = front
        self.pointer = pointer
        self.space = space
        self.time = time
        self.idle = idle
        self.ownPosts = ownPosts
    }
}

/// How long after one of our posts the last HID input may still be ours. A
/// posted mouse event can reset the HID idle time, dated within the post
/// itself and read a few milliseconds later.
public let ownPostSettle: Double = 0.1

/// The times the helper posted input, as spans: a post within
/// `ownPostSettle` of the span before it extends that span. Only the last
/// few spans are kept, which is all one action looks back on.
public struct OwnPosts: Equatable {
    public private(set) var spans: [ClosedRange<Double>] = []

    public init() {}

    public mutating func note(_ time: Double) {
        if let last = spans.last, time >= last.lowerBound, time - last.upperBound <= ownPostSettle {
            spans[spans.count - 1] = last.lowerBound...max(last.upperBound, time)
            return
        }
        spans.append(time...time)
        if spans.count > 16 { spans.removeFirst(spans.count - 16) }
    }

    /// A HID event at `time` may be one of our posts: it falls in a span or
    /// up to `ownPostSettle` after one. A few milliseconds before a span
    /// count too, for the two clock readings behind `time`.
    public func explain(_ time: Double) -> Bool {
        spans.contains { time >= $0.lowerBound - 0.005 && time <= $0.upperBound + ownPostSettle }
    }
}

/// The user gave real input between `start` and `now`: the last HID input is
/// more recent than the start, and no post of ours explains it.
public func userActed(start: UserState, now: UserState) -> Bool {
    let last = now.time - now.idle
    return last > start.time && !now.ownPosts.explain(last)
}

/// A change to the user's state that background input itself made.
public enum SideEffect: Equatable {
    /// The real pointer is at the point the input went to, and was not before.
    case pointerAtTarget
    /// The target app is frontmost, and was not before.
    case targetCameForward
    /// The active Space changed to one the target window is on.
    case spaceSwitchedToTarget
}

/// How near the targeted point the real pointer must be to count as moved there.
public let pointerNearTarget: CGFloat = 8

/// What background input did to the user's state between `start` and `now`,
/// or nil. Only its own side effects count: the user moving the pointer
/// elsewhere, or switching to another app or Space, is none, and once the
/// user gave real input since `start` no change is taken for ours. `point`
/// is where the pointer input went (nil for keys), and `targetOnScreen`
/// whether the target window is on the active Space now.
public func sideEffect(start: UserState, now: UserState, pid: pid_t, point: CGPoint?, targetOnScreen: Bool) -> SideEffect? {
    guard !userActed(start: start, now: now) else { return nil }
    func near(_ a: CGPoint, _ b: CGPoint) -> Bool { hypot(a.x - b.x, a.y - b.y) <= pointerNearTarget }
    if let point, near(now.pointer, point), !near(start.pointer, point) { return .pointerAtTarget }
    if cameForward(pid, start: start.front, now: now.front) { return .targetCameForward }
    if now.space != start.space, targetOnScreen { return .spaceSwitchedToTarget }
    return nil
}

/// What a background action does once one of its checks fails.
public enum BackgroundStop: Equatable {
    /// Nothing was posted yet: the action goes on as real input.
    case realInput
    /// Something was posted and may have landed: the action ends there, since
    /// real input could do it twice.
    case end
}

/// The app to bring back to the front after background input: the one the
/// user had in front at `start`, when the target came forward and the user
/// gave no input since (so the switch was ours). Nil leaves the front alone.
public func frontToRestore(start: UserState, now: UserState, pid: pid_t) -> pid_t? {
    guard cameForward(pid, start: start.front, now: now.front), !userActed(start: start, now: now) else { return nil }
    return start.front
}

public func afterStop(posted: Bool) -> BackgroundStop {
    posted ? .end : .realInput
}

/// Where a background click gives an element focus: the centre of the part
/// of its frame inside the window, or nil when none of it is inside.
public func backgroundFocusPoint(frame: CGRect, window: CGRect) -> CGPoint? {
    let visible = frame.intersection(window)
    guard !visible.isNull, !visible.isEmpty else { return nil }
    return CGPoint(x: visible.midX, y: visible.midY)
}
