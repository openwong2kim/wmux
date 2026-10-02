// Synthetic input: CGEvents from a private event source, with the exact flags
// set on every event so a Cmd or Shift the person is physically holding never
// merges into an agent's keystroke (and vice versa).
//
// Held input: every key-down and button-down is recorded (in memory and in a
// small per-pid file) before it is posted, and cleared after its up event. A
// batch always sends its ups (defer), even when it fails part-way.
// `releaseInput` releases what this helper holds, what a dead helper recorded,
// and what main lists from the request that was cut off; with nothing listed,
// the modifiers and mouse buttons only.
//
// Shutdown (stdin EOF, idle, SIGTERM) goes through one gate: posting stops
// first, under the same lock every post takes, and only then are held keys
// and buttons released — so the main thread can never post after the release.

import AppKit
import Carbon.HIToolbox
import ComputerUseCore
import CoreGraphics
import Darwin
import Foundation

struct HeldState: Codable, Equatable {
    var keys: [CGKeyCode] = []
    /// A pressed button and where it went down, so its up lands there too.
    var buttons: [HeldButton] = []

    var isEmpty: Bool { keys.isEmpty && buttons.isEmpty }
}

struct HeldButton: Codable, Hashable {
    let button: Int32
    let x: Double
    let y: Double
}

final class Input: @unchecked Sendable {
    static let shared = Input()

    /// Guards the held state, the stop flag and every post.
    private let lock = NSLock()
    private var heldKeys = Set<CGKeyCode>()
    private var heldButtons: [Int32: CGPoint] = [:]
    private var stopping = false

    private let source: CGEventSource? = {
        let src = CGEventSource(stateID: .privateState)
        // The default 0.25 s would swallow the person's own mouse and keys
        // after every synthetic event.
        src?.localEventsSuppressionInterval = 0
        return src
    }()

    // MARK: Posting (all of it goes through emit)

    /// Posts one event unless shutdown has begun. `releasing` lets the
    /// shutdown path itself through.
    @discardableResult
    private func emit(_ event: CGEvent?, releasing: Bool = false) -> Bool {
        guard let event else { return false }
        lock.lock()
        defer { lock.unlock() }
        if stopping && !releasing { return false }
        event.post(tap: .cghidEventTap)
        return true
    }

    private func keyEvent(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) -> CGEvent? {
        let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
        e?.flags = flags
        return e
    }

    private func mouseEvent(_ type: CGEventType, at point: CGPoint, button: CGMouseButton, flags: CGEventFlags, clickState: Int64) -> CGEvent? {
        let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
        e?.flags = flags
        e?.setIntegerValueField(.mouseEventClickState, value: clickState)
        return e
    }

    static func downType(_ b: CGMouseButton) -> CGEventType {
        switch b {
        case .left: return .leftMouseDown
        case .right: return .rightMouseDown
        default: return .otherMouseDown
        }
    }

    static func upType(_ b: CGMouseButton) -> CGEventType {
        switch b {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        default: return .otherMouseUp
        }
    }

    // MARK: Held-state bookkeeping

    private func keyDown(_ code: CGKeyCode, flags: CGEventFlags) -> Bool {
        lock.lock()
        heldKeys.insert(code)
        lock.unlock()
        persist()
        return emit(keyEvent(code, down: true, flags: flags))
    }

    private func keyUp(_ code: CGKeyCode, flags: CGEventFlags) {
        emit(keyEvent(code, down: false, flags: flags))
        lock.lock()
        heldKeys.remove(code)
        lock.unlock()
        persist()
    }

    private func persist() {
        lock.lock()
        let state = HeldState(
            keys: heldKeys.sorted(),
            buttons: heldButtons.map { HeldButton(button: $0.key, x: $0.value.x, y: $0.value.y) }
        )
        lock.unlock()
        HeldStore.write(state)
    }

    /// The four modifiers and three mouse buttons: what releaseInput releases
    /// when main lists nothing. Never plain keys — a stray key-up reaches
    /// keyup handlers in whatever app is in front.
    static var modifiersAndButtons: HeldState {
        HeldState(keys: KeyCodes.modifiers.map(\.keyCode), buttons: [])
    }

    /// Releases what this helper holds, what dead helpers recorded, and
    /// `extra` (buttons in `extra` go up at the cursor). Returns true when
    /// every up event was posted. `releasing` is the shutdown path.
    @discardableResult
    func releaseAll(extra: HeldState = HeldState(), extraButtons: [CGMouseButton] = [], releasing: Bool = false) -> Bool {
        lock.lock()
        var keys = heldKeys.union(extra.keys)
        var buttons = heldButtons
        heldKeys.removeAll()
        heldButtons.removeAll()
        lock.unlock()

        let orphaned = HeldStore.readOrphaned()
        for state in orphaned.map(\.state) {
            keys.formUnion(state.keys)
            for b in state.buttons where buttons[b.button] == nil { buttons[b.button] = CGPoint(x: b.x, y: b.y) }
        }
        let cursor = CGEvent(source: nil)?.location ?? .zero
        for b in extraButtons where buttons[Int32(b.rawValue)] == nil { buttons[Int32(b.rawValue)] = cursor }

        var ok = true
        for code in keys {
            ok = emit(keyEvent(code, down: false, flags: []), releasing: releasing) && ok
        }
        for (raw, point) in buttons {
            let button = CGMouseButton(rawValue: UInt32(raw)) ?? .left
            ok = emit(mouseEvent(Self.upType(button), at: point, button: button, flags: [], clickState: 1), releasing: releasing) && ok
        }
        for entry in orphaned { HeldStore.remove(entry.url) }
        HeldStore.removeOwn()
        return ok
    }

    /// Stops all posting for good (shutdown, step 1). Waits for an in-flight
    /// post, because every post holds the lock.
    func stopPosting() {
        lock.lock()
        stopping = true
        lock.unlock()
    }

    // MARK: Batches

    /// Presses `mods` (in protocol order), runs `body` with their combined
    /// flags, and releases them in reverse — always, even if `body` throws.
    func withModifiers<T>(_ mods: [KeyCodes.ModifierKey], _ body: (CGEventFlags) throws -> T) rethrows -> T {
        var flags: CGEventFlags = []
        var pressed: [KeyCodes.ModifierKey] = []
        defer {
            for mod in pressed.reversed() {
                flags.remove(mod.flag)
                keyUp(mod.keyCode, flags: flags)
            }
        }
        for mod in mods {
            flags.insert(mod.flag)
            pressed.append(mod)
            _ = keyDown(mod.keyCode, flags: flags)
        }
        return try body(flags)
    }

    func tap(key code: CGKeyCode, flags: CGEventFlags) {
        defer { keyUp(code, flags: flags) }
        _ = keyDown(code, flags: flags)
    }

    /// Types `text` as chunks of Unicode key events (each event carries a
    /// short string, so long text needs no clipboard). `shouldContinue` runs
    /// before every chunk; typing stops when it says no. Returns how many
    /// characters were typed.
    func typeUnicode(_ text: String, shouldContinue: () -> Bool) -> Int {
        var typed = 0
        for chunk in unicodeChunks(text) {
            guard shouldContinue() else { return typed }
            switch chunk {
            case .key(let name):
                if let code = KeyCodes.named[name] { tap(key: code, flags: []) }
            case .text(let s):
                let units = Array(s.utf16)
                // Virtual key 0 carries the payload; it is recorded like any key.
                lock.lock()
                heldKeys.insert(0)
                lock.unlock()
                persist()
                defer {
                    emit(unicodeEvent(units, down: false))
                    lock.lock()
                    heldKeys.remove(0)
                    lock.unlock()
                    persist()
                }
                emit(unicodeEvent(units, down: true))
            }
            typed += chunk.characterCount
            usleep(3_000)
        }
        return typed
    }

    private func unicodeEvent(_ units: [UniChar], down: Bool) -> CGEvent? {
        let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        e?.flags = []
        e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        return e
    }

    func click(at point: CGPoint, button: CGMouseButton, count: Int, flags: CGEventFlags) {
        emit(mouseEvent(.mouseMoved, at: point, button: .left, flags: flags, clickState: 0))
        for n in 1...max(1, count) {
            lock.lock()
            heldButtons[Int32(button.rawValue)] = point
            lock.unlock()
            persist()
            emit(mouseEvent(Self.downType(button), at: point, button: button, flags: flags, clickState: Int64(n)))
            emit(mouseEvent(Self.upType(button), at: point, button: button, flags: flags, clickState: Int64(n)))
            lock.lock()
            heldButtons.removeValue(forKey: Int32(button.rawValue))
            lock.unlock()
            persist()
        }
    }

    /// Scrolls one notch at a time; `shouldContinue` re-checks the target
    /// before every notch. Returns the notches sent.
    func scroll(at point: CGPoint, dx: Int32, dy: Int32, notches: Int, shouldContinue: () -> Bool) -> Int {
        emit(mouseEvent(.mouseMoved, at: point, button: .left, flags: [], clickState: 0))
        var sent = 0
        for _ in 0..<max(1, notches) {
            guard shouldContinue() else { return sent }
            let e = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
            e?.flags = []
            e?.location = point
            emit(e)
            sent += 1
            usleep(8_000)
        }
        return sent
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

// MARK: - Held-state files

/// One small file per helper pid in a private per-user directory. The files
/// are untrusted input to a process that posts events, so: the directory must
/// be ours and 0700, files are created 0600 without following links, read
/// back only if we own them, and their entries are turned into up events only
/// for keys in the vocabulary, the modifiers and the three buttons.
enum HeldStore {
    private static let dir: URL? = {
        // confstr, not $TMPDIR: the environment comes from our parent.
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        guard confstr(_CS_DARWIN_USER_TEMP_DIR, &buffer, buffer.count) > 0 else { return nil }
        let base = URL(fileURLWithPath: String(cString: buffer), isDirectory: true)
        let dir = base.appendingPathComponent("com.electron.wmux.computer-use.held", isDirectory: true)
        mkdir(dir.path, 0o700)
        // Ours and a real directory (O_NOFOLLOW): tighten a looser mode left
        // by an older build through the fd, then require 0700.
        let fd = open(dir.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var st = stat()
        if fstat(fd, &st) == 0, st.st_uid == getuid(), (st.st_mode & 0o077) != 0 { fchmod(fd, 0o700) }
        guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR, st.st_uid == getuid(), (st.st_mode & 0o077) == 0 else {
            Wire.log("held-input directory is not private; held keys will not survive a crash")
            return nil
        }
        return dir
    }()

    /// Key codes a helper can ever press, and buttons it can ever hold.
    private static let allowedKeys: Set<CGKeyCode> = {
        var codes = Set(KeyCodes.named.values).union(KeyCodes.ansiCharacters.values)
        codes.formUnion(KeyCodes.modifiers.map(\.keyCode))
        // The layout lookup can put a letter or digit on any key of the main
        // block (0x00–0x32), wherever a non-US layout has it.
        codes.formUnion((0...0x32).map { CGKeyCode($0) })
        return codes
    }()

    private static func file(_ pid: pid_t) -> URL? {
        dir?.appendingPathComponent("\(pid).json")
    }

    static func write(_ state: HeldState) {
        guard let url = file(getpid()) else { return }
        if state.isEmpty {
            unlink(url.path)
            return
        }
        guard let data = try? JSONEncoder().encode(state) else { return }
        let tmp = url.path + ".tmp"
        let fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { return }
        _ = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, data.count) }
        close(fd)
        rename(tmp, url.path)
    }

    static func removeOwn() {
        if let url = file(getpid()) { unlink(url.path) }
    }

    static func remove(_ url: URL) {
        unlink(url.path)
    }

    /// Records of this process and of helpers that are no longer running,
    /// sanitized.
    static func readOrphaned() -> [(url: URL, state: HeldState)] {
        guard let dir, let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
        return names.compactMap { name in
            guard name.hasSuffix(".json"), let pid = pid_t(name.dropLast(5)), pid > 0,
                  pid == getpid() || kill(pid, 0) != 0 else { return nil }
            let url = dir.appendingPathComponent(name)
            guard let state = read(url) else {
                unlink(url.path)
                return nil
            }
            return (url, state)
        }
    }

    private static func read(_ url: URL) -> HeldState? {
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var st = stat()
        guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_uid == getuid(), st.st_size < 4096 else {
            return nil
        }
        var data = Data(count: Int(st.st_size))
        let n = data.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, Int(st.st_size)) }
        guard n == Int(st.st_size), let state = try? JSONDecoder().decode(HeldState.self, from: data) else { return nil }
        return HeldState(
            keys: state.keys.filter { allowedKeys.contains($0) },
            buttons: state.buttons.filter { (0...2).contains($0.button) && $0.x.isFinite && $0.y.isFinite }
        )
    }
}
