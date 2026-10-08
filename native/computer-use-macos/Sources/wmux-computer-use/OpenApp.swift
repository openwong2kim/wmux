// openApp (optional method): launch the app if it is not running, bring it to
// the foreground, and make sure it has a window.
//
// The reopen event (kAEReopenApplication, what a Dock click sends) is
// delivered by LaunchServices: opening an app that is already running
// activates it and sends it a reopen event. The helper sends no Apple Event
// itself, because it carries no entitlements and the hardened runtime denies
// Apple Events without `com.apple.security.automation.apple-events`.

import AppKit

enum OpenApp {
    /// Inside main's 8 s default helper timeout.
    private static let totalBudget: TimeInterval = 7
    private static let launchBudget: TimeInterval = 3.5
    private static let firstWindowWait: TimeInterval = 1
    private static let reopenWindowWait: TimeInterval = 3

    static func open(_ selector: String) async throws -> JSON {
        let s = selector.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { throw HelperError("invalid_argument", "app is required") }
        let deadline = Date().addingTimeInterval(totalBudget)

        let running = try? Apps.find(s)
        let url: URL? = running == nil ? try installedApp(s) : running?.app.bundleURL
        if running?.pid == getpid() || (url.flatMap { Bundle(url: $0)?.bundleIdentifier } == Bundle.main.bundleIdentifier) {
            throw HelperError("app_blocked", "that is the computer-use helper itself")
        }

        let app: NSRunningApplication
        if let url {
            app = try await launch(url, name: running?.name ?? url.deletingPathExtension().lastPathComponent)
        } else if let running {
            // A running process with no bundle: nothing to launch, only activate.
            app = running.app
        } else {
            throw HelperError("app_not_found", "no app matches \"\(s.prefix(80))\"")
        }
        let resolved = ResolvedApp(app: app)
        _ = await waitUntil(deadline) { app.isFinishedLaunching }
        activate(app)

        var window = await waitForWindow(resolved, until: min(deadline, Date().addingTimeInterval(firstWindowWait)))
        if window == nil, let url {
            // Opening a running app again makes LaunchServices send it a reopen event.
            _ = try? await launch(url, name: resolved.name)
            window = await waitForWindow(resolved, until: min(deadline, Date().addingTimeInterval(reopenWindowWait)))
        }
        guard let window else {
            return ["app": resolved.json, "window": NSNull()]
        }
        let target = ControlTarget(pid: resolved.pid, windowID: window.id)
        await Focus.bringForward(target, window: window.element)
        let fresh = Apps.windows(of: resolved).first(where: { $0.id == window.id }) ?? window
        return ["app": resolved.json, "window": fresh.json(appId: resolved.id, pid: resolved.pid)]
    }

    /// An installed app: an absolute .app path, a bundle id, or a name in the
    /// usual application folders (file name, then the localized display name).
    static func installedApp(_ s: String) throws -> URL {
        let fm = FileManager.default
        if s.hasPrefix("/") {
            let url = URL(fileURLWithPath: s).standardizedFileURL
            var isDir: ObjCBool = false
            guard url.pathExtension.lowercased() == "app", fm.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue,
                  Bundle(url: url)?.bundleIdentifier != nil else {
                throw HelperError("app_not_found", "\(s.prefix(200)) is not an application bundle")
            }
            return url
        }
        if s.contains("."), !s.lowercased().hasSuffix(".app"), let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: s) {
            return url
        }
        let wanted = (s.lowercased().hasSuffix(".app") ? String(s.dropLast(4)) : s).lowercased()
        let dirs = [
            "/Applications", "/System/Applications", "/System/Applications/Utilities",
            fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path,
        ]
        var bundles: [URL] = []
        for dir in dirs {
            guard let items = try? fm.contentsOfDirectory(atPath: dir) else { continue }
            bundles += items.filter { $0.lowercased().hasSuffix(".app") }
                .map { URL(fileURLWithPath: dir, isDirectory: true).appendingPathComponent($0) }
        }
        if let hit = bundles.first(where: { $0.deletingPathExtension().lastPathComponent.lowercased() == wanted }) {
            return hit
        }
        func displayName(_ url: URL) -> String {
            let name = fm.displayName(atPath: url.path)
            return (name.lowercased().hasSuffix(".app") ? String(name.dropLast(4)) : name).lowercased()
        }
        if let hit = bundles.first(where: { displayName($0) == wanted }) { return hit }
        throw HelperError("app_not_found", "no running or installed app matches \"\(s.prefix(80))\"")
    }

    /// NSWorkspace.openApplication with activation, bounded by launchBudget.
    /// A launch that takes longer may still be under way: an instance of the
    /// bundle that is already running by then is used instead of failing.
    private static func launch(_ url: URL, name: String) async throws -> NSRunningApplication {
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        config.addsToRecentItems = false
        config.promptsUserIfNeeded = false
        let result: Result<NSRunningApplication, HelperError> = await withCheckedContinuation { cont in
            let once = Once()
            NSWorkspace.shared.openApplication(at: url, configuration: config) { app, error in
                once.run {
                    if let app {
                        cont.resume(returning: .success(app))
                    } else {
                        let why = error.map { ($0 as NSError).localizedDescription } ?? "unknown error"
                        cont.resume(returning: .failure(HelperError("internal", "macOS could not open \(name): \(why)")))
                    }
                }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + launchBudget) {
                once.run { cont.resume(returning: .failure(HelperError("timeout", "\(name) did not finish launching in time"))) }
            }
        }
        switch result {
        case .success(let app):
            return app
        case .failure(let error):
            if error.code == "timeout", let id = Bundle(url: url)?.bundleIdentifier,
               let app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first {
                return app
            }
            throw error
        }
    }

    /// LaunchServices' activation may be ignored for a background caller;
    /// kAXFrontmost is what reliably brings the app forward.
    private static func activate(_ app: NSRunningApplication) {
        guard app.processIdentifier != getpid() else { return }
        app.activate()
        AXUIElementSetAttributeValue(AX.app(app.processIdentifier), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    }

    private static func waitForWindow(_ app: ResolvedApp, until deadline: Date) async -> ResolvedWindow? {
        var found: ResolvedWindow?
        _ = await waitUntil(deadline) {
            found = try? Apps.window(of: app, selector: nil)
            return found != nil
        }
        return found
    }

    private static func waitUntil(_ deadline: Date, _ condition: () -> Bool) async -> Bool {
        while true {
            if condition() { return true }
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }
}

/// Runs its body once, whichever caller is first.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false

    func run(_ body: () -> Void) {
        lock.lock()
        defer { lock.unlock() }
        guard !done else { return }
        done = true
        body()
    }
}
