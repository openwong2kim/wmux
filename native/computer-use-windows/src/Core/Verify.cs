// When typed text counts as verified: the focused element's value read
// before and after the keystrokes must differ by exactly that text inserted
// at one position. "The value now contains the text" is not enough: text
// that was already there would verify a keystroke batch that never landed.

namespace WmuxComputerUse.Core;

public static class Verify
{
    /// <summary>One newline convention: an edit control stores Enter as \r\n, a rich edit as \r.</summary>
    public static string Lines(string s) => s.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');

    /// <summary>
    /// True when `after` is `before` with `typed` inserted at some position.
    /// A replaced selection, autocorrect or auto-indent all read as false
    /// (unverified), never as a false success.
    /// </summary>
    public static bool Inserted(string? before, string? after, string typed)
    {
        if (before == null || after == null || typed.Length == 0) return false;
        string b = Lines(before), a = Lines(after), t = Lines(typed);
        if (a.Length != b.Length + t.Length) return false;
        // The insertion point lies between the common prefix and the common
        // suffix; the typed text must fill exactly that gap.
        int prefix = 0;
        while (prefix < b.Length && a[prefix] == b[prefix]) prefix++;
        for (int p = Math.Min(prefix, b.Length); p >= 0; p--)
        {
            if (string.CompareOrdinal(a, p, t, 0, t.Length) != 0) continue;
            if (string.CompareOrdinal(a, p + t.Length, b, p, b.Length - p) == 0 && string.CompareOrdinal(a, 0, b, 0, p) == 0) return true;
        }
        return false;
    }
}
