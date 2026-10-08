// Control actions. Each one first brings its target forward (activates the
// app, raises the window), then re-checks the target right before sending
// input (protocol ControlTarget): keyboard batches need the target window in
// the foreground, pointer batches need the target's window under the point.
// Otherwise nothing is sent and the answer is `window_not_focused`.

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import ComputerUseCore

struct ControlTarget {
    let pid: pid_t
    let windowID: String

    init(pid: pid_t, windowID: String) {
        self.pid = pid
        self.windowID = windowID
    }

    init(_ params: JSON) throws {
        guard let t = params.object("target"), let pid = t.int("pid"), let window = t.string("windowId") else {
            throw HelperError("invalid_argument", "target {pid, windowId} is required")
        }
        self.pid = pid_t(pid)
        self.windowID = window
    }
}

enum Focus {
    /// The on-screen windows, front to back, as the hit test reads them.
    /// Needs no Screen Recording grant (only window titles are withheld).
    static func windowList() -> [HitWindow] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        return list.compactMap { info in
            guard let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict) else { return nil }
            return HitWindow(
                pid: (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1,
                windowID: (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value ?? 0,
                layer: (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
                bounds: bounds,
                alpha: (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
            )
        }
    }

    /// Roles that make an element part of a transient surface of its app.
    private static let transientRoles: Set<String> = ["AXMenu", "AXMenuItem", "AXMenuBar", "AXPopover", "AXSheet"]

    /// What AX finds at a screen point: the element's pid, its window and
    /// whether it sits in a menu, popover or sheet. Nil when AX cannot answer.
    /// Called off the main thread (actions run on the concurrent executor),
    /// so an answer routed to the helper's own overlay cannot deadlock.
    static func axHit(at point: CGPoint) -> AXHit? {
        var element: AXUIElement?
        let rc = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element)
        guard rc == .success, let element else { return nil }
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success, pid > 0 else { return nil }
        var windowID = AX.element(element, kAXWindowAttribute).flatMap(AX.windowID)
        var transient = false
        var node: AXUIElement? = element
        for _ in 0..<12 {
            guard let current = node else { break }
            let role = AX.string(current, kAXRoleAttribute) ?? ""
            if transientRoles.contains(role) { transient = true }
            if role == "AXWindow" || role == "AXSheet" {
                if windowID == nil { windowID = AX.windowID(current) }
                break
            }
            node = AX.element(current, kAXParentAttribute)
        }
        return AXHit(pid: pid, windowID: windowID, inTransient: transient)
    }

    /// The hit-test verdict at a point. `useAX: false` (the per-notch scroll
    /// re-check) reads the window list only, which is cheap and needs no IPC.
    static func verdict(_ target: ControlTarget, at point: CGPoint, useAX: Bool = true) -> PointerVerdict {
        guard let windowID = UInt32(target.windowID) else { return .covered(by: nil) }
        return pointerVerdict(
            targetPid: target.pid, targetWindowID: windowID, ownPid: getpid(),
            ax: useAX ? axHit(at: point) : nil, windows: windowList(), point: point
        )
    }

    /// The target app is frontmost and its focused window is the target window.
    static func isForward(_ target: ControlTarget) -> Bool {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid else { return false }
        let focused = AX.element(AX.app(target.pid), kAXFocusedWindowAttribute).flatMap(AX.windowID)
        return focused.map { String($0) == target.windowID } ?? false
    }

    /// Brings the target forward when it is not: un-minimizes the window,
    /// activates the app (NSRunningApplication, then kAXFrontmost, which is
    /// what works for a process that is never active itself), makes the
    /// window main and raises it, then waits up to 500 ms for the app to be
    /// frontmost with that window focused. Never activates the helper.
    @discardableResult
    static func bringForward(_ target: ControlTarget, window: AXUIElement) async -> Bool {
        if isForward(target) { return true }
        guard target.pid != getpid() else { return false }
        let appEl = AX.app(target.pid)
        if AX.bool(window, kAXMinimizedAttribute) == true {
            AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        }
        NSRunningApplication(processIdentifier: target.pid)?.activate()
        AXUIElementSetAttributeValue(appEl, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        for _ in 0..<10 {
            try? await Task.sleep(nanoseconds: 50_000_000)
            if isForward(target) { return true }
        }
        return false
    }

    static func requireKeyboard(_ target: ControlTarget) throws {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid else {
            throw HelperError("window_not_focused", "the target app is not in the foreground; nothing was typed")
        }
        let focused = AX.element(AX.app(target.pid), kAXFocusedWindowAttribute).flatMap(AX.windowID)
        guard let focused, String(focused) == target.windowID else {
            throw HelperError("window_not_focused", "the target window is not the app's focused window; nothing was typed")
        }
    }

    /// The re-check before every typed chunk and every key press: the target
    /// app is in front, its focused window is the target window, the screen is
    /// not locked, and no password field has focus (secure input or a secure
    /// focused element). Throws the error that stops the batch.
    static func requireStillSafe(_ target: ControlTarget) throws {
        if Session.isLocked { throw HelperError("window_not_focused", "the screen locked; the rest was not sent") }
        try requireKeyboard(target)
        try refuseSecureInput(target.pid)
    }

    /// Brings the target forward, then requires the point to land on the
    /// target window. A refused point gets one more raise and 500 ms to clear.
    static func requirePointer(_ target: ControlTarget, window: AXUIElement, at point: CGPoint) async throws {
        await bringForward(target, window: window)
        var last = verdict(target, at: point)
        if last == .target { return }
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        for _ in 0..<10 {
            try await Task.sleep(nanoseconds: 50_000_000)
            last = verdict(target, at: point)
            if last == .target { return }
        }
        throw HelperError("window_not_focused", "\(coverName(last)) covers that point; nothing was sent")
    }

    private static func coverName(_ verdict: PointerVerdict) -> String {
        guard case .covered(let pid?) = verdict else { return "no window of the target" }
        let name = NSRunningApplication(processIdentifier: pid)?.localizedName
        return name.map { "a window of \($0)" } ?? "another window"
    }

    /// Secure input (a password field anywhere has focus, or the focused
    /// element of the target is a password field): keystrokes are refused.
    static func refuseSecureInput(_ pid: pid_t) throws {
        if IsSecureEventInputEnabled() {
            throw HelperError("app_blocked", "secure keyboard entry is on (a password field has focus); wmux does not type into it")
        }
        if let el = AX.element(AX.app(pid), kAXFocusedUIElementAttribute), isSecure(el) {
            throw HelperError("app_blocked", "the focused field is a password field; wmux does not type into it")
        }
    }

    /// AXSecureTextField, or a field whose label says it holds a secret — the
    /// same rule that redacts its value in the tree.
    static func isSecure(_ el: AXUIElement) -> Bool {
        let subrole = AX.string(el, kAXSubroleAttribute)
        let label = [kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute]
            .compactMap { AX.string(el, $0) }
            .joined(separator: " ")
        return isSensitive(subrole: subrole, name: label)
    }
}

private func result(_ method: String, verified: Bool, note: String? = nil) -> JSON {
    var out: JSON = ["method": method, "verification": verified ? "verified" : "unverified"]
    if let note { out["note"] = note }
    return out
}

private func screenPoint(_ snap: Snapshot, index: Int?, point: CGPoint?) throws -> (CGPoint, AXUIElement?) {
    if let index {
        let el = try snap.element(at: index)
        guard let frame = AX.frame(el), frame.width > 0, frame.height > 0 else {
            throw HelperError("action_not_supported", "element \(index) has no on-screen frame; use coordinates from a screenshot")
        }
        // The fresh frame, clipped to the window, so a moved window is no misclick.
        let visible = (try? snap.windowFrame()).map { frame.intersection($0) } ?? frame
        let box = visible.isNull || visible.isEmpty ? frame : visible
        return (CGPoint(x: box.midX, y: box.midY), el)
    }
    guard let point else { throw HelperError("invalid_argument", "index or point is required") }
    let window = try snap.windowFrame()
    guard point.x >= 0, point.y >= 0, point.x < window.width, point.y < window.height else {
        throw HelperError("invalid_argument", "point is outside the window")
    }
    return (CGPoint(x: window.minX + point.x, y: window.minY + point.y), nil)
}

private func checkTarget(_ snap: Snapshot, _ target: ControlTarget) throws {
    guard snap.pid == target.pid, String(snap.windowID) == target.windowID else {
        throw HelperError("invalid_argument", "target does not match the snapshot's window")
    }
}

/// Keyboard actions: bring the target forward, show the halo, then require
/// it in front and no password field focused. Nothing is sent otherwise.
private func requireKeyboardForward(_ snap: Snapshot, _ target: ControlTarget) async throws {
    await Focus.bringForward(target, window: snap.window)
    try Focus.requireKeyboard(target)
    try Focus.refuseSecureInput(target.pid)
    await Overlay.shared.show(window: try? snap.windowFrame(), cursor: nil, wait: false)
}

private func focusedValue(_ pid: pid_t) -> String? {
    AX.element(AX.app(pid), kAXFocusedUIElementAttribute).flatMap { AX.string($0, kAXValueAttribute) }
}

enum Actions {
    static func click(_ p: JSON, _ snaps: SnapshotStore) async throws -> JSON {
        let snap = try snaps.get(try p.requireString("snapshotId"))
        let target = try ControlTarget(p)
        try checkTarget(snap, target)
        let button: CGMouseButton
        switch p.string("button") ?? "left" {
        case "left": button = .left
        case "right": button = .right
        case "middle": button = .center
        default: throw HelperError("invalid_argument", "button must be left, right or middle")
        }
        let count = min(3, max(1, p.int("clickCount") ?? 1))
        let modNames = (p["modifiers"] as? [String]) ?? []
        guard let mods = KeyCodes.orderedModifiers(modNames) else {
            throw HelperError("invalid_argument", "modifiers must be ctrl, alt, shift or meta")
        }
        let (point, element) = try screenPoint(snap, index: p.int("index"), point: try p.point("point"))

        // Action ladder: a plain left click on a pressable element is AXPress.
        if let element, button == .left, count == 1, mods.isEmpty, AX.actions(element).contains(kAXPressAction) {
            if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success {
                await Overlay.shared.show(window: try? snap.windowFrame(), cursor: point, wait: false)
                await Overlay.shared.press(at: point)
                return result("accessibility", verified: false, note: "pressed through accessibility (AXPress)")
            }
        }
        try await Focus.requirePointer(target, window: snap.window, at: point)
        await Overlay.shared.show(window: try? snap.windowFrame(), cursor: point, wait: true)
        await Overlay.shared.press(at: point)
        Input.shared.withModifiers(mods) { flags in
            Input.shared.click(at: point, button: button, count: count, flags: flags)
        }
        return result("synthetic", verified: false)
    }

    static func setValue(_ p: JSON, _ snaps: SnapshotStore) throws -> JSON {
        let snap = try snaps.get(try p.requireString("snapshotId"))
        let target = try ControlTarget(p)
        try checkTarget(snap, target)
        guard let index = p.int("index") else { throw HelperError("invalid_argument", "setValue needs an element index") }
        let value = try p.requireString("value")
        let el = try snap.element(at: index)
        if Focus.isSecure(el) || IsSecureEventInputEnabled() {
            throw HelperError("app_blocked", "that is a password field (or secure input is on); wmux does not fill it")
        }
        guard AX.isSettable(el, kAXValueAttribute) else {
            throw HelperError("value_not_settable", "element \(index) does not accept a value through accessibility")
        }
        let rc = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFString)
        guard rc == .success else {
            if isGone(rc) { throw HelperError("element_stale", "element \(index) went away") }
            throw HelperError("value_not_settable", "the app refused the value (AXError \(rc.rawValue))")
        }
        let readBack = AX.string(el, kAXValueAttribute)
        if readBack == value { return result("accessibility", verified: true) }
        return result("accessibility", verified: false, note: "the value read back differs from what was set")
    }

    static func type(_ p: JSON, _ snaps: SnapshotStore) async throws -> JSON {
        let snap = try snaps.get(try p.requireString("snapshotId"))
        let target = try ControlTarget(p)
        try checkTarget(snap, target)
        let text = try p.requireString("text")
        guard !text.isEmpty else { throw HelperError("invalid_argument", "type needs text") }
        if let index = p.int("index") {
            let el = try snap.element(at: index)
            if Focus.isSecure(el) { throw HelperError("app_blocked", "that is a password field; wmux does not type into it") }
            // Forward first: focusing an element of a background app often does not take.
            await Focus.bringForward(target, window: snap.window)
            AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            // Typing into whatever else has focus would put the text in the wrong field.
            let focused = AX.element(AX.app(target.pid), kAXFocusedUIElementAttribute)
            guard let focused, CFEqual(focused, el) else {
                throw HelperError("action_not_supported", "element \(index) did not take keyboard focus; nothing was typed. Click it first")
            }
        }
        try await requireKeyboardForward(snap, target)

        let before = focusedValue(target.pid)
        try typeChecked(text, target: target)
        let verified = await waitForEffect(of: text, before: before, pid: target.pid, timeout: text.count < 64 ? 0.3 : 1.0)
        return result("synthetic", verified: verified)
    }

    /// Types `text` in short Unicode chunks (no clipboard), re-checking the
    /// target and password-field focus before every chunk.
    private static func typeChecked(_ text: String, target: ControlTarget) throws {
        var stop: HelperError?
        let typed = Input.shared.typeUnicode(text) {
            do {
                try Focus.requireStillSafe(target)
                return true
            } catch let e as HelperError {
                stop = e
                return false
            } catch {
                return false
            }
        }
        if typed < text.count {
            let why = stop ?? HelperError("window_not_focused", "focus left the target")
            throw HelperError(why.code, "\(why.message) (after \(typed) of \(text.count) characters; the rest was not typed)")
        }
    }

    /// Verified only when the focused element's value changed and now holds
    /// the end of the text (untrimmed, so whitespace-only text counts too).
    private static func waitForEffect(of text: String, before: String?, pid: pid_t, timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        let needle = String(text.suffix(32))
        repeat {
            if let v = focusedValue(pid), v != before, v.contains(needle) { return true }
            try? await Task.sleep(nanoseconds: 50_000_000)
        } while Date() < deadline
        return false
    }

    static func pressKey(_ p: JSON, _ snaps: SnapshotStore) async throws -> JSON {
        let snap = try snaps.get(try p.requireString("snapshotId"))
        let target = try ControlTarget(p)
        try checkTarget(snap, target)
        let key = try p.requireString("key")
        guard let code = KeyCodes.keyCode(for: key, layout: Input.shared.layoutKeyCode) else {
            throw HelperError("invalid_argument", "\"\(key.prefix(20))\" is not a canonical key name")
        }
        let repeatCount = min(50, max(1, p.int("repeat") ?? 1))
        try await requireKeyboardForward(snap, target)
        let flags = KeyCodes.intrinsicFlags(for: key)
        for n in 0..<repeatCount {
            if n > 0 {
                do {
                    try Focus.requireStillSafe(target)
                } catch let e as HelperError {
                    throw HelperError(e.code, "\(e.message) (after \(n) of \(repeatCount) presses; the rest were not sent)")
                }
            }
            Input.shared.tap(key: code, flags: flags)
            usleep(4_000)
        }
        return result("synthetic", verified: false)
    }

    static func hotkey(_ p: JSON, _ snaps: SnapshotStore) async throws -> JSON {
        let snap = try snaps.get(try p.requireString("snapshotId"))
        let target = try ControlTarget(p)
        try checkTarget(snap, target)
        let key = try p.requireString("key")
        guard let code = KeyCodes.keyCode(for: key, layout: Input.shared.layoutKeyCode) else {
            throw HelperError("invalid_argument", "\"\(key.prefix(20))\" is not a canonical key name")
        }
        guard let mods = KeyCodes.orderedModifiers((p["modifiers"] as? [String]) ?? []) else {
            throw HelperError("invalid_argument", "modifiers must be ctrl, alt, shift or meta")
        }
        try await requireKeyboardForward(snap, target)
        Input.shared.withModifiers(mods) { flags in
            Input.shared.tap(key: code, flags: flags.union(KeyCodes.intrinsicFlags(for: key)))
        }
        return result("synthetic", verified: false)
    }

    static func scroll(_ p: JSON, _ snaps: SnapshotStore) async throws -> JSON {
        let snap = try snaps.get(try p.requireString("snapshotId"))
        let target = try ControlTarget(p)
        try checkTarget(snap, target)
        let amount = min(50, max(1, p.int("amount") ?? 3))
        let (dx, dy): (Int32, Int32)
        switch p.string("direction") ?? "down" {
        case "up": (dx, dy) = (0, 3)
        case "down": (dx, dy) = (0, -3)
        case "left": (dx, dy) = (3, 0)
        case "right": (dx, dy) = (-3, 0)
        default: throw HelperError("invalid_argument", "direction must be up, down, left or right")
        }
        let (point, _) = try screenPoint(snap, index: p.int("index"), point: try p.point("point"))
        try await Focus.requirePointer(target, window: snap.window, at: point)
        await Overlay.shared.show(window: try? snap.windowFrame(), cursor: point, wait: true)
        // Re-run the hit-test before every notch: a window that moves over
        // the point mid-scroll must not receive the rest. The window list
        // alone (no AX round trip per notch), compared with what it said once
        // AX had accepted the point.
        let baseline = Focus.verdict(target, at: point, useAX: false)
        let sent = Input.shared.scroll(at: point, dx: dx, dy: dy, notches: amount) {
            guard !Session.isLocked else { return false }
            let now = Focus.verdict(target, at: point, useAX: false)
            return now == .target || now == baseline
        }
        if sent < amount {
            throw HelperError("window_not_focused", "another window covered the point after \(sent) of \(amount) notches; the rest was not sent")
        }
        return result("synthetic", verified: false)
    }
}
