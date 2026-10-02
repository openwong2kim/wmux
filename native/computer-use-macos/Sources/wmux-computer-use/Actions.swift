// Control actions. Each one re-checks its target right before sending input
// (protocol ControlTarget): keyboard batches need the target window in the
// foreground, pointer batches need the target's window under the point.
// Otherwise nothing is sent and the answer is `window_not_focused`.

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import ComputerUseCore

struct ControlTarget {
    let pid: pid_t
    let windowID: String

    init(_ params: JSON) throws {
        guard let t = params.object("target"), let pid = t.int("pid"), let window = t.string("windowId") else {
            throw HelperError("invalid_argument", "target {pid, windowId} is required")
        }
        self.pid = pid_t(pid)
        self.windowID = window
    }
}

enum Focus {
    struct Hit {
        let pid: pid_t
        let windowID: CGWindowID
        let layer: Int
    }

    /// The window under a screen point, front to back, skipping fully
    /// transparent windows and wmux's own click-through, content-protected
    /// overlay (it belongs to our parent process).
    static func hit(at point: CGPoint) -> Hit? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        let parent = getppid()
        for info in list {
            guard let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict),
                  bounds.contains(point) else { continue }
            if let alpha = info[kCGWindowAlpha as String] as? Double, alpha <= 0 { continue }
            let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1
            let sharing = (info[kCGWindowSharingState as String] as? NSNumber)?.intValue ?? 1
            if pid == parent && sharing == 0 { continue }
            return Hit(
                pid: pid,
                windowID: (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value ?? 0,
                layer: (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
            )
        }
        return nil
    }

    /// The point lands on the target window, or on a menu, popover or other
    /// above-normal window of the same app (a menu the previous click opened).
    /// Another normal window of the same app does not count.
    static func pointerHitsTarget(_ target: ControlTarget, at point: CGPoint) -> Bool {
        guard let hit = hit(at: point), hit.pid == target.pid else { return false }
        return String(hit.windowID) == target.windowID || hit.layer != 0
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

    /// Cheap per-keystroke re-check inside a batch: the person may switch
    /// apps or focus a password field while a long string is being typed.
    static func stillSafeToType(_ target: ControlTarget) -> Bool {
        NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid && !IsSecureEventInputEnabled()
            && !Session.isLocked
    }

    /// Brings the target window forward (AX, not input) if another window
    /// covers the point, then requires the point to land on the target.
    static func requirePointer(_ target: ControlTarget, window: AXUIElement, at point: CGPoint) async throws {
        if pointerHitsTarget(target, at: point) { return }
        AXUIElementSetAttributeValue(AX.app(target.pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        for _ in 0..<10 {
            try await Task.sleep(nanoseconds: 50_000_000)
            if pointerHitsTarget(target, at: point) { return }
        }
        throw HelperError("window_not_focused", "another window covers that point; nothing was clicked")
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
                return result("accessibility", verified: false, note: "pressed through accessibility (AXPress)")
            }
        }
        try await Focus.requirePointer(target, window: snap.window, at: point)
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
            AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            // Typing into whatever else has focus would put the text in the wrong field.
            let focused = AX.element(AX.app(target.pid), kAXFocusedUIElementAttribute)
            guard let focused, CFEqual(focused, el) else {
                throw HelperError("action_not_supported", "element \(index) did not take keyboard focus; nothing was typed. Click it first")
            }
        }
        try Focus.requireKeyboard(target)
        try Focus.refuseSecureInput(target.pid)

        let before = focusedValue(target.pid)
        if text.count < 64 {
            try typeChecked(text, target: target)
            let verified = await waitForEffect(of: text, before: before, pid: target.pid, timeout: 0.3)
            return result("synthetic", verified: verified)
        }
        return try await paste(text, target: target, before: before)
    }

    /// Types `text`, re-checking before every character that the target is
    /// still in front and no password field took focus.
    private static func typeChecked(_ text: String, target: ControlTarget) throws {
        let typed = Input.shared.typeUnicode(text) { Focus.stillSafeToType(target) }
        if typed < text.count {
            throw HelperError(
                "window_not_focused",
                "focus left the target (or a password field took it) after \(typed) of \(text.count) characters; the rest was not typed"
            )
        }
    }

    /// Long text goes through the pasteboard, marked concealed + transient so
    /// clipboard managers skip it. The previous contents come back afterwards,
    /// unless something else wrote the pasteboard in the meantime. If the
    /// current contents cannot be saved completely (a promised or unreadable
    /// type), the text is typed instead: the clipboard is not ours to lose.
    private static func paste(_ text: String, target: ControlTarget, before: String?) async throws -> JSON {
        guard let saved = Clipboard.snapshot() else {
            try typeChecked(text, target: target)
            let verified = await waitForEffect(of: text, before: before, pid: target.pid, timeout: 0.5)
            return result("synthetic", verified: verified, note: "typed, because the clipboard could not be saved")
        }
        guard Clipboard.write(text, saved: saved) else {
            Clipboard.restoreIfUnchanged()
            throw HelperError("internal", "could not write the pasteboard")
        }
        let vKey = KeyCodes.keyCode(for: "v", layout: Input.shared.layoutKeyCode) ?? CGKeyCode(kVK_ANSI_V)
        guard Focus.stillSafeToType(target) else {
            Clipboard.restoreIfUnchanged()
            throw HelperError("window_not_focused", "focus left the target before the paste; nothing was pasted")
        }
        Input.shared.withModifiers([KeyCodes.modifier(named: "meta")!]) { flags in
            Input.shared.tap(key: vKey, flags: flags)
        }
        // The app reads the pasteboard asynchronously. Restore only once the
        // field visibly changed to hold the text, or after a grace period.
        let verified = await waitForEffect(of: text, before: before, pid: target.pid, timeout: 1.0)
        if !verified { try? await Task.sleep(nanoseconds: 500_000_000) }
        let restored = Clipboard.restoreIfUnchanged()
        return result(
            "clipboard", verified: verified,
            note: restored ? "pasted; the previous clipboard was restored" : "pasted; the clipboard changed meanwhile, so it was not restored"
        )
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

    static func pressKey(_ p: JSON, _ snaps: SnapshotStore) throws -> JSON {
        let snap = try snaps.get(try p.requireString("snapshotId"))
        let target = try ControlTarget(p)
        try checkTarget(snap, target)
        let key = try p.requireString("key")
        guard let code = KeyCodes.keyCode(for: key, layout: Input.shared.layoutKeyCode) else {
            throw HelperError("invalid_argument", "\"\(key.prefix(20))\" is not a canonical key name")
        }
        let repeatCount = min(50, max(1, p.int("repeat") ?? 1))
        try Focus.requireKeyboard(target)
        try Focus.refuseSecureInput(target.pid)
        let flags = KeyCodes.intrinsicFlags(for: key)
        for n in 0..<repeatCount {
            if n > 0 && !Focus.stillSafeToType(target) {
                throw HelperError("window_not_focused", "focus left the target after \(n) of \(repeatCount) presses; the rest were not sent")
            }
            Input.shared.tap(key: code, flags: flags)
            usleep(4_000)
        }
        return result("synthetic", verified: false)
    }

    static func hotkey(_ p: JSON, _ snaps: SnapshotStore) throws -> JSON {
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
        try Focus.requireKeyboard(target)
        try Focus.refuseSecureInput(target.pid)
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
        Input.shared.scroll(at: point, dx: dx, dy: dy, notches: amount)
        return result("synthetic", verified: false)
    }
}
