// When typed text counts as verified: the focused element's value read
// before and after the keystrokes must differ by exactly that text inserted
// at one position. "The value now contains the text" is not enough: text
// that was already there would verify a keystroke batch that never landed.
//
// SameValue, Settle and Observed:
// Adapted from vercel-labs/agent-desktop crates/core/src/tree/value_matches.rs
// and crates/core/src/actions/post_action.rs @6660fbac (Apache-2.0), modified:
// ported to C#; the line-break rule reuses Lines below; the settle loop polls
// every 15 ms with a fixed extension instead of the interaction lease's
// deadline; the unverified result carries a 120-character, secret-masked
// excerpt of the value from where it first differs instead of the whole
// element state.

namespace WmuxComputerUse.Core;

/// <summary>A settled read-back: whether it verified, and the last value read (null when unreadable).</summary>
public readonly record struct ReadBack(bool Verified, string? Last);

public static class Verify
{
    /// <summary>How long a read-back keeps polling past its base wait while the value is still changing.</summary>
    public const int SettleExtraMs = 2000;
    /// <summary>A value that did not change for this long counts as settled.</summary>
    public const int QuietMs = 50;
    /// <summary>Text shown before the first difference in an observed-value excerpt.</summary>
    public const int ExcerptContext = 40;

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

    /// <summary>
    /// setValue's read-back: the value equals what was set, with line breaks
    /// compared normalized (a rich edit reads `a\nb` back as `a\rb`). Each
    /// break still counts once, so a dropped or added newline never matches.
    /// </summary>
    public static bool SameValue(string expected, string? observed) =>
        observed != null
        && (string.Equals(expected, observed, StringComparison.Ordinal)
            || string.Equals(Lines(expected), Lines(observed), StringComparison.Ordinal));

    /// <summary>
    /// Reads `read` until `ok` holds. Stops at `baseMs`, unless the value
    /// changed within the last QuietMs: then it keeps reading while the value
    /// is still changing (an app still drawing posted keys), up to
    /// `baseMs + extraMs`. `now` and `sleep` are injected for tests.
    /// </summary>
    public static ReadBack Settle(Func<string?> read, Func<string?, bool> ok, int baseMs, int extraMs, Func<long> now, Action<int> sleep, int pollMs = 15)
    {
        long start = now();
        long baseEnd = start + baseMs, hardEnd = baseEnd + extraMs;
        string? last = read();
        long changedAt = start;
        while (true)
        {
            if (ok(last)) return new(true, last);
            long t = now();
            if (t >= hardEnd || (t >= baseEnd && t - changedAt >= QuietMs)) return new(false, last);
            sleep(pollMs);
            var next = read();
            if (!string.Equals(next, last, StringComparison.Ordinal))
            {
                changedAt = now();
                last = next;
            }
        }
    }

    /// <summary>
    /// The text after a caret is nothing but line breaks (or nothing): the
    /// caret counts as at the end. A rich edit keeps its final paragraph mark
    /// after the last position a caret can take. Null (unreadable) is not.
    /// </summary>
    public static bool OnlyLineBreaks(string? tail) => tail != null && tail.Trim('\r', '\n').Length == 0;

    /// <summary>
    /// `Settle` for typed text: verified once the value is `before` with
    /// `text` inserted (Inserted). Without a value before, nothing can verify
    /// and nothing is read.
    /// </summary>
    public static ReadBack SettleInserted(Func<string?> read, string? before, string text, int baseMs, Func<long> now, Action<int> sleep) =>
        before == null
            ? new(false, null)
            : Settle(read, value => Inserted(before, value, text), baseMs, SettleExtraMs, now, sleep);

    /// <summary>
    /// What an unverified result shows of the value the field holds now:
    /// null when it could not be read, `[redacted]` for a secret field, and
    /// otherwise an excerpt (Tree.Preview: whitespace collapsed, at most
    /// Tree.TextPreviewChars text elements with its ellipses) that starts a
    /// little before the first place it differs from `reference` (the value
    /// before typing, or the value set), so the text that landed, or the
    /// place it went wrong, is in view.
    /// </summary>
    public static string? Observed(string? reference, string? observed, bool secret)
    {
        if (observed == null) return null;
        if (secret) return "[redacted]";
        string o = Lines(observed);
        int diff = 0;
        if (reference != null)
        {
            string r = Lines(reference);
            while (diff < r.Length && diff < o.Length && r[diff] == o[diff]) diff++;
        }
        int start = Math.Max(0, diff - ExcerptContext);
        // Never start inside a surrogate pair.
        if (start > 0 && char.IsLowSurrogate(o[start])) start--;
        // One place is kept for Tree.Preview's closing ellipsis, one more for the opening one.
        if (start > 0)
        {
            var rest = Tree.Preview(o[start..], Tree.TextPreviewChars - 2);
            // Only whitespace from there on: show the field from the top instead of "".
            if (rest.Length > 0) return "…" + rest;
        }
        return Tree.Preview(o, Tree.TextPreviewChars - 1);
    }
}
