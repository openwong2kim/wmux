// Private SkyLight entry points for input sent to one app, resolved at run
// time: a symbol an OS release removed turns its path off instead of failing
// to load the helper. hello reports what resolved (protocol
// HelperInputCapabilities).
//
// Adapted from Cua Driver (MIT) libs/cua-driver/rust/crates/platform-macos/src/input/skylight.rs@a9902d27

import CoreGraphics
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
    // MARK: Calls (Background.swift). Each one is a no-op, or answers false
    // or nil, when its symbol did not resolve.

    private typealias PostToPid = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Void
    private typealias SetIntField = @convention(c) (UnsafeMutableRawPointer, UInt32, Int64) -> Void
    private typealias SetWindowLocation = @convention(c) (UnsafeMutableRawPointer, CGPoint) -> Void
    private typealias SetAuthMessage = @convention(c) (UnsafeMutableRawPointer, UnsafeMutableRawPointer) -> Void
    private typealias AuthFactory = @convention(c) (AnyClass, Selector, UnsafeMutableRawPointer, Int32, UInt32) -> UnsafeMutableRawPointer?
    private typealias PostEventRecord = @convention(c) (UnsafeRawPointer, UnsafeRawPointer) -> Int32
    private typealias MainConnection = @convention(c) () -> UInt32
    private typealias WindowOwner = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>) -> Int32
    private typealias ConnectionPSN = @convention(c) (UInt32, UnsafeMutableRawPointer) -> Int32
    private typealias ActiveSpace = @convention(c) (UInt32) -> UInt64

    private static func fn<T>(_ name: String, _: T.Type) -> T? {
        symbol(name).map { unsafeBitCast($0, to: T.self) }
    }

    private static let postToPidFn = fn("SLEventPostToPid", PostToPid.self)
    private static let setIntFieldFn = fn("SLEventSetIntegerValueField", SetIntField.self)
    private static let setWindowLocationFn = fn("CGEventSetWindowLocation", SetWindowLocation.self)
    private static let setAuthMessageFn = fn("SLEventSetAuthenticationMessage", SetAuthMessage.self)
    private static let authFactoryFn = fn("objc_msgSend", AuthFactory.self)
    private static let postEventRecordFn = fn("SLPSPostEventRecordTo", PostEventRecord.self)
    private static let mainConnectionFn = fn("SLSMainConnectionID", MainConnection.self)
    private static let windowOwnerFn = fn("SLSGetWindowOwner", WindowOwner.self)
    private static let connectionPSNFn = fn("SLSGetConnectionPSN", ConnectionPSN.self)
    private static let activeSpaceFn = fn("SLSGetActiveSpace", ActiveSpace.self)

    private static func pointer(_ e: CGEvent) -> UnsafeMutableRawPointer {
        Unmanaged.passUnretained(e).toOpaque()
    }

    static func setField(_ e: CGEvent, _ field: UInt32, _ value: Int64) {
        setIntFieldFn?(pointer(e), field, value)
    }

    /// The screen point WindowServer routes the event to inside its window.
    static func setWindowLocation(_ e: CGEvent, _ point: CGPoint) {
        setWindowLocationFn?(pointer(e), point)
    }

    /// Posts to the process. SkyLight's route is the one Chromium and Catalyst
    /// accept; the public call is the fallback. `auth` attaches the key-event
    /// authentication message (keys only, macOS 15 and later).
    static func post(_ e: CGEvent, pid: pid_t, auth: Bool) {
        let ptr = pointer(e)
        guard let postToPidFn else {
            e.postToPid(pid)
            return
        }
        if auth, keyAuth, let factory = authFactoryFn, let setAuth = setAuthMessageFn,
           let cls = NSClassFromString("SLSEventAuthenticationMessage"),
           let record = eventRecord(ptr),
           let message = factory(cls, NSSelectorFromString("messageWithEventRecord:pid:version:"), record, pid, 0) {
            setAuth(ptr, message)
        }
        postToPidFn(pid, ptr)
    }

    /// The SLSEventRecord inside a CGEvent: the first non-null pointer after
    /// the CFRuntimeBase, probed at the offsets it has had across releases.
    private static func eventRecord(_ ptr: UnsafeMutableRawPointer) -> UnsafeMutableRawPointer? {
        for offset in [24, 32, 16] {
            if let record = ptr.load(fromByteOffset: offset, as: UnsafeMutableRawPointer?.self) { return record }
        }
        return nil
    }

    /// An event record addressed to `windowID`.
    private static func record(_ windowID: CGWindowID, kind: UInt8) -> [UInt8] {
        var record = [UInt8](repeating: 0, count: 0xF8)
        record[0x04] = 0xF8
        record[0x08] = kind
        for byte in 0..<4 { record[0x3C + byte] = UInt8((windowID >> (8 * UInt32(byte))) & 0xFF) }
        return record
    }

    /// Sends event records to the process that owns `windowID`, and only to it.
    private static func send(_ records: [[UInt8]], toOwnerOf windowID: CGWindowID, settleMs: UInt32 = 0) -> Bool {
        guard let postEventRecordFn, let mainConnectionFn, let windowOwnerFn, let connectionPSNFn else { return false }
        var owner: UInt32 = 0
        guard windowOwnerFn(mainConnectionFn(), windowID, &owner) == 0, owner != 0 else { return false }
        var psn = [UInt8](repeating: 0, count: 8)
        guard connectionPSNFn(owner, &psn) == 0 else { return false }
        var ok = true
        for (n, record) in records.enumerated() {
            if n > 0, settleMs > 0 { usleep(settleMs * 1000) }
            ok = psn.withUnsafeBytes { p in record.withUnsafeBytes { r in postEventRecordFn(p.baseAddress!, r.baseAddress!) } } == 0 && ok
        }
        return ok
    }

    /// Focuses `windowID` without raising it or changing the frontmost app:
    /// the focus event record, sent to the window's process alone. The record
    /// that would take focus from the frontmost app is left out, which would
    /// stop the user's own typing.
    ///
    /// The record layout is yabai's (MIT), as Cua Driver's skylight.rs uses it.
    static func focusWithoutRaise(_ windowID: CGWindowID) -> Bool {
        var focus = record(windowID, kind: 0x0D)
        focus[0x8A] = 0x01
        return send([focus], toOwnerOf: windowID)
    }

    /// Moves key status inside one app from `current` to `target` without
    /// activating it, raising a window or touching the pointer: the defocus
    /// record for `current`, the focus record for `target`, then the make-key
    /// pair for `target`, all to that app alone, 120 ms apart. Whether the app
    /// acted on them is for the caller to read back.
    static func moveWindowKey(from current: CGWindowID?, to target: CGWindowID) -> Bool {
        var records: [[UInt8]] = []
        if let current {
            var defocus = record(current, kind: 0x0D)
            defocus[0x8A] = 0x02
            records.append(defocus)
        }
        var focus = record(target, kind: 0x0D)
        focus[0x8A] = 0x01
        records.append(focus)
        for kind: UInt8 in [0x01, 0x02] {
            var makeKey = record(target, kind: kind)
            makeKey[0x3A] = 0x10
            for i in 0x20..<0x30 { makeKey[i] = 0xFF }
            records.append(makeKey)
        }
        return send(records, toOwnerOf: target, settleMs: 120)
    }

    /// The Space the user is on, or nil when it cannot be read.
    static func activeSpace() -> UInt64? {
        guard let activeSpaceFn, let mainConnectionFn else { return nil }
        return activeSpaceFn(mainConnectionFn())
    }
}
