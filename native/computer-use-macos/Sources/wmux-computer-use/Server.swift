// Request loop: NDJSON on stdin, one request at a time on the main thread.

import AppKit
import ApplicationServices
import ComputerUseCore

/// src/shared/computer/protocol.ts COMPUTER_PROTOCOL_VERSION.
let protocolVersion = 2
let idleExitSeconds: TimeInterval = 5 * 60
/// Inside the 15 s main allows getAppState, leaving room for the 2 s
/// screen-recording recheck and the capture.
let walkBudgetSeconds: TimeInterval = 8

let agentActions = [
    "capabilities", "listApps", "listWindows", "getAppState",
    "click", "setValue", "type", "pressKey", "hotkey", "scroll",
]

@MainActor
final class Server {
    private let snapshots = SnapshotStore()
    private var idleTimer: Timer?

    static var helperVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    func capabilities() -> JSON {
        [
            "actions": agentActions,
            "modes": ["ax", "vision", "both"],
            "permissions": [
                "accessibility": Permission.accessibility.granted,
                "screenRecording": Permission.screenRecording.granted,
            ],
        ]
    }

    func run(lines: AsyncStream<String>) async {
        Wire.send([
            "type": "hello",
            "protocolVersion": protocolVersion,
            "os": "darwin",
            "helperVersion": Self.helperVersion,
            "capabilities": capabilities(),
        ])
        armIdle()
        for await line in lines {
            idleTimer?.invalidate()
            await handle(line)
            armIdle()
        }
        shutdown()
    }

    private func armIdle() {
        idleTimer?.invalidate()
        idleTimer = Timer.scheduledTimer(withTimeInterval: idleExitSeconds, repeats: false) { _ in
            Wire.log("idle for \(Int(idleExitSeconds)) s; exiting")
            shutdown()
        }
    }

    private func handle(_ line: String) async {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? JSON,
              let idNumber = object["id"] as? NSNumber else {
            // An id-less line cannot be answered without desynchronising main,
            // which kills a helper that replies to an unknown id.
            Wire.log("dropping a malformed request line")
            return
        }
        let id = idNumber.intValue
        let method = object["method"] as? String ?? ""
        let params = object["params"] as? JSON ?? [:]
        do {
            let result = try await dispatch(method, params)
            Wire.send(["id": id, "ok": true, "result": result], id: id)
        } catch let error as HelperError {
            Wire.send(["id": id, "ok": false, "error": ["code": error.code, "message": error.message]], id: id)
        } catch {
            Wire.send(["id": id, "ok": false, "error": ["code": "internal", "message": String(describing: error)]], id: id)
        }
    }

    private func dispatch(_ method: String, _ p: JSON) async throws -> Any {
        switch method {
        case "capabilities":
            return capabilities()
        case "listApps":
            return Apps.listApps()
        case "listWindows":
            try await Permissions.require(.accessibility)
            return try Apps.listWindows(app: p.string("app"))
        case "resolveTarget":
            try await Permissions.require(.accessibility)
            let (app, window) = try Apps.resolveTarget(app: try p.requireString("app"), window: p.string("window"))
            return ["app": app.json, "window": window.json(appId: app.id, pid: app.pid)]
        case "getAppState":
            return try await getAppState(p)
        case "click":
            try await Permissions.require(.accessibility)
            return try await Actions.click(p, snapshots)
        case "setValue":
            try await Permissions.require(.accessibility)
            return try Actions.setValue(p, snapshots)
        case "type":
            try await Permissions.require(.accessibility)
            return try await Actions.type(p, snapshots)
        case "pressKey":
            try await Permissions.require(.accessibility)
            return try Actions.pressKey(p, snapshots)
        case "hotkey":
            try await Permissions.require(.accessibility)
            return try Actions.hotkey(p, snapshots)
        case "scroll":
            try await Permissions.require(.accessibility)
            return try await Actions.scroll(p, snapshots)
        case "releaseInput":
            return ["released": try releaseInput(p)]
        default:
            throw HelperError("action_not_supported", "unknown method \"\(method.prefix(40))\"")
        }
    }

    /// releaseInput `{keys?, modifiers?, buttons?}`: what this helper tracked,
    /// plus what main lists from the request that was cut off. With no fields
    /// at all it releases the four modifiers and three mouse buttons.
    private func releaseInput(_ p: JSON) throws -> Bool {
        func names(_ key: String) throws -> [String] {
            guard let v = p[key] else { return [] }
            guard let list = v as? [String] else { throw HelperError("invalid_argument", "\(key) must be a list of names") }
            return list
        }
        var extra = Set<HeldInput>()
        for key in try names("keys") {
            guard let code = KeyCodes.keyCode(for: key, layout: Input.shared.layoutKeyCode) else {
                throw HelperError("invalid_argument", "\"\(key.prefix(20))\" is not a canonical key name")
            }
            extra.insert(.key(code))
            // The key may have gone down on the ANSI position before a layout change.
            if let ansi = KeyCodes.keyCode(for: key) { extra.insert(.key(ansi)) }
        }
        guard let mods = KeyCodes.orderedModifiers(try names("modifiers")) else {
            throw HelperError("invalid_argument", "modifiers must be ctrl, alt, shift or meta")
        }
        extra.formUnion(mods.map { .key($0.keyCode) })
        for button in try names("buttons") {
            switch button {
            case "left": extra.insert(.mouse(Int32(CGMouseButton.left.rawValue)))
            case "right": extra.insert(.mouse(Int32(CGMouseButton.right.rawValue)))
            case "middle": extra.insert(.mouse(Int32(CGMouseButton.center.rawValue)))
            default: throw HelperError("invalid_argument", "buttons must be left, right or middle")
            }
        }
        let listed = p["keys"] != nil || p["modifiers"] != nil || p["buttons"] != nil
        // Nothing known: the modifiers and buttons only, never ordinary keys.
        if !listed { extra.formUnion(Input.modifiersAndButtons) }
        return Input.shared.releaseAll(extra: extra)
    }

    private func getAppState(_ p: JSON) async throws -> JSON {
        let mode = p.string("mode") ?? "both"
        guard ["ax", "vision", "both"].contains(mode) else {
            throw HelperError("invalid_argument", "mode must be ax, vision or both")
        }
        let maxNodes = min(max(p.int("maxNodes") ?? 800, 1), 800)
        let maxDepth = min(max(p.int("maxDepth") ?? 40, 1), 40)
        // Even vision needs AX: the window is found and addressed through it.
        try await Permissions.require(.accessibility)
        let (app, window) = try Apps.resolveTarget(app: try p.requireString("app"), window: p.string("window"))
        if Apps.enableElectronAccessibility(app) {
            // Chromium builds the tree asynchronously after the switch flips.
            try await Task.sleep(nanoseconds: 300_000_000)
        }

        let snapshotId = snapshots.nextId()
        var out: JSON = [
            "snapshotId": snapshotId,
            "app": app.json,
            "window": window.json(appId: app.id, pid: app.pid),
        ]
        var elements: [WalkedElement<AXUIElement>] = []
        if mode != "vision" {
            let appEl = AX.app(app.pid)
            var roots = [WalkRoot(node: window.element, depth: 0, parentRole: "AXApplication", clip: window.frame)]
            if let menuBar = AX.element(appEl, kAXMenuBarAttribute) {
                roots.append(WalkRoot(node: menuBar, depth: 1, parentRole: "AXApplication"))
            }
            // An open context menu hangs off the application, not the window.
            for child in AX.elements(appEl, kAXChildrenAttribute) where AX.string(child, kAXRoleAttribute) == "AXMenu" {
                roots.append(WalkRoot(node: child, depth: 1, parentRole: "AXApplication"))
            }
            let walk = walkTree(
                source: AXTreeSource(), roots: roots,
                maxNodes: maxNodes, maxDepth: maxDepth, deadline: Date().addingTimeInterval(walkBudgetSeconds)
            )
            elements = walk.elements
            var text = [renderHeader(appName: app.name, pid: app.pid, windowTitle: window.title)] + walk.lines
            if let focused = AX.element(appEl, kAXFocusedUIElementAttribute),
               let index = elements.firstIndex(where: { CFEqual($0.node, focused) }) {
                text.append("Focused: \(index)")
            }
            out["tree"] = text.joined(separator: "\n")
            out["elementCount"] = elements.count
            if walk.truncated { out["truncated"] = true }
        }

        if mode == "ax" {
            out["screenshotStatus"] = ["status": "skipped"]
        } else if try await Permissions.check(.screenRecording) {
            do {
                out["screenshot"] = try await Capture.window(window.windowID)
                out["screenshotStatus"] = ["status": "captured"]
            } catch let error as HelperError {
                out["screenshotStatus"] = ["status": "failed", "error": ["code": error.code, "message": error.message]]
            }
        } else {
            let e = Permission.screenRecording.missingError
            out["screenshotStatus"] = ["status": "failed", "error": ["code": e.code, "message": e.message]]
        }

        snapshots.add(Snapshot(
            id: snapshotId, pid: app.pid, windowID: window.windowID, window: window.element,
            elements: elements, created: Date()
        ))
        return out
    }
}

/// Releases anything held and puts back a clipboard a paste was using, then
/// exits. Safe from any thread.
func shutdown(code: Int32 = 0) -> Never {
    Input.shared.releaseAll()
    Clipboard.restoreIfUnchanged()
    exit(code)
}
