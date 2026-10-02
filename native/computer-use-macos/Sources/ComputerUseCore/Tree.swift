// Accessibility-tree walking, pruning and rendering, independent of AX itself.
//
// The helper adapts AXUIElement to `TreeSource`; tests use a fake source. The
// text format is the one in docs/computer-use-design.md ("Observation"), with
// the macOS choices recorded in docs/computer-use-macos.md:
//
//   App: TextEdit (pid 4812) · Window: "Untitled"
//   0 window Untitled
//   	1 menu bar
//   		2 menu bar item File
//   	3 text area, Value: hello world
//   Focused: 3

import CoreGraphics
import Foundation

public let treeTextPreviewChars = 120

/// The attributes one element contributes to the tree, read in one AX round-trip.
public struct NodeInfo: Equatable {
    public var role: String
    public var subrole: String?
    public var title: String?
    public var description: String?
    public var value: String?
    public var identifier: String?
    public var enabled: Bool
    public var selected: Bool
    public var expanded: Bool
    /// Screen frame in points, when the element reports one.
    public var frame: CGRect?

    public init(
        role: String, subrole: String? = nil, title: String? = nil, description: String? = nil,
        value: String? = nil, identifier: String? = nil, enabled: Bool = true, selected: Bool = false,
        expanded: Bool = false, frame: CGRect? = nil
    ) {
        self.role = role
        self.subrole = subrole
        self.title = title
        self.description = description
        self.value = value
        self.identifier = identifier
        self.enabled = enabled
        self.selected = selected
        self.expanded = expanded
        self.frame = frame
    }
}

public protocol TreeSource {
    associatedtype Node
    /// nil when the element is gone; the walker skips it.
    func info(of node: Node) -> NodeInfo?
    func children(of node: Node, info: NodeInfo) -> [Node]
    /// Whether the element offers an action worth an index (AXPress, AXIncrement…).
    /// Only asked for nodes that would otherwise be pruned.
    func hasActions(_ node: Node) -> Bool
}

/// What a snapshot remembers to re-resolve an element before acting on it.
/// Value is deliberately absent so a text field still matches after typing.
public struct ElementIdentity: Equatable {
    public var role: String
    public var subrole: String?
    public var title: String?
    public var identifier: String?
    public var parentRole: String

    public init(role: String, subrole: String?, title: String?, identifier: String?, parentRole: String) {
        self.role = role
        self.subrole = subrole
        self.title = title
        self.identifier = identifier
        self.parentRole = parentRole
    }
}

public struct WalkRoot<Node> {
    public var node: Node
    /// Indentation of this root in the rendered text.
    public var depth: Int
    /// Role of the element's real AX parent, for its identity.
    public var parentRole: String
    /// Subtrees wholly outside this rectangle are skipped (the window frame
    /// for the window; nil for the menu bar, which lives outside it).
    public var clip: CGRect?

    public init(node: Node, depth: Int, parentRole: String, clip: CGRect? = nil) {
        self.node = node
        self.depth = depth
        self.parentRole = parentRole
        self.clip = clip
    }
}

public struct WalkedElement<Node> {
    public var node: Node
    public var identity: ElementIdentity
}

public struct WalkResult<Node> {
    public var lines: [String]
    public var elements: [WalkedElement<Node>]
    public var truncated: Bool
}

// MARK: - Classification

/// Containers that orient the reader even without a name.
let landmarkRoles: Set<String> = [
    "AXWindow", "AXSheet", "AXDrawer", "AXMenuBar", "AXMenu", "AXToolbar", "AXTabGroup",
    "AXTable", "AXOutline", "AXList", "AXBrowser", "AXWebArea", "AXPopover",
]

let interactiveRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea", "AXComboBox",
    "AXPopUpButton", "AXMenuButton", "AXMenuItem", "AXMenuBarItem", "AXSlider", "AXLink",
    "AXDisclosureTriangle", "AXIncrementor", "AXColorWell", "AXSegmentedControl", "AXRow",
    "AXCell", "AXDateField", "AXTimeField", "AXStepper", "AXSearchField", "AXDockItem",
]

let textRoles: Set<String> = ["AXStaticText", "AXHeading"]

enum Keep { case always, ifText, ifNamed, ifNamedOrActionable }

func keepRule(for role: String) -> Keep {
    if landmarkRoles.contains(role) || interactiveRoles.contains(role) { return .always }
    if textRoles.contains(role) { return .ifText }
    if role == "AXImage" { return .ifNamed }
    return .ifNamedOrActionable
}

// MARK: - Text

/// Collapses whitespace (one line per element) and caps the preview length.
public func preview(_ text: String?, limit: Int = treeTextPreviewChars) -> String {
    guard let text else { return "" }
    let collapsed = text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
    if collapsed.count <= limit { return collapsed }
    return String(collapsed.prefix(limit)) + "…"
}

/// `AXPopUpButton` → `pop up button`; subroles that change what the element
/// is (search field, switch, tab) win over the role.
public func humanizeRole(_ role: String, subrole: String? = nil) -> String {
    switch subrole {
    case "AXSearchField": return "search field"
    case "AXSecureTextField": return "secure text field"
    case "AXSwitch": return "switch"
    case "AXTabButton": return "tab"
    case "AXToggle": return "toggle button"
    case "AXOutlineRow", "AXTableRow": return "row"
    case "AXDialog", "AXSystemDialog": return "dialog"
    default: break
    }
    if role == "AXStaticText" { return "text" }
    var name = role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
    if name.isEmpty { name = role }
    var words: [String] = []
    var current = ""
    for ch in name {
        if ch.isUppercase, !current.isEmpty {
            words.append(current)
            current = ""
        }
        current.append(ch)
    }
    if !current.isEmpty { words.append(current) }
    return words.joined(separator: " ").lowercased()
}

private let sensitiveNamePattern = try! NSRegularExpression(
    pattern: #"\b(password|passcode|passphrase|pin|one[- ]time|otp|verification code|security code)\b"#,
    options: [.caseInsensitive]
)

/// Labels in other languages, matched as substrings (no word boundaries in
/// CJK). Korean, Japanese, Chinese, German, French, Spanish, Portuguese,
/// Italian, Russian.
private let sensitiveNameFragments = [
    "비밀번호", "암호", "인증번호", "パスワード", "暗証番号", "密码", "密碼", "口令", "验证码",
    "passwort", "kennwort", "mot de passe", "contraseña", "senha", "password", "пароль",
]

/// A field whose value must never reach the model: AXSecureTextField, or a
/// name that says it holds a secret.
public func isSensitive(subrole: String?, name: String) -> Bool {
    if subrole == "AXSecureTextField" { return true }
    let range = NSRange(name.startIndex..., in: name)
    if sensitiveNamePattern.firstMatch(in: name, range: range) != nil { return true }
    let lower = name.lowercased()
    return sensitiveNameFragments.contains { lower.contains($0) }
}

private let windowControlNames: [String: String] = [
    "AXCloseButton": "Close", "AXMinimizeButton": "Minimize", "AXZoomButton": "Zoom",
    "AXFullScreenButton": "Full Screen",
]

/// One rendered line, without indentation:
/// `<index> <role> <name>[, Value: …][, Description: …][, State: a b]`.
public func renderLine(index: Int, info: NodeInfo) -> String {
    let role = humanizeRole(info.role, subrole: info.subrole)
    let title = preview(info.title)
    let desc = preview(info.description)
    var name: String
    var value: String? = nil
    var description: String? = nil
    if info.role == "AXStaticText" {
        // Static text carries its text in AXValue; it is the element's name.
        name = preview(info.value)
        if name.isEmpty { name = title.isEmpty ? desc : title }
    } else {
        name = title.isEmpty ? desc : title
        if !title.isEmpty, !desc.isEmpty, desc != title { description = desc }
        if name.isEmpty, let sub = info.subrole, let fallback = windowControlNames[sub] { name = fallback }
        if isSensitive(subrole: info.subrole, name: name) {
            value = "[redacted]"
        } else {
            let v = preview(info.value)
            if !v.isEmpty, v != name { value = v }
        }
    }
    var line = "\(index) \(role)"
    if !name.isEmpty { line += " \(name)" }
    if let value { line += ", Value: \(value)" }
    if let description { line += ", Description: \(description)" }
    var states: [String] = []
    if !info.enabled { states.append("disabled") }
    if info.selected { states.append("selected") }
    if info.expanded { states.append("expanded") }
    if !states.isEmpty { line += ", State: \(states.joined(separator: " "))" }
    return line
}

public func renderHeader(appName: String, pid: Int32, windowTitle: String) -> String {
    "App: \(preview(appName)) (pid \(pid)) · Window: \"\(preview(windowTitle))\""
}

// MARK: - Walk

/// Walks `roots` depth-first and renders every kept element with an index.
///
/// - Pruned (structural) nodes get no index, but their children are kept one
///   level up.
/// - A subtree whose frame lies wholly outside its root's `clip` is skipped
///   (off-screen rows), and so is a ruler (a row of tab stops, all noise).
/// - `maxNodes` caps indexed elements, `maxDepth` the raw AX depth; hitting
///   either, or the deadline, sets `truncated`.
public func walkTree<S: TreeSource>(
    source: S,
    roots: [WalkRoot<S.Node>],
    maxNodes: Int,
    maxDepth: Int,
    deadline: Date? = nil
) -> WalkResult<S.Node> {
    var lines: [String] = []
    var elements: [WalkedElement<S.Node>] = []
    var truncated = false

    func visit(_ node: S.Node, rawDepth: Int, depth: Int, parentRole: String, clip: CGRect?) {
        if elements.count >= maxNodes || rawDepth > maxDepth {
            truncated = true
            return
        }
        if let deadline, Date() >= deadline {
            truncated = true
            return
        }
        guard let info = source.info(of: node), info.role != "AXRuler" else { return }
        if let clip, let frame = info.frame, frame.width > 0, frame.height > 0, !frame.intersects(clip) {
            return
        }
        let keep: Bool
        switch keepRule(for: info.role) {
        case .always: keep = true
        case .ifText: keep = !(info.value ?? "").isEmpty || !(info.title ?? "").isEmpty
        case .ifNamed: keep = !(info.title ?? "").isEmpty || !(info.description ?? "").isEmpty
        case .ifNamedOrActionable:
            keep = !(info.title ?? "").isEmpty || !(info.description ?? "").isEmpty
                || !(info.value ?? "").isEmpty || source.hasActions(node)
        }
        var childDepth = depth
        if keep {
            let index = elements.count
            elements.append(WalkedElement(
                node: node,
                identity: ElementIdentity(
                    role: info.role, subrole: info.subrole, title: info.title,
                    identifier: info.identifier, parentRole: parentRole
                )
            ))
            lines.append(String(repeating: "\t", count: depth) + renderLine(index: index, info: info))
            childDepth = depth + 1
        }
        for child in source.children(of: node, info: info) {
            visit(child, rawDepth: rawDepth + 1, depth: childDepth, parentRole: info.role, clip: clip)
            if truncated && elements.count >= maxNodes { return }
        }
    }

    for root in roots {
        visit(root.node, rawDepth: 0, depth: root.depth, parentRole: root.parentRole, clip: root.clip)
    }
    return WalkResult(lines: lines, elements: elements, truncated: truncated)
}
