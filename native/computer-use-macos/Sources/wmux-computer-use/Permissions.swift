// TCC checks. Runtime calls never prompt: a missing grant is reported as
// `permission_missing` with the System Settings deep link, and the person
// grants it there. `--request-permissions` (onboarding, run on an explicit
// user action) is the only path that shows the system prompts.

import ApplicationServices
import CoreGraphics
import Foundation

enum Permission {
    case accessibility
    case screenRecording

    var settingsURL: String {
        switch self {
        case .accessibility: return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        case .screenRecording: return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
    }

    var paneName: String {
        switch self {
        case .accessibility: return "Accessibility"
        case .screenRecording: return "Screen & System Audio Recording"
        }
    }

    /// One check, no prompt, read again on every call. Posting input needs
    /// Accessibility as well, which AXIsProcessTrusted covers;
    /// CGPreflightPostEventAccess is checked too so a partial grant is not
    /// reported as working.
    var granted: Bool {
        switch self {
        case .accessibility: return AXIsProcessTrusted() && CGPreflightPostEventAccess()
        case .screenRecording: return CGPreflightScreenCaptureAccess() || Self.windowTitlesReadable()
        }
    }

    /// CGPreflightScreenCaptureAccess can keep answering false for the rest of
    /// the process after a grant. The window list is read live: without the
    /// grant it withholds the titles of other apps' windows, so one titled
    /// normal window of another process means the grant is there.
    private static func windowTitlesReadable() -> Bool {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return false
        }
        let me = getpid()
        return list.contains { info in
            let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? me
            let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
            let title = info[kCGWindowName as String] as? String
            return pid != me && layer == 0 && !(title ?? "").isEmpty
        }
    }

    var missingError: HelperError {
        HelperError(
            "permission_missing",
            "macOS has not granted \(paneName) to \"wmux Computer Use\". Open System Settings › Privacy & Security › \(paneName) (\(settingsURL)) and turn on \"wmux Computer Use\"."
        )
    }
}

enum Permissions {
    /// A grant can read as denied for about 2 s after the person gives it, so a
    /// `false` is re-checked every 100 ms for up to 2 s before it is reported.
    static func require(_ permission: Permission) async throws {
        if try await check(permission) { return }
        throw permission.missingError
    }

    static func check(_ permission: Permission) async throws -> Bool {
        if permission.granted { return true }
        for _ in 0..<20 {
            try await Task.sleep(nanoseconds: 100_000_000)
            if permission.granted { return true }
        }
        return false
    }

    /// Onboarding only (`--request-permissions`): shows the system prompts,
    /// which add the helper to both Settings lists.
    static func requestInteractively() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        _ = CGRequestPostEventAccess()
        _ = CGRequestScreenCaptureAccess()
    }
}

enum Session {
    /// While the screen is locked, AX reports no windows for any app and the
    /// lock screen owns the keyboard: nothing may be observed or driven.
    static var isLocked: Bool {
        guard let info = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        return (info["CGSSessionScreenIsLocked"] as? Bool) == true
    }

    static func requireUnlocked() throws {
        if isLocked {
            throw HelperError(
                "window_not_focused",
                "the screen is locked; macOS hides every window until the person unlocks it. Nothing was read or sent"
            )
        }
    }
}
