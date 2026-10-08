// Pointer hit-test decision: does a synthetic click or scroll at a screen
// point land on the target window? Pure, so the rules are unit-tested; the
// executable gathers the inputs (an AX hit and the on-screen window list).
//
// macOS 26's Dock keeps a full-screen, layer-20 window on screen at all times
// that real clicks pass through. Taking the topmost window under the point at
// face value refused every pointer action, so a window of another process
// above the normal layer never decides on its own.

import CoreGraphics

/// One entry of CGWindowListCopyWindowInfo, front to back.
public struct HitWindow: Equatable {
    public let pid: Int32
    public let windowID: UInt32
    public let layer: Int
    public let bounds: CGRect
    public let alpha: Double

    public init(pid: Int32, windowID: UInt32, layer: Int, bounds: CGRect, alpha: Double = 1) {
        self.pid = pid
        self.windowID = windowID
        self.layer = layer
        self.bounds = bounds
        self.alpha = alpha
    }
}

/// What AXUIElementCopyElementAtPosition answered: the element's process,
/// the CGWindowID of its window when AX names one, and whether the element
/// sits in a menu, popover or sheet (a transient surface of its app).
public struct AXHit: Equatable {
    public let pid: Int32
    public let windowID: UInt32?
    public let inTransient: Bool

    public init(pid: Int32, windowID: UInt32?, inTransient: Bool = false) {
        self.pid = pid
        self.windowID = windowID
        self.inTransient = inTransient
    }
}

public enum PointerVerdict: Equatable {
    case target
    /// Something else is under the point: the pid that owns it (nil: no window).
    case covered(by: Int32?)
}

/// Decides whether the point lands on the target window.
///
/// 1. AX first. An element of the target app counts when its window is the
///    target window, or when it is a menu, popover or sheet of that app (or
///    its window is above the normal layer, like a menu the previous click
///    opened). Another normal window of the same app refuses. An element of
///    another app refuses only when that app owns a normal (layer 0) window
///    under the point; otherwise AX is not trusted to have looked through the
///    overlay, and the window list decides.
/// 2. The window list, front to back, skipping fully transparent windows, the
///    helper's own windows (the agent overlay) and any window of another
///    process above the normal layer (the Dock's full-screen window, the menu
///    bar). The first window left decides, with the same same-app rule.
///
/// An own-process AX answer (the overlay) or no AX answer at all also falls
/// through to the window list.
public func pointerVerdict(
    targetPid: Int32,
    targetWindowID: UInt32,
    ownPid: Int32,
    ax: AXHit?,
    windows: [HitWindow],
    point: CGPoint
) -> PointerVerdict {
    let under = windows.filter { $0.alpha > 0 && $0.bounds.contains(point) }
    func layer(of id: UInt32?) -> Int? {
        guard let id else { return nil }
        return windows.first(where: { $0.windowID == id })?.layer
    }

    if let ax, ax.pid != ownPid {
        if ax.pid == targetPid {
            if ax.windowID == targetWindowID || ax.inTransient { return .target }
            if let l = layer(of: ax.windowID), l != 0 { return .target }
            // A window id AX names but that is another normal window of the app.
            if ax.windowID != nil { return .covered(by: targetPid) }
            // No window: AX could not say; the window list decides.
        } else if under.contains(where: { $0.pid == ax.pid && $0.layer == 0 }) {
            return .covered(by: ax.pid)
        }
    }

    for w in under {
        if w.pid == ownPid { continue }
        if w.pid != targetPid && w.layer != 0 { continue }
        if w.pid != targetPid { return .covered(by: w.pid) }
        return w.windowID == targetWindowID || w.layer != 0 ? .target : .covered(by: targetPid)
    }
    return .covered(by: nil)
}

// MARK: - Screen coordinates

/// AX and CGWindowList use a global space with its origin at the top-left of
/// the primary display and y growing down. AppKit (NSWindow, NSScreen) puts
/// the origin at the bottom-left of the primary display with y growing up.
/// The same flip converts in both directions.
public func flipRect(_ rect: CGRect, primaryHeight: CGFloat) -> CGRect {
    CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
}

/// A global top-left point in the coordinates of a layer that fills a screen
/// (given by its AppKit frame) and has a flipped geometry (origin top-left).
public func localPoint(_ point: CGPoint, screenFrame: CGRect, primaryHeight: CGFloat) -> CGPoint {
    let screenTopLeft = flipRect(screenFrame, primaryHeight: primaryHeight).origin
    return CGPoint(x: point.x - screenTopLeft.x, y: point.y - screenTopLeft.y)
}
