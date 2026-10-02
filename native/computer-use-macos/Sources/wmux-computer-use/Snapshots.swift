// Snapshot binding: indexes are valid only with the snapshotId they came from.
// The last 16 snapshots are kept for 2 minutes.

import ApplicationServices
import ComputerUseCore
import Foundation

let snapshotTTL: TimeInterval = 120
let snapshotCacheSize = 16

struct Snapshot {
    let id: String
    let pid: pid_t
    let windowID: CGWindowID
    let window: AXUIElement
    let elements: [WalkedElement<AXUIElement>]
    let created: Date
}

final class SnapshotStore {
    private var order: [String] = []
    private var byId: [String: Snapshot] = [:]
    private var counter = 0
    // Unique per helper process: a restarted helper must never re-issue an id
    // main still maps to the dead helper's elements.
    private let prefix = String(UInt32.random(in: 0...UInt32.max), radix: 16)

    func nextId() -> String {
        counter += 1
        return "\(prefix)-\(counter)"
    }

    func add(_ snapshot: Snapshot) {
        byId[snapshot.id] = snapshot
        order.append(snapshot.id)
        while order.count > snapshotCacheSize {
            byId.removeValue(forKey: order.removeFirst())
        }
    }

    func get(_ id: String) throws -> Snapshot {
        guard let snap = byId[id], Date().timeIntervalSince(snap.created) <= snapshotTTL else {
            throw HelperError("snapshot_unknown", "snapshot \(id) is unknown or expired")
        }
        return snap
    }
}

extension Snapshot {
    /// Re-resolves one indexed element and checks it is still the element the
    /// snapshot saw: role, subrole, title, identifier and parent role must
    /// match (value is excluded so a field still matches after typing). The
    /// whole tree is not re-walked.
    func element(at index: Int) throws -> AXUIElement {
        guard index >= 0, index < elements.count else {
            throw HelperError("element_not_found", "index \(index) is not in snapshot \(id) (0…\(elements.count - 1))")
        }
        let walked = elements[index]
        let el = walked.node
        var role: CFTypeRef?
        let rc = AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &role)
        if rc != .success {
            throw HelperError("element_stale", "element \(index) no longer exists")
        }
        var elementPid: pid_t = 0
        AXUIElementGetPid(el, &elementPid)
        let parentRole = AX.element(el, kAXParentAttribute).flatMap { AX.string($0, kAXRoleAttribute) } ?? walked.identity.parentRole
        let now = ElementIdentity(
            role: (role as? String) ?? "",
            subrole: AX.string(el, kAXSubroleAttribute),
            title: AX.string(el, kAXTitleAttribute),
            identifier: AX.string(el, kAXIdentifierAttribute),
            parentRole: parentRole
        )
        guard elementPid == pid, now == walked.identity else {
            throw HelperError("element_stale", "element \(index) changed since snapshot \(id) was taken")
        }
        return el
    }

    /// The window's current frame (it may have moved since the snapshot).
    func windowFrame() throws -> CGRect {
        guard let frame = AX.frame(window) else {
            throw HelperError("window_not_found", "the snapshot's window is gone")
        }
        return frame
    }
}
