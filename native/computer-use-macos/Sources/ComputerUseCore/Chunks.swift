// How `type` splits text into key events: runs of ordinary characters become
// short Unicode strings (one key event each), and newline / tab become real
// Return / Tab presses. Graphemes are never split, so a composed Hangul
// syllable or an emoji with modifiers arrives whole.

public enum TypeChunk: Equatable {
    case text(String)
    case key(String)

    public var characterCount: Int {
        switch self {
        case .text(let s): return s.count
        case .key: return 1
        }
    }
}

/// UTF-16 units per Unicode key event. Apps take the whole payload, but some
/// truncate long ones; short strings keep every app on the safe side.
public let unicodeChunkUnits = 16

public func unicodeChunks(_ text: String, maxUnits: Int = unicodeChunkUnits) -> [TypeChunk] {
    var chunks: [TypeChunk] = []
    var current = ""
    var units = 0
    func flush() {
        if !current.isEmpty { chunks.append(.text(current)) }
        current = ""
        units = 0
    }
    for ch in text {
        if ch == "\n" || ch == "\r\n" || ch == "\r" {
            flush()
            chunks.append(.key("Enter"))
        } else if ch == "\t" {
            flush()
            chunks.append(.key("Tab"))
        } else {
            let n = String(ch).utf16.count
            if units + n > maxUnits { flush() }
            current.append(ch)
            units += n
        }
    }
    flush()
    return chunks
}
