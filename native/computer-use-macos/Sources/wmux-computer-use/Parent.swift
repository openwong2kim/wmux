// Who may drive this helper.
//
// The helper owns its own Accessibility and Screen Recording grants, and it
// does whatever its stdin says. Without a check, any process of the same user
// could exec it and drive the desktop with none of wmux's consent prompts,
// blocklist or stop key. So the helper refuses to start unless its parent —
// the process holding the other end of stdio — is wmux itself, signed by the
// wmux team.
//
// Dev builds of wmux are not signed that way, so a helper built with
// `build.sh --dev-any-parent` (compile flag WMUX_ALLOW_ANY_PARENT) skips the
// check. Release builds never pass that flag, and check-signature.sh
// --release fails a binary that carries the dev marker.

import Foundation
import Security

enum Parent {
    static let requirement =
        #"anchor apple generic and certificate leaf[subject.OU] = "8RGHH2F237" and identifier "com.electron.wmux""#

    #if WMUX_ALLOW_ANY_PARENT
    /// Found by check-signature.sh --release; must never ship.
    static let devMarker = "WMUX_COMPUTER_USE_DEV_ANY_PARENT"
    #endif

    /// Returns only when the parent may drive the helper; exits otherwise.
    static func enforce() {
        #if WMUX_ALLOW_ANY_PARENT
        Wire.log("\(devMarker): dev build, any parent process may drive this helper")
        return
        #else
        let ppid = getppid()
        if let reason = refusal(for: ppid) {
            Wire.log("refusing to run for parent pid \(ppid): \(reason)")
            exit(71)
        }
        #endif
    }

    /// Why `pid` may not drive the helper, or nil when it is signed wmux.
    static func refusal(for pid: pid_t) -> String? {
        guard pid > 1 else { return "no parent process" }
        var code: SecCode?
        let attrs = [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attrs, [], &code) == errSecSuccess, let code else {
            return "its code could not be examined"
        }
        var req: SecRequirement?
        guard SecRequirementCreateWithString(requirement as CFString, [], &req) == errSecSuccess, let req else {
            return "the requirement did not parse"
        }
        let status = SecCodeCheckValidity(code, [], req)
        return status == errSecSuccess ? nil : "it is not wmux signed by the wmux team (OSStatus \(status))"
    }
}
