// The held-input record a helper keeps on disk so the next helper can release
// what a killed one left down. A file is untrusted input to a process that
// injects input, so reading it is strict: a size cap, the pid it claims must be
// the pid in its file name, and its entries survive only as up events for keys
// a helper can press (Keys.Pressable) and the three mouse buttons at finite
// coordinates.
//
// Shape: {"pid":4812,"created":133700000000000000,"keys":[162,65],
//         "buttons":[{"button":0,"x":100,"y":200}]}
// `created` is the process creation time (FILETIME ticks), so a recycled pid
// is not mistaken for the helper that wrote the file.

using System.Text.Json;

namespace WmuxComputerUse.Core;

/// <summary>A pressed button (0 left, 1 right, 2 middle) and where it went down, so its up lands there too.</summary>
public readonly record struct HeldButton(int Button, double X, double Y);

public sealed record HeldState(int Pid, long Created, IReadOnlyList<ushort> Keys, IReadOnlyList<HeldButton> Buttons)
{
    public const int MaxFileBytes = 4096;
    /// <summary>Coordinates beyond this are nonsense on any desktop.</summary>
    public const double MaxCoordinate = 1_000_000;

    public bool IsEmpty => Keys.Count == 0 && Buttons.Count == 0;

    public byte[] Serialize()
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteNumber("pid", Pid);
            w.WriteNumber("created", Created);
            w.WriteStartArray("keys");
            foreach (var k in Keys) w.WriteNumberValue(k);
            w.WriteEndArray();
            w.WriteStartArray("buttons");
            foreach (var b in Buttons)
            {
                w.WriteStartObject();
                w.WriteNumber("button", b.Button);
                w.WriteNumber("x", b.X);
                w.WriteNumber("y", b.Y);
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteEndObject();
        }
        return ms.ToArray();
    }

    /// <summary>
    /// Parses and sanitizes a record read from `&lt;pid&gt;.json`. Returns null for
    /// anything malformed, oversized or claiming another pid; otherwise only
    /// pressable keys and valid buttons are kept.
    /// </summary>
    public static HeldState? Parse(ReadOnlySpan<byte> data, int filePid)
    {
        if (data.Length == 0 || data.Length > MaxFileBytes || filePid <= 0) return null;
        try
        {
            using var doc = JsonDocument.Parse(data.ToArray(), new JsonDocumentOptions { MaxDepth = 4 });
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("pid", out var pidEl) || !IsNumber(pidEl) || !pidEl.TryGetInt32(out var pid) || pid != filePid) return null;
            if (!root.TryGetProperty("created", out var createdEl) || !IsNumber(createdEl) || !createdEl.TryGetInt64(out var created)) return null;

            var keys = new List<ushort>();
            if (root.TryGetProperty("keys", out var keysEl) && keysEl.ValueKind == JsonValueKind.Array)
            {
                foreach (var k in keysEl.EnumerateArray())
                {
                    if (k.ValueKind == JsonValueKind.Number && k.TryGetInt32(out var vk) && vk is > 0 and <= 0xFF
                        && Core.Keys.Pressable.Contains((ushort)vk) && !keys.Contains((ushort)vk))
                    {
                        keys.Add((ushort)vk);
                    }
                }
            }
            var buttons = new List<HeldButton>();
            if (root.TryGetProperty("buttons", out var buttonsEl) && buttonsEl.ValueKind == JsonValueKind.Array)
            {
                foreach (var b in buttonsEl.EnumerateArray())
                {
                    if (b.ValueKind != JsonValueKind.Object) continue;
                    if (!b.TryGetProperty("button", out var bn) || !IsNumber(bn) || !bn.TryGetInt32(out var button) || button is < 0 or > 2) continue;
                    if (!b.TryGetProperty("x", out var xe) || !IsNumber(xe) || !xe.TryGetDouble(out var x)) continue;
                    if (!b.TryGetProperty("y", out var ye) || !IsNumber(ye) || !ye.TryGetDouble(out var y)) continue;
                    if (!double.IsFinite(x) || !double.IsFinite(y) || Math.Abs(x) > MaxCoordinate || Math.Abs(y) > MaxCoordinate) continue;
                    if (buttons.Any(h => h.Button == button)) continue;
                    buttons.Add(new HeldButton(button, x, y));
                }
            }
            return new HeldState(pid, created, keys, buttons);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // JsonElement.TryGet* throws on a non-number; a hostile file must not.
    private static bool IsNumber(JsonElement e) => e.ValueKind == JsonValueKind.Number;

    /// <summary>`4812.json` → 4812; anything else → null.</summary>
    public static int? PidFromFileName(string name)
    {
        if (!name.EndsWith(".json", StringComparison.Ordinal)) return null;
        var stem = name[..^5];
        if (stem.Length == 0 || stem.Length > 10 || !stem.All(char.IsAsciiDigit)) return null;
        return int.TryParse(stem, out var pid) && pid > 0 ? pid : null;
    }
}
