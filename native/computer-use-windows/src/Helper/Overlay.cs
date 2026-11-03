// The agent overlay. Every agent that drives an app gets its own marker, in
// the colour main gave it (src/shared/computer/agentMarker.ts; the rules are
// in Core/Markers.cs, the same as the macOS helper's):
//   - a 3 px ring around its target window and a name pill above the
//     window's top-left ("● #api-1 · Claude Code · typing"). A second agent
//     on the same window rings 3 px outside the first, its pill beside the
//     first one's;
//   - click and scroll (UIA Invoke included): its own pointer, an arrow in
//     its colour with a name chip, which moves to each point and pulses on
//     press;
//   - keyboard actions and setValue: a caret at the insertion point, with
//     the chip;
//   - real input: the pill inverted (" · using your mouse"), and for pointer
//     actions a ring where the real pointer goes instead of the arrow;
//   - waiting for another agent's real input (markerWait): ring and pill
//     dimmed, " · waiting for <agent>".
// Each marker fades 1.5 s after its own last action, a waiting one 15 s
// after markerWait; markerClear removes it at once. While any marker shows,
// a dark bar at the top of the primary monitor counts them and carries the
// stop chord. Pills, pointers and carets draw above every ring.
//
// One topmost, click-through, never-activating layered tool window per
// monitor (WS_EX_LAYERED | TRANSPARENT | TOOLWINDOW | NOACTIVATE | TOPMOST),
// drawn with GDI+ into a premultiplied 32-bit DIB and put on screen with
// UpdateLayeredWindow. WS_EX_TRANSPARENT keeps it out of WindowFromPoint (the
// helper's own pointer check) and out of the mouse; WS_EX_TOOLWINDOW keeps it
// out of listWindows and the taskbar; it is left out of screen captures
// (WDA_EXCLUDEFROMCAPTURE) unless WMUX_OVERLAY_CAPTURABLE=1 is in the
// helper's environment (dev screenshots).
//
// Everything is drawn on a thread of its own, started on first use: a
// request only posts a command and goes on, so drawing never delays input
// and never runs between a request's last safety check and its first key.

using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.Graphics.Gdi;
using Windows.Win32.Graphics.GdiPlus;
using Windows.Win32.UI.HiDpi;
using Windows.Win32.UI.WindowsAndMessaging;
using WmuxComputerUse.Core;

namespace WmuxComputerUse;

internal static unsafe class Overlay
{
    private static volatile bool enabled = true;
    private static readonly ConcurrentQueue<Action> Commands = new();
    private static readonly AutoResetEvent Wake = new(false);
    private static int started;

    /// <summary>Dev only: `WMUX_OVERLAY_CAPTURABLE=1` lets screen captures include the overlay.</summary>
    internal static readonly bool Capturable = Environment.GetEnvironmentVariable("WMUX_OVERLAY_CAPTURABLE") == "1";

    /// <summary>The overlay is on until `configure { overlay: false }`.</summary>
    public static bool Enabled => enabled;

    public static void SetEnabled(bool on)
    {
        enabled = on;
        if (!on) Hide();
    }

    /// <summary>
    /// Draws `marker` for an input action on `window`. With `pointer`, moves
    /// the marker's pointer there; with `caret`, draws its caret there.
    /// `realInput`: the action uses the user's own pointer or keyboard.
    /// </summary>
    public static void Show(AgentMarker marker, MarkerVerb verb, ControlTarget target, (double X, double Y)? pointer = null, Rect? caret = null, bool realInput = false)
    {
        if (!enabled) return;
        Post(() => Engine.Show(marker, verb, target, pointer, caret, realInput));
    }

    /// <summary>markerWait: `marker` waits on the target window for another agent's real input.</summary>
    public static void Wait(AgentMarker marker, ControlTarget target, string waitingFor)
    {
        if (!enabled) return;
        Post(() => Engine.Wait(marker, target, waitingFor));
    }

    /// <summary>A ring in the marker's colour that pulses out from the press point.</summary>
    public static void Press(string id, double x, double y)
    {
        if (!enabled) return;
        Post(() => Engine.Press(id, x, y));
    }

    /// <summary>After an input action: that marker fades unless it acts again first.</summary>
    public static void ScheduleFade(string id)
    {
        if (Volatile.Read(ref started) == 0) return;
        Post(() => Engine.ScheduleFade(id, Markers.FadeDelayMs));
    }

    /// <summary>markerClear: that marker goes now.</summary>
    public static void Clear(string id)
    {
        if (Volatile.Read(ref started) == 0) return;
        Post(() => Engine.Clear(id));
    }

    /// <summary>Every marker, now: releaseInput, the stop key, the overlay switched off.</summary>
    public static void Hide()
    {
        if (Volatile.Read(ref started) == 0) return;
        Post(Engine.HideAll);
    }

    private static void Post(Action command)
    {
        if (Interlocked.Exchange(ref started, 1) == 0)
        {
            var thread = new Thread(Engine.Run) { IsBackground = true, Name = "agent overlay" };
            thread.Start();
        }
        Commands.Enqueue(command);
        Wake.Set();
    }

    /// <summary>The overlay thread: all state and every window live here.</summary>
    private static class Engine
    {
        private const double PillHeight = 24, PillGap = 6, PillLift = 4, ChipHeight = 18, BarHeight = 28;
        private const int BarMaxDots = 16;
        /// <summary>The corner radius of a Windows 11 window, which the innermost ring follows.</summary>
        private const double WindowRadius = 8;
        private const int FramePollMs = 100;
        private const int AnimationFrameMs = 16;

        private sealed class State(AgentMarker marker, long created)
        {
            public AgentMarker Marker = marker;
            public readonly long Created = created;
            public HWND Window;
            /// <summary>The pid the window belongs to: a handle reused by another app loses the ring.</summary>
            public uint Pid;
            public long Arrival;
            public MarkerVerb Verb = MarkerVerb.Clicking;
            public bool RealInput;
            /// <summary>0: none; 1: pointer; 2: caret.</summary>
            public int Spot;
            public double FromX, FromY, ToX, ToY;
            public long MoveStart;
            public bool Moving;
            public Rect Caret;
            public (double X, double Y)? LastPointer;
            public long FadeAt = long.MaxValue;
            public bool Fading;
            public long FadeStart;
            public long PulseStart = -1;
            public double PulseX, PulseY;
        }

        private sealed class Monitor
        {
            public RECT Bounds, Work;
            public double Scale;
            public bool Primary;
            public HWND Hwnd;
            public HDC Dc;
            public HBITMAP Bitmap;
            public HGDIOBJ Previous;
            public GpBitmap* Image;
            public GpGraphics* Graphics;
            /// <summary>The DIB's pixels: premultiplied BGRA, top-down, Width * 4 bytes a row.</summary>
            public void* Bits;
            public bool Shown;
            public int Width => Bounds.right - Bounds.left;
            public int Height => Bounds.bottom - Bounds.top;
        }

        private static readonly Dictionary<string, State> States = new(StringComparer.Ordinal);
        private static readonly List<Monitor> Monitors = [];
        private static readonly Dictionary<nint, Rect?> Frames = [];
        private static long sequence;
        private static bool dirty;
        /// <summary>The monitors as last read, failed windows included, so a monitor whose window could not be made is not retried every frame.</summary>
        private static List<(RECT Bounds, RECT Work, double Scale, bool Primary)> layout = [];
        private static bool rescan = true;
        private static long lastScan;
        private const int ScanIntervalMs = 1000;
        private static long nextFramePoll;
        private static bool failed;
        private static readonly char[] ClassName = "wmux-agent-overlay\0".ToCharArray();

        private static long Now => Environment.TickCount64;

        public static void Run()
        {
            try
            {
                Start();
            }
            catch (Exception e)
            {
                Wire.Log($"agent overlay: could not start ({e.Message}); no markers are drawn");
                failed = true;
            }
            var handle = new HANDLE(Wake.SafeWaitHandle.DangerousGetHandle());
            while (true)
            {
                uint timeout = Timeout();
                PInvoke.MsgWaitForMultipleObjectsEx(1, &handle, timeout, QUEUE_STATUS_FLAGS.QS_ALLINPUT, MSG_WAIT_FOR_MULTIPLE_OBJECTS_EX_FLAGS.MWMO_INPUTAVAILABLE);
                Pump();
                while (Commands.TryDequeue(out var command))
                {
                    if (failed) continue;
                    try
                    {
                        command();
                    }
                    catch (Exception e)
                    {
                        Wire.Log($"agent overlay: {e.Message}");
                    }
                    dirty = true;
                }
                if (failed) continue;
                try
                {
                    Tick();
                }
                catch (Exception e)
                {
                    Wire.Log($"agent overlay: drawing failed ({e.Message}); markers cleared");
                    States.Clear();
                    HideWindows();
                }
            }
        }

        private static void Start()
        {
            var input = new GdiplusStartupInput { GdiplusVersion = 1 };
            nuint token;
            var status = PInvoke.GdiplusStartup(&token, &input, null);
            if (status != Status.Ok) throw new InvalidOperationException($"GDI+ did not start ({status})");
            fixed (char* name = ClassName)
            {
                var wc = new WNDCLASSEXW
                {
                    cbSize = (uint)sizeof(WNDCLASSEXW),
                    lpfnWndProc = &WndProc,
                    hInstance = (HINSTANCE)(nint)PInvoke.GetModuleHandle((PCWSTR)null).Value,
                    lpszClassName = name,
                };
                if (PInvoke.RegisterClassEx(&wc) == 0) throw new InvalidOperationException("the overlay window class could not be registered");
            }
        }

        [UnmanagedCallersOnly(CallConvs = [typeof(CallConvStdcall)])]
        private static LRESULT WndProc(HWND hwnd, uint msg, WPARAM wParam, LPARAM lParam)
        {
            switch (msg)
            {
                case PInvoke.WM_NCHITTEST:
                    return new LRESULT(-1); // HTTRANSPARENT
                case PInvoke.WM_MOUSEACTIVATE:
                    return new LRESULT(3); // MA_NOACTIVATE
                case PInvoke.WM_DISPLAYCHANGE:
                case PInvoke.WM_DPICHANGED:
                case 0x001A: // WM_SETTINGCHANGE (the work area moved)
                    // Read the monitors again; only a changed set rebuilds the windows.
                    rescan = true;
                    dirty = true;
                    break;
            }
            return PInvoke.DefWindowProc(hwnd, msg, wParam, lParam);
        }

        private static void Pump()
        {
            MSG msg;
            while (PInvoke.PeekMessage(&msg, HWND.Null, 0, 0, PEEK_MESSAGE_REMOVE_TYPE.PM_REMOVE))
            {
                PInvoke.TranslateMessage(&msg);
                PInvoke.DispatchMessage(&msg);
            }
        }

        private static bool ReduceMotion
        {
            get
            {
                BOOL on = true;
                // SPI_GETCLIENTAREAANIMATION: off is Settings › Accessibility › Animation effects off.
                if (!PInvoke.SystemParametersInfo((SYSTEM_PARAMETERS_INFO_ACTION)0x1042, 0, &on, 0)) return false;
                return !on;
            }
        }

        // MARK: Commands

        public static void Show(AgentMarker marker, MarkerVerb verb, ControlTarget target, (double X, double Y)? pointer, Rect? caret, bool realInput)
        {
            var s = Begin(marker, target);
            s.Verb = verb;
            s.RealInput = realInput;
            if (pointer is { } to)
            {
                bool animate = !ReduceMotion;
                // Real input moves the user's pointer: its ring starts there.
                var start = realInput ? null : s.LastPointer;
                var from = animate ? start ?? CursorPosition() ?? to : to;
                s.Spot = 1;
                (s.FromX, s.FromY, s.ToX, s.ToY) = (from.X, from.Y, to.X, to.Y);
                s.MoveStart = Now;
                s.Moving = animate && (from.X != to.X || from.Y != to.Y);
                s.LastPointer = to;
            }
            else if (caret is { } c)
            {
                s.Spot = 2;
                s.Caret = c;
                s.Moving = false;
            }
            else
            {
                s.Spot = 0;
                s.Moving = false;
            }
        }

        public static void Wait(AgentMarker marker, ControlTarget target, string waitingFor)
        {
            var s = Begin(marker, target);
            s.Verb = MarkerVerb.Waiting(waitingFor);
            s.RealInput = false;
            s.Spot = 0;
            s.Moving = false;
            s.FadeAt = Now + Markers.WaitFadeDelayMs;
        }

        public static void Press(string id, double x, double y)
        {
            if (!States.TryGetValue(id, out var s) || ReduceMotion) return;
            s.PulseStart = Now;
            (s.PulseX, s.PulseY) = (x, y);
        }

        public static void ScheduleFade(string id, int delayMs)
        {
            if (States.TryGetValue(id, out var s) && !s.Fading && !s.Verb.IsWaiting) s.FadeAt = Now + delayMs;
        }

        public static void Clear(string id) => States.Remove(id);

        public static void HideAll() => States.Clear();

        /// <summary>The marker's state for a new action: its fade called off, its ring on the target window.</summary>
        private static State Begin(AgentMarker marker, ControlTarget target)
        {
            sequence++;
            if (!States.TryGetValue(marker.Id, out var s))
            {
                s = new State(marker, sequence);
                States[marker.Id] = s;
            }
            s.Marker = marker;
            s.FadeAt = long.MaxValue;
            s.Fading = false;
            if (s.Window != target.Window || s.Pid != target.Pid)
            {
                s.Window = target.Window;
                s.Pid = target.Pid;
                s.Arrival = sequence;
            }
            return s;
        }

        private static (double X, double Y)? CursorPosition() =>
            PInvoke.GetCursorPos(out var p) ? (p.X, p.Y) : null;

        // MARK: Time

        private static bool Animating(long now)
        {
            foreach (var s in States.Values)
            {
                if (s.Moving || s.Fading || (s.PulseStart >= 0 && now - s.PulseStart < Markers.PulseDurationMs)) return true;
            }
            return false;
        }

        private static uint Timeout()
        {
            if (States.Count == 0) return uint.MaxValue; // INFINITE
            long now = Now;
            if (Animating(now)) return AnimationFrameMs;
            long next = nextFramePoll;
            foreach (var s in States.Values) next = Math.Min(next, s.FadeAt);
            return (uint)Math.Clamp(next - now, 1, FramePollMs);
        }

        private static void Tick()
        {
            long now = Now;
            bool reduce = false, readReduce = false;
            foreach (var id in States.Keys.ToList())
            {
                var s = States[id];
                if (!s.Fading && now >= s.FadeAt)
                {
                    if (!readReduce)
                    {
                        reduce = ReduceMotion;
                        readReduce = true;
                    }
                    if (reduce)
                    {
                        States.Remove(id);
                    }
                    else
                    {
                        s.Fading = true;
                        s.FadeStart = now;
                    }
                    dirty = true;
                }
                else if (s.Fading && now - s.FadeStart >= Markers.FadeDurationMs)
                {
                    States.Remove(id);
                    dirty = true;
                }
            }
            // Windows move: their rings follow.
            if (now >= nextFramePoll)
            {
                nextFramePoll = now + FramePollMs;
                if (ReadFrames()) dirty = true;
            }
            if (dirty || Animating(now))
            {
                dirty = false;
                Render(now);
            }
        }

        /// <summary>The current frame of every marked window; true when any changed.</summary>
        private static bool ReadFrames()
        {
            bool changed = false;
            var live = new HashSet<nint>();
            foreach (var s in States.Values)
            {
                if (s.Window == HWND.Null) continue;
                nint key = (nint)s.Window.Value;
                if (!live.Add(key)) continue;
                Rect? frame = PInvoke.IsWindow(s.Window) && Win.EffectivePid(s.Window) == s.Pid && Win.IsShown(s.Window) && !PInvoke.IsIconic(s.Window)
                    ? Win.Bounds(s.Window)
                    : null;
                if (!Frames.TryGetValue(key, out var old) || old != frame) changed = true;
                Frames[key] = frame;
            }
            foreach (var key in Frames.Keys.ToList())
            {
                if (!live.Contains(key)) Frames.Remove(key);
            }
            return changed;
        }

        // MARK: Monitors

        private static readonly List<HMONITOR> Enumerated = [];

        [UnmanagedCallersOnly(CallConvs = [typeof(CallConvStdcall)])]
        private static BOOL CollectMonitor(HMONITOR monitor, HDC dc, RECT* clip, LPARAM data)
        {
            Enumerated.Add(monitor);
            return true;
        }

        private static List<(RECT Bounds, RECT Work, double Scale, bool Primary)> ReadMonitors()
        {
            Enumerated.Clear();
            PInvoke.EnumDisplayMonitors(HDC.Null, null, &CollectMonitor, default);
            var list = new List<(RECT, RECT, double, bool)>();
            foreach (var m in Enumerated)
            {
                var info = new MONITORINFO { cbSize = (uint)sizeof(MONITORINFO) };
                if (!PInvoke.GetMonitorInfo(m, &info)) continue;
                double scale = PInvoke.GetDpiForMonitor(m, MONITOR_DPI_TYPE.MDT_EFFECTIVE_DPI, out var dpi, out _).Succeeded && dpi > 0 ? dpi / 96.0 : 1;
                list.Add((info.rcMonitor, info.rcWork, scale, (info.dwFlags & 1) != 0 /* MONITORINFOF_PRIMARY */));
            }
            return list;
        }

        /// <summary>
        /// One window per monitor, rebuilt only when the set of monitors (their
        /// bounds or scale) changed. Read on a display or settings message,
        /// and at most once a second otherwise.
        /// </summary>
        private static void EnsureMonitors(long now)
        {
            if (!rescan && layout.Count > 0 && now - lastScan < ScanIntervalMs) return;
            rescan = false;
            lastScan = now;
            var read = ReadMonitors();
            bool same = read.Count == layout.Count;
            for (int i = 0; same && i < read.Count; i++)
            {
                same = Same(read[i].Bounds, layout[i].Bounds) && read[i].Scale == layout[i].Scale;
            }
            layout = read;
            if (same)
            {
                // The work area (a moved taskbar) needs no new window.
                foreach (var m in Monitors)
                {
                    foreach (var r in read)
                    {
                        if (Same(r.Bounds, m.Bounds)) (m.Work, m.Primary) = (r.Work, r.Primary);
                    }
                }
                return;
            }
            DestroyAll();
            foreach (var (bounds, work, scale, primary) in read)
            {
                var m = Create(bounds, work, scale, primary);
                if (m != null) Monitors.Add(m);
            }
        }

        /// <summary>Every window and bitmap; the next marker makes them again.</summary>
        private static void DestroyAll()
        {
            foreach (var m in Monitors) Destroy(m);
            Monitors.Clear();
        }

        private static bool Same(RECT a, RECT b) => a.left == b.left && a.top == b.top && a.right == b.right && a.bottom == b.bottom;

        private static Monitor? Create(RECT bounds, RECT work, double scale, bool primary)
        {
            var m = new Monitor { Bounds = bounds, Work = work, Scale = scale, Primary = primary };
            if (m.Width <= 0 || m.Height <= 0) return null;
            fixed (char* name = ClassName)
            {
                m.Hwnd = PInvoke.CreateWindowEx(
                    WINDOW_EX_STYLE.WS_EX_LAYERED | WINDOW_EX_STYLE.WS_EX_TRANSPARENT | WINDOW_EX_STYLE.WS_EX_TOOLWINDOW
                        | WINDOW_EX_STYLE.WS_EX_NOACTIVATE | WINDOW_EX_STYLE.WS_EX_TOPMOST,
                    name, (PCWSTR)null, WINDOW_STYLE.WS_POPUP,
                    bounds.left, bounds.top, m.Width, m.Height, HWND.Null, HMENU.Null, HINSTANCE.Null, null);
            }
            if (m.Hwnd == HWND.Null)
            {
                Wire.Log("agent overlay: a monitor's window could not be created");
                return null;
            }
            if (!Capturable) PInvoke.SetWindowDisplayAffinity(m.Hwnd, WINDOW_DISPLAY_AFFINITY.WDA_EXCLUDEFROMCAPTURE);
            var bmi = new BITMAPINFO();
            bmi.bmiHeader.biSize = (uint)sizeof(BITMAPINFOHEADER);
            bmi.bmiHeader.biWidth = m.Width;
            bmi.bmiHeader.biHeight = -m.Height; // top-down
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = 0; // BI_RGB
            void* bits;
            m.Dc = PInvoke.CreateCompatibleDC(HDC.Null);
            m.Bitmap = PInvoke.CreateDIBSection(m.Dc, &bmi, DIB_USAGE.DIB_RGB_COLORS, &bits, HANDLE.Null, 0);
            if (m.Bitmap.IsNull || bits == null)
            {
                Wire.Log("agent overlay: a monitor's bitmap could not be created");
                Destroy(m);
                return null;
            }
            m.Bits = bits;
            m.Previous = PInvoke.SelectObject(m.Dc, (HGDIOBJ)m.Bitmap.Value);
            GpBitmap* image;
            const int PixelFormat32bppPARGB = 0x000E200B;
            if (PInvoke.GdipCreateBitmapFromScan0(m.Width, m.Height, m.Width * 4, PixelFormat32bppPARGB, (byte*)bits, &image) != Status.Ok)
            {
                Destroy(m);
                return null;
            }
            m.Image = image;
            GpGraphics* g;
            if (PInvoke.GdipGetImageGraphicsContext((GpImage*)image, &g) != Status.Ok)
            {
                Destroy(m);
                return null;
            }
            m.Graphics = g;
            PInvoke.GdipSetSmoothingMode(g, SmoothingMode.SmoothingModeAntiAlias);
            PInvoke.GdipSetPixelOffsetMode(g, PixelOffsetMode.PixelOffsetModeHalf);
            PInvoke.GdipSetTextRenderingHint(g, TextRenderingHint.TextRenderingHintAntiAliasGridFit);
            return m;
        }

        private static void Destroy(Monitor m)
        {
            if (m.Graphics != null) PInvoke.GdipDeleteGraphics(m.Graphics);
            if (m.Image != null) PInvoke.GdipDisposeImage((GpImage*)m.Image);
            if (!m.Dc.IsNull && !m.Previous.IsNull) PInvoke.SelectObject(m.Dc, m.Previous);
            if (!m.Bitmap.IsNull) PInvoke.DeleteObject((HGDIOBJ)m.Bitmap.Value);
            if (!m.Dc.IsNull) PInvoke.DeleteDC(m.Dc);
            if (m.Hwnd != HWND.Null) PInvoke.DestroyWindow(m.Hwnd);
            m.Graphics = null;
            m.Image = null;
        }

        private static void HideWindows()
        {
            foreach (var m in Monitors)
            {
                if (!m.Shown) continue;
                PInvoke.ShowWindow(m.Hwnd, SHOW_WINDOW_CMD.SW_HIDE);
                m.Shown = false;
            }
        }

        /// <summary>The monitor holding a point, or the primary one.</summary>
        private static Monitor? MonitorAt(double x, double y)
        {
            Monitor? primary = null;
            foreach (var m in Monitors)
            {
                if (x >= m.Bounds.left && x < m.Bounds.right && y >= m.Bounds.top && y < m.Bounds.bottom) return m;
                if (m.Primary) primary = m;
            }
            return primary ?? (Monitors.Count > 0 ? Monitors[0] : null);
        }

        // MARK: Drawing

        private sealed record Pill(string Label, string Verb, double LabelWidth, double Width, double Scale);

        private static void Render(long now)
        {
            if (States.Count == 0)
            {
                // Nothing shows: free the full-screen bitmaps until the next marker.
                Frames.Clear();
                DestroyAll();
                layout = [];
                return;
            }
            EnsureMonitors(now);
            if (Monitors.Count == 0) return;
            if (Frames.Count == 0 || States.Values.Any(s => s.Window != HWND.Null && !Frames.ContainsKey((nint)s.Window.Value))) ReadFrames();

            var g0 = Monitors[0].Graphics;
            var live = States.Values.OrderBy(s => s.Created).ToList();
            var pills = new Dictionary<string, Pill>(StringComparer.Ordinal);
            var rings = new Dictionary<string, (Rect Frame, int Ring, double Scale)>(StringComparer.Ordinal);
            var pillAt = new Dictionary<string, (double X, double Y)>(StringComparer.Ordinal);

            var byWindow = Markers.ByWindow(live
                .Where(s => s.Window != HWND.Null && Frames.GetValueOrDefault((nint)s.Window.Value) != null)
                .Select(s => new MarkerPlacement(s.Marker.Id, ((nint)s.Window.Value).ToString(System.Globalization.CultureInfo.InvariantCulture), s.Arrival)));
            foreach (var (windowKey, ids) in byWindow)
            {
                var frame = Frames[nint.Parse(windowKey, System.Globalization.CultureInfo.InvariantCulture)]!.Value;
                var home = MonitorAt(frame.X, frame.Y)!;
                double k = home.Scale;
                var widths = new List<double>(ids.Count);
                foreach (var id in ids)
                {
                    var s = States[id];
                    var label = s.Marker.Label;
                    var verb = s.Verb.Text(s.RealInput);
                    double lw = Text.Measure(g0, label, Text.Label(k));
                    double vw = Text.Measure(g0, verb, Text.Verb(k));
                    // 10 padding, 6 dot, 6 gap, the text, 12 padding.
                    var pill = new Pill(label, verb, lw, 22 * k + lw + vw + 12 * k, k);
                    pills[id] = pill;
                    widths.Add(pill.Width);
                }
                // Side by side while they fit over the window, then wrapped (Core PillLayout).
                var places = Markers.PillLayout(frame, widths, Markers.HaloOutset(ids.Count - 1) * k, PillHeight * k, PillLift * k,
                    PillGap * k, home.Work.top, 8 * k);
                for (int i = 0; i < ids.Count; i++)
                {
                    rings[ids[i]] = (frame, i, k);
                    pillAt[ids[i]] = places[i];
                }
            }

            bool allFading = live.All(s => s.Fading);
            double barAlpha = allFading ? live.Max(s => FadeFactor(s, now)) : 1;

            foreach (var m in Monitors)
            {
                var g = m.Graphics;
                PInvoke.GdipGraphicsClear(g, 0);
                var origin = (X: (double)m.Bounds.left, Y: (double)m.Bounds.top);
                // Rings, then pills, then pointers and carets, then the bar.
                foreach (var s in live)
                {
                    if (rings.TryGetValue(s.Marker.Id, out var r)) DrawRing(g, origin, s, r.Frame, r.Ring, r.Scale, now);
                }
                foreach (var s in live)
                {
                    if (pills.TryGetValue(s.Marker.Id, out var p)) DrawPill(m, origin, s, p, pillAt[s.Marker.Id], now);
                }
                foreach (var s in live) DrawSpot(g, origin, s, now);
                if (m.Primary) DrawBar(g, m, live, barAlpha);
                Present(m);
            }
            foreach (var s in live)
            {
                if (s.Moving && now - s.MoveStart >= Markers.MoveDurationMs) s.Moving = false;
                if (s.PulseStart >= 0 && now - s.PulseStart >= Markers.PulseDurationMs) s.PulseStart = -1;
            }
        }

        private static void Present(Monitor m)
        {
            var dst = new System.Drawing.Point(m.Bounds.left, m.Bounds.top);
            var src = new System.Drawing.Point(0, 0);
            var size = new SIZE(m.Width, m.Height);
            var blend = new BLENDFUNCTION { BlendOp = 0 /* AC_SRC_OVER */, SourceConstantAlpha = 255, AlphaFormat = 1 /* AC_SRC_ALPHA */ };
            PInvoke.UpdateLayeredWindow(m.Hwnd, HDC.Null, &dst, &size, m.Dc, &src, default, &blend, UPDATE_LAYERED_WINDOW_FLAGS.ULW_ALPHA);
            if (!m.Shown)
            {
                PInvoke.ShowWindow(m.Hwnd, SHOW_WINDOW_CMD.SW_SHOWNOACTIVATE);
                m.Shown = true;
            }
            // Stay above windows that went topmost since; never activate.
            PInvoke.SetWindowPos(m.Hwnd, new HWND((void*)-1) /* HWND_TOPMOST */, 0, 0, 0, 0,
                SET_WINDOW_POS_FLAGS.SWP_NOMOVE | SET_WINDOW_POS_FLAGS.SWP_NOSIZE | SET_WINDOW_POS_FLAGS.SWP_NOACTIVATE | SET_WINDOW_POS_FLAGS.SWP_NOOWNERZORDER);
        }

        private static double FadeFactor(State s, long now) =>
            s.Fading ? Math.Clamp(1 - (now - s.FadeStart) / (double)Markers.FadeDurationMs, 0, 1) : 1;

        private static uint Argb(MarkerRgb c, double alpha) =>
            ((uint)Math.Clamp(Math.Round(alpha * 255), 0, 255) << 24) | ((uint)c.Red << 16) | ((uint)c.Green << 8) | c.Blue;

        private static void DrawRing(GpGraphics* g, (double X, double Y) o, State s, Rect frame, int ring, double k, long now)
        {
            double alpha = (s.Verb.IsWaiting ? 0.45 : 1) * FadeFactor(s, now);
            double width = Markers.HaloRingWidth * k;
            double inset = Markers.HaloOutset(ring) * k - width / 2;
            var home = MonitorAt(frame.X + frame.Width / 2, frame.Y + frame.Height / 2);
            Rect? bounds = home == null ? null : new Rect(home.Bounds.left, home.Bounds.top, home.Width, home.Height);
            var c = Markers.RingRect(frame, ring, k, bounds);
            var r = new Rect(c.X - o.X, c.Y - o.Y, c.Width, c.Height);
            Shapes.StrokeRoundRect(g, r, WindowRadius * k + Math.Max(0, inset), Argb(s.Marker.Color, alpha), width);
        }

        /// <summary>
        /// A pill dimmed (waiting) or fading is drawn whole first and then
        /// laid over the monitor at that opacity, as one layer, so its text
        /// keeps its contrast against the fill instead of the fill and the
        /// text each letting the background through.
        /// </summary>
        private static void DrawPill(Monitor m, (double X, double Y) o, State s, Pill p, (double X, double Y) at, long now)
        {
            double alpha = (s.Verb.IsWaiting ? 0.55 : 1) * FadeFactor(s, now);
            if (alpha >= 0.999)
            {
                DrawPillAt(m.Graphics, s, p, at.X - o.X, at.Y - o.Y);
                return;
            }
            if (alpha <= 0.001) return;
            const int Pad = 2;
            int w = (int)Math.Ceiling(p.Width) + 2 * Pad, h = (int)Math.Ceiling(PillHeight * p.Scale) + 2 * Pad;
            int left = (int)Math.Floor(at.X - o.X) - Pad, top = (int)Math.Floor(at.Y - o.Y) - Pad;
            var layer = new uint[w * h];
            fixed (uint* bits = layer)
            {
                GpBitmap* image;
                if (PInvoke.GdipCreateBitmapFromScan0(w, h, w * 4, 0x000E200B /* PixelFormat32bppPARGB */, (byte*)bits, &image) != Status.Ok) return;
                GpGraphics* lg;
                if (PInvoke.GdipGetImageGraphicsContext((GpImage*)image, &lg) == Status.Ok)
                {
                    PInvoke.GdipSetSmoothingMode(lg, SmoothingMode.SmoothingModeAntiAlias);
                    PInvoke.GdipSetPixelOffsetMode(lg, PixelOffsetMode.PixelOffsetModeHalf);
                    PInvoke.GdipSetTextRenderingHint(lg, TextRenderingHint.TextRenderingHintAntiAliasGridFit);
                    DrawPillAt(lg, s, p, at.X - o.X - left, at.Y - o.Y - top);
                    PInvoke.GdipFlush(lg, FlushIntention.FlushIntentionSync);
                    PInvoke.GdipDeleteGraphics(lg);
                }
                PInvoke.GdipDisposeImage((GpImage*)image);
                PInvoke.GdipFlush(m.Graphics, FlushIntention.FlushIntentionSync);
                Composite(m, bits, left, top, w, h, alpha);
            }
        }

        /// <summary>Premultiplied `src` over the monitor's pixels at (left, top), scaled by `alpha`.</summary>
        private static void Composite(Monitor m, uint* src, int left, int top, int w, int h, double alpha)
        {
            uint a256 = (uint)Math.Round(Math.Clamp(alpha, 0, 1) * 256);
            uint* dst = (uint*)m.Bits;
            for (int y = 0; y < h; y++)
            {
                int dy = top + y;
                if (dy < 0 || dy >= m.Height) continue;
                for (int x = 0; x < w; x++)
                {
                    int dx = left + x;
                    if (dx < 0 || dx >= m.Width) continue;
                    uint s = src[y * w + x];
                    if (s == 0) continue;
                    // Scale every premultiplied channel by alpha, then source-over.
                    uint sa = ((s >> 24) * a256) >> 8, sr = (((s >> 16) & 0xFF) * a256) >> 8, sg = (((s >> 8) & 0xFF) * a256) >> 8, sb = ((s & 0xFF) * a256) >> 8;
                    uint d = dst[dy * m.Width + dx];
                    uint inv = 255 - sa;
                    uint da = sa + (((d >> 24) * inv + 127) / 255);
                    uint dr = sr + ((((d >> 16) & 0xFF) * inv + 127) / 255);
                    uint dg = sg + ((((d >> 8) & 0xFF) * inv + 127) / 255);
                    uint db = sb + (((d & 0xFF) * inv + 127) / 255);
                    dst[dy * m.Width + dx] = (Math.Min(da, 255) << 24) | (Math.Min(dr, 255) << 16) | (Math.Min(dg, 255) << 8) | Math.Min(db, 255);
                }
            }
        }

        private static void DrawPillAt(GpGraphics* g, State s, Pill p, double x, double y)
        {
            double k = p.Scale;
            const double alpha = 1;
            var color = s.Marker.Color;
            var ink = AgentMarker.Ink;
            double h = PillHeight * k;
            var box = new Rect(x, y, p.Width, h);
            // Real input: ink fill, text in the colour, a 2 px ring inside.
            var fill = s.RealInput ? ink : color;
            var textColor = s.RealInput ? color : ink;
            Shapes.FillRoundRect(g, box, h / 2, Argb(fill, alpha));
            if (s.RealInput) Shapes.StrokeRoundRect(g, Inset(box, k), h / 2 - k, Argb(color, alpha), 2 * k);
            // The dot; hollow while waiting.
            var dot = new Rect(box.X + 10.75 * k, box.Y + (h - 4.5 * k) / 2, 4.5 * k, 4.5 * k);
            if (!s.Verb.IsWaiting) Shapes.FillEllipse(g, dot, Argb(textColor, alpha));
            Shapes.StrokeEllipse(g, dot, Argb(textColor, alpha), 1.5 * k);
            Text.Draw(g, p.Label, Text.Label(k), box.X + 22 * k, box.Y, h, Argb(textColor, alpha));
            Text.Draw(g, p.Verb, Text.Verb(k), box.X + 22 * k + p.LabelWidth, box.Y, h, Argb(textColor, alpha * 0.62));
        }

        private static Rect Inset(Rect r, double d) => new(r.X + d, r.Y + d, r.Width - 2 * d, r.Height - 2 * d);

        private static void DrawSpot(GpGraphics* g, (double X, double Y) o, State s, long now)
        {
            double alpha = FadeFactor(s, now);
            var color = s.Marker.Color;
            var chip = AgentMarker.ChipLabel(s.Marker.Label);
            if (s.Spot == 1)
            {
                double t = s.Moving ? Math.Clamp((now - s.MoveStart) / (double)Markers.MoveDurationMs, 0, 1) : 1;
                double e = 1 - Math.Pow(1 - t, 3); // ease-out
                double x = s.FromX + (s.ToX - s.FromX) * e, y = s.FromY + (s.ToY - s.FromY) * e;
                double k = MonitorAt(x, y)?.Scale ?? 1;
                double px = x - o.X, py = y - o.Y;
                if (s.RealInput)
                {
                    // Around the real arrow, which hangs down-right from the point.
                    Shapes.StrokeEllipse(g, new Rect(px + (5 - 16.75) * k, py + (8 - 16.75) * k, 33.5 * k, 33.5 * k), Argb(color, alpha), 2.5 * k);
                }
                else
                {
                    Shapes.Arrow(g, px, py, k, Argb(color, alpha), Argb(AgentMarker.Ink, alpha));
                }
                var (cx, cy) = s.RealInput ? (24.0, 26.0) : (14.0, 20.0);
                DrawChip(g, chip, px + cx * k, py + cy * k, k, color, alpha);
            }
            else if (s.Spot == 2)
            {
                double k = MonitorAt(s.Caret.X, s.Caret.Y)?.Scale ?? 1;
                var c = new Rect(s.Caret.X - o.X, s.Caret.Y - o.Y, s.Caret.Width, s.Caret.Height);
                Shapes.FillRect(g, c, Argb(color, alpha));
                // Below the line, so it does not cover the text going in.
                DrawChip(g, chip, c.X + c.Width + 2 * k, c.Y + c.Height + 2 * k, k, color, alpha);
            }
            if (s.PulseStart >= 0)
            {
                double t = Math.Clamp((now - s.PulseStart) / (double)Markers.PulseDurationMs, 0, 1);
                double e = 1 - Math.Pow(1 - t, 3);
                double k = MonitorAt(s.PulseX, s.PulseY)?.Scale ?? 1;
                double d = 30 * k * (0.4 + 1.2 * e);
                Shapes.StrokeEllipse(g, new Rect(s.PulseX - o.X - d / 2, s.PulseY - o.Y - d / 2, d, d), Argb(color, 0.9 * (1 - e)), 2 * k);
            }
        }

        private static void DrawChip(GpGraphics* g, string name, double x, double y, double k, MarkerRgb color, double alpha)
        {
            double h = ChipHeight * k;
            double w = Text.Measure(g, name, Text.Chip(k)) + 14 * k;
            var box = new Rect(x, y, w, h);
            Shapes.FillRoundRect(g, box, h / 2, Argb(color, alpha));
            Text.Draw(g, name, Text.Chip(k), x + 7 * k, y, h, Argb(AgentMarker.Ink, alpha));
        }

        /// <summary>
        /// The bar on the primary monitor: a dot per live marker, how many
        /// there are, and the stop chord.
        /// </summary>
        private static void DrawBar(GpGraphics* g, Monitor m, List<State> live, double alpha)
        {
            double k = m.Scale;
            double h = BarHeight * k;
            var text = Markers.BarText(live.Count);
            var hint = Markers.BarStopHint;
            int dots = Math.Min(live.Count, BarMaxDots);
            double textWidth = Text.Measure(g, text, Text.Label(k));
            double hintWidth = Text.Measure(g, hint, Text.Verb(k));
            double width = 12 * k + dots * 12 * k + 4 * k + textWidth + 12 * k + hintWidth + 14 * k;
            double x = (m.Width - width) / 2;
            double y = m.Work.top - m.Bounds.top + 8 * k;
            var box = new Rect(Math.Floor(x), Math.Floor(y), width, h);
            Shapes.FillRoundRect(g, box, h / 2, Argb(AgentMarker.Ink, 0.92 * alpha));
            Shapes.StrokeRoundRect(g, Inset(box, 0.5 * k), h / 2 - 0.5 * k, Argb(new MarkerRgb(255, 255, 255), 0.12 * alpha), k);
            double cx = box.X + 12 * k;
            for (int i = 0; i < dots; i++)
            {
                Shapes.FillEllipse(g, new Rect(cx, box.Y + (h - 8 * k) / 2, 8 * k, 8 * k), Argb(live[i].Marker.Color, alpha));
                cx += 12 * k;
            }
            cx += 4 * k;
            var barInk = new MarkerRgb(242, 242, 242);
            Text.Draw(g, text, Text.Label(k), cx, box.Y, h, Argb(barInk, alpha));
            cx += textWidth + 12 * k;
            Text.Draw(g, hint, Text.Verb(k), cx, box.Y, h, Argb(barInk, 0.6 * alpha));
        }
    }

    /// <summary>GDI+ shapes in pixel coordinates.</summary>
    private static class Shapes
    {
        private static GpPath* RoundRectPath(Rect r, double radius)
        {
            GpPath* path;
            PInvoke.GdipCreatePath(FillMode.FillModeAlternate, &path);
            float x = (float)r.X, y = (float)r.Y, w = (float)r.Width, h = (float)r.Height;
            float d = (float)Math.Clamp(radius * 2, 0, Math.Min(r.Width, r.Height));
            if (d <= 0.5f)
            {
                var pts = stackalloc PointF[4];
                pts[0] = new PointF { X = x, Y = y };
                pts[1] = new PointF { X = x + w, Y = y };
                pts[2] = new PointF { X = x + w, Y = y + h };
                pts[3] = new PointF { X = x, Y = y + h };
                PInvoke.GdipAddPathPolygon(path, pts, 4);
                return path;
            }
            PInvoke.GdipAddPathArc(path, x, y, d, d, 180, 90);
            PInvoke.GdipAddPathArc(path, x + w - d, y, d, d, 270, 90);
            PInvoke.GdipAddPathArc(path, x + w - d, y + h - d, d, d, 0, 90);
            PInvoke.GdipAddPathArc(path, x, y + h - d, d, d, 90, 90);
            PInvoke.GdipClosePathFigure(path);
            return path;
        }

        public static void FillRoundRect(GpGraphics* g, Rect r, double radius, uint argb)
        {
            if (r.Width <= 0 || r.Height <= 0 || argb >> 24 == 0) return;
            var path = RoundRectPath(r, radius);
            Fill(g, path, argb);
            PInvoke.GdipDeletePath(path);
        }

        public static void StrokeRoundRect(GpGraphics* g, Rect r, double radius, uint argb, double width)
        {
            if (r.Width <= 0 || r.Height <= 0 || argb >> 24 == 0) return;
            var path = RoundRectPath(r, radius);
            Stroke(g, path, argb, width);
            PInvoke.GdipDeletePath(path);
        }

        public static void FillRect(GpGraphics* g, Rect r, uint argb)
        {
            if (argb >> 24 == 0) return;
            GpSolidFill* brush;
            PInvoke.GdipCreateSolidFill(argb, &brush);
            PInvoke.GdipFillRectangle(g, (GpBrush*)brush, (float)r.X, (float)r.Y, (float)r.Width, (float)r.Height);
            PInvoke.GdipDeleteBrush((GpBrush*)brush);
        }

        public static void FillEllipse(GpGraphics* g, Rect r, uint argb)
        {
            if (argb >> 24 == 0) return;
            GpPath* path;
            PInvoke.GdipCreatePath(FillMode.FillModeAlternate, &path);
            PInvoke.GdipAddPathEllipse(path, (float)r.X, (float)r.Y, (float)r.Width, (float)r.Height);
            Fill(g, path, argb);
            PInvoke.GdipDeletePath(path);
        }

        public static void StrokeEllipse(GpGraphics* g, Rect r, uint argb, double width)
        {
            if (argb >> 24 == 0) return;
            GpPath* path;
            PInvoke.GdipCreatePath(FillMode.FillModeAlternate, &path);
            PInvoke.GdipAddPathEllipse(path, (float)r.X, (float)r.Y, (float)r.Width, (float)r.Height);
            Stroke(g, path, argb, width);
            PInvoke.GdipDeletePath(path);
        }

        /// <summary>An arrow pointer with its tip at (x, y), pointing up-left, like the system's.</summary>
        public static void Arrow(GpGraphics* g, double x, double y, double k, uint fill, uint outline)
        {
            ReadOnlySpan<double> shape = [1, 1, 1, 18, 5.5, 14, 8.5, 20.5, 11, 19.5, 8, 13, 14, 13];
            var pts = stackalloc PointF[7];
            for (int i = 0; i < 7; i++)
            {
                pts[i] = new PointF { X = (float)(x + (shape[2 * i] - 1) * k), Y = (float)(y + (shape[2 * i + 1] - 1) * k) };
            }
            GpPath* path;
            PInvoke.GdipCreatePath(FillMode.FillModeAlternate, &path);
            PInvoke.GdipAddPathPolygon(path, pts, 7);
            Fill(g, path, fill);
            Stroke(g, path, outline, 1.5 * k);
            PInvoke.GdipDeletePath(path);
        }

        private static void Fill(GpGraphics* g, GpPath* path, uint argb)
        {
            GpSolidFill* brush;
            PInvoke.GdipCreateSolidFill(argb, &brush);
            PInvoke.GdipFillPath(g, (GpBrush*)brush, path);
            PInvoke.GdipDeleteBrush((GpBrush*)brush);
        }

        private static void Stroke(GpGraphics* g, GpPath* path, uint argb, double width)
        {
            GpPen* pen;
            PInvoke.GdipCreatePen1(argb, (float)width, Unit.UnitPixel, &pen);
            PInvoke.GdipDrawPath(g, pen, path);
            PInvoke.GdipDeletePen(pen);
        }
    }

    /// <summary>GDI+ text: Segoe UI at the overlay's sizes, cached per scale.</summary>
    private static class Text
    {
        private static readonly Dictionary<(int Kind, double Scale), nint> Fonts = [];
        private static GpStringFormat* format;

        public static GpFont* Label(double k) => Font(0, k);
        public static GpFont* Verb(double k) => Font(1, k);
        public static GpFont* Chip(double k) => Font(2, k);

        /// <summary>Kind 0: the label (semibold 12), 1: the verb (regular 12), 2: the chip (semibold 11).</summary>
        private static GpFont* Font(int kind, double k)
        {
            if (Fonts.TryGetValue((kind, k), out var cached)) return (GpFont*)cached;
            float size = (float)((kind == 2 ? 11 : 12) * k);
            GpFont* font = null;
            foreach (var (family, style) in kind == 1
                ? new[] { ("Segoe UI", 0) }
                : new[] { ("Segoe UI Semibold", 0), ("Segoe UI", 1 /* bold */) })
            {
                GpFontFamily* f;
                fixed (char* name = family)
                {
                    if (PInvoke.GdipCreateFontFamilyFromName(name, null, &f) != Status.Ok) continue;
                }
                if (PInvoke.GdipCreateFont(f, size, style, Unit.UnitPixel, &font) == Status.Ok) break;
                font = null;
            }
            if (font == null) throw new InvalidOperationException("no Segoe UI font");
            Fonts[(kind, k)] = (nint)font;
            return font;
        }

        private static GpStringFormat* Format
        {
            get
            {
                if (format != null) return format;
                GpStringFormat* generic, clone;
                PInvoke.GdipStringFormatGetGenericTypographic(&generic);
                PInvoke.GdipCloneStringFormat(generic, &clone);
                // StringFormatFlagsNoWrap | StringFormatFlagsMeasureTrailingSpaces.
                PInvoke.GdipSetStringFormatFlags(clone, 0x1000 | 0x0800);
                return format = clone;
            }
        }

        public static double Measure(GpGraphics* g, string text, GpFont* font)
        {
            if (text.Length == 0) return 0;
            var layout = new RectF { X = 0, Y = 0, Width = 100_000, Height = 10_000 };
            RectF box;
            fixed (char* s = text)
            {
                PInvoke.GdipMeasureString(g, s, text.Length, font, &layout, Format, &box, null, null);
            }
            return Math.Ceiling(box.Width);
        }

        private static readonly Dictionary<nint, double> LineHeights = [];

        /// <summary>A font's line height, measured once (fonts live as long as the helper).</summary>
        private static double LineHeight(GpGraphics* g, GpFont* font)
        {
            if (LineHeights.TryGetValue((nint)font, out var cached)) return cached;
            return LineHeights[(nint)font] = MeasureLine(g, font);
        }

        private static double MeasureLine(GpGraphics* g, GpFont* font)
        {
            var layout = new RectF { X = 0, Y = 0, Width = 100_000, Height = 10_000 };
            RectF box;
            fixed (char* s = "Ag")
            {
                PInvoke.GdipMeasureString(g, s, 2, font, &layout, Format, &box, null, null);
            }
            return box.Height;
        }

        /// <summary>Draws `text` at `x`, centred in a row `rowHeight` tall that starts at `top`.</summary>
        public static void Draw(GpGraphics* g, string text, GpFont* font, double x, double top, double rowHeight, uint argb)
        {
            if (text.Length == 0 || argb >> 24 == 0) return;
            double line = LineHeight(g, font);
            var layout = new RectF { X = (float)x, Y = (float)(top + (rowHeight - line) / 2), Width = 100_000, Height = (float)line + 4 };
            GpSolidFill* brush;
            PInvoke.GdipCreateSolidFill(argb, &brush);
            fixed (char* s = text)
            {
                PInvoke.GdipDrawString(g, s, text.Length, font, &layout, Format, (GpBrush*)brush);
            }
            PInvoke.GdipDeleteBrush((GpBrush*)brush);
        }
    }
}
