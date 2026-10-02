// Thin AXUIElement helpers and the TreeSource adapter the walker runs on.

import AppKit
import ApplicationServices
import ComputerUseCore

/// Per-call messaging timeout: a hung app must not stall the helper for AX's
/// default 6 s per attribute.
let axMessagingTimeout: Float = 1.5

enum AX {
    static func app(_ pid: pid_t) -> AXUIElement {
        let el = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(el, axMessagingTimeout)
        return el
    }

    static func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success else { return nil }
        return value
    }

    static func string(_ el: AXUIElement, _ name: String) -> String? {
        attr(el, name).flatMap(stringValue)
    }

    static func bool(_ el: AXUIElement, _ name: String) -> Bool? {
        guard let v = attr(el, name) else { return nil }
        if CFGetTypeID(v) == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }
        if let n = v as? NSNumber { return n.boolValue }
        return nil
    }

    static func element(_ el: AXUIElement, _ name: String) -> AXUIElement? {
        guard let v = attr(el, name), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    static func elements(_ el: AXUIElement, _ name: String) -> [AXUIElement] {
        guard let v = attr(el, name), let array = v as? [AnyObject] else { return [] }
        return array.compactMap { item in
            CFGetTypeID(item) == AXUIElementGetTypeID() ? (item as! AXUIElement) : nil
        }
    }

    static func frame(_ el: AXUIElement) -> CGRect? {
        guard let pos = attr(el, kAXPositionAttribute), let size = attr(el, kAXSizeAttribute) else { return nil }
        return frame(position: pos, size: size)
    }

    static func frame(position: CFTypeRef, size: CFTypeRef) -> CGRect? {
        guard CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero
        var s = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &p), AXValueGetValue(size as! AXValue, .cgSize, &s),
              [p.x, p.y, s.width, s.height].allSatisfy(\.isFinite) else {
            return nil
        }
        return CGRect(origin: p, size: s)
    }

    /// AXValue, AXTitle… as display text. Numbers and booleans render as their
    /// number (a checkbox is 0/1); structs (ranges, points) are not text.
    static func stringValue(_ v: CFTypeRef) -> String? {
        let type = CFGetTypeID(v)
        if type == CFStringGetTypeID() { return (v as! String) }
        if type == CFAttributedStringGetTypeID() { return (v as! NSAttributedString).string }
        if type == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) ? "1" : "0" }
        if type == CFNumberGetTypeID() { return (v as! NSNumber).stringValue }
        if type == CFURLGetTypeID() { return (v as! URL).absoluteString }
        return nil
    }

    static func actions(_ el: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(el, &names) == .success, let list = names as? [String] else { return [] }
        return list
    }

    static func isSettable(_ el: AXUIElement, _ name: String) -> Bool {
        var settable: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(el, name as CFString, &settable) == .success && settable.boolValue
    }

    private typealias GetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
    private static let getWindowFn: GetWindow? = {
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
        return unsafeBitCast(sym, to: GetWindow.self)
    }()

    /// The CGWindowID behind an AX window (private but long-stable SPI); the
    /// window id main sees, and the one ScreenCaptureKit captures.
    static func windowID(_ el: AXUIElement) -> CGWindowID? {
        guard let fn = getWindowFn else { return nil }
        var id: CGWindowID = 0
        return fn(el, &id) == .success && id != 0 ? id : nil
    }
}

/// AX errors that mean "this element no longer exists".
func isGone(_ error: AXError) -> Bool {
    error == .invalidUIElement || error == .cannotComplete
}

// MARK: - Tree source

/// The attributes fetched per element in one AXUIElementCopyMultipleAttributeValues call.
private let walkAttributes: [String] = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
    kAXValueAttribute, kAXIdentifierAttribute, kAXEnabledAttribute, kAXSelectedAttribute,
    kAXExpandedAttribute, kAXPositionAttribute, kAXSizeAttribute,
]

/// Actions that do not make an otherwise empty node worth an index.
private let incidentalActions: Set<String> = [
    "AXShowMenu", "AXScrollToVisible", "AXShowDefaultUI", "AXShowAlternateUI", "AXRaise",
]

struct AXTreeSource: TreeSource {
    func info(of el: AXUIElement) -> NodeInfo? {
        var values: CFArray?
        let err = AXUIElementCopyMultipleAttributeValues(el, walkAttributes as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
        guard err == .success, let list = values as? [AnyObject], list.count == walkAttributes.count else { return nil }
        func value(_ i: Int) -> CFTypeRef? {
            let v = list[i] as CFTypeRef
            // Missing attributes come back as an AXValue wrapping an AXError.
            if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { return nil }
            return v
        }
        func text(_ i: Int) -> String? { value(i).flatMap(AX.stringValue) }
        func flag(_ i: Int) -> Bool? {
            guard let v = value(i) else { return nil }
            if CFGetTypeID(v) == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }
            return (v as? NSNumber)?.boolValue
        }
        guard let role = text(0), !role.isEmpty else { return nil }
        var frame: CGRect?
        if let p = value(9), let s = value(10) { frame = AX.frame(position: p, size: s) }
        return NodeInfo(
            role: role, subrole: text(1), title: text(2), description: text(3),
            value: text(4), identifier: text(5), enabled: flag(6) ?? true,
            selected: flag(7) ?? false, expanded: flag(8) ?? false, frame: frame
        )
    }

    func children(of el: AXUIElement, info: NodeInfo) -> [AXUIElement] {
        switch info.role {
        case "AXTable", "AXOutline":
            // Only the rows on screen: a 10 000-row table would otherwise eat
            // the whole node budget. Headers and other non-row children stay.
            let visible = AX.elements(el, kAXVisibleRowsAttribute)
            if !visible.isEmpty {
                let others = AX.elements(el, kAXChildrenAttribute).filter { AX.string($0, kAXRoleAttribute) != "AXRow" }
                return others + visible
            }
        case "AXMenuBarItem", "AXMenuItem":
            // A closed menu still exposes every item; descend only into the open one.
            if !info.selected { return [] }
        default:
            break
        }
        return AX.elements(el, kAXChildrenAttribute)
    }

    func hasActions(_ el: AXUIElement) -> Bool {
        AX.actions(el).contains { !incidentalActions.contains($0) }
    }
}
