// Apps and windows: listApps, listWindows, resolveTarget.
//
// An "app" is a process that owns at least one app window (visible, unowned,
// not cloaked, not a tool window). UWP windows count for the process inside
// their ApplicationFrameHost frame. Window ids are HWNDs in decimal; bounds
// are physical pixels (the helper is PerMonitorV2 aware).

using System.Text.Json.Nodes;
using Windows.Win32;
using Windows.Win32.Foundation;
using WmuxComputerUse.Core;

namespace WmuxComputerUse;

internal sealed record AppEntry(uint Pid, string Path, string Name, bool Frontmost)
{
    /// <summary>Stable id: the lower-cased exe path (protocol AppInfo.id).</summary>
    public string Id => Path.Length > 0 ? Path.ToLowerInvariant() : $"pid:{Pid}";

    public JsonObject Json()
    {
        var o = new JsonObject { ["id"] = Id, ["name"] = Name, ["pid"] = Pid, ["path"] = Path };
        if (Frontmost) o["frontmost"] = true;
        return o;
    }
}

internal sealed record WindowEntry(HWND Hwnd, uint Pid, string Title, string ClassName, Rect Bounds, bool Focused, bool Minimized)
{
    public string Id => Win.WindowId(Hwnd);

    public JsonObject Json(AppEntry app)
    {
        var o = new JsonObject
        {
            ["id"] = Id,
            ["appId"] = app.Id,
            ["pid"] = Pid,
            ["title"] = Title,
            ["bounds"] = new JsonObject { ["x"] = Bounds.X, ["y"] = Bounds.Y, ["width"] = Bounds.Width, ["height"] = Bounds.Height },
            // Diagnostic: lets main tell Explorer's Run dialog (#32770) and
            // Control Panel / File Explorer frames (CabinetWClass) apart from
            // other explorer.exe windows.
            ["className"] = ClassName,
        };
        if (Focused) o["focused"] = true;
        if (Minimized) o["minimized"] = true;
        if (Integrity.IsAboveSelf(Pid)) o["elevated"] = true;
        return o;
    }
}

internal static class Apps
{
    private static readonly uint SelfPid = (uint)Environment.ProcessId;

    /// <summary>App windows front to back, with the process each belongs to.</summary>
    public static List<WindowEntry> AllWindows()
    {
        var foreground = Win.Root(PInvoke.GetForegroundWindow());
        var list = new List<WindowEntry>();
        foreach (var hwnd in Win.TopLevelWindows())
        {
            if (!Win.IsAppWindow(hwnd)) continue;
            uint pid = Win.EffectivePid(hwnd);
            if (pid == 0 || pid == SelfPid) continue;
            list.Add(new WindowEntry(hwnd, pid, Win.Title(hwnd), Win.ClassName(hwnd), Win.Bounds(hwnd),
                hwnd == foreground, PInvoke.IsIconic(hwnd)));
        }
        return list;
    }

    public static List<AppEntry> Running(List<WindowEntry>? windows = null)
    {
        windows ??= AllWindows();
        var foregroundPid = Win.EffectivePid(Win.Root(PInvoke.GetForegroundWindow()));
        var apps = new List<AppEntry>();
        var seen = new HashSet<uint>();
        foreach (var w in windows)
        {
            if (!seen.Add(w.Pid)) continue;
            var info = Win.Process(w.Pid);
            apps.Add(new AppEntry(w.Pid, info?.Path ?? "", info?.Name ?? $"pid {w.Pid}", w.Pid == foregroundPid));
        }
        return apps;
    }

    public static JsonObject ListApps() =>
        new() { ["apps"] = new JsonArray(Running().Select(a => (JsonNode)a.Json()).ToArray()) };

    /// <summary>
    /// Accepts what listApps returns (`id` = lower-cased exe path or `pid:N`),
    /// a pid, an exe name with or without `.exe`, or a display name
    /// (case-insensitive). Several instances prefer the frontmost one.
    /// </summary>
    public static AppEntry Find(string selector, List<AppEntry> apps)
    {
        var s = selector.Trim();
        if (s.Length == 0) throw new HelperError("invalid_argument", "app is required");
        var pidText = s.StartsWith("pid:", StringComparison.Ordinal) ? s[4..] : s;
        if (uint.TryParse(pidText, out var pid))
        {
            var byPid = apps.FirstOrDefault(a => a.Pid == pid);
            if (byPid != null) return byPid;
        }
        var lower = s.ToLowerInvariant();
        var exe = lower.EndsWith(".exe", StringComparison.Ordinal) ? lower : lower + ".exe";
        var candidates = apps.Where(a => a.Id == lower)
            .Concat(apps.Where(a => a.Name.ToLowerInvariant() == lower))
            .Concat(apps.Where(a => System.IO.Path.GetFileName(a.Path).ToLowerInvariant() == exe))
            .ToList();
        if (candidates.Count == 0) throw new HelperError("app_not_found", $"no running app matches \"{Clip(s)}\"");
        return candidates.FirstOrDefault(a => a.Frontmost) ?? candidates[0];
    }

    public static JsonObject ListWindows(string? selector)
    {
        var windows = AllWindows();
        var apps = Running(windows);
        var chosen = selector != null ? [Find(selector, apps)] : apps;
        var result = new JsonArray();
        foreach (var app in chosen)
        {
            foreach (var w in windows.Where(w => w.Pid == app.Pid)) result.Add((JsonNode)w.Json(app));
        }
        return new JsonObject { ["windows"] = result };
    }

    /// <summary>
    /// The window a selector names: its id from listWindows, else a title
    /// (exact, then substring). No selector means the focused window, then
    /// the first one that is not minimized (front to back).
    /// </summary>
    public static (AppEntry App, WindowEntry Window) ResolveTarget(string appSelector, string? windowSelector)
    {
        var windows = AllWindows();
        var app = Find(appSelector, Running(windows));
        var own = windows.Where(w => w.Pid == app.Pid).ToList();
        if (own.Count == 0) throw new HelperError("window_not_found", $"{app.Name} has no windows");
        if (!string.IsNullOrEmpty(windowSelector))
        {
            var w = own.FirstOrDefault(w => w.Id == windowSelector)
                ?? own.FirstOrDefault(w => string.Equals(w.Title, windowSelector, StringComparison.OrdinalIgnoreCase))
                ?? own.FirstOrDefault(w => w.Title.Contains(windowSelector, StringComparison.OrdinalIgnoreCase));
            return w != null ? (app, w) : throw new HelperError("window_not_found", $"{app.Name} has no window matching \"{Clip(windowSelector)}\"");
        }
        return (app, own.FirstOrDefault(w => w.Focused) ?? own.FirstOrDefault(w => !w.Minimized) ?? own[0]);
    }

    private static string Clip(string s) => s.Length > 60 ? s[..60] : s;
}
