// Shell location of folder windows: for an explorer.exe folder window
// (CabinetWClass / ExploreWClass), the folder it shows, as its absolute
// parsing name. A filesystem folder is a path (C:\..., \\server\share\...);
// a shell namespace location (Control Panel, This PC) is "::{GUID}…".
//
// IShellWindows lists the shell's browser windows; the one with a matching
// HWND gives its view's folder. These are cross-process COM calls into
// explorer with no timeout of their own, so they run on a worker thread with
// a deadline; a lookup that does not finish in time leaves the field out,
// and while a stuck one is still running no new one starts.

using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.System.Com;
using Windows.Win32.System.Variant;
using Windows.Win32.UI.Shell;
using Windows.Win32.UI.Shell.Common;
using ComServiceProvider = Windows.Win32.System.Com.IServiceProvider;

namespace WmuxComputerUse;

internal static unsafe class Shell
{
    private const int DeadlineMs = 1500;
    private static readonly Guid ClsidShellWindows = new(0x9BA05972, 0xF6A8, 0x11CF, 0xA4, 0x42, 0x00, 0xA0, 0xC9, 0x0A, 0x8F, 0x39);
    private static int running;

    public static bool IsFolderWindow(WindowEntry w) => w.ClassName is "CabinetWClass" or "ExploreWClass";

    /// <summary>Shell locations of the folder windows among `windows`, by HWND; missing ones could not be determined.</summary>
    public static Dictionary<nint, string> Locations(IEnumerable<WindowEntry> windows)
    {
        var wanted = windows.Where(IsFolderWindow).Select(w => (nint)w.Hwnd.Value).ToHashSet();
        if (wanted.Count == 0) return [];
        if (Interlocked.CompareExchange(ref running, 1, 0) != 0) return [];
        var result = new Dictionary<nint, string>();
        var done = new ManualResetEventSlim(false);
        var thread = new Thread(() =>
        {
            try
            {
                PInvoke.CoInitializeEx(null, COINIT.COINIT_MULTITHREADED);
                var found = Lookup(wanted);
                lock (result)
                {
                    foreach (var kv in found) result[kv.Key] = kv.Value;
                }
            }
            catch (Exception)
            {
            }
            finally
            {
                done.Set();
                Volatile.Write(ref running, 0);
            }
        }) { IsBackground = true, Name = "computer-use shell" };
        thread.SetApartmentState(ApartmentState.MTA);
        thread.Start();
        long deadline = Environment.TickCount64 + DeadlineMs;
        while (!done.Wait(0) && Environment.TickCount64 < deadline) Sta.Sleep(5);
        lock (result)
        {
            // A late answer is dropped: the copy is taken now or never.
            return done.IsSet ? new Dictionary<nint, string>(result) : [];
        }
    }

    private static Dictionary<nint, string> Lookup(HashSet<nint> wanted)
    {
        var found = new Dictionary<nint, string>();
        var clsid = ClsidShellWindows;
        var iid = IShellWindows.IID_Guid;
        void* ppv;
        if (PInvoke.CoCreateInstance(&clsid, null, CLSCTX.CLSCTX_ALL, &iid, &ppv).Failed) return found;
        var windows = (IShellWindows*)ppv;
        try
        {
            int count = Math.Min(windows->Count, 256);
            for (int i = 0; i < count && found.Count < wanted.Count; i++)
            {
                var index = new VARIANT();
                index.vt = VARENUM.VT_I4;
                index.lVal = i;
                IDispatch* item = null;
                try
                {
                    item = windows->Item(index);
                    if (item == null) continue;
                    var location = LocationOf(item, wanted, out var hwnd);
                    if (location != null) found[hwnd] = location;
                }
                catch (Exception)
                {
                }
                finally
                {
                    if (item != null) item->Release();
                }
            }
        }
        finally
        {
            windows->Release();
        }
        return found;
    }

    private static string? LocationOf(IDispatch* item, HashSet<nint> wanted, out nint hwnd)
    {
        hwnd = 0;
        IWebBrowserApp* browser = null;
        ComServiceProvider* services = null;
        IShellBrowser* shellBrowser = null;
        IShellView* view = null;
        IFolderView* folderView = null;
        IPersistFolder2* folder = null;
        ITEMIDLIST* pidl = null;
        try
        {
            var iidBrowser = IWebBrowserApp.IID_Guid;
            if (item->QueryInterface(&iidBrowser, (void**)&browser).Failed) return null;
            hwnd = (nint)browser->HWND.Value;
            if (!wanted.Contains(hwnd)) return null;
            var iidServices = ComServiceProvider.IID_Guid;
            if (item->QueryInterface(&iidServices, (void**)&services).Failed) return null;
            var sid = PInvoke.SID_STopLevelBrowser;
            var iidShellBrowser = IShellBrowser.IID_Guid;
            services->QueryService(&sid, &iidShellBrowser, (void**)&shellBrowser);
            shellBrowser->QueryActiveShellView(&view);
            var iidFolderView = IFolderView.IID_Guid;
            if (view->QueryInterface(&iidFolderView, (void**)&folderView).Failed) return null;
            var iidFolder = IPersistFolder2.IID_Guid;
            folderView->GetFolder(&iidFolder, (void**)&folder);
            folder->GetCurFolder(&pidl);
            PWSTR name;
            if (PInvoke.SHGetNameFromIDList(pidl, SIGDN.SIGDN_DESKTOPABSOLUTEPARSING, &name).Failed) return null;
            try
            {
                var text = name.ToString();
                return string.IsNullOrEmpty(text) ? null : text;
            }
            finally
            {
                PInvoke.CoTaskMemFree(name.Value);
            }
        }
        finally
        {
            if (pidl != null) PInvoke.CoTaskMemFree(pidl);
            if (folder != null) folder->Release();
            if (folderView != null) folderView->Release();
            if (view != null) view->Release();
            if (shellBrowser != null) shellBrowser->Release();
            if (services != null) services->Release();
            if (browser != null) browser->Release();
        }
    }
}
