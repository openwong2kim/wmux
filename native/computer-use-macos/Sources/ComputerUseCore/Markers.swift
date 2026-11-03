// Agent markers: the pure rules behind each agent's overlay marker
// (Overlay.swift). Main sends `marker: {id, label, color}` with every control
// request (src/shared/computer/agentMarker.ts); a request without one (an
// older main) draws the default marker, which looks as the single overlay did.

import CoreGraphics
import Foundation

/// An sRGB colour, channels 0...1.
public struct MarkerRGB: Equatable {
    public let red: Double
    public let green: Double
    public let blue: Double

    public init(red: Double, green: Double, blue: Double) {
        self.red = red
        self.green = green
        self.blue = blue
    }
}

/// agentMarker.ts AGENT_MARKER_COLORS[0], the attention orange the single overlay used.
public let defaultMarkerColor = MarkerRGB(red: 1, green: 0x8A / 255.0, blue: 0x3D / 255.0)
/// agentMarker.ts AGENT_MARKER_INK, drawn on a marker fill.
public let markerInk = MarkerRGB(red: 0x0B / 255.0, green: 0x0C / 255.0, blue: 0x0E / 255.0)
public let defaultMarkerID = "default"
public let defaultMarkerLabel = "wmux agent"
public let markerLabelMaxCharacters = 60

/// `#RRGGBB` (either case) or nil.
public func parseMarkerColor(_ value: Any?) -> MarkerRGB? {
    guard let text = value as? String, text.count == 7, text.hasPrefix("#") else { return nil }
    let hex = text.dropFirst()
    guard hex.allSatisfy(\.isHexDigit), let n = UInt32(hex, radix: 16) else { return nil }
    return MarkerRGB(
        red: Double((n >> 16) & 0xFF) / 255.0,
        green: Double((n >> 8) & 0xFF) / 255.0,
        blue: Double(n & 0xFF) / 255.0
    )
}

/// One line of display text: control characters become spaces, runs of
/// whitespace collapse, ends are trimmed, and at most `limit` characters stay.
/// Nil when nothing is left.
public func markerText(_ value: Any?, limit: Int = markerLabelMaxCharacters) -> String? {
    guard let raw = value as? String else { return nil }
    let cleaned = raw.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : String($0) }.joined()
    let words = cleaned.split(whereSeparator: { $0.isWhitespace })
    guard !words.isEmpty else { return nil }
    let line = words.joined(separator: " ")
    guard line.count > limit else { return line }
    return String(line.prefix(limit)).trimmingCharacters(in: .whitespaces)
}

/// The agent a control request is drawn for.
public struct AgentMarker: Equatable {
    public let id: String
    public let label: String
    public let color: MarkerRGB

    public init(id: String, label: String, color: MarkerRGB) {
        self.id = id
        self.label = label
        self.color = color
    }

    public static let fallback = AgentMarker(id: defaultMarkerID, label: defaultMarkerLabel, color: defaultMarkerColor)

    /// The request's `marker`, parsed defensively: no marker or no id is the
    /// default marker; a bad colour is the default orange; an empty label is
    /// "wmux agent".
    public init(wire: Any?) {
        guard let object = wire as? [String: Any], let id = object["id"] as? String, !id.isEmpty else {
            self = .fallback
            return
        }
        self.init(
            id: id,
            label: markerText(object["label"]) ?? defaultMarkerLabel,
            color: parseMarkerColor(object["color"]) ?? defaultMarkerColor
        )
    }
}

/// The name on the chip beside the pointer or caret: the label up to its
/// first " · " ("#api-1 · Claude Code" → "#api-1").
public func markerChipLabel(_ label: String) -> String {
    guard let cut = label.range(of: " · ") else { return label }
    let head = label[..<cut.lowerBound].trimmingCharacters(in: .whitespaces)
    return head.isEmpty ? label : head
}

/// What the agent is doing, after its label in the pill.
public enum MarkerVerb: Equatable {
    case clicking
    case typing
    case settingValue
    case scrolling
    case waiting(for: String)

    var isPointer: Bool { self == .clicking || self == .scrolling }

    /// " · typing"; with real input " · using your mouse" (pointer actions)
    /// or " · using your keyboard" (keyboard actions).
    public func text(realInput: Bool) -> String {
        switch self {
        case .waiting(let holder): return " · waiting for \(holder)"
        case _ where realInput: return isPointer ? " · using your mouse" : " · using your keyboard"
        case .clicking: return " · clicking"
        case .typing: return " · typing"
        case .settingValue: return " · setting value"
        case .scrolling: return " · scrolling"
        }
    }
}

// MARK: - Halos and pills

public let haloRingWidth: CGFloat = 3
public let haloRingGap: CGFloat = 3

/// How far the outer edge of ring `index` (0 = the innermost) sits outside
/// the window's edge: each ring is 3 px wide, 3 px outside the one before.
public func haloOutset(ring index: Int) -> CGFloat {
    haloRingWidth + CGFloat(max(0, index)) * (haloRingWidth + haloRingGap)
}

/// A marker on a window, and when it arrived there.
public struct MarkerPlacement: Equatable {
    public let id: String
    public let window: String
    public let arrival: Int

    public init(id: String, window: String, arrival: Int) {
        self.id = id
        self.window = window
        self.arrival = arrival
    }
}

/// The markers on each window, in the order they arrived on it: the first
/// one draws the innermost ring and the leftmost pill.
public func markersByWindow(_ placements: [MarkerPlacement]) -> [String: [String]] {
    Dictionary(grouping: placements, by: \.window).mapValues { group in
        group.sorted { ($0.arrival, $0.id) < ($1.arrival, $1.id) }.map(\.id)
    }
}

/// Each pill's row (0 = nearest the window) and x offset within it: side by
/// side while they fit in `rowWidth`, then on a new row, so a window's pills
/// stay over that window and never run into a neighbouring window's pills.
/// A pill wider than the row still gets a row of its own.
public func pillGrid(widths: [CGFloat], gap: CGFloat, rowWidth: CGFloat) -> [(row: Int, x: CGFloat)] {
    var x: CGFloat = 0
    var row = 0
    return widths.map { width in
        if x > 0, x + width > rowWidth {
            row += 1
            x = 0
        }
        defer { x += width + gap }
        return (row, x)
    }
}

/// Where a window's first row of pills starts: above its top-left corner,
/// outside its outermost ring, with `rows - 1` more rows stacked upward; or
/// inside the window's top-left corner, rows stacked downward, when they do
/// not all fit above it below `topLimit` (the menu bar).
public func pillRowOrigin(window: CGRect, outset: CGFloat, pillHeight: CGFloat, lift: CGFloat, topLimit: CGFloat,
                          rows: Int = 1, rowGap: CGFloat = 0) -> CGPoint {
    let above = window.minY - outset - lift - pillHeight
    let topRow = above - CGFloat(max(0, rows - 1)) * (pillHeight + rowGap)
    if topRow >= topLimit { return CGPoint(x: window.minX - outset, y: above) }
    return CGPoint(x: window.minX + 8, y: max(window.minY, topLimit) + 8)
}

// MARK: - Global bar

public let agentsBarStopHint = "Stop all ⌃⌥⇧Esc"

public func agentsBarText(count: Int) -> String {
    count == 1 ? "1 wmux agent is using apps" : "\(count) wmux agents are using apps"
}

// MARK: - Caret

/// The caret drawn for a keyboard action, 2 px wide. `insertionLine` is what
/// AX reported for the insertion point (its x is the caret, its height the
/// line's): used when it is finite, a line's height and on the window.
/// Otherwise the leading edge of the element's frame, inset as the text in a
/// field is, no taller than a line. Nil without either.
public func caretRect(insertionLine: CGRect?, elementFrame: CGRect?, window: CGRect?) -> CGRect? {
    if let line = insertionLine,
       [line.minX, line.minY, line.width, line.height].allSatisfy(\.isFinite),
       line.height >= 4, line.height <= 200,
       window.map({ $0.insetBy(dx: -4, dy: -4).contains(CGPoint(x: line.minX, y: line.midY)) }) ?? true {
        return CGRect(x: line.minX - 1, y: line.minY, width: 2, height: line.height)
    }
    guard let frame = elementFrame,
          [frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite),
          frame.width > 0, frame.height > 0 else { return nil }
    let height = min(frame.height, 22)
    // A one-line field: centred; a text area: its first line.
    let y = frame.height <= 40 ? frame.midY - height / 2 : frame.minY + 6
    return CGRect(x: frame.minX + min(6, frame.width / 2), y: y, width: 2, height: height)
}
