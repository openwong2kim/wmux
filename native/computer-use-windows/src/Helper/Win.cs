// Win32 facts about windows, processes and the input desktop: enumeration,
// ownership, integrity levels. No UIA here, so every function is safe from any
// thread.

using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.Graphics.Dwm;
using Windows.Win32.Security;
using Windows.Win32.System.StationsAndDesktops;
using Windows.Win32.System.Threading;
using Windows.Win32.UI.WindowsAndMessaging;
using WmuxComputerUse.Core;

namespace WmuxComputerUse;

internal static unsafe class Win
{
    // Shell surfaces that are not app windows: the desktop and the taskbars.
    private static readonly HashSet<string> ShellClasses =
        ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

    /// <summary>Top-level windows in Z order (front first).</summary>
    public static List<HWND> TopLevelWindows()
    {
        var list = new List<HWND>();
        var handle = GCHandle.Alloc(list);
        try
        {
            PInvoke.EnumWindows(&CollectWindow, (LPARAM)GCHandle.ToIntPtr(handle));
        }
        finally
        {
            handle.Free();
        }
        return list;
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvStdcall)])]
    private static BOOL CollectWindow(HWND hwnd, LPARAM param)
    {
        var list = (List<HWND>)GCHandle.FromIntPtr((IntPtr)param.Value).Target!;
        list.Add(hwnd);
        return true;
    }

    /// <summary>
    /// The top-level windows a person can see: visible, not cloaked, not tool
    /// windows, not the desktop or taskbars. Owned windows (dialogs, owned
    /// popups) count too; WindowEntry reports their owner.
    /// </summary>
    public static bool IsAppWindow(HWND hwnd)
    {
        if (!PInvoke.IsWindowVisible(hwnd)) return false;
        var exStyle = (WINDOW_EX_STYLE)(uint)PInvoke.GetWindowLongPtr(hwnd, WINDOW_LONG_PTR_INDEX.GWL_EXSTYLE);
        if ((exStyle & WINDOW_EX_STYLE.WS_EX_TOOLWINDOW) != 0) return false;
        if (IsCloaked(hwnd)) return false;
        return !ShellClasses.Contains(ClassName(hwnd));
    }

    /// <summary>Cloaked windows (other virtual desktops, suspended UWP frames) are not on screen.</summary>
    public static bool IsCloaked(HWND hwnd)
    {
        int cloaked = 0;
        return PInvoke.DwmGetWindowAttribute(hwnd, DWMWINDOWATTRIBUTE.DWMWA_CLOAKED, &cloaked, sizeof(int)).Succeeded && cloaked != 0;
    }

    public static string Title(HWND hwnd)
    {
        Span<char> buffer = stackalloc char[512];
        int n = PInvoke.GetWindowText(hwnd, buffer);
        return n > 0 ? new string(buffer[..n]) : "";
    }

    public static string ClassName(HWND hwnd)
    {
        Span<char> buffer = stackalloc char[256];
        int n = PInvoke.GetClassName(hwnd, buffer);
        return n > 0 ? new string(buffer[..n]) : "";
    }

    public static uint OwnerPid(HWND hwnd)
    {
        PInvoke.GetWindowThreadProcessId(hwnd, out var pid);
        return pid;
    }

    /// <summary>
    /// The process that owns what a person sees in a window. A UWP app
    /// (Settings, Calculator) draws inside an ApplicationFrameHost.exe frame,
    /// so its real process is that of the frame's CoreWindow child; without
    /// this, main's blocklist would see "applicationframehost.exe" instead of
    /// "systemsettings.exe".
    /// </summary>
    public static uint EffectivePid(HWND hwnd)
    {
        uint pid = OwnerPid(hwnd);
        if (ClassName(hwnd) != "ApplicationFrameWindow") return pid;
        var state = new FrameChild { HostPid = pid };
        var handle = GCHandle.Alloc(state);
        try
        {
            PInvoke.EnumChildWindows(hwnd, &FindCoreWindow, (LPARAM)GCHandle.ToIntPtr(handle));
        }
        finally
        {
            handle.Free();
        }
        return state.ChildPid != 0 ? state.ChildPid : pid;
    }

    private sealed class FrameChild
    {
        public uint HostPid;
        public uint ChildPid;
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvStdcall)])]
    private static BOOL FindCoreWindow(HWND child, LPARAM param)
    {
        var state = (FrameChild)GCHandle.FromIntPtr((IntPtr)param.Value).Target!;
        if (ClassName(child) != "Windows.UI.Core.CoreWindow") return true;
        uint pid = OwnerPid(child);
        if (pid == state.HostPid) return true;
        state.ChildPid = pid;
        return false;
    }

    /// <summary>The top-level window a child, menu or dialog control belongs to.</summary>
    public static HWND Root(HWND hwnd) => hwnd == HWND.Null ? HWND.Null : PInvoke.GetAncestor(hwnd, GET_ANCESTOR_FLAGS.GA_ROOT);

    /// <summary>
    /// The window's visible frame in physical pixels: DWM's extended frame
    /// bounds, which leave out the invisible resize border and the shadow
    /// that GetWindowRect includes.
    /// </summary>
    public static Rect Bounds(HWND hwnd)
    {
        RECT r;
        if (PInvoke.DwmGetWindowAttribute(hwnd, DWMWINDOWATTRIBUTE.DWMWA_EXTENDED_FRAME_BOUNDS, &r, (uint)sizeof(RECT)).Failed)
        {
            PInvoke.GetWindowRect(hwnd, out r);
        }
        return new Rect(r.left, r.top, r.right - r.left, r.bottom - r.top);
    }

    public static Rect WindowRect(HWND hwnd)
    {
        PInvoke.GetWindowRect(hwnd, out var r);
        return new Rect(r.left, r.top, r.right - r.left, r.bottom - r.top);
    }

    public static HWND ParseWindowId(string id)
    {
        if (!long.TryParse(id, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var value) || value <= 0)
        {
            throw new HelperError("invalid_argument", "windowId must be a window id from listWindows");
        }
        return new HWND((void*)(nint)value);
    }

    public static string WindowId(HWND hwnd) => ((nint)hwnd.Value).ToString(System.Globalization.CultureInfo.InvariantCulture);

    // MARK: Processes

    public sealed record ProcessInfo(string Path, string Name, long Created);

    private static readonly Dictionary<uint, ProcessInfo> ProcessCache = new();
    private static readonly object ProcessLock = new();

    /// <summary>Exe path, display name and creation time of a process, or null when it cannot be opened.</summary>
    public static ProcessInfo? Process(uint pid)
    {
        var handle = PInvoke.OpenProcess(PROCESS_ACCESS_RIGHTS.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle.IsNull) return null;
        try
        {
            long created = CreationTime(handle);
            lock (ProcessLock)
            {
                if (ProcessCache.TryGetValue(pid, out var cached) && cached.Created == created) return cached;
            }
            char* buffer = stackalloc char[1024];
            uint size = 1024;
            if (!PInvoke.QueryFullProcessImageName(handle, PROCESS_NAME_FORMAT.PROCESS_NAME_WIN32, new PWSTR(buffer), &size)) return null;
            var path = new string(buffer, 0, (int)size);
            var info = new ProcessInfo(path, DisplayName(path), created);
            lock (ProcessLock) ProcessCache[pid] = info;
            return info;
        }
        finally
        {
            PInvoke.CloseHandle(handle);
        }
    }

    /// <summary>Creation time in FILETIME ticks, 0 when unknown; with the pid it names one process instance.</summary>
    public static long CreationTime(HANDLE process)
    {
        System.Runtime.InteropServices.ComTypes.FILETIME created, exited, kernel, user;
        if (!PInvoke.GetProcessTimes(process, &created, &exited, &kernel, &user)) return 0;
        return ((long)(uint)created.dwHighDateTime << 32) | (uint)created.dwLowDateTime;
    }

    /// <summary>Creation time of a running process, or null when it is not running (or cannot be opened).</summary>
    public static long? RunningCreationTime(uint pid)
    {
        var handle = PInvoke.OpenProcess(PROCESS_ACCESS_RIGHTS.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle.IsNull) return null;
        try
        {
            uint code;
            if (!PInvoke.GetExitCodeProcess(handle, &code) || code != 259 /* STILL_ACTIVE */) return null;
            return CreationTime(handle);
        }
        finally
        {
            PInvoke.CloseHandle(handle);
        }
    }

    /// <summary>The exe's FileDescription ("Notepad"), else its file name without `.exe`.</summary>
    private static string DisplayName(string path)
    {
        var fallback = System.IO.Path.GetFileNameWithoutExtension(path);
        try
        {
            uint size = PInvoke.GetFileVersionInfoSize(path, out _);
            if (size == 0 || size > 1 << 20) return fallback;
            var data = new byte[size];
            if (!PInvoke.GetFileVersionInfo(path, data)) return fallback;
            fixed (byte* p = data)
            {
                if (!PInvoke.VerQueryValue(p, "\\VarFileInfo\\Translation", out var trans, out var transLen) || transLen < 4) return fallback;
                ushort lang = ((ushort*)trans)[0], codepage = ((ushort*)trans)[1];
                var key = $"\\StringFileInfo\\{lang:x4}{codepage:x4}\\FileDescription";
                if (!PInvoke.VerQueryValue(p, key, out var value, out var len) || len <= 1) return fallback;
                var text = new string((char*)value).Trim();
                return text.Length > 0 ? text : fallback;
            }
        }
        catch (Exception)
        {
            return fallback;
        }
    }
}

/// <summary>Token integrity levels: who may send input to whom under UIPI.</summary>
internal static unsafe class Integrity
{
    private const uint HighRid = 0x3000;
    private static readonly uint? Self = Of(PInvoke.GetCurrentProcess(), closeProcess: false);

    /// <summary>The helper's own token is elevated (or High integrity or above).</summary>
    public static bool SelfIsElevated()
    {
        if (Self is null || Self >= HighRid) return true;
        HANDLE token;
        if (!PInvoke.OpenProcessToken(PInvoke.GetCurrentProcess(), TOKEN_ACCESS_MASK.TOKEN_QUERY, &token)) return true;
        try
        {
            TOKEN_ELEVATION elevation;
            uint len;
            if (!PInvoke.GetTokenInformation(token, TOKEN_INFORMATION_CLASS.TokenElevation, &elevation, (uint)sizeof(TOKEN_ELEVATION), &len)) return true;
            return elevation.TokenIsElevated != 0;
        }
        finally
        {
            PInvoke.CloseHandle(token);
        }
    }

    /// <summary>
    /// True when UIPI would silently drop our input into `pid`: its integrity
    /// is above ours, or cannot be read at all (a protected or elevated
    /// process usually refuses the token query). Fail closed.
    /// </summary>
    public static bool IsAboveSelf(uint pid)
    {
        if (Self is null) return true;
        var process = PInvoke.OpenProcess(PROCESS_ACCESS_RIGHTS.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process.IsNull) return true;
        var level = Of(process, closeProcess: true);
        return level is null || level > Self;
    }

    private static uint? Of(HANDLE process, bool closeProcess)
    {
        try
        {
            HANDLE token;
            if (!PInvoke.OpenProcessToken(process, TOKEN_ACCESS_MASK.TOKEN_QUERY, &token)) return null;
            try
            {
                uint len;
                PInvoke.GetTokenInformation(token, TOKEN_INFORMATION_CLASS.TokenIntegrityLevel, null, 0, &len);
                if (len == 0 || len > 4096) return null;
                byte* buffer = stackalloc byte[(int)len];
                if (!PInvoke.GetTokenInformation(token, TOKEN_INFORMATION_CLASS.TokenIntegrityLevel, buffer, len, &len)) return null;
                var label = (TOKEN_MANDATORY_LABEL*)buffer;
                var sid = label->Label.Sid;
                byte count = *PInvoke.GetSidSubAuthorityCount(sid);
                if (count == 0) return null;
                return *PInvoke.GetSidSubAuthority(sid, (uint)(count - 1));
            }
            finally
            {
                PInvoke.CloseHandle(token);
            }
        }
        finally
        {
            if (closeProcess) PInvoke.CloseHandle(process);
        }
    }
}

/// <summary>The desktop that receives input: the normal one, or the lock screen / UAC secure desktop.</summary>
internal static unsafe class InputDesktop
{
    /// <summary>
    /// True only when the input desktop is the person's "Default" desktop.
    /// While the screen is locked or a UAC / Ctrl+Alt+Del secure desktop is
    /// up, OpenInputDesktop fails or names another desktop, and SendInput
    /// would report success while delivering nothing (or to the wrong place).
    /// </summary>
    public static bool IsDefault()
    {
        var desk = PInvoke.OpenInputDesktop(0, false, DESKTOP_ACCESS_FLAGS.DESKTOP_READOBJECTS);
        if (desk.IsNull) return false;
        try
        {
            char* name = stackalloc char[64];
            uint needed;
            if (!PInvoke.GetUserObjectInformation((HANDLE)desk.Value, USER_OBJECT_INFORMATION_INDEX.UOI_NAME, name, 64 * sizeof(char), &needed)) return false;
            return string.Equals(new string(name), "Default", StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            PInvoke.CloseDesktop(desk);
        }
    }

    public static void Require()
    {
        if (!IsDefault())
        {
            throw new HelperError("window_not_focused", "the screen is locked or a secure desktop is shown; nothing was sent");
        }
    }
}
