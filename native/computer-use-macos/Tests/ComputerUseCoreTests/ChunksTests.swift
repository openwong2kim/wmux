import ComputerUseCore
import XCTest

final class ChunksTests: XCTestCase {
    func testSplitsLongTextIntoShortPayloads() {
        let text = String(repeating: "abcdefgh", count: 5)  // 40 units
        let chunks = unicodeChunks(text)
        XCTAssertEqual(chunks, [.text(String(text.prefix(16))), .text(String(text.dropFirst(16).prefix(16))), .text(String(text.suffix(8)))])
        XCTAssertEqual(chunks.map(\.characterCount).reduce(0, +), 40)
    }

    func testNewlinesAndTabsArePresses() {
        XCTAssertEqual(unicodeChunks("a\nb\tc\r\nd"), [.text("a"), .key("Enter"), .text("b"), .key("Tab"), .text("c"), .key("Enter"), .text("d")])
    }

    func testNeverSplitsAGrapheme() {
        // A family emoji is one grapheme of 8 UTF-16 units: with 8 per chunk it
        // goes alone, neither split nor merged with its neighbours.
        let family = "👨‍👩‍👧"
        XCTAssertEqual(family.utf16.count, 8)
        let chunks = unicodeChunks("abcdef" + family + "한글", maxUnits: 8)
        XCTAssertEqual(chunks, [.text("abcdef"), .text(family), .text("한글")])
    }

    func testEmpty() {
        XCTAssertEqual(unicodeChunks(""), [])
    }
}
