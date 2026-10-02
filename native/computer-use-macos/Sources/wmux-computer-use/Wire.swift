// NDJSON plumbing and the error type every method throws.

import Foundation

/// A failure reported to main as `{ok:false, error:{code, message}}`. Codes are
/// the ones in src/shared/computer/errors.ts; main maps anything else to
/// `internal`.
struct HelperError: Error {
    let code: String
    let message: String

    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

typealias JSON = [String: Any]

enum Wire {
    private static let lock = NSLock()

    /// One line to stdout, written unbuffered: a pipe would otherwise hold the
    /// hello back until the buffer fills, and main's hello timer would fire.
    static func send(_ object: JSON) {
        let data: Data
        do {
            data = try JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
        } catch {
            data = Data(#"{"id":-1,"ok":false,"error":{"code":"internal","message":"unencodable reply"}}"#.utf8)
        }
        lock.lock()
        defer { lock.unlock() }
        var out = data
        out.append(0x0A)
        out.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let n = write(STDOUT_FILENO, raw.baseAddress! + offset, raw.count - offset)
                if n < 0 {
                    if errno == EINTR { continue }
                    // main is gone; nothing left to answer.
                    exit(0)
                }
                offset += n
            }
        }
    }

    static func log(_ message: String) {
        FileHandle.standardError.write(Data("[computer-use] \(message)\n".utf8))
    }
}

// MARK: - Params

extension Dictionary where Key == String, Value == Any {
    func string(_ key: String) -> String? {
        self[key] as? String
    }

    func requireString(_ key: String) throws -> String {
        guard let s = self[key] as? String else { throw HelperError("invalid_argument", "\(key) must be a string") }
        return s
    }

    func int(_ key: String) -> Int? {
        if let n = self[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() { return n.intValue }
        return nil
    }

    func double(_ key: String) -> Double? {
        if let n = self[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() { return n.doubleValue }
        return nil
    }

    func object(_ key: String) -> JSON? {
        self[key] as? JSON
    }

    func point(_ key: String) throws -> CGPoint? {
        guard let p = object(key) else { return nil }
        guard let x = p.double("x"), let y = p.double("y"), x.isFinite, y.isFinite else {
            throw HelperError("invalid_argument", "\(key) needs numeric x and y")
        }
        return CGPoint(x: x, y: y)
    }
}
