// The agent overlay: while an input action runs, a halo around the target
// window (with a "wmux agent · Stop ⌃⌥⇧Esc" pill) and an agent cursor that
// moves to each click or scroll point and pulses on press. Keyboard actions
// show the halo only. It fades 1.5 s after the last action.
//
// One borderless, transparent, click-through panel per display (with
// separate Spaces a window spanning displays shows on one only). The panels
// never become key or main, are left out of screen captures
// (sharingType .none), join every Space, and are skipped by the pointer hit
// test (own pid). Created lazily on first use, so nothing exists before the
// trampoline re-exec or while the overlay is off.

import AppKit
import ComputerUseCore
import QuartzCore

/// DESIGN.md's attention orange (ATTENTION_COLORS fill of the dark looks) and
/// its ink, which keeps ≥ 4.5:1 on the fill.
private let attention = CGColor(srgbRed: 1, green: 0x8A / 255.0, blue: 0x3D / 255.0, alpha: 1)
private let attentionInk = CGColor(srgbRed: 0x0B / 255.0, green: 0x0C / 255.0, blue: 0x0E / 255.0, alpha: 1)
private let pillText = "wmux agent · Stop ⌃⌥⇧Esc"
private let fadeDelay: TimeInterval = 1.5
private let moveDuration: TimeInterval = 0.15

private final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class Overlay {
    static let shared = Overlay()

    private struct Display {
        let frame: CGRect
        let panel: OverlayPanel
        let root: CALayer
        let halo: CALayer
        let pill: CALayer
        let cursor: CAShapeLayer
        let ring: CAShapeLayer
    }

    private(set) var enabled = true
    private var displays: [Display] = []
    /// Where the agent cursor is, in global top-left coordinates.
    private var cursorPoint: CGPoint?
    private var fadeTimer: Timer?
    private var shown = false
    /// Bumped by every show and hide, so a fade that finishes after a newer
    /// action does not hide it.
    private var generation = 0

    private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    private var primaryHeight: CGFloat { NSScreen.screens.first?.frame.height ?? 0 }

    func setEnabled(_ on: Bool) {
        enabled = on
        if !on { hide() }
    }

    /// Shows the halo around `window` (global top-left frame) and, with a
    /// point, moves the agent cursor there. `wait`: hold until the cursor has
    /// arrived (≈150 ms) so it lands before the click does.
    func show(window: CGRect?, cursor point: CGPoint?, wait: Bool) async {
        guard enabled else { return }
        fadeTimer?.invalidate()
        fadeTimer = nil
        generation += 1
        ensureDisplays()
        guard !displays.isEmpty else { return }
        let animate = !reduceMotion

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for d in displays {
            // Cancels a fade under way, which would otherwise finish and snap back.
            d.root.removeAnimation(forKey: "opacity")
            d.root.opacity = 1
            if let window {
                d.halo.frame = local(window, on: d).insetBy(dx: -3, dy: -3)
                d.halo.isHidden = false
                let width = d.pill.bounds.width
                d.pill.position = CGPoint(x: d.halo.frame.midX - width / 2, y: d.halo.frame.minY - 10)
                d.pill.isHidden = false
            } else {
                d.halo.isHidden = true
                d.pill.isHidden = true
            }
        }
        var moved = false
        if let point {
            let from = cursorPoint ?? (animate ? mouseLocation() : point)
            for d in displays {
                let onThis = d.frame.contains(appKitPoint(point))
                d.cursor.isHidden = !onThis
                guard onThis else { continue }
                // Start from where the cursor was, when that is on this display.
                d.cursor.position = d.frame.contains(appKitPoint(from)) ? localPoint(from, on: d) : localPoint(point, on: d)
            }
            moved = animate && from != point
        }
        if !shown {
            for d in displays { d.panel.orderFrontRegardless() }
            shown = true
        }
        CATransaction.commit()

        if let point {
            CATransaction.begin()
            CATransaction.setDisableActions(!moved)
            CATransaction.setAnimationDuration(moveDuration)
            CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeOut))
            for d in displays where !d.cursor.isHidden { d.cursor.position = localPoint(point, on: d) }
            CATransaction.commit()
            cursorPoint = point
            if wait && moved { try? await Task.sleep(nanoseconds: UInt64(moveDuration * 1_000_000_000)) }
        }
    }

    /// A ring that pulses out from the press point (none with reduced motion).
    func press(at point: CGPoint) {
        guard enabled, shown, !reduceMotion else { return }
        for d in displays where d.frame.contains(appKitPoint(point)) {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            d.ring.position = localPoint(point, on: d)
            CATransaction.commit()
            let scale = CABasicAnimation(keyPath: "transform.scale")
            scale.fromValue = 0.4
            scale.toValue = 1.6
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0.9
            fade.toValue = 0
            let group = CAAnimationGroup()
            group.animations = [scale, fade]
            group.duration = 0.35
            group.timingFunction = CAMediaTimingFunction(name: .easeOut)
            d.ring.add(group, forKey: "pulse")
        }
    }

    /// After an input action: fade out unless another action comes first.
    func scheduleFade() {
        guard shown else { return }
        fadeTimer?.invalidate()
        fadeTimer = Timer.scheduledTimer(withTimeInterval: fadeDelay, repeats: false) { _ in
            Task { @MainActor in Overlay.shared.fade() }
        }
    }

    /// Immediately, no animation: stop, releaseInput, overlay switched off.
    func hide() {
        fadeTimer?.invalidate()
        fadeTimer = nil
        generation += 1
        guard shown else { return }
        for d in displays { d.panel.orderOut(nil) }
        shown = false
        cursorPoint = nil
    }

    private func fade() {
        fadeTimer = nil
        guard shown else { return }
        if reduceMotion {
            hide()
            return
        }
        let current = generation
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.3)
        for d in displays { d.root.opacity = 0 }
        CATransaction.commit()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            Task { @MainActor in
                if Overlay.shared.generation == current { Overlay.shared.hide() }
            }
        }
    }

    // MARK: Displays

    /// One panel per display, rebuilt when the display set changes.
    private func ensureDisplays() {
        let frames = NSScreen.screens.map(\.frame)
        guard displays.map(\.frame) != frames else { return }
        for d in displays { d.panel.orderOut(nil) }
        shown = false
        cursorPoint = nil
        displays = NSScreen.screens.map(makeDisplay)
    }

    private func makeDisplay(_ screen: NSScreen) -> Display {
        let frame = screen.frame
        let panel = OverlayPanel(
            contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.sharingType = .none
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.popUpMenu.rawValue + 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.setAccessibilityElement(false)
        panel.setFrame(frame, display: false)

        let view = NSView(frame: NSRect(origin: .zero, size: frame.size))
        view.wantsLayer = true
        view.setAccessibilityElement(false)
        panel.contentView = view
        let scale = screen.backingScaleFactor

        // Top-left, y-down coordinates, like AX and CGEvent.
        let root = CALayer()
        root.frame = CGRect(origin: .zero, size: frame.size)
        root.isGeometryFlipped = true
        view.layer?.addSublayer(root)

        let halo = CALayer()
        halo.borderColor = attention
        halo.borderWidth = 2
        halo.cornerRadius = 12
        halo.shadowColor = attention
        halo.shadowOpacity = 0.85
        halo.shadowRadius = 8
        halo.shadowOffset = .zero
        root.addSublayer(halo)

        let font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        let textSize = (pillText as NSString).size(withAttributes: [.font: font])
        let pill = CALayer()
        pill.anchorPoint = .zero
        pill.bounds = CGRect(x: 0, y: 0, width: ceil(textSize.width) + 20, height: 20)
        pill.backgroundColor = attention
        pill.cornerRadius = 10
        let text = CATextLayer()
        text.string = pillText
        text.font = font
        text.fontSize = 11
        text.foregroundColor = attentionInk
        text.alignmentMode = .center
        text.contentsScale = scale
        text.frame = CGRect(x: 0, y: (20 - ceil(textSize.height)) / 2, width: pill.bounds.width, height: ceil(textSize.height))
        pill.addSublayer(text)
        root.addSublayer(pill)

        let ring = CAShapeLayer()
        ring.bounds = CGRect(x: 0, y: 0, width: 32, height: 32)
        ring.path = CGPath(ellipseIn: ring.bounds.insetBy(dx: 1, dy: 1), transform: nil)
        ring.fillColor = nil
        ring.strokeColor = attention
        ring.lineWidth = 2
        ring.opacity = 0
        ring.contentsScale = scale
        root.addSublayer(ring)

        // An arrow with its tip at the layer's origin (the anchor), pointing up-left.
        let cursor = CAShapeLayer()
        cursor.anchorPoint = .zero
        cursor.bounds = CGRect(x: 0, y: 0, width: 16, height: 22)
        let arrow = CGMutablePath()
        arrow.addLines(between: [
            CGPoint(x: 1, y: 1), CGPoint(x: 1, y: 18), CGPoint(x: 5.5, y: 14), CGPoint(x: 8.5, y: 20.5),
            CGPoint(x: 11, y: 19.5), CGPoint(x: 8, y: 13), CGPoint(x: 14, y: 13),
        ])
        arrow.closeSubpath()
        cursor.path = arrow
        cursor.fillColor = attention
        cursor.strokeColor = CGColor(gray: 1, alpha: 1)
        cursor.lineWidth = 1.5
        cursor.lineJoin = .round
        cursor.shadowColor = CGColor(gray: 0, alpha: 1)
        cursor.shadowOpacity = 0.35
        cursor.shadowRadius = 2
        cursor.shadowOffset = .zero
        cursor.contentsScale = scale
        cursor.isHidden = true
        root.addSublayer(cursor)

        return Display(frame: frame, panel: panel, root: root, halo: halo, pill: pill, cursor: cursor, ring: ring)
    }

    // MARK: Coordinates

    private func local(_ rect: CGRect, on d: Display) -> CGRect {
        let origin = localPoint(rect.origin, on: d)
        return CGRect(origin: origin, size: rect.size)
    }

    private func localPoint(_ point: CGPoint, on d: Display) -> CGPoint {
        ComputerUseCore.localPoint(point, screenFrame: d.frame, primaryHeight: primaryHeight)
    }

    /// A global top-left point in AppKit's bottom-left space (for NSScreen frames).
    private func appKitPoint(_ point: CGPoint) -> CGPoint {
        CGPoint(x: point.x, y: primaryHeight - point.y)
    }

    private func mouseLocation() -> CGPoint {
        let p = NSEvent.mouseLocation
        return CGPoint(x: p.x, y: primaryHeight - p.y)
    }
}
