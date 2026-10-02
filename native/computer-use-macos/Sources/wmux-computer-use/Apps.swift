// Apps and windows: listApps, listWindows, resolveTarget.

import AppKit
import ApplicationServices

struct ResolvedApp {
    let app: NSRunningApplication
    var pid: pid_t { app.processIdentifier }
    var id: String { app.bundleIdentifier ?? "pid:\(app.processIdentifier)" }
    var name: String { app.localizedName ?? app.bundleIdentifier ?? "pid \(app.processIdentifier)" }

    var json: JSON {
        var out: JSON = [
            "id": id,
            "name": name,
            "pid": Int(pid),
            "path": app.bundleURL?.path ?? app.executableURL?.path ?? "",
        ]
        if let bundle = app.bundleIdentifier { out["bundleId"] = bundle }
        if app.isActive { out["frontmost"] = true }
        return out
    }

    /// Electron apps build their AX tree only when asked (AXManualAccessibility).
    var isElectron: Bool {
        guard let url = app.bundleURL else { return false }
        let framework = url.appendingPathComponent("Contents/Frameworks/Electron Framework.framework")
        return FileManager.default.fileExists(atPath: framework.path)
    }
}

struct ResolvedWindow {
    let element: AXUIElement
    let windowID: CGWindowID
    let title: String
    let frame: CGRect
    let focused: Bool
    let minimized: Bool

    var id: String { String(windowID) }

    func json(appId: String, pid: pid_t) -> JSON {
        var out: JSON = [
            "id": id,
            "appId": appId,
            "pid": Int(pid),
            "title": title,
            "bounds": ["x": frame.origin.x, "y": frame.origin.y, "width": frame.width, "height": frame.height],
        ]
        if focused { out["focused"] = true }
        if minimized { out["minimized"] = true }
        return out
    }
}

enum Apps {
    /// Apps a person can see: regular (Dock) apps, plus accessory apps that own a window.
    static func running() -> [NSRunningApplication] {
        NSWorkspace.shared.runningApplications.filter {
            !$0.isTerminated && $0.processIdentifier > 0 && $0.activationPolicy == .regular
        }
    }

    static func listApps() -> JSON {
        ["apps": running().map { ResolvedApp(app: $0).json }]
    }

    /// Accepts what listApps returns (`id` = bundle id or `pid:N`), a pid, or a
    /// name (case-insensitive). Several instances of one bundle prefer the
    /// frontmost one.
    static func find(_ selector: String) throws -> ResolvedApp {
        let s = selector.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { throw HelperError("invalid_argument", "app is required") }
        let all = NSWorkspace.shared.runningApplications.filter { !$0.isTerminated && $0.processIdentifier > 0 }
        let pidText = s.hasPrefix("pid:") ? String(s.dropFirst(4)) : s
        if let pid = pid_t(pidText), let app = all.first(where: { $0.processIdentifier == pid }) {
            return ResolvedApp(app: app)
        }
        let lower = s.lowercased()
        let candidates = all.filter { $0.bundleIdentifier?.lowercased() == lower }
            + all.filter { $0.localizedName?.lowercased() == lower }
            + all.filter { $0.bundleURL?.deletingPathExtension().lastPathComponent.lowercased() == lower }
        guard !candidates.isEmpty else { throw HelperError("app_not_found", "no running app matches \"\(s)\"") }
        return ResolvedApp(app: candidates.first(where: { $0.isActive }) ?? candidates[0])
    }

    static func windows(of app: ResolvedApp) -> [ResolvedWindow] {
        let appEl = AX.app(app.pid)
        let focused = AX.element(appEl, kAXFocusedWindowAttribute)
        return AX.elements(appEl, kAXWindowsAttribute).compactMap { el in
            guard let id = AX.windowID(el), let frame = AX.frame(el) else { return nil }
            return ResolvedWindow(
                element: el,
                windowID: id,
                title: AX.string(el, kAXTitleAttribute) ?? "",
                frame: frame,
                focused: focused.map { CFEqual($0, el) } ?? false,
                minimized: AX.bool(el, kAXMinimizedAttribute) ?? false
            )
        }
    }

    static func listWindows(app selector: String?) throws -> JSON {
        let apps: [ResolvedApp]
        if let selector { apps = [try find(selector)] } else { apps = running().map(ResolvedApp.init) }
        var out: [JSON] = []
        for app in apps {
            out += windows(of: app).map { $0.json(appId: app.id, pid: app.pid) }
        }
        return ["windows": out]
    }

    /// The window a selector names: its id from listWindows, else a title
    /// (exact, then substring). No selector means the focused window, then the
    /// main one, then the first one that is not minimized.
    static func window(of app: ResolvedApp, selector: String?) throws -> ResolvedWindow {
        let all = windows(of: app)
        guard !all.isEmpty else { throw HelperError("window_not_found", "\(app.name) has no windows") }
        if let selector, !selector.isEmpty {
            if let w = all.first(where: { $0.id == selector }) { return w }
            let lower = selector.lowercased()
            if let w = all.first(where: { $0.title.lowercased() == lower }) { return w }
            if let w = all.first(where: { $0.title.lowercased().contains(lower) }) { return w }
            throw HelperError("window_not_found", "\(app.name) has no window matching \"\(selector)\"")
        }
        if let w = all.first(where: { $0.focused }) { return w }
        let main = AX.element(AX.app(app.pid), kAXMainWindowAttribute)
        if let main, let w = all.first(where: { CFEqual($0.element, main) }) { return w }
        return all.first(where: { !$0.minimized }) ?? all[0]
    }

    static func resolveTarget(app selector: String, window: String?) throws -> (ResolvedApp, ResolvedWindow) {
        let app = try find(selector)
        return (app, try Apps.window(of: app, selector: window))
    }

    private static var manualAccessibilityPids = Set<pid_t>()

    /// Electron apps expose their tree only after AXManualAccessibility is set,
    /// once per process instance. Returns true when it was just turned on, so
    /// the caller can give the app a moment to build the tree.
    static func enableElectronAccessibility(_ app: ResolvedApp) -> Bool {
        guard app.isElectron, !manualAccessibilityPids.contains(app.pid) else { return false }
        manualAccessibilityPids.insert(app.pid)
        let rc = AXUIElementSetAttributeValue(AX.app(app.pid), "AXManualAccessibility" as CFString, kCFBooleanTrue)
        return rc == .success
    }
}
