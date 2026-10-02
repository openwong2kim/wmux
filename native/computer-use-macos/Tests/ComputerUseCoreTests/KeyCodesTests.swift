import ComputerUseCore
import CoreGraphics
import XCTest

final class KeyCodesTests: XCTestCase {
    /// The canonical vocabulary of src/shared/computer/protocol.ts as of the
    /// key-vocabulary contract commit d4ab6934 (NAMED_KEYS, a–z, 0–9). Every
    /// name main can send must map.
    static let namedKeys = [
        "Enter", "Tab", "Escape", "Backspace", "Delete", "Space",
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
        "Home", "End", "PageUp", "PageDown",
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
    ]
    static let letters = "abcdefghijklmnopqrstuvwxyz".map(String.init)
    static let digits = "0123456789".map(String.init)

    func testEveryCanonicalKeyMaps() {
        var codes = Set<CGKeyCode>()
        for key in Self.namedKeys + Self.letters + Self.digits {
            guard let code = KeyCodes.keyCode(for: key) else { return XCTFail("\(key) does not map") }
            codes.insert(code)
        }
        XCTAssertEqual(codes.count, Self.namedKeys.count + 36, "two keys share a key code")
    }

    func testKnownCodes() {
        XCTAssertEqual(KeyCodes.keyCode(for: "Enter"), 36)
        XCTAssertEqual(KeyCodes.keyCode(for: "Delete"), 117)  // forward delete
        XCTAssertEqual(KeyCodes.keyCode(for: "Backspace"), 51)
        XCTAssertEqual(KeyCodes.keyCode(for: "a"), 0)
        XCTAssertEqual(KeyCodes.keyCode(for: "0"), 29)
        XCTAssertEqual(KeyCodes.keyCode(for: "F12"), 111)
    }

    func testNonCanonicalNamesAreRefused() {
        for bad in ["A", "enter", "Return", "ctrl", "meta", "", "ab", "é", "F13", "-"] {
            XCTAssertNil(KeyCodes.keyCode(for: bad), bad)
        }
    }

    func testLayoutLookupWinsForCharacters() {
        // AZERTY: the key labelled A sits at the US Q position (12).
        let azerty: (Character) -> CGKeyCode? = { $0 == "a" ? 12 : nil }
        XCTAssertEqual(KeyCodes.keyCode(for: "a", layout: azerty), 12)
        XCTAssertEqual(KeyCodes.keyCode(for: "b", layout: azerty), 11)
        // Named keys are positional and ignore the layout.
        XCTAssertEqual(KeyCodes.keyCode(for: "Enter", layout: { _ in 99 }), 36)
    }

    func testModifierOrderAndFlags() {
        let mods = KeyCodes.orderedModifiers(["meta", "shift", "ctrl"])
        XCTAssertEqual(mods?.map(\.name), ["ctrl", "shift", "meta"])
        XCTAssertEqual(KeyCodes.modifier(named: "meta")?.flag, .maskCommand)
        XCTAssertEqual(KeyCodes.modifier(named: "alt")?.keyCode, 58)
        XCTAssertNil(KeyCodes.orderedModifiers(["cmd"]))
        XCTAssertEqual(KeyCodes.orderedModifiers([])?.count, 0)
    }

    func testIntrinsicFlags() {
        XCTAssertEqual(KeyCodes.intrinsicFlags(for: "ArrowLeft"), [.maskNumericPad, .maskSecondaryFn])
        XCTAssertEqual(KeyCodes.intrinsicFlags(for: "F5"), [.maskSecondaryFn])
        XCTAssertEqual(KeyCodes.intrinsicFlags(for: "PageDown"), [.maskSecondaryFn])
        XCTAssertEqual(KeyCodes.intrinsicFlags(for: "f"), [])
        XCTAssertEqual(KeyCodes.intrinsicFlags(for: "Enter"), [])
    }
}
