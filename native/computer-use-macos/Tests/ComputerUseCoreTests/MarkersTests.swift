import ComputerUseCore
import CoreGraphics
import XCTest

final class MarkersTests: XCTestCase {
    func testParsesHexColours() {
        XCTAssertEqual(parseMarkerColor("#5AA2FF"), MarkerRGB(red: 0x5A / 255.0, green: 0xA2 / 255.0, blue: 1))
        XCTAssertEqual(parseMarkerColor("#ff8a3d"), defaultMarkerColor)
        for bad: Any? in ["5AA2FF", "#5AA2F", "#5AA2FFF", "#GGGGGG", "#+1A2B3", "", 0x5AA2FF, nil] {
            XCTAssertNil(parseMarkerColor(bad), "\(String(describing: bad))")
        }
    }

    func testMarkerFromWire() {
        let m = AgentMarker(wire: ["id": "a1", "label": "  #api-1 · Claude Code ", "color": "#2FD4C0"])
        XCTAssertEqual(m.id, "a1")
        XCTAssertEqual(m.label, "#api-1 · Claude Code")
        XCTAssertEqual(m.color, parseMarkerColor("#2FD4C0"))
    }

    func testMarkerFallsBackFieldByField() {
        // No marker, or no id: the default marker, as an older main gets.
        XCTAssertEqual(AgentMarker(wire: nil), .fallback)
        XCTAssertEqual(AgentMarker(wire: ["label": "x", "color": "#2FD4C0"]), .fallback)
        XCTAssertEqual(AgentMarker(wire: ["id": ""]), .fallback)
        XCTAssertEqual(AgentMarker(wire: "a1"), .fallback)
        // A bad colour or label keeps the id.
        let m = AgentMarker(wire: ["id": "a1", "label": " \n ", "color": "red"])
        XCTAssertEqual(m, AgentMarker(id: "a1", label: defaultMarkerLabel, color: defaultMarkerColor))
    }

    func testLabelIsOneLineOfAtMostSixtyCharacters() {
        XCTAssertEqual(markerText("a\nb\t\u{7}c   d"), "a b c d")
        let long = String(repeating: "가", count: 80)
        XCTAssertEqual(markerText(long)?.count, markerLabelMaxCharacters)
        // A cut that ends on a space does not leave it at the end.
        XCTAssertEqual(markerText(String(repeating: "a", count: 59) + " bcd"), String(repeating: "a", count: 59))
        XCTAssertNil(markerText("   "))
        XCTAssertNil(markerText(42))
    }

    func testChipLabelIsTheLabelUpToTheFirstSeparator() {
        XCTAssertEqual(markerChipLabel("#api-1 · Claude Code"), "#api-1")
        XCTAssertEqual(markerChipLabel("web · Codex · extra"), "web")
        XCTAssertEqual(markerChipLabel("wmux agent"), "wmux agent")
        XCTAssertEqual(markerChipLabel(" · Codex"), " · Codex")
    }

    func testVerbs() {
        XCTAssertEqual(MarkerVerb.typing.text(realInput: false), " · typing")
        XCTAssertEqual(MarkerVerb.clicking.text(realInput: false), " · clicking")
        XCTAssertEqual(MarkerVerb.settingValue.text(realInput: false), " · setting value")
        XCTAssertEqual(MarkerVerb.scrolling.text(realInput: false), " · scrolling")
        XCTAssertEqual(MarkerVerb.clicking.text(realInput: true), " · using your mouse")
        XCTAssertEqual(MarkerVerb.scrolling.text(realInput: true), " · using your mouse")
        XCTAssertEqual(MarkerVerb.typing.text(realInput: true), " · using your keyboard")
        XCTAssertEqual(MarkerVerb.waiting(for: "#web-2").text(realInput: true), " · waiting for #web-2")
    }

    func testHalosStackOutwardInArrivalOrder() {
        XCTAssertEqual(haloOutset(ring: 0), 3)
        // The second ring starts 3 px outside the first and is 3 px wide.
        XCTAssertEqual(haloOutset(ring: 1), 9)
        XCTAssertEqual(haloOutset(ring: 2), 15)
        let byWindow = markersByWindow([
            MarkerPlacement(id: "b", window: "7", arrival: 5),
            MarkerPlacement(id: "a", window: "7", arrival: 2),
            MarkerPlacement(id: "c", window: "9", arrival: 1),
            MarkerPlacement(id: "d", window: "7", arrival: 9),
        ])
        XCTAssertEqual(byWindow, ["7": ["a", "b", "d"], "9": ["c"]])
    }

    func testPillsSitSideBySideThenWrapWithinTheWindow() {
        let place = { (widths: [CGFloat], rowWidth: CGFloat) in
            pillGrid(widths: widths, gap: 6, rowWidth: rowWidth).map { "\($0.row):\(Int($0.x))" }
        }
        XCTAssertEqual(place([100, 80, 120], 400), ["0:0", "0:106", "0:192"])
        // Too wide for one row over a 300 px window: the third pill starts a new row.
        XCTAssertEqual(place([100, 80, 120], 300), ["0:0", "0:106", "1:0"])
        // A pill wider than the window still gets its own row; nothing is dropped.
        XCTAssertEqual(place([420, 90], 300), ["0:0", "1:0"])
        XCTAssertEqual(place([], 300), [])
    }

    func testPillRowAboveTheWindowOrInsideBelowTheMenuBar() {
        let window = CGRect(x: 200, y: 300, width: 800, height: 600)
        // Above the outermost ring, aligned with its left edge.
        XCTAssertEqual(pillRowOrigin(window: window, outset: 9, pillHeight: 24, lift: 4, topLimit: 25), CGPoint(x: 191, y: 263))
        // A window right under the menu bar: inside its top-left corner.
        let top = CGRect(x: 0, y: 25, width: 800, height: 600)
        XCTAssertEqual(pillRowOrigin(window: top, outset: 3, pillHeight: 24, lift: 4, topLimit: 25), CGPoint(x: 8, y: 33))
        // Partly under the menu bar: still below it.
        let under = CGRect(x: 0, y: 10, width: 800, height: 600)
        XCTAssertEqual(pillRowOrigin(window: under, outset: 3, pillHeight: 24, lift: 4, topLimit: 25), CGPoint(x: 8, y: 33))
        // Two rows fit above a window with room for them; not above one with room for only one.
        XCTAssertEqual(pillRowOrigin(window: window, outset: 9, pillHeight: 24, lift: 4, topLimit: 25, rows: 2, rowGap: 6), CGPoint(x: 191, y: 263))
        let tight = CGRect(x: 0, y: 70, width: 800, height: 600)
        XCTAssertEqual(pillRowOrigin(window: tight, outset: 3, pillHeight: 24, lift: 4, topLimit: 25), CGPoint(x: -3, y: 39))
        XCTAssertEqual(pillRowOrigin(window: tight, outset: 3, pillHeight: 24, lift: 4, topLimit: 25, rows: 2, rowGap: 6), CGPoint(x: 8, y: 78))
    }

    func testAgentsBarText() {
        XCTAssertEqual(agentsBarText(count: 1), "1 wmux agent is using apps")
        XCTAssertEqual(agentsBarText(count: 10), "10 wmux agents are using apps")
    }

    func testCaretAtTheInsertionPoint() {
        let window = CGRect(x: 100, y: 100, width: 600, height: 400)
        let line = CGRect(x: 240, y: 180, width: 0, height: 16)
        XCTAssertEqual(caretRect(insertionLine: line, elementFrame: nil, window: window), CGRect(x: 239, y: 180, width: 2, height: 16))
    }

    func testCaretFallsBackToTheElementsLeadingEdge() {
        let window = CGRect(x: 100, y: 100, width: 600, height: 400)
        let field = CGRect(x: 120, y: 150, width: 300, height: 24)
        let expected = CGRect(x: 126, y: 151, width: 2, height: 22)
        // No answer, a zero-height answer, (0,0) off the window, a non-finite answer.
        for bad: CGRect? in [nil, CGRect(x: 240, y: 180, width: 0, height: 0), CGRect(x: 0, y: 0, width: 0, height: 16),
                             CGRect(x: CGFloat.nan, y: 180, width: 0, height: 16)] {
            XCTAssertEqual(caretRect(insertionLine: bad, elementFrame: field, window: window), expected)
        }
        // A text area: its first line, not its middle.
        let area = CGRect(x: 120, y: 150, width: 300, height: 200)
        XCTAssertEqual(caretRect(insertionLine: nil, elementFrame: area, window: window), CGRect(x: 126, y: 156, width: 2, height: 22))
        XCTAssertNil(caretRect(insertionLine: nil, elementFrame: nil, window: window))
        XCTAssertNil(caretRect(insertionLine: nil, elementFrame: .zero, window: window))
    }
}
