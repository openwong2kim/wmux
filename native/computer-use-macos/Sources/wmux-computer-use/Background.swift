// Background input: events posted to the target process and routed to its
// window, so the user's pointer, frontmost app and Space stay as they were
// (protocol ActionDelivery `background`). Actions.swift asks `reason` first
// and uses real input (Input.swift) when it names one.
//
// Adapted from Cua Driver (MIT) libs/cua-driver/rust/crates/platform-macos/src/input/mouse.rs@a9902d27
// and keyboard.rs@a9902d27.

import AppKit
import ComputerUseCore

enum Background {
    static var support: BackgroundSupport {
        BackgroundSupport(
            backgroundPointer: SkyLight.backgroundPointer,
            focusWithoutRaise: SkyLight.focusWithoutRaise,
            keyAuth: SkyLight.keyAuth
        )
    }

    /// Why `input` to `target` goes as real input, or nil when it can go in the background.
    static func reason(_ input: BackgroundInput, _ target: ControlTarget) -> String? {
        guard let windowID = CGWindowID(target.windowID) else { return "the window id is not a window number" }
        let app = NSRunningApplication(processIdentifier: target.pid)
        let bundle = app?.bundleURL
        let electron = bundle.map(isElectron) ?? false
        let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid
        return foregroundReason(input, support: support, target: BackgroundTarget(
            windowOnScreen: onScreen(target.pid, windowID),
            chromium: electron || (bundle.map(isChromium) ?? false),
            electron: electron,
            readsPointer: readsPointer(app),
            frontmost: frontmost,
            focusedWindow: !frontmost || AX.element(AX.app(target.pid), kAXFocusedWindowAttribute).flatMap(AX.windowID) == windowID,
            secureEntry: secureKeyboardEntryApp(bundleID: app?.bundleIdentifier)
        ))
    }

    /// In the on-screen window list: on this Space, not minimized or hidden.
    static func onScreen(_ pid: pid_t, _ windowID: CGWindowID) -> Bool {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return false }
        return list.contains {
            ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID
                && ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid
        }
    }

    private static func isElectron(_ bundle: URL) -> Bool {
        FileManager.default.fileExists(atPath: bundle.appendingPathComponent("Contents/Frameworks/Electron Framework.framework").path)
    }

    /// A Chromium browser keeps its helper apps inside its framework
    /// (`Google Chrome Framework.framework/Helpers`); a CEF app ships
    /// `Chromium Embedded Framework.framework`.
    private static func isChromium(_ bundle: URL) -> Bool {
        let frameworks = bundle.appendingPathComponent("Contents/Frameworks")
        let names = (try? FileManager.default.contentsOfDirectory(atPath: frameworks.path)) ?? []
        return names.contains {
            $0 == "Chromium Embedded Framework.framework"
                || ($0.hasSuffix(" Framework.framework")
                    && FileManager.default.fileExists(atPath: frameworks.appendingPathComponent($0).appendingPathComponent("Helpers").path))
        }
    }

    /// Tk and LibreOffice place a click where the real pointer is, so a
    /// posted click would land under the user's pointer. Read from the
    /// bundle and the executable name, which errs toward real input.
    private static func readsPointer(_ app: NSRunningApplication?) -> Bool {
        if let bundle = app?.bundleURL {
            let frameworks = bundle.appendingPathComponent("Contents/Frameworks")
            for name in ["Tk.framework", "libvclplug_osxlo.dylib"]
            where FileManager.default.fileExists(atPath: frameworks.appendingPathComponent(name).path) {
                return true
            }
        }
        let executable = app?.executableURL?.lastPathComponent.lowercased() ?? ""
        return executable.hasPrefix("python") || executable.hasPrefix("wish")
    }

    // MARK: What the user sees

    /// kCGAnyInputEventType. Should it not convert, no user input is ever
    /// seen and every change counts as ours, as before input was read.
    private static let anyInput = CGEventType(rawValue: ~0)

    static func userState() -> UserState {
        UserState(
            front: NSWorkspace.shared.frontmostApplication?.processIdentifier,
            pointer: CGEvent(source: nil)?.location ?? .zero,
            space: SkyLight.activeSpace(),
            time: ProcessInfo.processInfo.systemUptime,
            idle: anyInput.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) } ?? .infinity,
            ownPosts: Input.shared.ownPosts
        )
    }

    /// A check that failed during background input. Actions goes on as real
    /// input when nothing was posted yet, and ends the call when something
    /// was (ComputerUseCore afterStop).
    struct Stop: Error {
        let reason: String
    }

    /// Stops on a side effect of our own input (ComputerUseCore sideEffect),
    /// or, with `requireOnScreen`, once the target window left the screen.
    /// `point`: where the pointer input goes, if any. The user moving the
    /// pointer elsewhere or switching apps does not stop it.
    static func check(_ target: ControlTarget, _ windowID: CGWindowID, since start: UserState, point: CGPoint?,
                      requireOnScreen: Bool = true) throws {
        let visible = onScreen(target.pid, windowID)
        switch sideEffect(start: start, now: userState(), pid: target.pid, point: point, targetOnScreen: visible) {
        case .pointerAtTarget: throw Stop(reason: "the real pointer moved to the target point")
        case .targetCameForward: throw Stop(reason: "the target app came to the front")
        case .spaceSwitchedToTarget: throw Stop(reason: "the Space switched to the target window's")
        case nil: break
        }
        if requireOnScreen, !visible { throw Stop(reason: "the target window left the screen") }
    }

    /// After the input: an app that brought itself to the front (a click on
    /// a link does, shortly after) is put back behind the one the user had,
    /// the way Focus.bringForward activates an app. An app the user brought
    /// forward (real input since `start`) stays (ComputerUseCore
    /// frontToRestore). Returns the note for the result when the app came
    /// forward, saying whether the user's app is back, or when the real
    /// pointer ended at `point`.
    static func settle(after start: UserState, pid: pid_t, point: CGPoint? = nil) async -> String? {
        let pointer = sideEffect(start: start, now: userState(), pid: pid, point: point, targetOnScreen: false) == .pointerAtTarget
            ? "the real pointer moved to the target point, so the input may have gone as real input"
            : nil
        var back: pid_t?
        for n in 0..<4 {
            if n > 0 { try? await Task.sleep(nanoseconds: 40_000_000) }
            let now = userState()
            if cameForward(pid, start: start.front, now: now.front) {
                back = frontToRestore(start: start, now: now, pid: pid)
                break
            }
        }
        guard let front = back else { return pointer }
        NSRunningApplication(processIdentifier: front)?.activate()
        AXUIElementSetAttributeValue(AX.app(front), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        var note = "the app came to the front on its own, and the app that was in front could not be brought back"
        for _ in 0..<6 {
            try? await Task.sleep(nanoseconds: 50_000_000)
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == front {
                note = "the app came to the front on its own; the app that was in front was brought back"
                break
            }
        }
        return [pointer, note].compactMap { $0 }.joined(separator: "; ")
    }

    // MARK: Keyboard focus

    /// The app's focused window is the target window, made so in the app
    /// alone when it was not: the key-window records (twice at most, since
    /// they are handled asynchronously), then AXFocusedWindow. Keys posted to
    /// a process go to its focused window, so text for this window would
    /// otherwise land in another one of the same app.
    ///
    /// Adapted from Cua Driver (MIT) libs/cua-driver/rust/crates/platform-macos/src/input/skylight.rs@a9902d27
    /// `previous` is the window that had key status before, for restoreKey.
    static func focusWindow(_ target: ControlTarget, _ windowID: CGWindowID) async -> (ok: Bool, previous: CGWindowID?) {
        let appEl = AX.app(target.pid)
        func current() -> CGWindowID? { AX.element(appEl, kAXFocusedWindowAttribute).flatMap(AX.windowID) }
        func settled() async -> Bool {
            for _ in 0..<6 {
                if current() == windowID { return true }
                try? await Task.sleep(nanoseconds: 40_000_000)
            }
            return current() == windowID
        }
        let previous = current()
        if previous == windowID { return (true, nil) }
        for _ in 0..<2 where SkyLight.moveWindowKey(from: current(), to: windowID, pid: target.pid) {
            if await settled() { return (true, previous) }
        }
        let window = AX.elements(appEl, kAXWindowsAttribute).first { AX.windowID($0) == windowID }
        if let window, AXUIElementSetAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, window) == .success {
            return (await settled(), previous)
        }
        return (false, previous)
    }

    /// Gives key status back to the window that had it in the app before
    /// focusWindow, once the input is done: the same records, the other way,
    /// or AXFocusedWindow when the records cannot be sent (focusWindow then
    /// made the window key that way).
    static func restoreKey(_ windowID: CGWindowID, to previous: CGWindowID?, pid: pid_t) {
        guard let previous, previous != windowID else { return }
        if SkyLight.moveWindowKey(from: windowID, to: previous, pid: pid) { return }
        let appEl = AX.app(pid)
        if let window = AX.elements(appEl, kAXWindowsAttribute).first(where: { AX.windowID($0) == previous }) {
            AXUIElementSetAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, window)
        }
    }

    /// Gives `el` keyboard focus without bringing its app forward: AX first,
    /// then a background click at `point` (a web page in a window that was
    /// never active takes focus only that way). `focused` once the app
    /// reports it focused; `clicked` when the click was sent (an app that
    /// places clicks where the real pointer is gets none).
    static func focus(_ el: AXUIElement, _ target: ControlTarget, _ windowID: CGWindowID, clickAt point: CGPoint?) async -> (focused: Bool, clicked: Bool) {
        func focused() -> Bool { AX.element(AX.app(target.pid), kAXFocusedUIElementAttribute).map { CFEqual($0, el) } ?? false }
        if focused() { return (true, false) }
        AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        if focused() { return (true, false) }
        guard let point, !Session.isLocked, reason(.click(button: 0, count: 1), target) == nil else { return (false, false) }
        click(pid: target.pid, windowID: windowID, at: point, count: 1, flags: [])
        for _ in 0..<6 {
            try? await Task.sleep(nanoseconds: 50_000_000)
            if focused() { return (true, true) }
        }
        return (false, true)
    }

    /// The app's focused element takes text (its value is settable).
    static func focusedFieldTakesText(_ pid: pid_t) -> Bool {
        guard let el = AX.element(AX.app(pid), kAXFocusedUIElementAttribute) else { return false }
        return AX.isSettable(el, kAXValueAttribute)
    }

    /// The re-check before every typed chunk and key press: the screen is not
    /// locked, no side effect of ours (check, with the focus click's `point`),
    /// the window still focused in its app, and no password field has focus.
    /// The target app coming to the front stops it whoever caused it. The
    /// window must be on screen only before the first key
    /// (`beforeFirstKey`): keys posted to the app reach it anyway, and the
    /// user switching Spaces mid-type is no reason to stop. The system-wide
    /// secure-input flag counts only while the target is frontmost.
    static func requireStillSafe(_ target: ControlTarget, _ windowID: CGWindowID, since start: UserState, point: CGPoint? = nil,
                                 beforeFirstKey: Bool) throws {
        if Session.isLocked { throw HelperError("window_not_focused", "the screen locked; the rest was not sent") }
        // Whoever brought it forward, the user's own keys now go to the
        // window we made key, so ours would interleave with theirs.
        if cameForward(target.pid, start: start.front, now: NSWorkspace.shared.frontmostApplication?.processIdentifier) {
            throw Stop(reason: "the target app came to the front")
        }
        try check(target, windowID, since: start, point: point, requireOnScreen: beforeFirstKey)
        guard AX.element(AX.app(target.pid), kAXFocusedWindowAttribute).flatMap(AX.windowID) == windowID else {
            throw Stop(reason: "the target window is no longer the app's focused window")
        }
        try Focus.refuseSecureInput(target.pid, global: NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid)
    }

    // MARK: Posting

    private static let source = CGEventSource(stateID: .hidSystemState)

    private static func stamp(_ e: CGEvent, pid: pid_t, windowID: CGWindowID, at point: CGPoint, fields: [(UInt32, Int64)]) {
        SkyLight.setWindowLocation(e, point)
        for (field, value) in fields { SkyLight.setField(e, field, value) }
        SkyLight.setField(e, 51, Int64(windowID))
        SkyLight.setField(e, 91, Int64(windowID))
        SkyLight.setField(e, 92, Int64(windowID))
        SkyLight.setField(e, 40, Int64(pid))
    }

    /// A left click (one or two) posted to the window: the window is focused
    /// without raising it first, then the plan's events go in order.
    static func click(pid: pid_t, windowID: CGWindowID, at point: CGPoint, count: Int, flags: CGEventFlags) {
        if SkyLight.focusWithoutRaise(windowID, pid: pid) { usleep(50_000) }
        let group = Int64(Date().timeIntervalSince1970.truncatingRemainder(dividingBy: 1) * 1e9)
        for step in backgroundClickPlan(at: point, count: count) {
            let type: CGEventType = step.kind == .move ? .mouseMoved : step.kind == .down ? .leftMouseDown : .leftMouseUp
            guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: step.point, mouseButton: .left) else { continue }
            stamp(e, pid: pid, windowID: windowID, at: step.point,
                  fields: [(0, step.phase), (1, step.clickState), (3, 0), (7, 3), (58, group)])
            e.flags = flags
            Input.shared.postToProcess(e, pid: pid, auth: false)
            if step.delayAfterMs > 0 { usleep(step.delayAfterMs * 1000) }
        }
    }

    /// Scrolls one notch at a time; `shouldContinue` runs before every notch.
    /// Returns the notches sent.
    static func scroll(pid: pid_t, windowID: CGWindowID, at point: CGPoint, dx: Int32, dy: Int32, notches: Int,
                       shouldContinue: () -> Bool) -> Int {
        // A window that never saw a move keeps a stale hit-test point.
        if let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
            stamp(move, pid: pid, windowID: windowID, at: point, fields: [(3, 0), (7, 3)])
            move.flags = []
            Input.shared.postToProcess(move, pid: pid, auth: false)
            usleep(12_000)
        }
        var sent = 0
        for _ in 0..<max(1, notches) {
            guard shouldContinue() else { return sent }
            guard let e = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { break }
            e.location = point
            stamp(e, pid: pid, windowID: windowID, at: point, fields: [])
            e.flags = []
            Input.shared.postToProcess(e, pid: pid, auth: false)
            sent += 1
            usleep(30_000)
        }
        return sent
    }

    /// Types `text` as Unicode key events (named keys for Enter and Tab),
    /// posted to the process. `shouldContinue` runs before every chunk.
    /// Returns how many characters were posted; it stops at the first chunk
    /// that could not be.
    static func type(pid: pid_t, _ text: String, shouldContinue: () -> Bool) -> Int {
        var typed = 0
        for chunk in unicodeChunks(text) {
            guard shouldContinue() else { return typed }
            let posted: Bool
            switch chunk {
            case .key(let name):
                posted = KeyCodes.named[name].map { tap(pid: pid, key: $0, flags: []) } ?? false
            case .text(let s):
                let units = Array(s.utf16)
                guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                      let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { return typed }
                for e in [down, up] {
                    e.flags = []
                    e.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                }
                posted = postKey(down: down, up: up, pid: pid, auth: SkyLight.keyAuth)
            }
            guard posted else { return typed }
            typed += chunk.characterCount
        }
        return typed
    }

    /// One key down and up, the modifiers as flags only. A shortcut with
    /// Command goes without the authentication message: with it the event
    /// takes a route that never reaches the app's menus. False, with nothing
    /// posted, when the press could not be sent.
    @discardableResult
    static func tap(pid: pid_t, key code: CGKeyCode, flags: CGEventFlags) -> Bool {
        let auth = SkyLight.keyAuth && !flags.contains(.maskCommand)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { return false }
        down.flags = flags
        up.flags = flags
        return postKey(down: down, up: up, pid: pid, auth: auth)
    }

    /// A key down and its up, posted to the process. A down that went out
    /// always gets its up: when the up's authentication message cannot be
    /// built it goes without one, so the app is not left with the key down.
    /// False, with nothing posted, when the down did not go.
    private static func postKey(down: CGEvent, up: CGEvent, pid: pid_t, auth: Bool) -> Bool {
        guard Input.shared.postToProcess(down, pid: pid, auth: auth) else { return false }
        usleep(4_000)
        if !Input.shared.postToProcess(up, pid: pid, auth: auth) {
            Input.shared.postToProcess(up, pid: pid, auth: false)
        }
        usleep(4_000)
        return true
    }
}
