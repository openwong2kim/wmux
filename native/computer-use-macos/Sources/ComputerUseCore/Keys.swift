// The canonical key vocabulary of src/shared/computer/protocol.ts (NAMED_KEYS,
// a–z, 0–9, and the four modifiers) mapped to macOS virtual key codes. Main
// normalizes aliases, so anything outside this closed set is refused, never
// guessed.

import CoreGraphics

public enum KeyCodes {
    /// Positional (layout-independent) keys.
    public static let named: [String: CGKeyCode] = [
        "Enter": 36, "Tab": 48, "Escape": 53, "Backspace": 51, "Delete": 117, "Space": 49,
        "ArrowUp": 126, "ArrowDown": 125, "ArrowLeft": 123, "ArrowRight": 124,
        "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
        "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97,
        "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111,
    ]

    /// ANSI (US) positions, used when the current layout has no key for a character.
    public static let ansiCharacters: [Character: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32,
        "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
        "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29,
    ]

    public struct ModifierKey: Equatable {
        public let name: String
        public let keyCode: CGKeyCode
        public let flag: CGEventFlags
    }

    /// In protocol MODIFIERS order: pressed in this order, released in reverse.
    public static let modifiers: [ModifierKey] = [
        ModifierKey(name: "ctrl", keyCode: 59, flag: .maskControl),
        ModifierKey(name: "alt", keyCode: 58, flag: .maskAlternate),
        ModifierKey(name: "shift", keyCode: 56, flag: .maskShift),
        ModifierKey(name: "meta", keyCode: 55, flag: .maskCommand),
    ]

    public static func modifier(named name: String) -> ModifierKey? {
        modifiers.first { $0.name == name }
    }

    /// The key code for a canonical key. `layout` maps a character to the key
    /// that types it on the user's current ASCII-capable layout, so `meta+a`
    /// on AZERTY presses the key labelled A rather than the US position of A.
    public static func keyCode(for key: String, layout: ((Character) -> CGKeyCode?)? = nil) -> CGKeyCode? {
        if let code = named[key] { return code }
        guard key.count == 1, let ch = key.first, ansiCharacters[ch] != nil else { return nil }
        return layout?(ch) ?? ansiCharacters[ch]
    }

    /// Flags a real keyboard sets on its own for these keys (arrows are keypad
    /// keys and, like the navigation and function keys, carry Fn); some text
    /// views read them.
    public static func intrinsicFlags(for key: String) -> CGEventFlags {
        switch key {
        case "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight":
            return [.maskNumericPad, .maskSecondaryFn]
        case "Home", "End", "PageUp", "PageDown", "Delete":
            return [.maskSecondaryFn]
        default:
            return key.count > 1 && key.hasPrefix("F") ? [.maskSecondaryFn] : []
        }
    }

    /// Modifier names in press order, or nil if any name is not a modifier.
    public static func orderedModifiers(_ names: [String]) -> [ModifierKey]? {
        for name in names where modifier(named: name) == nil { return nil }
        return modifiers.filter { names.contains($0.name) }
    }
}
