// Synthetic input: CGEvents from a private event source, with the exact flags
// set on every event so a Cmd or Shift the person is physically holding never
// merges into an agent's keystroke (and vice versa).
//
// Held input: every modifier key-down and mouse button-down is recorded before
// it is posted and cleared after its up event. A batch always sends its ups
// (defer), even when it fails part-way. `releaseAll` (releaseInput, stdin EOF,
// SIGTERM) releases only what a helper pressed — this process, or a helper
// that died holding something (the record is also kept in a small file,
// keyed by pid) — never a key the person holds.

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

    private static let stateFile: URL = FileManager.default.temporaryDirectory
        .appendingPathComponent("com.electron.wmux.computer-use.held.json")

    // MARK: Held-state bookkeeping

    private func setHeld(_ input: HeldInput, _ down: Bool) {
        lock.lock()
        if down { held.insert(input) } else { held.remove(input) }
        let snapshot = held
        lock.unlock()
        persist(snapshot)
    }

    private func persist(_ snapshot: Set<HeldInput>) {
        var all = Self.readState().filter { $0.key != getpid() }
        if !snapshot.isEmpty { all[getpid()] = Array(snapshot) }
        if all.isEmpty {
            try? FileManager.default.removeItem(at: Self.stateFile)
        } else if let data = try? JSONEncoder().encode(all.map { StateEntry(pid: $0.key, held: $0.value) }) {
            try? data.write(to: Self.stateFile, options: .atomic)
        }
    }

    private struct StateEntry: Codable {
        let pid: pid_t
        let held: [HeldInput]
    }

    private static func readState() -> [pid_t: [HeldInput]] {
        guard let data = try? Data(contentsOf: stateFile),
              let entries = try? JSONDecoder().decode([StateEntry].self, from: data) else { return [:] }
        return Dictionary(entries.map { ($0.pid, $0.held) }, uniquingKeysWith: { a, _ in a })
    }

    /// Releases what this helper holds, plus what a dead helper left held.
    /// Thread-safe: the SIGTERM handler calls it off the main thread.
    @discardableResult
    func releaseAll() -> Int {
        lock.lock()
        var toRelease = held
        held.removeAll()
        lock.unlock()
        let state = Self.readState()
        for (pid, entries) in state where pid == getpid() || kill(pid, 0) != 0 {
            toRelease.formUnion(entries)
        }
        let location = CGEvent(source: nil)?.location ?? .zero
        for input in toRelease {
            switch input {
            case .key(let code):
                post(keyboard: code, down: false, flags: [])
            case .mouse(let raw):
                let button = CGMouseButton(rawValue: UInt32(raw)) ?? .left
                post(mouse: Self.upType(button), at: location, button: button, flags: [], clickState: 1)
            }
        }
        // Drop our entry and those of dead helpers; a live sibling keeps its own.
        let survivors = state.filter { $0.key != getpid() && kill($0.key, 0) == 0 }
        if survivors.isEmpty {
            try? FileManager.default.removeItem(at: Self.stateFile)
        } else if let data = try? JSONEncoder().encode(survivors.map { StateEntry(pid: $0.key, held: $0.value) }) {
            try? data.write(to: Self.stateFile, options: .atomic)
        }
        return toRelease.count
    }

    // MARK: Posting

    private func post(keyboard code: CGKeyCode, down: Bool, flags: CGEventFlags) {
        guard let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { return }
        e.flags = flags
        e.post(tap: .cghidEventTap)
    }

    private func post(mouse type: CGEventType, at point: CGPoint, button: CGMouseButton, flags: CGEventFlags, clickState: Int64) {
        guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
        e.flags = flags
        e.setIntegerValueField(.mouseEventClickState, value: clickState)
        e.post(tap: .cghidEventTap)
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
        post(keyboard: code, down: true, flags: flags)
        post(keyboard: code, down: false, flags: flags)
    }

    /// Types one string through the Unicode payload of a key event (bypasses
    /// the layout; an IME is bypassed too, so this suits ASCII and precomposed
    /// text). Newline and tab go as real Return / Tab keys.
    func typeUnicode(_ text: String) {
        for ch in text {
            if ch == "\n" || ch == "\r\n" || ch == "\r" {
                tap(key: CGKeyCode(kVK_Return), flags: [])
            } else if ch == "\t" {
                tap(key: CGKeyCode(kVK_Tab), flags: [])
            } else {
                let units = Array(String(ch).utf16)
                for down in [true, false] {
                    guard let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
                    e.flags = []
                    e.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                    e.post(tap: .cghidEventTap)
                }
            }
            usleep(2_000)
        }
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

    /// Character → key code on the current ASCII-capable layout, built once.
    private lazy var layoutMap: [Character: CGKeyCode] = Self.buildLayoutMap()

    func layoutKeyCode(for ch: Character) -> CGKeyCode? {
        lock.lock()
        defer { lock.unlock() }
        return layoutMap[ch]
    }

    private static func buildLayoutMap() -> [Character: CGKeyCode] {
        guard let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue(),
              let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return [:] }
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
