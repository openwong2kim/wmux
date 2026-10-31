// Private SkyLight entry points for input sent to one app, resolved at run
// time: a symbol an OS release removed turns its path off instead of failing
// to load the helper. hello reports what resolved (protocol
// HelperInputCapabilities).
//
// Adapted from Cua Driver (MIT) libs/cua-driver/rust/crates/platform-macos/src/input/skylight.rs@a9902d27

import Foundation
import ObjectiveC

enum SkyLight {
    private static let loaded: Void = {
        _ = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_GLOBAL)
    }()

    /// The symbol's address, or nil when this OS does not have it.
    private static func symbol(_ name: String) -> UnsafeMutableRawPointer? {
        _ = loaded
        return dlsym(UnsafeMutableRawPointer(bitPattern: -2), name)
    }

    private static func all(_ names: [String]) -> Bool {
        names.allSatisfy { symbol($0) != nil }
    }

    /// Pointer events posted to one process, routed to one of its windows.
    static let backgroundPointer = all(["SLEventPostToPid", "SLEventSetIntegerValueField", "CGEventSetWindowLocation"])

    /// The focus record sent to the target window's process alone, which
    /// focuses it without raising it or changing the frontmost app.
    static let focusWithoutRaise = all(["SLPSPostEventRecordTo", "SLSMainConnectionID", "SLSGetWindowOwner", "SLSGetConnectionPSN"])

    /// The authentication message Chromium needs on a key event posted to the
    /// process. The class exists on macOS 14, but its factory method only from
    /// macOS 15, so the class is asked, not just looked up.
    static let keyAuth: Bool = {
        guard all(["SLEventPostToPid", "SLEventSetAuthenticationMessage"]),
              let cls = NSClassFromString("SLSEventAuthenticationMessage") else { return false }
        return (cls as AnyObject).responds(to: NSSelectorFromString("messageWithEventRecord:pid:version:"))
    }()

    static var capabilities: JSON {
        ["backgroundPointer": backgroundPointer, "focusWithoutRaise": focusWithoutRaise, "keyAuth": keyAuth]
    }
}
