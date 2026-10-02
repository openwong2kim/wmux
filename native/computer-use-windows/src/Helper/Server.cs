// Request dispatch: one NDJSON request in, exactly one response out, on the STA thread.

using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace WmuxComputerUse;

internal static class Server
{
    /// <summary>src/shared/computer/protocol.ts COMPUTER_PROTOCOL_VERSION.</summary>
    public const int ProtocolVersion = 2;

    private static readonly string[] AgentActions =
    [
        "capabilities", "listApps", "listWindows", "getAppState",
        "click", "setValue", "type", "pressKey", "hotkey", "scroll",
    ];

    public static string HelperVersion
    {
        get
        {
            var v = typeof(Server).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
            return string.IsNullOrEmpty(v) ? "dev" : v;
        }
    }

    public static JsonObject Hello() => new()
    {
        ["type"] = "hello",
        ["protocolVersion"] = ProtocolVersion,
        ["os"] = "win32",
        ["helperVersion"] = HelperVersion,
        ["capabilities"] = Capabilities(),
    };

    /// <summary>Windows has no TCC-like grant: UIA and capture need no permission.</summary>
    public static JsonObject Capabilities() => new()
    {
        ["actions"] = new JsonArray(AgentActions.Select(a => (JsonNode)a).ToArray()),
        ["modes"] = new JsonArray("ax", "vision", "both"),
        ["permissions"] = new JsonObject { ["accessibility"] = true, ["screenRecording"] = true },
    };

    public static void Handle(byte[] line)
    {
        JsonObject? request;
        try
        {
            request = JsonNode.Parse(line) as JsonObject;
        }
        catch (JsonException)
        {
            request = null;
        }
        // An id-less line cannot be answered without desynchronising main,
        // which kills a helper that replies to an unknown id.
        if (request?["id"] is not JsonValue idValue || idValue.GetValueKind() != JsonValueKind.Number
            || !idValue.TryGetValue<double>(out var idNumber) || idNumber != Math.Floor(idNumber))
        {
            Wire.Log("dropping a malformed request line");
            return;
        }
        int id = (int)idNumber;
        var method = request["method"] is JsonValue m && m.GetValueKind() == JsonValueKind.String ? m.GetValue<string>() : "";
        var p = new Params(request["params"] as JsonObject ?? new JsonObject());
        try
        {
            var result = Dispatch(method, p);
            Wire.Send(new JsonObject { ["id"] = id, ["ok"] = true, ["result"] = result }, id);
        }
        catch (HelperError e)
        {
            Wire.Send(Error(id, e.Code, e.Message), id);
        }
        catch (Exception e)
        {
            Wire.Send(Error(id, Uia.ErrorCode(e), Uia.Describe(e)), id);
        }
    }

    private static JsonObject Error(int id, string code, string message) => new()
    {
        ["id"] = id,
        ["ok"] = false,
        ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
    };

    private static JsonNode Dispatch(string method, Params p)
    {
        // Never act on the lock screen or a UAC / Ctrl+Alt+Del secure
        // desktop, and say why windows "vanished".
        if (method is not ("capabilities" or "listApps" or "releaseInput")) InputDesktop.Require();
        // A dead helper's held keys go up before this one sends anything.
        if (method is "click" or "setValue" or "type" or "pressKey" or "hotkey" or "scroll") Input.EnsureOrphansReleased();
        switch (method)
        {
            case "capabilities": return Capabilities();
            case "listApps": return Apps.ListApps();
            case "listWindows": return Apps.ListWindows(p.String("app"));
            case "resolveTarget":
            {
                var (app, window) = Apps.ResolveTarget(p.RequireString("app"), p.String("window"));
                return new JsonObject { ["app"] = app.Json(), ["window"] = window.Json(app) };
            }
            case "getAppState": return Observe.GetAppState(p);
            case "click": return Actions.Click(p);
            case "setValue": return Actions.SetValue(p);
            case "type": return Actions.Type(p);
            case "pressKey": return Actions.PressKey(p);
            case "hotkey": return Actions.Hotkey(p);
            case "scroll": return Actions.Scroll(p);
            case "releaseInput": return new JsonObject { ["released"] = Input.ReleaseInput(p) };
            default:
                throw new HelperError("action_not_supported", $"unknown method \"{(method.Length > 40 ? method[..40] : method)}\"");
        }
    }
}
