// Synthetic input: CGEvents from a private event source, with the exact flags
// set on every event so a Cmd or Shift the person is physically holding never
// merges into an agent's keystroke (and vice versa).
//
// Held input: every key-down and mouse button-down is recorded before
// it is posted and cleared after its up event. A batch always sends its ups
// (defer), even when it fails part-way. On stdin EOF and SIGTERM, `releaseAll`
// releases what this process holds (and what a dead helper recorded in its
// small per-pid state file). `releaseInput` adds the keys, modifiers and
// buttons main lists from the request that was cut off; with nothing listed,
// it releases the modifiers and mouse buttons only.

import AppKit
import Carbon.HIToolbox
import ComputerUseCore
import CoreGraphics
import Foundation

enum HeldInput: Hashable, Codable {
    case key(CGKeyCode)
    case mouse(Int32)  // CGMouseButton raw value
}

final class Input: @unchecked Sendable {
    static let shared = Input()

    private let lock = NSLock()
    private var held = Set<HeldInput>()
    private let source: CGEventSource? = {
        let src = CGEventSource(stateID: .privateState)
        // The default 0.25 s would swallow the person's own mouse and keys
        // after every synthetic event.
        src?.localEventsSuppressionInterval = 0
        return src
    }()

    /// One small file per helper pid, so two helpers (two wmux instances)
    /// never overwrite each other's record.
    private static let stateDir: URL = FileManager.default.temporaryDirectory
        .appendingPathComponent("com.electron.wmux.computer-use.held", isDirectory: true)

    private static func stateFile(_ pid: pid_t) -> URL {
        stateDir.appendingPathComponent("\(pid).json")
    }

    // MARK: Held-state bookkeeping

    private func setHeld(_ input: HeldInput, _ down: Bool) {
        lock.lock()
        if down { held.insert(input) } else { held.remove(input) }
        let snapshot = held
        lock.unlock()
        // Only modifiers and buttons stay down across a batch; a plain key's
        // down and up are back to back, so a file write per keystroke buys nothing.
        if case .key(let code) = input, !KeyCodes.modifiers.contains(where: { $0.keyCode == code }) { return }
        persist(snapshot)
    }

    private func persist(_ snapshot: Set<HeldInput>) {
        let file = Self.stateFile(getpid())
        let lasting = snapshot.filter {
            if case .key(let code) = $0 { return KeyCodes.modifiers.contains { $0.keyCode == code } }
            return true
        }
        if lasting.isEmpty {
            try? FileManager.default.removeItem(at: file)
            return
        }
        try? FileManager.default.createDirectory(at: Self.stateDir, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(Array(lasting)) {
            try? data.write(to: file, options: .atomic)
        }
    }

    /// Records left by this process or by helpers that are no longer running.
    private static func orphanedState() -> [(URL, [HeldInput])] {
        let files = (try? FileManager.default.contentsOfDirectory(at: stateDir, includingPropertiesForKeys: nil)) ?? []
        return files.compactMap { file in
            guard let pid = pid_t(file.deletingPathExtension().lastPathComponent),
                  pid == getpid() || kill(pid, 0) != 0,
                  let data = try? Data(contentsOf: file),
                  let held = try? JSONDecoder().decode([HeldInput].self, from: data) else { return nil }
            return (file, held)
        }
    }

    /// Releases what this helper holds, what a dead helper recorded in the
    /// state file, and `extra`. Returns true when every up event was posted.
    /// Thread-safe: the SIGTERM handler calls it off the main thread.
    @discardableResult
    func releaseAll(extra: Set<HeldInput> = []) -> Bool {
        lock.lock()
        var toRelease = held.union(extra)
        held.removeAll()
        lock.unlock()
        let orphaned = Self.orphanedState()
        for (_, entries) in orphaned { toRelease.formUnion(entries) }
        let location = CGEvent(source: nil)?.location ?? .zero
        var ok = true
        for input in toRelease {
            switch input {
            case .key(let code):
                ok = post(keyboard: code, down: false, flags: []) && ok
            case .mouse(let raw):
                let button = CGMouseButton(rawValue: UInt32(raw)) ?? .left
                ok = post(mouse: Self.upType(button), at: location, button: button, flags: [], clickState: 1) && ok
            }
        }
        // Our record and dead helpers' are settled; a live sibling keeps its own.
        for (file, _) in orphaned { try? FileManager.default.removeItem(at: file) }
        try? FileManager.default.removeItem(at: Self.stateFile(getpid()))
        return ok
    }

    /// The four modifiers and three mouse buttons: what releaseInput releases
    /// when main lists nothing. Never plain keys — a stray key-up
    /// reaches keyup handlers in whatever app is in front.
    static let modifiersAndButtons: Set<HeldInput> = Set(KeyCodes.modifiers.map { .key($0.keyCode) })
        .union([CGMouseButton.left, .right, .center].map { .mouse(Int32($0.rawValue)) })

    // MARK: Posting

    @discardableResult
    private func post(keyboard code: CGKeyCode, down: Bool, flags: CGEventFlags) -> Bool {
        guard let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { return false }
        e.flags = flags
        e.post(tap: .cghidEventTap)
        return true
    }

    @discardableResult
    private func post(mouse type: CGEventType, at point: CGPoint, button: CGMouseButton, flags: CGEventFlags, clickState: Int64) -> Bool {
        guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return false }
        e.flags = flags
        e.setIntegerValueField(.mouseEventClickState, value: clickState)
        e.post(tap: .cghidEventTap)
        return true
    }

    private static func downType(_ b: CGMouseButton) -> CGEventType {
        switch b {
        case .left: return .leftMouseDown
        case .right: return .rightMouseDown
        default: return .otherMouseDown
        }
    }

    private static func upType(_ b: CGMouseButton) -> CGEventType {
        switch b {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        default: return .otherMouseUp
        }
    }

    /// Presses `mods` (in protocol order), runs `body` with their combined
    /// flags, and releases them in reverse — always, even if `body` throws.
    func withModifiers<T>(_ mods: [KeyCodes.ModifierKey], _ body: (CGEventFlags) throws -> T) rethrows -> T {
        var flags: CGEventFlags = []
        var pressed: [KeyCodes.ModifierKey] = []
        defer {
            for mod in pressed.reversed() {
                flags.remove(mod.flag)
                post(keyboard: mod.keyCode, down: false, flags: flags)
                setHeld(.key(mod.keyCode), false)
            }
        }
        for mod in mods {
            setHeld(.key(mod.keyCode), true)
            flags.insert(mod.flag)
            post(keyboard: mod.keyCode, down: true, flags: flags)
            pressed.append(mod)
        }
        return try body(flags)
    }

    func tap(key code: CGKeyCode, flags: CGEventFlags) {
        setHeld(.key(code), true)
        post(keyboard: code, down: true, flags: flags)
        post(keyboard: code, down: false, flags: flags)
        setHeld(.key(code), false)
    }

    /// Types one string through the Unicode payload of a key event (bypasses
    /// the layout; an IME is bypassed too, so this suits ASCII and precomposed
    /// text). Newline and tab go as real Return / Tab keys.
    /// `shouldContinue` runs before each character; typing stops when it
    /// says no. Returns how many characters were typed.
    func typeUnicode(_ text: String, shouldContinue: () -> Bool) -> Int {
        var typed = 0
        for ch in text {
            guard shouldContinue() else { return typed }
            if ch == "\n" || ch == "\r\n" || ch == "\r" {
                tap(key: CGKeyCode(kVK_Return), flags: [])
            } else if ch == "\t" {
                tap(key: CGKeyCode(kVK_Tab), flags: [])
            } else {
                let units = Array(String(ch).utf16)
                setHeld(.key(0), true)
                for down in [true, false] {
                    guard let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
                    e.flags = []
                    e.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                    e.post(tap: .cghidEventTap)
                }
                setHeld(.key(0), false)
            }
            typed += 1
            usleep(2_000)
        }
        return typed
    }

    func click(at point: CGPoint, button: CGMouseButton, count: Int, flags: CGEventFlags) {
        if let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
            move.flags = flags
            move.post(tap: .cghidEventTap)
        }
        for n in 1...max(1, count) {
            setHeld(.mouse(Int32(button.rawValue)), true)
            post(mouse: Self.downType(button), at: point, button: button, flags: flags, clickState: Int64(n))
            post(mouse: Self.upType(button), at: point, button: button, flags: flags, clickState: Int64(n))
            setHeld(.mouse(Int32(button.rawValue)), false)
        }
    }

    func scroll(at point: CGPoint, dx: Int32, dy: Int32, notches: Int) {
        if let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
            move.flags = []
            move.post(tap: .cghidEventTap)
        }
        for _ in 0..<max(1, notches) {
            guard let e = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { continue }
            e.flags = []
            e.location = point
            e.post(tap: .cghidEventTap)
            usleep(8_000)
        }
    }

    // MARK: Layout

    /// Character → key code on the current ASCII-capable layout, rebuilt
    /// when the person switches layouts (a stale map would send the wrong
    /// shortcut).
    private var layoutMap: [Character: CGKeyCode] = [:]
    private var layoutID: String?

    func layoutKeyCode(for ch: Character) -> CGKeyCode? {
        guard let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue() else { return nil }
        let id = TISGetInputSourceProperty(source, kTISPropertyInputSourceID)
            .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String }
        lock.lock()
        defer { lock.unlock() }
        if id != layoutID || layoutMap.isEmpty {
            layoutMap = Self.buildLayoutMap(source)
            layoutID = id
        }
        return layoutMap[ch]
    }

    private static func buildLayoutMap(_ source: TISInputSource) -> [Character: CGKeyCode] {
        guard let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return [:] }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
        var map: [Character: CGKeyCode] = [:]
        data.withUnsafeBytes { bytes in
            guard let layout = bytes.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
            for code in 0..<128 {
                var dead: UInt32 = 0
                var chars = [UniChar](repeating: 0, count: 4)
                var length = 0
                let rc = UCKeyTranslate(
                    layout, UInt16(code), UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()),
                    OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, chars.count, &length, &chars
                )
                guard rc == noErr, length == 1, let scalar = Unicode.Scalar(chars[0]) else { continue }
                let ch = Character(scalar)
                // Keypad keys type digits too; keep the first (main-row) key.
                if map[ch] == nil { map[ch] = CGKeyCode(code) }
            }
        }
        return map
    }
}
