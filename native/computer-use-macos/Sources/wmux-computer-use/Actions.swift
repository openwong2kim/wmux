// Control actions. Each one sends its input in the background when it can
// (Background.swift: posted to the target window alone, the user's pointer,
// frontmost app and Space left as they were). Otherwise it brings its target
// forward (activates the app, raises the window) and sends real input, after
// re-checking the target right before it (protocol ControlTarget): keyboard
// batches need the target window in the foreground, pointer batches need the
// target's window under the point. Otherwise nothing is sent and the answer
// is `window_not_focused`. The result's `delivery` says which way it went.

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
    /// The on-screen windows, front to back, as the hit test reads them, and
    /// the pids of the WindowServer process among their owners. Needs no
    /// Screen Recording grant (only window titles are withheld).
    static func windowList() -> (windows: [HitWindow], windowServer: Set<Int32>) {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return ([], [])
        }
        var windowServer = Set<Int32>()
        let windows: [HitWindow] = list.compactMap { info in
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
        for info in list where (info[kCGWindowOwnerName as String] as? String) == "Window Server" {
            if let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value { windowServer.insert(pid) }
        }
        return (windows, windowServer)
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
        let role = AX.string(element, kAXRoleAttribute)
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
        return AXHit(pid: pid, windowID: windowID, inTransient: transient, role: role)
    }

    /// The hit-test verdict at a point. `useAX: false` reads the window list
    /// only, which is cheap and needs no IPC: the re-check right before a
    /// click is posted and before every scroll notch.
    static func verdict(_ target: ControlTarget, at point: CGPoint, useAX: Bool = true) -> PointerVerdict {
        guard let windowID = UInt32(target.windowID) else { return .covered(by: nil) }
        let list = windowList()
        let dock = Set(NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").map(\.processIdentifier))
        return pointerVerdict(
            targetPid: target.pid, targetWindowID: windowID, ownPid: getpid(),
            passThrough: PassThrough(dockPids: dock, windowServerPids: list.windowServer),
            ax: useAX ? axHit(at: point) : nil, windows: list.windows, point: point
        )
    }

    /// Both readings must accept the point: AX, and the window list alone
    /// (the one the pre-post and per-notch re-checks use), so an accepted
    /// point does not fail its own re-check.
    static func acceptedVerdict(_ target: ControlTarget, at point: CGPoint) -> PointerVerdict {
        let withAX = verdict(target, at: point)
        return withAX == .target ? verdict(target, at: point, useAX: false) : withAX
    }

    /// The re-check right before input is posted: the window list must still
    /// put the target under the point.
    static func requireStillUnder(_ target: ControlTarget, at point: CGPoint) throws {
        let now = verdict(target, at: point, useAX: false)
        guard now == .target else {
            throw HelperError("window_not_focused", "\(coverName(now)) covers that point; nothing was sent")
        }
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
        var last = acceptedVerdict(target, at: point)
        if last == .target { return }
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        for _ in 0..<10 {
            try await Task.sleep(nanoseconds: 50_000_000)
            last = acceptedVerdict(target, at: point)
            if last == .target { return }
        }
        throw HelperError("window_not_focused", "\(coverName(last)) covers that point; nothing was sent")
    }

    static func coverName(_ verdict: PointerVerdict) -> String {
        guard case .covered(let pid?) = verdict else { return "no window of the target" }
        let name = NSRunningApplication(processIdentifier: pid)?.localizedName
        return name.map { "a window of \($0)" } ?? "another window"
    }

    /// Secure input (a password field anywhere has focus, or the focused
    /// element of the target is a password field): keystrokes are refused.
    /// `global: false` skips the system-wide flag, for keys posted to an app
    /// that is not frontmost: that flag is then the user's own password field.
    static func refuseSecureInput(_ pid: pid_t, global: Bool = true) throws {
        if global, IsSecureEventInputEnabled() {
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

/// `delivery` (protocol ActionDelivery): `background` when the input went to
/// the app alone, `foreground` when it was real input to the frontmost app.
private func result(_ method: String, verified: Bool, delivery: String, note: String? = nil) -> JSON {
    var out: JSON = ["method": method, "verification": verified ? "verified" : "unverified", "delivery": delivery]
    if let note { out["note"] = note }
    return out
}

/// An accessibility action is background unless the frontmost app changed
/// while it ran (an app that brings itself forward when pressed).
private func accessibilityDelivery(since front: pid_t?) -> String {
    NSWorkspace.shared.frontmostApplication?.processIdentifier == front ? "background" : "foreground"
}

/// A background action's result: `foreground` after all when the app
/// brought itself to the front (it was put back behind the user's app).
private func backgroundResult(_ verified: Bool = false, since start: UserState, pid: pid_t, point: CGPoint? = nil) async -> JSON {
    if let note = await Background.settle(after: start, pid: pid, point: point) {
        return result("synthetic", verified: verified, delivery: "foreground", note: note)
    }
    return result("synthetic", verified: verified, delivery: "background")
}

/// After a background attempt hit `stop`: the reason to go on as real input
/// when nothing was posted, otherwise the error that ends the call, since the
/// input may have landed and real input could do it twice.
private func realInputAfter(_ stop: Background.Stop, sentBefore: Int, detail: String = "") throws -> String {
    guard afterStop(posted: Input.shared.sent != sentBefore) == .realInput else {
        throw HelperError("window_not_focused", "\(stop.reason) while the input was being sent in the background\(detail); nothing more was sent")
    }
    return stop.reason
}

/// The note on real input that could not go in the background.
private func realInputNote(_ why: String?) -> String? {
    why.map { "sent as real input: \($0)" }
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
            let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
            let rc = AXUIElementPerformAction(element, kAXPressAction as CFString)
            // cannotComplete: the app did not answer in time (a press that
            // opens a modal often does), so it may have acted. A real click
            // now could press twice; any other error refused the press.
            if rc == .success || rc == .cannotComplete {
                Input.shared.noteSent()
                await Overlay.shared.show(window: try? snap.windowFrame(), cursor: point, wait: false)
                await Overlay.shared.press(at: point)
                let note = rc == .success
                    ? "pressed through accessibility (AXPress)"
                    : "pressed through accessibility (AXPress), which did not answer in time; the app may have acted on it"
                return result("accessibility", verified: false, delivery: accessibilityDelivery(since: front), note: note)
            }
        }
        var why = Background.reason(.click(button: Int(button.rawValue), count: count), target)
        if why == nil, let windowID = CGWindowID(target.windowID) {
            let start = Background.userState()
            let sentBefore = Input.shared.sent
            do {
                await Overlay.shared.show(window: try? snap.windowFrame(), cursor: point, wait: true)
                // The cursor glide awaited: check again right before posting.
                if Session.isLocked { throw HelperError("window_not_focused", "the screen locked; nothing was sent") }
                try Background.check(target, windowID, since: start, point: point)
                await Overlay.shared.press(at: point)
                let flags = mods.reduce(into: CGEventFlags()) { $0.insert($1.flag) }
                Background.click(pid: target.pid, windowID: windowID, at: point, count: count, flags: flags)
                return await backgroundResult(since: start, pid: target.pid, point: point)
            } catch let stop as Background.Stop {
                why = try realInputAfter(stop, sentBefore: sentBefore)
            }
        }
        try await Focus.requirePointer(target, window: snap.window, at: point)
        await Overlay.shared.show(window: try? snap.windowFrame(), cursor: point, wait: true)
        // The cursor glide awaited: check again right before posting.
        try Focus.requireStillUnder(target, at: point)
        await Overlay.shared.press(at: point)
        Input.shared.withModifiers(mods) { flags in
            Input.shared.click(at: point, button: button, count: count, flags: flags)
        }
        return result("synthetic", verified: false, delivery: "foreground", note: realInputNote(why))
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
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let rc = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFString)
        // As for AXPress: an app that did not answer may have taken the value.
        if rc == .success || rc == .cannotComplete { Input.shared.noteSent() }
        guard rc == .success else {
            if isGone(rc) { throw HelperError("element_stale", "element \(index) went away") }
            throw HelperError("value_not_settable", "the app refused the value (AXError \(rc.rawValue))")
        }
        let readBack = AX.string(el, kAXValueAttribute)
        if readBack == value { return result("accessibility", verified: true, delivery: accessibilityDelivery(since: front)) }
        return result("accessibility", verified: false, delivery: accessibilityDelivery(since: front), note: "the value read back differs from what was set")
    }

    static func type(_ p: JSON, _ snaps: SnapshotStore) async throws -> JSON {
        let snap = try snaps.get(try p.requireString("snapshotId"))
        let target = try ControlTarget(p)
        try checkTarget(snap, target)
        let text = try p.requireString("text")
        guard !text.isEmpty else { throw HelperError("invalid_argument", "type needs text") }
        let windowID = CGWindowID(target.windowID)
        var why = Background.reason(.keys(command: false), target)
        if why == nil, let windowID {
            let start = Background.userState()
            let sentBefore = Input.shared.sent
            var previousKey: CGWindowID?
            // Key status goes back on every way out, an error included.
            func restoreKey() {
                Background.restoreKey(windowID, to: previousKey, pid: target.pid)
                previousKey = nil
            }
            defer { restoreKey() }
            var focusPoint: CGPoint?
            var clicked = false
            var typed = 0
            do {
                // Without an index the keys go to the app's focused element. One
                // that does not take text is refused before anything is sent, so
                // the call goes on as real input instead of failing on every retry.
                if p.int("index") == nil, !Background.focusedFieldTakesText(target.pid) {
                    throw Background.Stop(reason: "the app has no focused text field to type into in the background")
                }
                // Focus first, in the background: a background app keeps its
                // own focused element, and a page's autofocus does not take in
                // a window that was never active.
                let focus = await Background.focusWindow(target, windowID)
                previousKey = focus.previous
                guard focus.ok else { throw Background.Stop(reason: "the target window did not take focus in the background") }
                if let index = p.int("index") {
                    let el = try snap.element(at: index)
                    if Focus.isSecure(el) { throw HelperError("app_blocked", "that is a password field; wmux does not type into it") }
                    focusPoint = AX.frame(el).flatMap { frame in (try? snap.windowFrame()).flatMap { backgroundFocusPoint(frame: frame, window: $0) } }
                    let field = await Background.focus(el, target, windowID, clickAt: focusPoint)
                    clicked = field.clicked
                    if !field.focused {
                        throw Background.Stop(reason: "element \(index) did not take keyboard focus in the background")
                    }
                } else {
                    if let el = AX.element(AX.app(target.pid), kAXFocusedUIElementAttribute), Focus.isSecure(el) {
                        throw HelperError("app_blocked", "the focused field is a password field; wmux does not type into it")
                    }
                    if !Background.focusedFieldTakesText(target.pid) {
                        throw Background.Stop(reason: "the app has no focused text field to type into in the background")
                    }
                }
                // The focus click's own effect on the pointer is checked once,
                // here; the per-chunk checks leave the pointer to the user.
                try Background.requireStillSafe(target, windowID, since: start, point: focusPoint, beforeFirstKey: true)
                await Overlay.shared.show(window: try? snap.windowFrame(), cursor: nil, wait: false)
                let before = focusedValue(target.pid)
                var stop: Error?
                var checks = 0
                typed = Background.type(pid: target.pid, text) {
                    checks += 1
                    do {
                        try Background.requireStillSafe(target, windowID, since: start, beforeFirstKey: checks == 1)
                        return true
                    } catch {
                        stop = error
                        return false
                    }
                }
                if typed < text.count {
                    if let stop = stop as? Background.Stop { throw stop }
                    guard let e = stop as? HelperError else { throw Background.Stop(reason: "a key event could not be posted") }
                    throw HelperError(e.code, "\(e.message) (after \(typed) of \(text.count) characters; the rest was not typed)")
                }
                let verified = await waitForEffect(of: text, before: before, pid: target.pid, timeout: text.count < 64 ? 0.3 : 1.0)
                restoreKey()
                return await backgroundResult(verified, since: start, pid: target.pid, point: focusPoint)
            } catch let stop as Background.Stop {
                if Input.shared.sent != sentBefore {
                    let back = await Background.settle(after: start, pid: target.pid, point: focusPoint)
                    restoreKey()
                    let note = back.map { " (\($0))" } ?? ""
                    // Only focus went out (key status moved, or a focus click):
                    // real input now could click the field again and select a
                    // word, so the call ends.
                    if typed == 0 {
                        let after = clicked ? "after a background click on the field" : "after the window was focused in the background, with no click"
                        let next = p.int("index") == nil
                            ? "Call getAppState, then pass the index of the field to type into"
                            : "It may have focus now: call getAppState, then type without an index"
                        throw HelperError("window_not_focused", "\(stop.reason) \(after); nothing was typed\(note). \(next)")
                    }
                    throw HelperError("window_not_focused", "\(stop.reason) while typing in the background, after \(typed) of \(text.count) characters; the rest was not typed\(note)")
                }
                why = stop.reason
            }
        }
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
        return result("synthetic", verified: verified, delivery: "foreground", note: realInputNote(why))
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
        let flags = KeyCodes.intrinsicFlags(for: key)
        let windowID = CGWindowID(target.windowID)
        var why = Background.reason(.keys(command: flags.contains(.maskCommand)), target)
        if why == nil, let windowID {
            let start = Background.userState()
            let sentBefore = Input.shared.sent
            var previousKey: CGWindowID?
            // Key status goes back on every way out, an error included.
            func restoreKey() {
                Background.restoreKey(windowID, to: previousKey, pid: target.pid)
                previousKey = nil
            }
            defer { restoreKey() }
            var pressed = 0
            do {
                let focus = await Background.focusWindow(target, windowID)
                previousKey = focus.previous
                guard focus.ok else { throw Background.Stop(reason: "the target window did not take focus in the background") }
                await Overlay.shared.show(window: try? snap.windowFrame(), cursor: nil, wait: false)
                for n in 0..<repeatCount {
                    do {
                        try Background.requireStillSafe(target, windowID, since: start, beforeFirstKey: n == 0)
                    } catch let e as HelperError {
                        throw HelperError(e.code, n == 0 ? e.message : "\(e.message) (after \(n) of \(repeatCount) presses; the rest were not sent)")
                    }
                    guard Background.tap(pid: target.pid, key: code, flags: flags) else {
                        throw Background.Stop(reason: "the key event could not be posted")
                    }
                    pressed += 1
                    usleep(4_000)
                }
                restoreKey()
                return await backgroundResult(since: start, pid: target.pid)
            } catch let stop as Background.Stop {
                // The defer restores key status once this is decided: its
                // own records must not count as this input.
                why = try realInputAfter(stop, sentBefore: sentBefore, detail: " (after \(pressed) of \(repeatCount) presses)")
            }
        }
        try await requireKeyboardForward(snap, target)
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
        return result("synthetic", verified: false, delivery: "foreground", note: realInputNote(why))
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
        let flags = mods.reduce(into: KeyCodes.intrinsicFlags(for: key)) { $0.insert($1.flag) }
        let windowID = CGWindowID(target.windowID)
        var why = Background.reason(.keys(command: flags.contains(.maskCommand)), target)
        if why == nil, let windowID {
            let start = Background.userState()
            let sentBefore = Input.shared.sent
            var previousKey: CGWindowID?
            // Key status goes back on every way out, an error included.
            func restoreKey() {
                Background.restoreKey(windowID, to: previousKey, pid: target.pid)
                previousKey = nil
            }
            defer { restoreKey() }
            do {
                let focus = await Background.focusWindow(target, windowID)
                previousKey = focus.previous
                guard focus.ok else { throw Background.Stop(reason: "the target window did not take focus in the background") }
                await Overlay.shared.show(window: try? snap.windowFrame(), cursor: nil, wait: false)
                try Background.requireStillSafe(target, windowID, since: start, beforeFirstKey: true)
                guard Background.tap(pid: target.pid, key: code, flags: flags) else {
                    throw Background.Stop(reason: "the key event could not be posted")
                }
                restoreKey()
                return await backgroundResult(since: start, pid: target.pid)
            } catch let stop as Background.Stop {
                // The defer restores key status once this is decided: its
                // own records must not count as this input.
                why = try realInputAfter(stop, sentBefore: sentBefore)
            }
        }
        try await requireKeyboardForward(snap, target)
        Input.shared.withModifiers(mods) { flags in
            Input.shared.tap(key: code, flags: flags.union(KeyCodes.intrinsicFlags(for: key)))
        }
        return result("synthetic", verified: false, delivery: "foreground", note: realInputNote(why))
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
        var why = Background.reason(.scroll, target)
        if why == nil, let windowID = CGWindowID(target.windowID) {
            let start = Background.userState()
            let sentBefore = Input.shared.sent
            var sent = 0
            do {
                await Overlay.shared.show(window: try? snap.windowFrame(), cursor: point, wait: true)
                if Session.isLocked { throw HelperError("window_not_focused", "the screen locked; nothing was sent") }
                try Background.check(target, windowID, since: start, point: point)
                var stop: Background.Stop?
                sent = Background.scroll(pid: target.pid, windowID: windowID, at: point, dx: dx, dy: dy, notches: amount) {
                    if Session.isLocked { return false }
                    do {
                        try Background.check(target, windowID, since: start, point: point)
                        return true
                    } catch {
                        stop = error as? Background.Stop
                        return false
                    }
                }
                if sent < amount {
                    if let stop { throw stop }
                    throw HelperError("window_not_focused", "the screen locked after \(sent) of \(amount) notches; the rest was not sent")
                }
                return await backgroundResult(since: start, pid: target.pid, point: point)
            } catch let stop as Background.Stop {
                why = try realInputAfter(stop, sentBefore: sentBefore, detail: " (after \(sent) of \(amount) notches)")
            }
        }
        try await Focus.requirePointer(target, window: snap.window, at: point)
        await Overlay.shared.show(window: try? snap.windowFrame(), cursor: point, wait: true)
        // Re-run the hit-test before every notch (the first one included,
        // after the cursor glide): a window that moves over the point
        // mid-scroll must not receive the rest. The window list alone, no AX
        // round trip per notch, and it must put the target under the point.
        let sent = Input.shared.scroll(at: point, dx: dx, dy: dy, notches: amount) {
            !Session.isLocked && Focus.verdict(target, at: point, useAX: false) == .target
        }
        if sent < amount {
            throw HelperError("window_not_focused", "another window covered the point after \(sent) of \(amount) notches; the rest was not sent")
        }
        return result("synthetic", verified: false, delivery: "foreground", note: realInputNote(why))
    }
}
