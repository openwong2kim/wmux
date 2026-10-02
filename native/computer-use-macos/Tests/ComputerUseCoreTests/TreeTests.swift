import ComputerUseCore
import CoreGraphics
import XCTest

/// A tree built in memory, standing in for AXUIElement.
final class FakeNode {
    let info: NodeInfo?
    let children: [FakeNode]
    let actions: Bool

    init(_ info: NodeInfo?, actions: Bool = false, _ children: [FakeNode] = []) {
        self.info = info
        self.children = children
        self.actions = actions
    }
}

struct FakeSource: TreeSource {
    func info(of node: FakeNode) -> NodeInfo? { node.info }
    func children(of node: FakeNode, info: NodeInfo) -> [FakeNode] { node.children }
    func hasActions(_ node: FakeNode) -> Bool { node.actions }
}

private func node(_ role: String, _ title: String? = nil, value: String? = nil, subrole: String? = nil,
                  frame: CGRect? = nil, actions: Bool = false, _ children: [FakeNode] = []) -> FakeNode {
    FakeNode(NodeInfo(role: role, subrole: subrole, title: title, value: value, frame: frame), actions: actions, children)
}

private func node(_ role: String, _ children: [FakeNode]) -> FakeNode {
    node(role, nil, children)
}

final class TreeTests: XCTestCase {
    private func walk(_ roots: [WalkRoot<FakeNode>], clip: CGRect? = nil, maxNodes: Int = 800, maxDepth: Int = 40) -> WalkResult<FakeNode> {
        walkTree(source: FakeSource(), roots: roots, clip: clip, maxNodes: maxNodes, maxDepth: maxDepth)
    }

    /// The golden shape from docs/computer-use-design.md, macOS flavour.
    func testRendersTheDesignDocShape() {
        let window = node("AXWindow", "notes.txt", [
            node("AXGroup", [  // unnamed structural group: dropped, children kept
                node("AXTextArea", value: "hello world"),
                node("AXButton", subrole: "AXCloseButton"),
            ]),
        ])
        let menuBar = node("AXMenuBar", [node("AXMenuBarItem", "File")])
        let result = walk([
            WalkRoot(node: window, depth: 0, parentRole: "AXApplication"),
            WalkRoot(node: menuBar, depth: 1, parentRole: "AXApplication"),
        ])
        let text = ([renderHeader(appName: "TextEdit", pid: 4812, windowTitle: "notes.txt")] + result.lines + ["Focused: 1"])
            .joined(separator: "\n")
        XCTAssertEqual(text, """
        App: TextEdit (pid 4812) · Window: "notes.txt"
        0 window notes.txt
        \t1 text area, Value: hello world
        \t2 button Close
        \t3 menu bar
        \t\t4 menu bar item File
        Focused: 1
        """)
        XCTAssertFalse(result.truncated)
        XCTAssertEqual(result.elements.count, 5)
        XCTAssertEqual(result.elements[1].identity.parentRole, "AXGroup")
        XCTAssertEqual(result.elements[3].identity.parentRole, "AXApplication")
    }

    func testRoleHumanising() {
        XCTAssertEqual(humanizeRole("AXPopUpButton"), "pop up button")
        XCTAssertEqual(humanizeRole("AXStaticText"), "text")
        XCTAssertEqual(humanizeRole("AXTextField", subrole: "AXSearchField"), "search field")
        XCTAssertEqual(humanizeRole("AXRadioButton", subrole: "AXTabButton"), "tab")
        XCTAssertEqual(humanizeRole("AXCheckBox", subrole: "AXSwitch"), "switch")
    }

    func testLineFieldsAndStates() {
        var info = NodeInfo(role: "AXCheckBox", title: "Wrap lines", description: "Wraps long lines", value: "1")
        info.enabled = false
        info.selected = true
        XCTAssertEqual(renderLine(index: 7, info: info),
                       "7 check box Wrap lines, Value: 1, Description: Wraps long lines, State: disabled selected")
        // Static text: the text is the name, not a value.
        XCTAssertEqual(renderLine(index: 2, info: NodeInfo(role: "AXStaticText", value: "Saved")), "2 text Saved")
        // Name falls back to the description; it is not repeated.
        XCTAssertEqual(renderLine(index: 3, info: NodeInfo(role: "AXButton", description: "Share")), "3 button Share")
        XCTAssertEqual(renderLine(index: 4, info: NodeInfo(role: "AXGroup")), "4 group")
    }

    func testPasswordsAreRedacted() {
        XCTAssertEqual(
            renderLine(index: 1, info: NodeInfo(role: "AXTextField", subrole: "AXSecureTextField", title: "Account", value: "hunter2")),
            "1 secure text field Account, Value: [redacted]"
        )
        XCTAssertEqual(
            renderLine(index: 2, info: NodeInfo(role: "AXTextField", title: "Verification code", value: "123456")),
            "2 text field Verification code, Value: [redacted]"
        )
        XCTAssertEqual(
            renderLine(index: 3, info: NodeInfo(role: "AXTextField", title: "Spinner speed", value: "3")),
            "3 text field Spinner speed, Value: 3"
        )
        for label in ["비밀번호", "パスワード", "Mot de passe", "Kennwort"] {
            XCTAssertTrue(isSensitive(subrole: nil, name: label), label)
        }
        XCTAssertFalse(isSensitive(subrole: nil, name: "Search"))
    }

    func testPreviewCollapsesWhitespaceAndCaps() {
        XCTAssertEqual(preview("a\n\tb   c"), "a b c")
        let long = String(repeating: "x", count: 200)
        XCTAssertEqual(preview(long), String(repeating: "x", count: 120) + "…")
    }

    func testPrunesEmptyStructureButKeepsActionableAndNamed() {
        let root = node("AXWindow", "W", [
            node("AXGroup"),  // empty, no actions: dropped
            node("AXGroup", actions: true),  // actionable: kept
            node("AXGroup", "Sidebar"),  // named: kept
            node("AXStaticText", value: ""),  // empty text: dropped
            node("AXImage"),  // unnamed image: dropped
        ])
        let lines = walk([WalkRoot(node: root, depth: 0, parentRole: "AXApplication")]).lines
        XCTAssertEqual(lines, ["0 window W", "\t1 group", "\t2 group Sidebar"])
    }

    func testSkipsOffScreenSubtrees() {
        let clip = CGRect(x: 0, y: 0, width: 100, height: 100)
        let root = node("AXWindow", "W", frame: clip, [
            node("AXRow", "visible", frame: CGRect(x: 0, y: 10, width: 100, height: 20)),
            node("AXRow", "below", frame: CGRect(x: 0, y: 500, width: 100, height: 20), [node("AXButton", "inner")]),
            node("AXButton", "no frame"),
        ])
        let lines = walk([WalkRoot(node: root, depth: 0, parentRole: "AXApplication")], clip: clip).lines
        XCTAssertEqual(lines, ["0 window W", "\t1 row visible", "\t2 button no frame"])
    }

    func testNodeCapTruncates() {
        let root = node("AXWindow", "W", (0..<10).map { node("AXButton", "b\($0)") })
        let result = walk([WalkRoot(node: root, depth: 0, parentRole: "AXApplication")], maxNodes: 4)
        XCTAssertEqual(result.elements.count, 4)
        XCTAssertTrue(result.truncated)
    }

    func testDepthCapTruncates() {
        var leaf = node("AXButton", "deep")
        for _ in 0..<5 { leaf = node("AXGroup", [leaf]) }
        let root = node("AXWindow", "W", [leaf])
        let result = walk([WalkRoot(node: root, depth: 0, parentRole: "AXApplication")], maxDepth: 3)
        XCTAssertEqual(result.lines, ["0 window W"])
        XCTAssertTrue(result.truncated)
    }

    func testVanishedElementsAreSkipped() {
        let root = node("AXWindow", "W", [FakeNode(nil), node("AXButton", "ok")])
        XCTAssertEqual(walk([WalkRoot(node: root, depth: 0, parentRole: "AXApplication")]).lines, ["0 window W", "\t1 button ok"])
    }

    func testScaleMatchesTheSharedFormula() {
        XCTAssertEqual(screenshotScale(width: 800, height: 600), 1)
        XCTAssertEqual(screenshotScale(width: 2560, height: 400), 0.5, accuracy: 1e-9)
        XCTAssertEqual(screenshotScale(width: 1280, height: 1280), (1_150_000.0 / (1280 * 1280)).squareRoot(), accuracy: 1e-9)
        XCTAssertEqual(screenshotScale(width: 0, height: 10), 1)
    }
}
