// NDJSON plumbing: raw UTF-8 bytes on stdout, one line per message, flushed
// under one lock, and the error type every method throws.

using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace WmuxComputerUse;

/// <summary>
/// A failure reported to main as `{ok:false, error:{code, message}}`. Codes are
/// the ones in src/shared/computer/errors.ts; main maps anything else to
/// `internal`.
/// </summary>
internal sealed class HelperError(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

internal static class Wire
{
    private static readonly object WriteLock = new();
    private static readonly Stream Stdout = Console.OpenStandardOutput();

    public static void Send(JsonObject message, int? id = null)
    {
        string text;
        try
        {
            text = message.ToJsonString();
        }
        catch (Exception)
        {
            // Keep the reply answering its request: main kills a helper that
            // answers an id it is not waiting for.
            text = $"{{\"id\":{id ?? -1},\"ok\":false,\"error\":{{\"code\":\"internal\",\"message\":\"the helper could not encode its reply\"}}}}";
        }
        var bytes = Encoding.UTF8.GetBytes(text + "\n");
        lock (WriteLock)
        {
            try
            {
                Stdout.Write(bytes, 0, bytes.Length);
                Stdout.Flush();
            }
            catch (IOException)
            {
                // main is gone; nothing left to answer.
                Shutdown.Run("stdout closed");
            }
        }
    }

    public static void Log(string message)
    {
        try
        {
            Console.Error.WriteLine($"[computer-use] {message}");
        }
        catch (IOException)
        {
        }
    }
}

/// <summary>Typed access to a request's params; wrong types are `invalid_argument`.</summary>
internal sealed class Params(JsonObject obj)
{
    public JsonObject Raw { get; } = obj;

    public bool Has(string key) => Raw.ContainsKey(key) && Raw[key] != null;

    public string? String(string key) =>
        Raw[key] is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : null;

    public string RequireString(string key) => String(key) ?? throw new HelperError("invalid_argument", $"{key} must be a string");

    public double? Double(string key) =>
        Raw[key] is JsonValue v && v.GetValueKind() == JsonValueKind.Number && v.TryGetValue<double>(out var d) && double.IsFinite(d) ? d : null;

    public int? Int(string key)
    {
        var d = Double(key);
        if (d is null) return null;
        return d.Value >= int.MinValue && d.Value <= int.MaxValue ? (int)Math.Truncate(d.Value) : null;
    }

    public Params? Object(string key) => Raw[key] is JsonObject o ? new Params(o) : null;

    /// <summary>A list of strings, or null when absent; anything else is refused.</summary>
    public List<string>? Strings(string key)
    {
        if (!Has(key)) return null;
        if (Raw[key] is not JsonArray arr) throw new HelperError("invalid_argument", $"{key} must be a list of names");
        var list = new List<string>(arr.Count);
        foreach (var item in arr)
        {
            if (item is JsonValue v && v.GetValueKind() == JsonValueKind.String) list.Add(v.GetValue<string>());
            else throw new HelperError("invalid_argument", $"{key} must be a list of names");
        }
        return list;
    }

    public (double X, double Y)? Point(string key)
    {
        var p = Object(key);
        if (p == null) return null;
        var x = p.Double("x");
        var y = p.Double("y");
        if (x is null || y is null) throw new HelperError("invalid_argument", $"{key} needs numeric x and y");
        return (x.Value, y.Value);
    }
}
