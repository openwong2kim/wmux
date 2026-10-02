// How `type` splits text into SendInput batches: runs of ordinary characters
// become short KEYEVENTF_UNICODE runs (one SendInput each), and newline / tab
// become real Enter / Tab presses. Graphemes are never split, so a surrogate
// pair, a composed Hangul syllable or an emoji ZWJ sequence arrives whole.

using System.Globalization;

namespace WmuxComputerUse.Core;

public readonly record struct TypeChunk(string? Text, string? Key)
{
    public static TypeChunk OfText(string text) => new(text, null);
    public static TypeChunk OfKey(string key) => new(null, key);

    /// <summary>Graphemes this chunk types (a key press counts as one).</summary>
    public int GraphemeCount => Text != null ? new StringInfo(Text).LengthInTextElements : 1;
}

public static class Chunks
{
    /// <summary>
    /// UTF-16 units per batch. Apps take any length, but a short batch lets
    /// the helper re-check the foreground window often. A single grapheme
    /// longer than this travels alone, unsplit.
    /// </summary>
    public const int UnicodeChunkUnits = 16;

    public static List<TypeChunk> Unicode(string text, int maxUnits = UnicodeChunkUnits)
    {
        var chunks = new List<TypeChunk>();
        var current = new System.Text.StringBuilder();
        void Flush()
        {
            if (current.Length > 0) chunks.Add(TypeChunk.OfText(current.ToString()));
            current.Clear();
        }
        var e = StringInfo.GetTextElementEnumerator(text);
        while (e.MoveNext())
        {
            var g = (string)e.Current;
            if (g == "\n" || g == "\r\n" || g == "\r")
            {
                Flush();
                chunks.Add(TypeChunk.OfKey("Enter"));
            }
            else if (g == "\t")
            {
                Flush();
                chunks.Add(TypeChunk.OfKey("Tab"));
            }
            else
            {
                if (current.Length + g.Length > maxUnits) Flush();
                current.Append(g);
            }
        }
        Flush();
        return chunks;
    }
}
