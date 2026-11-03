// Agent markers: the pure rules behind each agent's overlay marker
// (Helper/Overlay.cs). Main sends `marker: {id, label, color}` with every
// control request (src/shared/computer/agentMarker.ts); a request without one
// (an older main) draws the default marker, which looks as a lone agent's
// would. The macOS helper follows the same rules (ComputerUseCore/Markers.swift).
//
// Sizes here are in device-independent pixels (96 DPI); the overlay multiplies
// them by its monitor's scale, because the helper works in physical pixels.

using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace WmuxComputerUse.Core;

/// <summary>An sRGB colour, 0-255 per channel.</summary>
public readonly record struct MarkerRgb(byte Red, byte Green, byte Blue);

/// <summary>The agent a control request is drawn for.</summary>
public sealed record AgentMarker(string Id, string Label, MarkerRgb Color)
{
    /// <summary>agentMarker.ts AGENT_MARKER_COLORS[0], the attention orange.</summary>
    public static readonly MarkerRgb DefaultColor = new(0xFF, 0x8A, 0x3D);
    /// <summary>agentMarker.ts AGENT_MARKER_INK, drawn on a marker fill.</summary>
    public static readonly MarkerRgb Ink = new(0x0B, 0x0C, 0x0E);
    public const string DefaultId = "default";
    public const string DefaultLabel = "wmux agent";
    public const int LabelMaxCharacters = 60;

    public static readonly AgentMarker Fallback = new(DefaultId, DefaultLabel, DefaultColor);

    /// <summary>
    /// The request's `marker`, parsed defensively: no marker or no id is the
    /// default marker; a bad colour is the default orange; an empty label is
    /// "wmux agent".
    /// </summary>
    public static AgentMarker FromWire(JsonNode? wire)
    {
        if (wire is not JsonObject o || StringOf(o["id"]) is not { Length: > 0 } id) return Fallback;
        return new AgentMarker(id, Text(StringOf(o["label"])) ?? DefaultLabel, ParseColor(StringOf(o["color"])) ?? DefaultColor);
    }

    private static string? StringOf(JsonNode? node) =>
        node is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : null;

    /// <summary>`#RRGGBB` (either case) or null.</summary>
    public static MarkerRgb? ParseColor(string? text)
    {
        if (text is not { Length: 7 } || text[0] != '#') return null;
        for (int i = 1; i < 7; i++)
        {
            if (!char.IsAsciiHexDigit(text[i])) return null;
        }
        uint n = uint.Parse(text.AsSpan(1), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
        return new MarkerRgb((byte)(n >> 16), (byte)(n >> 8), (byte)n);
    }

    /// <summary>
    /// One line of display text: control and format characters (Cc, Cf, as
    /// macOS's CharacterSet.controlCharacters: bidi overrides and zero-width
    /// marks could reorder or hide what the pill says) become spaces, runs
    /// of whitespace collapse, ends are trimmed, and at most `limit`
    /// characters (text elements) stay. Null when nothing is left.
    /// </summary>
    public static string? Text(string? raw, int limit = LabelMaxCharacters)
    {
        if (raw == null) return null;
        var cleaned = new StringBuilder(raw.Length);
        foreach (var rune in raw.EnumerateRunes())
        {
            var category = Rune.GetUnicodeCategory(rune);
            if (category is UnicodeCategory.Control or UnicodeCategory.Format) cleaned.Append(' ');
            else cleaned.Append(rune.ToString());
        }
        var words = cleaned.ToString().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (words.Length == 0) return null;
        var line = string.Join(' ', words);
        var info = new StringInfo(line);
        if (info.LengthInTextElements <= limit) return line;
        return info.SubstringByTextElements(0, limit).TrimEnd();
    }

    /// <summary>
    /// The name on the chip beside the pointer or caret: the label up to its
    /// first " · " ("#api-1 · Claude Code" → "#api-1").
    /// </summary>
    public static string ChipLabel(string label)
    {
        int cut = label.IndexOf(" · ", StringComparison.Ordinal);
        if (cut < 0) return label;
        var head = label[..cut].Trim();
        return head.Length == 0 ? label : head;
    }
}

/// <summary>What the agent is doing, after its label in the pill.</summary>
public enum MarkerVerbKind { Clicking, Typing, SettingValue, Scrolling, Waiting }

public readonly record struct MarkerVerb(MarkerVerbKind Kind, string WaitingFor = "")
{
    public static readonly MarkerVerb Clicking = new(MarkerVerbKind.Clicking);
    public static readonly MarkerVerb Typing = new(MarkerVerbKind.Typing);
    public static readonly MarkerVerb SettingValue = new(MarkerVerbKind.SettingValue);
    public static readonly MarkerVerb Scrolling = new(MarkerVerbKind.Scrolling);
    public static MarkerVerb Waiting(string holder) => new(MarkerVerbKind.Waiting, holder);

    public bool IsPointer => Kind is MarkerVerbKind.Clicking or MarkerVerbKind.Scrolling;
    public bool IsWaiting => Kind == MarkerVerbKind.Waiting;

    /// <summary>
    /// " · typing"; with real input " · using your mouse" (pointer actions)
    /// or " · using your keyboard" (keyboard actions).
    /// </summary>
    public string Text(bool realInput) => Kind switch
    {
        MarkerVerbKind.Waiting => $" · waiting for {WaitingFor}",
        _ when realInput => IsPointer ? " · using your mouse" : " · using your keyboard",
        MarkerVerbKind.Clicking => " · clicking",
        MarkerVerbKind.Typing => " · typing",
        MarkerVerbKind.SettingValue => " · setting value",
        _ => " · scrolling",
    };
}

/// <summary>A marker on a window, and when it arrived there.</summary>
public readonly record struct MarkerPlacement(string Id, string Window, long Arrival);

public static class Markers
{
    public const double HaloRingWidth = 3;
    public const double HaloRingGap = 3;

    /// <summary>How long after its own last action a marker starts to fade.</summary>
    public const int FadeDelayMs = 1500;
    /// <summary>
    /// How long a waiting marker stays without a newer action or markerClear:
    /// main's INPUT_LOCK_IDLE_MS (15 000 ms, src/main/computer/inputLanes.ts).
    /// </summary>
    public const int WaitFadeDelayMs = 15_000;
    public const int FadeDurationMs = 300;
    public const int MoveDurationMs = 150;
    public const int PulseDurationMs = 350;

    /// <summary>
    /// How far the outer edge of ring `index` (0 = the innermost) sits
    /// outside the window's edge: each ring is 3 px wide, 3 px outside the
    /// one before.
    /// </summary>
    public static double HaloOutset(int index) => HaloRingWidth + Math.Max(0, index) * (HaloRingWidth + HaloRingGap);

    /// <summary>
    /// The centre line of ring `index`'s stroke around `window`, in physical
    /// pixels at `scale`. When the window lies within one monitor and the
    /// ring would leave it (a maximized window), each side that would leave
    /// is pulled in to that monitor's edge, ring `index` a ring and a gap
    /// further in per ring, so the ring stays on its own monitor (not as a
    /// strip on the next one) and stacked rings stay apart.
    /// </summary>
    public static Rect RingRect(Rect window, int index, double scale, Rect? monitor)
    {
        double width = HaloRingWidth * scale;
        double inset = HaloOutset(index) * scale - width / 2;
        double left = window.X - inset, top = window.Y - inset;
        double right = window.X + window.Width + inset, bottom = window.Y + window.Height + inset;
        if (monitor is { } m && window.X >= m.X - 1 && window.Y >= m.Y - 1
            && window.X + window.Width <= m.X + m.Width + 1 && window.Y + window.Height <= m.Y + m.Height + 1)
        {
            double edge = Math.Max(0, index) * (HaloRingWidth + HaloRingGap) * scale + width / 2;
            left = Math.Max(left, m.X + edge);
            top = Math.Max(top, m.Y + edge);
            right = Math.Min(right, m.X + m.Width - edge);
            bottom = Math.Min(bottom, m.Y + m.Height - edge);
        }
        return new Rect(left, top, Math.Max(0, right - left), Math.Max(0, bottom - top));
    }

    /// <summary>
    /// The markers on each window, in the order they arrived on it: the first
    /// one draws the innermost ring and the leftmost pill.
    /// </summary>
    public static Dictionary<string, List<string>> ByWindow(IEnumerable<MarkerPlacement> placements) =>
        placements.GroupBy(p => p.Window, StringComparer.Ordinal).ToDictionary(
            g => g.Key,
            g => g.OrderBy(p => p.Arrival).ThenBy(p => p.Id, StringComparer.Ordinal).Select(p => p.Id).ToList(),
            StringComparer.Ordinal);

    /// <summary>
    /// Each pill's row (0 = nearest the window) and x offset within it: side
    /// by side while they fit in `rowWidth`, then on a new row, so a window's
    /// pills stay over that window and never run into a neighbouring
    /// window's pills. A pill wider than the row still gets a row of its own.
    /// </summary>
    public static List<(int Row, double X)> PillGrid(IReadOnlyList<double> widths, double gap, double rowWidth)
    {
        var grid = new List<(int, double)>(widths.Count);
        double x = 0;
        int row = 0;
        foreach (var w in widths)
        {
            if (x > 0 && x + w > rowWidth)
            {
                row++;
                x = 0;
            }
            grid.Add((row, x));
            x += w + gap;
        }
        return grid;
    }

    /// <summary>
    /// Where a window's first row of pills starts: above its top-left corner,
    /// outside its outermost ring, with `rows - 1` more rows stacked upward;
    /// or inside the window's top-left corner, rows stacked downward, when
    /// they do not all fit above it below `topLimit` (the top of the
    /// monitor's work area). `inset` is how far inside the corner that row sits.
    /// </summary>
    public static (double X, double Y) PillRowOrigin(Rect window, double outset, double pillHeight, double lift, double topLimit,
        double inset = 8, int rows = 1, double rowGap = 0)
    {
        double above = window.Y - outset - lift - pillHeight;
        double topRow = above - Math.Max(0, rows - 1) * (pillHeight + rowGap);
        if (topRow >= topLimit) return (window.X - outset, above);
        return (window.X + inset, Math.Max(window.Y, topLimit) + inset);
    }

    /// <summary>
    /// Where each of a window's pills goes (`widths` in arrival order). Above
    /// the window the rows span its outermost ring (window width + 2 ×
    /// `outset`) and stack upward; when they do not all fit there, every row
    /// goes inside the window's top-left corner, `inset` in, at most the
    /// window's width less 2 × `inset` wide, stacked downward.
    /// </summary>
    public static List<(double X, double Y)> PillLayout(Rect window, IReadOnlyList<double> widths, double outset, double pillHeight,
        double lift, double gap, double topLimit, double inset = 8)
    {
        var aboveGrid = PillGrid(widths, gap, window.Width + 2 * outset);
        int rows = aboveGrid.Count == 0 ? 1 : aboveGrid.Max(p => p.Row) + 1;
        var (x, y) = PillRowOrigin(window, outset, pillHeight, lift, topLimit, inset, rows, gap);
        bool above = y < window.Y;
        var grid = above ? aboveGrid : PillGrid(widths, gap, window.Width - 2 * inset);
        double step = (above ? -1 : 1) * (pillHeight + gap);
        return grid.Select(p => (x + p.X, y + p.Row * step)).ToList();
    }

    /// <summary>The Windows stop chord (src/main/computer/index.ts stopKeyAcceleratorFor).</summary>
    public const string BarStopHint = "Stop all Ctrl+Alt+Shift+Esc";

    public static string BarText(int count) =>
        count == 1 ? "1 wmux agent is using apps" : $"{count} wmux agents are using apps";

    /// <summary>
    /// The caret drawn for a keyboard action, 2 px wide (times `scale`).
    /// `insertionLine` is what UIA reported for the insertion point (its x is
    /// the caret, its height the line's): used when it is finite, a line's
    /// height and on the window. Otherwise the leading edge of the element's
    /// frame, inset as the text in a field is, no taller than a line. Null
    /// without either. All in physical pixels; `scale` is the monitor's.
    /// </summary>
    public static Rect? CaretRect(Rect? insertionLine, Rect? elementFrame, Rect? window, double scale = 1)
    {
        double s = scale > 0 && double.IsFinite(scale) ? scale : 1;
        if (insertionLine is { } line && Finite(line) && line.Height >= 4 * s && line.Height <= 200 * s
            && (window is not { } w || Contains(Inflate(w, 4 * s), line.X, line.Y + line.Height / 2)))
        {
            return new Rect(line.X - s, line.Y, 2 * s, line.Height);
        }
        if (elementFrame is not { } frame || !Finite(frame) || frame.Width <= 0 || frame.Height <= 0) return null;
        double height = Math.Min(frame.Height, 22 * s);
        // A one-line field: centred; a text area: its first line.
        double y = frame.Height <= 40 * s ? frame.Y + frame.Height / 2 - height / 2 : frame.Y + 6 * s;
        return new Rect(frame.X + Math.Min(6 * s, frame.Width / 2), y, 2 * s, height);
    }

    private static bool Finite(Rect r) =>
        double.IsFinite(r.X) && double.IsFinite(r.Y) && double.IsFinite(r.Width) && double.IsFinite(r.Height);

    private static Rect Inflate(Rect r, double d) => new(r.X - d, r.Y - d, r.Width + 2 * d, r.Height + 2 * d);

    private static bool Contains(Rect r, double x, double y) => x >= r.X && x < r.X + r.Width && y >= r.Y && y < r.Y + r.Height;
}
