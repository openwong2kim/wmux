// Apps and windows: listApps, listWindows, resolveTarget.
//
// An "app" is a process that owns at least one app window (visible, unowned,
// not cloaked, not a tool window). UWP windows count for the process inside
// their ApplicationFrameHost frame. Window ids are HWNDs in decimal; bounds
// are physical pixels (the helper is PerMonitorV2 aware).

using System.Text.Json.Nodes;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.UI.WindowsAndMessaging;
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

internal sealed record WindowEntry(HWND Hwnd, uint Pid, string Title, string ClassName, Rect Bounds, bool Focused, bool Minimized, HWND Owner)
{
    public string Id => Win.WindowId(Hwnd);

    public JsonObject Json(AppEntry app, string? shellLocation = null)
    {
        var o = new JsonObject
        {
            ["id"] = Id,
            ["appId"] = app.Id,
            ["pid"] = Pid,
            ["title"] = Title,
            ["bounds"] = new JsonObject { ["x"] = Bounds.X, ["y"] = Bounds.Y, ["width"] = Bounds.Width, ["height"] = Bounds.Height },
            // Lets main tell dialogs (#32770) and folder windows
            // (CabinetWClass) apart from other windows of the same exe.
            ["className"] = ClassName,
        };
        if (Owner != HWND.Null) o["ownerId"] = Win.WindowId(Owner);
        if (shellLocation != null) o["shellLocation"] = shellLocation;
        if (Focused) o["focused"] = true;
        if (Minimized) o["minimized"] = true;
        if (Integrity.IsAboveSelf(Pid)) o["elevated"] = true;
        return o;
    }
}

internal static unsafe class Apps
{
    private static readonly uint SelfPid = (uint)Environment.ProcessId;

    /// <summary>Visible top-level windows front to back (owned ones included), with the process each belongs to.</summary>
    public static List<WindowEntry> AllWindows()
    {
        var foreground = Win.Root(PInvoke.GetForegroundWindow());
        var list = new List<WindowEntry>();
        foreach (var hwnd in Win.TopLevelWindows())
        {
            if (!Win.IsAppWindow(hwnd)) continue;
            uint pid = Win.EffectivePid(hwnd);
            if (pid == 0 || pid == SelfPid) continue;
            var bounds = Win.Bounds(hwnd);
            bool minimized = PInvoke.IsIconic(hwnd);
            if (bounds.IsEmpty && !minimized) continue;
            list.Add(new WindowEntry(hwnd, pid, Win.Title(hwnd), Win.ClassName(hwnd), bounds,
                hwnd == foreground, minimized, PInvoke.GetWindow(hwnd, GET_WINDOW_CMD.GW_OWNER)));
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
    /// Every process a selector names. `pid:N` or a pid names one process;
    /// an id from listApps (the lower-cased exe path), an exe name with or
    /// without `.exe`, or a display name (case-insensitive) names every
    /// process of that app.
    /// </summary>
    public static List<AppEntry> FindAll(string selector, List<AppEntry> apps)
    {
        var s = selector.Trim();
        if (s.Length == 0) throw new HelperError("invalid_argument", "app is required");
        var pidText = s.StartsWith("pid:", StringComparison.Ordinal) ? s[4..] : s;
        if (uint.TryParse(pidText, out var pid))
        {
            var byPid = apps.FirstOrDefault(a => a.Pid == pid);
            if (byPid != null) return [byPid];
        }
        var lower = s.ToLowerInvariant();
        var exe = lower.EndsWith(".exe", StringComparison.Ordinal) ? lower : lower + ".exe";
        var matches = apps.Where(a => a.Id == lower || a.Name.ToLowerInvariant() == lower
            || System.IO.Path.GetFileName(a.Path).ToLowerInvariant() == exe).ToList();
        if (matches.Count == 0) throw new HelperError("app_not_found", $"no running app matches \"{Clip(s)}\"");
        return matches;
    }

    public static JsonObject ListWindows(string? selector)
    {
        var windows = AllWindows();
        var apps = Running(windows);
        var chosen = selector != null ? FindAll(selector, apps) : apps;
        var byPid = chosen.ToDictionary(a => a.Pid);
        var mine = windows.Where(w => byPid.ContainsKey(w.Pid)).ToList();
        var shell = Shell.Locations(mine);
        var result = new JsonArray();
        foreach (var w in mine)
        {
            result.Add((JsonNode)w.Json(byPid[w.Pid], shell.GetValueOrDefault((nint)w.Hwnd.Value)));
        }
        return new JsonObject { ["windows"] = result };
    }

    /// <summary>
    /// The window a selector names, across every process of the app: its id
    /// from listWindows, else a title (exact, then substring). No window
    /// selector means the focused window, then the first unowned one that is
    /// not minimized, then the first (front to back). When an app name or a
    /// title leaves windows of more than one process, the caller has to say
    /// which.
    /// </summary>
    public static (AppEntry App, WindowEntry Window) ResolveTarget(string appSelector, string? windowSelector)
    {
        var windows = AllWindows();
        var apps = FindAll(appSelector, Running(windows));
        var byPid = apps.ToDictionary(a => a.Pid);
        var own = windows.Where(w => byPid.ContainsKey(w.Pid)).ToList();
        if (own.Count == 0) throw new HelperError("window_not_found", $"{apps[0].Name} has no windows");

        if (!string.IsNullOrEmpty(windowSelector))
        {
            var byId = own.FirstOrDefault(w => w.Id == windowSelector);
            if (byId != null) return (byPid[byId.Pid], byId);
            var titled = own.Where(w => string.Equals(w.Title, windowSelector, StringComparison.OrdinalIgnoreCase)).ToList();
            if (titled.Count == 0) titled = own.Where(w => w.Title.Contains(windowSelector, StringComparison.OrdinalIgnoreCase)).ToList();
            if (titled.Count == 0) throw new HelperError("window_not_found", $"{apps[0].Name} has no window matching \"{Clip(windowSelector)}\"");
            RequireOneProcess(titled, apps);
            return (byPid[titled[0].Pid], titled[0]);
        }
        RequireOneProcess(own, apps);
        var window = own.FirstOrDefault(w => w.Focused)
            ?? own.FirstOrDefault(w => w.Owner == HWND.Null && !w.Minimized)
            ?? own.FirstOrDefault(w => !w.Minimized)
            ?? own[0];
        return (byPid[window.Pid], window);
    }

    private static void RequireOneProcess(List<WindowEntry> windows, List<AppEntry> apps)
    {
        int processes = windows.Select(w => w.Pid).Distinct().Count();
        if (processes <= 1) return;
        var exe = System.IO.Path.GetFileName(apps[0].Path);
        throw new HelperError("invalid_argument",
            $"{processes} processes of {(exe.Length > 0 ? exe : apps[0].Name)} have windows; pass a window id from listWindows or pid:N");
    }

    /// <summary>The window's JSON with its shell location when it is a folder window.</summary>
    public static JsonObject WindowJson(AppEntry app, WindowEntry window) =>
        window.Json(app, Shell.IsFolderWindow(window) ? Shell.Locations([window]).GetValueOrDefault((nint)window.Hwnd.Value) : null);

    private static string Clip(string s) => s.Length > 60 ? s[..60] : s;
}
