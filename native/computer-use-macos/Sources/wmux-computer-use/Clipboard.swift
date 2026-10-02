// The pasteboard round-trip behind long `type` text. One transaction at a
// time; the saved contents are kept here (not on a stack frame) so that a
// stop-key SIGTERM in the middle of a paste still puts the person's clipboard
// back before the helper exits.

import AppKit

enum Clipboard {
    typealias Saved = [[(NSPasteboard.PasteboardType, Data)]]

    private static let concealedType = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
    private static let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

    private static let lock = NSLock()
    /// The saved contents and the changeCount of our write, while a paste is pending.
    private static var pending: (saved: Saved, ours: Int)?

    /// Every item and type on the pasteboard, or nil if any type cannot be
    /// read (a promise that fails, a lazily provided type): restoring a
    /// partial copy would corrupt the clipboard.
    static func snapshot() -> Saved? {
        var saved: Saved = []
        for item in NSPasteboard.general.pasteboardItems ?? [] {
            var entries: [(NSPasteboard.PasteboardType, Data)] = []
            for type in item.types {
                guard let data = item.data(forType: type) else { return nil }
                entries.append((type, data))
            }
            saved.append(entries)
        }
        return saved
    }

    /// Replaces the pasteboard with `text` (concealed + transient) and
    /// remembers `saved` for the restore.
    static func write(_ text: String, saved: Saved) -> Bool {
        let pb = NSPasteboard.general
        pb.clearContents()
        let item = NSPasteboardItem()
        guard item.setString(text, forType: .string),
              item.setData(Data(), forType: concealedType),
              item.setData(Data(), forType: transientType) else { return false }
        lock.lock()
        pending = (saved, pb.changeCount)
        lock.unlock()
        guard pb.writeObjects([item]) else { return false }
        lock.lock()
        pending = (saved, pb.changeCount)
        lock.unlock()
        return true
    }

    /// Puts the saved contents back if nothing else wrote the pasteboard
    /// since our write. Returns whether it restored. Safe from any thread.
    @discardableResult
    static func restoreIfUnchanged() -> Bool {
        lock.lock()
        let txn = pending
        pending = nil
        lock.unlock()
        guard let txn else { return false }
        let pb = NSPasteboard.general
        guard pb.changeCount == txn.ours else { return false }
        pb.clearContents()
        let items: [NSPasteboardItem] = txn.saved.map { entries in
            let it = NSPasteboardItem()
            for (type, data) in entries { it.setData(data, forType: type) }
            return it
        }
        return items.isEmpty || pb.writeObjects(items)
    }
}
