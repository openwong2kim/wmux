// Request dispatch: one NDJSON request in, exactly one response out, on the STA thread.

using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using WmuxComputerUse.Core;

namespace WmuxComputerUse;

internal static class Server
{
    /// <summary>src/shared/computer/protocol.ts COMPUTER_PROTOCOL_VERSION.</summary>
    public const int ProtocolVersion = 2;

    /// <summary>Methods whose errors say whether input was sent (protocol ActionDisposition).</summary>
    private static readonly string[] ControlMethods = ["click", "setValue", "type", "pressKey", "hotkey", "scroll"];

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
        // Every method this helper answers, internal ones included; `actions`
        // stays the agent-facing set, because main passes it to the agent.
        ["methods"] = new JsonArray(AgentActions.Concat(["resolveTarget", "releaseInput"]).Select(m => (JsonNode)m).ToArray()),
        ["modes"] = new JsonArray("ax", "vision", "both"),
        ["permissions"] = new JsonObject { ["accessibility"] = true, ["screenRecording"] = true },
        // Background input (BackgroundInput.cs): a posted left click leaves
        // the cursor alone; nothing gives a window focus without the app
        // taking it itself; posted keys reach Chromium-based apps after a
        // posted click on the field.
        ["input"] = new JsonObject
        {
            ["backgroundPointer"] = true,
            ["focusWithoutRaise"] = false,
            ["keyAuth"] = true,
            // Honours `foreground: 'refuse'` (answers needs_foreground
            // instead of real input), so main can run input in per-app lanes.
            ["deferForeground"] = true,
        },
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
        // Dispositions and needs_foreground compare Input.Sent around one
        // request, so they are true only while requests run one at a time
        // (Core RequestGate). The loop is single-threaded; this asserts it.
        if (!Gate.TryEnter())
        {
            Wire.Log("a request arrived while another was in flight; refused before sending anything");
            Wire.Send(Error(id, "internal", "the computer-use helper was already running a request; nothing was sent",
                ControlMethods.Contains(method) ? "not_delivered" : null), id);
            return;
        }
        long sentBefore = Input.Sent;
        try
        {
            var result = Dispatch(method, p, ref sentBefore);
            Wire.Send(new JsonObject { ["id"] = id, ["ok"] = true, ["result"] = result }, id);
        }
        catch (HelperError e)
        {
            Wire.Send(Error(id, e.Code, e.Message, Disposition(method, sentBefore)), id);
        }
        catch (Exception e)
        {
            Wire.Send(Error(id, Uia.ErrorCode(e), Uia.Describe(e), Disposition(method, sentBefore)), id);
        }
        finally
        {
            Gate.Exit();
        }
    }

    private static readonly RequestGate Gate = new();

    /// <summary>
    /// A control method's error says whether it sent anything: main may retry
    /// only a `not_delivered` one. Input.Sent counts every input event,
    /// posted message and UIA pattern call that may have reached an app.
    /// </summary>
    private static string? Disposition(string method, long sentBefore) =>
        !ControlMethods.Contains(method) ? null : Input.Sent == sentBefore ? "not_delivered" : "delivered_unverified";

    private static JsonObject Error(int id, string code, string message, string? disposition = null)
    {
        var error = new JsonObject { ["code"] = code, ["message"] = message };
        if (disposition != null) error["disposition"] = disposition;
        return new JsonObject { ["id"] = id, ["ok"] = false, ["error"] = error };
    }

    /// <remarks>
    /// `sentBefore` is this request's baseline for Disposition. It is taken
    /// again after the orphan release: up events a dead helper's keys needed
    /// are not this action's input, so they can never make an action's
    /// `needs_foreground` or `not_delivered` untrue, nor be mistaken for it
    /// (the actions take their own baseline after this point too).
    /// </remarks>
    private static JsonNode Dispatch(string method, Params p, ref long sentBefore)
    {
        // Never act on the lock screen or a UAC / Ctrl+Alt+Del secure
        // desktop, and say why windows "vanished".
        if (method is not ("capabilities" or "listApps" or "releaseInput")) InputDesktop.Require();
        // A dead helper's held keys go up before this one sends anything.
        if (method is "click" or "setValue" or "type" or "pressKey" or "hotkey" or "scroll")
        {
            Input.EnsureOrphansReleased();
            sentBefore = Input.Sent;
        }
        switch (method)
        {
            case "capabilities": return Capabilities();
            case "listApps": return Apps.ListApps();
            case "listWindows": return Apps.ListWindows(p.String("app"));
            case "resolveTarget":
            {
                var (app, window) = Apps.ResolveTarget(p.RequireString("app"), p.String("window"));
                return new JsonObject { ["app"] = app.Json(), ["window"] = Apps.WindowJson(app, window) };
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
