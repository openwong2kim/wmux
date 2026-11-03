// The agent overlay. Every agent that drives an app gets its own marker, in
// the colour main gave it (src/shared/computer/agentMarker.ts; the rules are
// in ComputerUseCore/Markers.swift):
//   - a 3 px ring around its target window and a name pill above the
//     window's top-left ("● #api-1 · Claude Code · typing"). A second agent
//     on the same window rings 3 px outside the first, its pill beside the
//     first one's;
//   - click and scroll (AXPress included): its own pointer, an arrow in its
//     colour with a name chip, which moves to each point and pulses on press;
//   - keyboard actions and setValue: a caret at the insertion point, with
//     the chip;
//   - real input: the pill inverted (" · using your mouse"), and for pointer
//     actions a ring where the real pointer goes instead of the arrow;
//   - waiting for another agent's real input (markerWait): ring and pill
//     dimmed, " · waiting for <agent>".
// Each marker fades 1.5 s after its own last action, a waiting one 15 s
// after markerWait; markerClear removes it at once. While any marker shows,
// a dark bar at the top of the main display counts them and carries the stop
// chord. Pills, pointers and carets draw above every ring.
//
// One borderless, transparent, click-through panel per display (with
// separate Spaces a window spanning displays shows on one only). The panels
// never become key or main, are left out of screen captures
// (sharingType .none; WMUX_OVERLAY_CAPTURABLE=1 at launch lets them in, for
// dev screenshots), join every Space, and are skipped by the pointer hit
// test (own pid). Created lazily on first use, so nothing exists before the
// trampoline re-exec or while the overlay is off.

import AppKit
import ComputerUseCore
import QuartzCore

private let fadeDelay: TimeInterval = 1.5
/// How long a waiting marker stays without a newer action or markerClear:
/// main's INPUT_LOCK_IDLE_MS (15 000 ms, src/main/computer/inputLanes.ts).
/// The real-input lease it waits on is free by then, and main may never send
/// markerClear for an agent it refused.
private let waitFadeDelay: TimeInterval = 15
private let fadeDuration: TimeInterval = 0.3
private let moveDuration: TimeInterval = 0.15
private let pillHeight: CGFloat = 24
private let pillGap: CGFloat = 6
private let pillLift: CGFloat = 4
private let chipHeight: CGFloat = 18
private let barHeight: CGFloat = 28
private let barMaxDots = 16
/// The corner radius of a window, which the innermost ring follows.
private let windowRadius: CGFloat = 10
private let labelFont = NSFont.systemFont(ofSize: 12, weight: .semibold)
private let verbFont = NSFont.systemFont(ofSize: 12, weight: .regular)
private let chipFont = NSFont.systemFont(ofSize: 11, weight: .semibold)
private let ink = markerInk.cg()
private let barInk = CGColor(gray: 0.95, alpha: 1)

/// Dev only: `WMUX_OVERLAY_CAPTURABLE=1` in the helper's environment at
/// launch lets screen captures include the overlay, for screenshots.
private let capturable = ProcessInfo.processInfo.environment["WMUX_OVERLAY_CAPTURABLE"] == "1"

private extension MarkerRGB {
    func cg(_ alpha: CGFloat = 1) -> CGColor { CGColor(srgbRed: red, green: green, blue: blue, alpha: alpha) }
}

private final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Where a marker's pointer or caret is, in global top-left coordinates.
private enum Spot {
    case none
    case pointer(CGPoint)
    case caret(CGRect)
}

private func makeText(_ scale: CGFloat) -> CATextLayer {
    let text = CATextLayer()
    text.anchorPoint = .zero
    text.contentsScale = scale
    text.isWrapped = false
    return text
}

private func textWidth(_ string: String, _ font: NSFont) -> CGFloat {
    ceil((string as NSString).size(withAttributes: [.font: font]).width)
}

/// Sets a text layer's string, font and colour at `x`, centred in a row
/// `rowHeight` tall. Returns the text's width.
@discardableResult
private func setText(_ layer: CATextLayer, _ string: String, font: NSFont, color: CGColor, x: CGFloat, rowHeight: CGFloat) -> CGFloat {
    let width = textWidth(string, font)
    let lineHeight = ceil(font.ascender - font.descender + font.leading)
    layer.string = string
    layer.font = font
    layer.fontSize = font.pointSize
    layer.foregroundColor = color
    layer.bounds = CGRect(x: 0, y: 0, width: width + 2, height: lineHeight)
    layer.position = CGPoint(x: x, y: floor((rowHeight - lineHeight) / 2))
    return width
}

/// The pill's text, measured once per render.
private struct PillText {
    let label: String
    let verb: String
    let labelWidth: CGFloat
    let width: CGFloat

    init(label: String, verb: String) {
        self.label = label
        self.verb = verb
        labelWidth = textWidth(label, labelFont)
        // 10 padding, 6 dot, 6 gap, the text, 12 padding.
        width = 22 + labelWidth + textWidth(verb, verbFont) + 12
    }
}

/// The name chip beside a pointer or caret.
private final class Chip {
    let layer = CALayer()
    let text: CATextLayer

    init(scale: CGFloat) {
        text = makeText(scale)
        layer.anchorPoint = .zero
        layer.cornerRadius = chipHeight / 2
        layer.addSublayer(text)
    }

    func set(_ name: String, color: CGColor) {
        let width = setText(text, name, font: chipFont, color: ink, x: 7, rowHeight: chipHeight)
        layer.bounds = CGRect(x: 0, y: 0, width: width + 14, height: chipHeight)
        layer.backgroundColor = color
    }
}

/// One marker's layers on one display.
private final class MarkerLayers {
    let halo = CALayer()
    let pill = CALayer()
    let dot = CAShapeLayer()
    let label: CATextLayer
    let verb: CATextLayer
    /// Positioned at the point: the arrow's tip sits on it.
    let pointer = CALayer()
    let arrow = CAShapeLayer()
    /// Real input: a ring around the user's own pointer instead of the arrow.
    let realRing = CAShapeLayer()
    let pointerChip: Chip
    /// Positioned at the caret's top.
    let caret = CALayer()
    let caretBar = CALayer()
    let caretChip: Chip
    let press = CAShapeLayer()

    /// What fades out with the marker.
    var faded: [CALayer] { [halo, pill, pointer, caret] }

    init(scale: CGFloat, halos: CALayer, pills: CALayer, pointers: CALayer) {
        label = makeText(scale)
        verb = makeText(scale)
        pointerChip = Chip(scale: scale)
        caretChip = Chip(scale: scale)

        halo.borderWidth = haloRingWidth
        halos.addSublayer(halo)

        pill.anchorPoint = .zero
        pill.cornerRadius = pillHeight / 2
        dot.frame = CGRect(x: 10, y: (pillHeight - 6) / 2, width: 6, height: 6)
        dot.path = CGPath(ellipseIn: CGRect(x: 0.75, y: 0.75, width: 4.5, height: 4.5), transform: nil)
        dot.lineWidth = 1.5
        dot.contentsScale = scale
        pill.addSublayer(dot)
        pill.addSublayer(label)
        pill.addSublayer(verb)
        pills.addSublayer(pill)

        press.bounds = CGRect(x: 0, y: 0, width: 32, height: 32)
        press.path = CGPath(ellipseIn: press.bounds.insetBy(dx: 1, dy: 1), transform: nil)
        press.fillColor = nil
        press.lineWidth = 2
        press.opacity = 0
        press.contentsScale = scale
        pointers.addSublayer(press)

        caret.anchorPoint = .zero
        caret.addSublayer(caretBar)
        caret.addSublayer(caretChip.layer)
        caret.isHidden = true
        pointers.addSublayer(caret)

        pointer.anchorPoint = .zero
        pointer.bounds = .zero
        // An arrow with its tip at the pointer's origin, pointing up-left.
        arrow.frame = CGRect(x: 0, y: 0, width: 16, height: 22)
        let path = CGMutablePath()
        path.addLines(between: [
            CGPoint(x: 1, y: 1), CGPoint(x: 1, y: 18), CGPoint(x: 5.5, y: 14), CGPoint(x: 8.5, y: 20.5),
            CGPoint(x: 11, y: 19.5), CGPoint(x: 8, y: 13), CGPoint(x: 14, y: 13),
        ])
        path.closeSubpath()
        arrow.path = path
        arrow.strokeColor = ink
        arrow.lineWidth = 1.5
        arrow.lineJoin = .round
        arrow.shadowColor = CGColor(gray: 0, alpha: 1)
        arrow.shadowOpacity = 0.3
        arrow.shadowRadius = 2
        arrow.shadowOffset = .zero
        arrow.contentsScale = scale
        // Around the real arrow, which hangs down-right from the point.
        realRing.frame = CGRect(x: 5 - 18, y: 8 - 18, width: 36, height: 36)
        realRing.path = CGPath(ellipseIn: CGRect(x: 1.25, y: 1.25, width: 33.5, height: 33.5), transform: nil)
        realRing.fillColor = nil
        realRing.lineWidth = 2.5
        realRing.contentsScale = scale
        pointer.addSublayer(realRing)
        pointer.addSublayer(arrow)
        pointer.addSublayer(pointerChip.layer)
        pointer.isHidden = true
        pointers.addSublayer(pointer)
    }

    func remove() {
        for layer in [halo, pill, pointer, caret, press] { layer.removeFromSuperlayer() }
    }
}

/// One display's panel and layers.
@MainActor
private final class Display {
    let frame: CGRect
    let visibleFrame: CGRect
    let scale: CGFloat
    let panel: OverlayPanel
    /// Rings, then pills, then pointers and carets, then the bar: each
    /// container draws above the one before.
    let halos = CALayer()
    let pills = CALayer()
    let pointers = CALayer()
    let bar = CALayer()
    let barText: CATextLayer
    let barHint: CATextLayer
    var barDots: [CAShapeLayer] = []
    var markers: [String: MarkerLayers] = [:]

    init(screen: NSScreen) {
        frame = screen.frame
        visibleFrame = screen.visibleFrame
        scale = screen.backingScaleFactor
        panel = OverlayPanel(
            contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.sharingType = capturable ? .readOnly : .none
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

        // Top-left, y-down coordinates, like AX and CGEvent.
        let root = CALayer()
        root.frame = CGRect(origin: .zero, size: frame.size)
        root.isGeometryFlipped = true
        view.layer?.addSublayer(root)
        for container in [halos, pills, pointers] {
            container.frame = root.bounds
            root.addSublayer(container)
        }

        barText = makeText(scale)
        barHint = makeText(scale)
        bar.backgroundColor = markerInk.cg(0.92)
        bar.borderColor = CGColor(gray: 1, alpha: 0.12)
        bar.borderWidth = 1
        bar.cornerRadius = barHeight / 2
        bar.addSublayer(barText)
        bar.addSublayer(barHint)
        bar.isHidden = true
        root.addSublayer(bar)
    }

    func layers(for id: String) -> MarkerLayers {
        if let layers = markers[id] { return layers }
        let layers = MarkerLayers(scale: scale, halos: halos, pills: pills, pointers: pointers)
        markers[id] = layers
        return layers
    }
}

@MainActor
final class Overlay {
    static let shared = Overlay()

    private struct State {
        var marker: AgentMarker
        /// When it first showed: the order of the bar's dots.
        let created: Int
        /// The window its ring and pill are on, and when it arrived there.
        var window: String?
        var arrival = 0
        var verb: MarkerVerb = .clicking
        var realInput = false
        var spot: Spot = .none
        /// Where its pointer last was, so the next one moves on from there.
        var lastPointer: CGPoint?
        /// The overlay-wide `sequence` at this marker's latest action, so a
        /// fade that finishes after a newer action does not remove it. Never
        /// reused, so a fade still pending when hide or clear dropped the
        /// marker cannot match it once the same id is drawn again.
        var generation = 0
        var fadeTimer: Timer?
        var fading = false

        var waiting: Bool {
            if case .waiting = verb { return true }
            return false
        }
    }

    private(set) var enabled = true
    private var displays: [Display] = []
    private var states: [String: State] = [:]
    /// The latest frame of each window a marker is on (global top-left).
    private var windowFrames: [String: CGRect] = [:]
    private var sequence = 0
    private var shown = false

    private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    private var primaryHeight: CGFloat { NSScreen.screens.first?.frame.height ?? 0 }

    func setEnabled(_ on: Bool) {
        enabled = on
        if !on { hide() }
    }

    /// Draws `marker` for an input action on the window `windowID` (`window`:
    /// its global top-left frame, nil when it could not be read). With
    /// `pointer`, moves the marker's pointer there; with `caret`, draws its
    /// caret there. `realInput`: the action uses the user's own pointer or
    /// keyboard. `wait`: hold until the pointer has arrived (≈150 ms) so it
    /// lands before the click does.
    func show(
        _ marker: AgentMarker, verb: MarkerVerb, window: CGRect?, windowID: String,
        pointer: CGPoint? = nil, caret: CGRect? = nil, realInput: Bool = false, wait: Bool = false
    ) async {
        guard enabled else { return }
        var state = begin(marker, window: window, windowID: windowID)
        state.verb = verb
        state.realInput = realInput
        let animate = !reduceMotion
        var from: CGPoint?
        if let pointer {
            // Real input moves the user's pointer: its ring starts there.
            let start = realInput ? nil : state.lastPointer
            from = animate ? start ?? mouseLocation() : pointer
            state.spot = .pointer(from ?? pointer)
            state.lastPointer = pointer
        } else {
            state.spot = caret.map(Spot.caret) ?? .none
        }
        states[marker.id] = state
        render()
        guard let pointer, let from else { return }

        states[marker.id]?.spot = .pointer(pointer)
        let moved = animate && from != pointer
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for d in displays {
            guard let layers = d.markers[marker.id] else { continue }
            if !contains(d, pointer) {
                layers.pointer.isHidden = true
            } else if !contains(d, from) {
                // Arriving from another display: it starts at the point.
                layers.pointer.position = local(pointer, on: d)
                layers.pointer.isHidden = false
            }
        }
        CATransaction.commit()
        CATransaction.begin()
        CATransaction.setDisableActions(!moved)
        CATransaction.setAnimationDuration(moveDuration)
        CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeOut))
        for d in displays where contains(d, pointer) && contains(d, from) {
            d.markers[marker.id]?.pointer.position = local(pointer, on: d)
        }
        CATransaction.commit()
        if wait && moved { try? await Task.sleep(nanoseconds: UInt64(moveDuration * 1_000_000_000)) }
    }

    /// markerWait: `marker` waits on the window for another agent's real
    /// input to end. It stays until its next action or markerClear, or fades
    /// after waitFadeDelay.
    func wait(_ marker: AgentMarker, window: CGRect, windowID: String, waitingFor: String) {
        guard enabled else { return }
        var state = begin(marker, window: window, windowID: windowID)
        state.verb = .waiting(for: waitingFor)
        state.realInput = false
        state.spot = .none
        states[marker.id] = state
        render()
        scheduleFade(marker.id, after: waitFadeDelay)
    }

    /// A ring in the marker's colour that pulses out from the press point
    /// (none with reduced motion).
    func press(_ id: String, at point: CGPoint) {
        guard enabled, !reduceMotion else { return }
        for d in displays where contains(d, point) {
            guard let ring = d.markers[id]?.press else { continue }
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            ring.position = local(point, on: d)
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
            ring.add(group, forKey: "pulse")
        }
    }

    /// After an input action: that marker fades unless it acts again first.
    func scheduleFade(_ id: String, after delay: TimeInterval = fadeDelay) {
        guard var state = states[id] else { return }
        state.fadeTimer?.invalidate()
        let generation = state.generation
        state.fadeTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { _ in
            Task { @MainActor in Overlay.shared.fade(id, generation: generation) }
        }
        states[id] = state
    }

    /// markerClear: that marker goes now, no animation.
    func clear(_ id: String) {
        guard let state = states.removeValue(forKey: id) else { return }
        state.fadeTimer?.invalidate()
        render()
    }

    /// Every marker, now, no animation: stop, releaseInput, overlay switched off.
    func hide() {
        for state in states.values { state.fadeTimer?.invalidate() }
        states.removeAll()
        render()
    }

    private func fade(_ id: String, generation: Int) {
        guard var state = states[id], state.generation == generation else { return }
        state.fadeTimer = nil
        if reduceMotion {
            states[id] = state
            clear(id)
            return
        }
        state.fading = true
        states[id] = state
        let last = states.values.allSatisfy(\.fading)
        CATransaction.begin()
        CATransaction.setAnimationDuration(fadeDuration)
        for d in displays {
            for layer in d.markers[id]?.faded ?? [] { layer.opacity = 0 }
            if last { d.bar.opacity = 0 }
        }
        CATransaction.commit()
        DispatchQueue.main.asyncAfter(deadline: .now() + fadeDuration) {
            Task { @MainActor in
                let overlay = Overlay.shared
                if overlay.states[id]?.generation == generation { overlay.clear(id) }
            }
        }
    }

    /// The marker's state for a new action: its fade called off, its ring on `windowID`.
    private func begin(_ marker: AgentMarker, window: CGRect?, windowID: String) -> State {
        sequence += 1
        var state = states[marker.id] ?? State(marker: marker, created: sequence)
        state.marker = marker
        state.fadeTimer?.invalidate()
        state.fadeTimer = nil
        state.fading = false
        state.generation = sequence
        if let window {
            if state.window != windowID {
                state.window = windowID
                state.arrival = sequence
            }
            windowFrames[windowID] = window
        } else {
            state.window = nil
        }
        return state
    }

    // MARK: Drawing

    /// Brings every display's layers in line with `states`.
    private func render() {
        if states.isEmpty {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            for d in displays {
                for layers in d.markers.values { layers.remove() }
                d.markers.removeAll()
                d.bar.isHidden = true
            }
            CATransaction.commit()
            windowFrames.removeAll()
            if shown {
                for d in displays { d.panel.orderOut(nil) }
                shown = false
            }
            return
        }
        ensureDisplays()
        guard !displays.isEmpty else { return }

        let byWindow = markersByWindow(states.values.compactMap { s in
            s.window.map { MarkerPlacement(id: s.marker.id, window: $0, arrival: s.arrival) }
        })
        windowFrames = windowFrames.filter { byWindow[$0.key] != nil }
        var pills: [String: PillText] = [:]
        for (id, s) in states { pills[id] = PillText(label: s.marker.label, verb: s.verb.text(realInput: s.realInput)) }
        var rings: [String: Int] = [:]
        var pillOrigins: [String: CGPoint] = [:]
        for (window, ids) in byWindow {
            guard let frame = windowFrames[window] else { continue }
            let widths = ids.map { pills[$0]?.width ?? 0 }
            let outset = haloOutset(ring: ids.count - 1)
            // Above the window the rows span its outermost ring; inside it, its inset width.
            let aboveGrid = pillGrid(widths: widths, gap: pillGap, rowWidth: frame.width + 2 * outset)
            let row = pillRowOrigin(
                window: frame, outset: outset, pillHeight: pillHeight, lift: pillLift,
                topLimit: topLimit(for: frame), rows: (aboveGrid.map(\.row).max() ?? 0) + 1, rowGap: pillGap
            )
            let above = row.y < frame.minY
            let grid = above ? aboveGrid : pillGrid(widths: widths, gap: pillGap, rowWidth: frame.width - 16)
            let step = (above ? -1 : 1) * (pillHeight + pillGap)
            for (ring, id) in ids.enumerated() {
                rings[id] = ring
                pillOrigins[id] = CGPoint(x: row.x + grid[ring].x, y: row.y + CGFloat(grid[ring].row) * step)
            }
        }
        let live = states.values.sorted { $0.created < $1.created }

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (index, d) in displays.enumerated() {
            for id in Array(d.markers.keys) where states[id] == nil {
                d.markers.removeValue(forKey: id)?.remove()
            }
            for s in live {
                guard let pill = pills[s.marker.id] else { continue }
                draw(s, d.layers(for: s.marker.id), on: d, ring: rings[s.marker.id], pill: pill, pillAt: pillOrigins[s.marker.id])
            }
            drawBar(on: d, primary: index == 0, live: live)
        }
        CATransaction.commit()
        if !shown {
            for d in displays { d.panel.orderFrontRegardless() }
            shown = true
        }
    }

    private func draw(_ s: State, _ l: MarkerLayers, on d: Display, ring: Int?, pill: PillText, pillAt origin: CGPoint?) {
        let color = s.marker.color.cg()
        if !s.fading {
            for layer in l.faded { layer.removeAnimation(forKey: "opacity") }
            l.halo.opacity = s.waiting ? 0.45 : 1
            l.pill.opacity = s.waiting ? 0.55 : 1
            l.pointer.opacity = 1
            l.caret.opacity = 1
        }

        if let ring, let window = s.window, let frame = windowFrames[window] {
            let outset = haloOutset(ring: ring)
            l.halo.frame = local(frame, on: d).insetBy(dx: -outset, dy: -outset)
            l.halo.cornerRadius = windowRadius + outset
            l.halo.borderColor = color
            l.halo.isHidden = false
        } else {
            l.halo.isHidden = true
        }

        if let origin {
            // Real input: ink fill, text in the colour, a 2 px ring inside.
            let textColor = s.realInput ? color : ink
            l.pill.position = local(origin, on: d)
            l.pill.bounds = CGRect(x: 0, y: 0, width: pill.width, height: pillHeight)
            l.pill.backgroundColor = s.realInput ? ink : color
            l.pill.borderWidth = s.realInput ? 2 : 0
            l.pill.borderColor = color
            // Waiting: a hollow dot.
            l.dot.fillColor = s.waiting ? nil : textColor
            l.dot.strokeColor = textColor
            setText(l.label, pill.label, font: labelFont, color: textColor, x: 22, rowHeight: pillHeight)
            setText(l.verb, pill.verb, font: verbFont, color: textColor.copy(alpha: 0.62) ?? textColor,
                    x: 22 + pill.labelWidth, rowHeight: pillHeight)
            l.pill.isHidden = false
        } else {
            l.pill.isHidden = true
        }

        let chip = markerChipLabel(s.marker.label)
        if case .pointer(let point) = s.spot, contains(d, point) {
            l.pointer.position = local(point, on: d)
            l.arrow.fillColor = color
            l.arrow.isHidden = s.realInput
            l.realRing.strokeColor = color
            l.realRing.isHidden = !s.realInput
            l.pointerChip.set(chip, color: color)
            l.pointerChip.layer.position = s.realInput ? CGPoint(x: 24, y: 26) : CGPoint(x: 14, y: 20)
            l.pointer.isHidden = false
        } else {
            l.pointer.isHidden = true
        }

        if case .caret(let rect) = s.spot, contains(d, CGPoint(x: rect.minX, y: rect.midY)) {
            l.caret.position = local(rect.origin, on: d)
            l.caretBar.frame = CGRect(origin: .zero, size: rect.size)
            l.caretBar.backgroundColor = color
            l.caretChip.set(chip, color: color)
            // Below the line, so it does not cover the text going in.
            l.caretChip.layer.position = CGPoint(x: rect.width + 2, y: rect.height + 2)
            l.caret.isHidden = false
        } else {
            l.caret.isHidden = true
        }
        l.press.strokeColor = color
    }

    /// The bar on the main display: a dot per live marker, how many there
    /// are, and the stop chord.
    private func drawBar(on d: Display, primary: Bool, live: [State]) {
        guard primary else {
            d.bar.isHidden = true
            return
        }
        if !live.allSatisfy(\.fading) {
            d.bar.removeAnimation(forKey: "opacity")
            d.bar.opacity = 1
        }
        let dots = Array(live.prefix(barMaxDots))
        while d.barDots.count < dots.count {
            let dot = CAShapeLayer()
            dot.path = CGPath(ellipseIn: CGRect(x: 0, y: 0, width: 8, height: 8), transform: nil)
            dot.contentsScale = d.scale
            d.bar.addSublayer(dot)
            d.barDots.append(dot)
        }
        var x: CGFloat = 12
        for (i, dot) in d.barDots.enumerated() {
            guard i < dots.count else {
                dot.isHidden = true
                continue
            }
            dot.fillColor = dots[i].marker.color.cg()
            dot.frame = CGRect(x: x, y: (barHeight - 8) / 2, width: 8, height: 8)
            dot.isHidden = false
            x += 12
        }
        x += 4
        x += setText(d.barText, agentsBarText(count: live.count), font: labelFont, color: barInk, x: x, rowHeight: barHeight) + 12
        x += setText(d.barHint, agentsBarStopHint, font: verbFont, color: barInk.copy(alpha: 0.6) ?? barInk, x: x, rowHeight: barHeight) + 14
        let menuBar = d.frame.maxY - d.visibleFrame.maxY
        d.bar.frame = CGRect(x: floor((d.frame.width - x) / 2), y: menuBar + 8, width: x, height: barHeight)
        d.bar.isHidden = false
    }

    // MARK: Displays

    /// One panel per display, rebuilt when the display set changes.
    private func ensureDisplays() {
        let screens = NSScreen.screens
        guard displays.map(\.frame) != screens.map(\.frame) else { return }
        for d in displays { d.panel.orderOut(nil) }
        shown = false
        displays = screens.map { Display(screen: $0) }
    }

    /// The bottom of the menu bar on the display holding the window's
    /// top-left corner, in global top-left coordinates: pills stay below it.
    private func topLimit(for window: CGRect) -> CGFloat {
        let corner = appKitPoint(window.origin)
        guard let d = displays.first(where: { $0.frame.contains(corner) }) ?? displays.first else { return 0 }
        return primaryHeight - d.visibleFrame.maxY
    }

    // MARK: Coordinates

    private func contains(_ d: Display, _ point: CGPoint) -> Bool {
        d.frame.contains(appKitPoint(point))
    }

    private func local(_ rect: CGRect, on d: Display) -> CGRect {
        CGRect(origin: local(rect.origin, on: d), size: rect.size)
    }

    private func local(_ point: CGPoint, on d: Display) -> CGPoint {
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
