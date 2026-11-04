// Where keyboard input lands, for the agent marker's caret (Overlay.cs).
//
// Called on the request thread before an action's last safety check, never
// between that check and the first key: these are UIA round trips into the
// target app, time enough for focus to move to another window or a password
// field (the keyboard checks in Actions.cs run after this, as the last thing
// before the first key).

using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.Graphics.Gdi;
using Windows.Win32.System.Com;
using Windows.Win32.UI.Accessibility;
using Windows.Win32.UI.HiDpi;
using Windows.Win32.UI.WindowsAndMessaging;
using WmuxComputerUse.Core;

namespace WmuxComputerUse;

internal static unsafe class Caret
{
    /// <summary>
    /// The caret in `element` (null: the element with keyboard focus, when it
    /// is in the target window): the Win32 caret of the target's thread when
    /// it is in that control, else the insertion point UIA reports, else the
    /// element's leading edge (Core Markers.CaretRect). Null when the overlay
    /// is off or none of them can be read.
    /// </summary>
    public static Rect? For(ControlTarget target, IUIAutomationElement* element = null)
    {
        if (!Overlay.Enabled) return null;
        try
        {
            var window = Win.Bounds(target.Window);
            double scale = Scale(target.Window);
            var win32 = Win32Caret(target, out var caretWindow);
            IUIAutomationElement* el = element;
            bool owned = false;
            if (el == null)
            {
                el = Uia.Focused();
                owned = el != null;
                if (el != null && !InTarget(el, target))
                {
                    el->Release();
                    el = null;
                    owned = false;
                }
            }
            try
            {
                Rect? line = null;
                Rect? frame = null;
                if (el != null)
                {
                    // UIA answers in this process's physical pixels; the Win32
                    // caret only when it is this element's own control.
                    line = InsertionLine(el);
                    if (line == null && win32 != null && NativeWindow(el) == caretWindow) line = win32;
                    frame = Bounds(el);
                }
                else
                {
                    line = win32;
                }
                return Markers.CaretRect(line, frame, window, scale);
            }
            finally
            {
                if (owned) el->Release();
            }
        }
        catch (Exception e) when (e is not HelperError)
        {
            return null;
        }
    }

    private static double Scale(HWND window)
    {
        var monitor = PInvoke.MonitorFromWindow(window, MONITOR_FROM_FLAGS.MONITOR_DEFAULTTONEAREST);
        return PInvoke.GetDpiForMonitor(monitor, MONITOR_DPI_TYPE.MDT_EFFECTIVE_DPI, out var dpi, out _).Succeeded && dpi > 0 ? dpi / 96.0 : 1;
    }

    private static bool InTarget(IUIAutomationElement* el, ControlTarget target)
    {
        try
        {
            return el->CurrentProcessId == target.Pid && Win.InTargetWindow(Uia.TopWindowOf(el), target.Window, target.Pid);
        }
        catch (Exception e) when (e is not HelperError)
        {
            return false;
        }
    }

    private static HWND NativeWindow(IUIAutomationElement* el)
    {
        try
        {
            return el->CurrentNativeWindowHandle;
        }
        catch (Exception e) when (e is not HelperError)
        {
            return HWND.Null;
        }
    }

    private static Rect? Bounds(IUIAutomationElement* el)
    {
        try
        {
            var r = Uia.ToRect(el->CurrentBoundingRectangle);
            return r.IsEmpty ? null : r;
        }
        catch (Exception e) when (e is not HelperError)
        {
            return null;
        }
    }

    /// <summary>
    /// The caret Win32 keeps for the target window's thread (classic edit and
    /// rich edit controls set one, focused or not), in screen pixels, when it
    /// is inside the target window.
    /// </summary>
    private static Rect? Win32Caret(ControlTarget target, out HWND caretWindow)
    {
        caretWindow = HWND.Null;
        uint thread = PInvoke.GetWindowThreadProcessId(target.Window);
        var info = new GUITHREADINFO { cbSize = (uint)sizeof(GUITHREADINFO) };
        if (thread == 0 || !PInvoke.GetGUIThreadInfo(thread, &info) || info.hwndCaret == HWND.Null) return null;
        if (Win.Root(info.hwndCaret) != target.Window) return null;
        var r = info.rcCaret;
        if (r.bottom <= r.top) return null;
        // rcCaret is in the control's own client units. A window that is not
        // aware of its monitor's DPI is stretched by DWM, and ClientToScreen
        // (called from this per-monitor-aware process) adds unstretched units
        // to the physical origin, so they are stretched here first.
        uint windowDpi = PInvoke.GetDpiForWindow(info.hwndCaret);
        var monitor = PInvoke.MonitorFromWindow(info.hwndCaret, MONITOR_FROM_FLAGS.MONITOR_DEFAULTTONEAREST);
        double stretch = windowDpi > 0 && PInvoke.GetDpiForMonitor(monitor, MONITOR_DPI_TYPE.MDT_EFFECTIVE_DPI, out var monitorDpi, out _).Succeeded && monitorDpi > 0
            ? (double)monitorDpi / windowDpi
            : 1;
        var p = new System.Drawing.Point((int)Math.Round(r.left * stretch), (int)Math.Round(r.top * stretch));
        if (!PInvoke.ClientToScreen(info.hwndCaret, &p)) return null;
        caretWindow = info.hwndCaret;
        return new Rect(p.X, p.Y, 0, (r.bottom - r.top) * stretch);
    }

    /// <summary>
    /// The line at the selection's start (UIA TextPattern), its x the
    /// insertion point: the bounds of the empty range there, or of the
    /// character after it, or the trailing edge of the one before it.
    /// </summary>
    private static Rect? InsertionLine(IUIAutomationElement* el)
    {
        IUIAutomationTextPattern* text;
        var iid = IUIAutomationTextPattern.IID_Guid;
        try
        {
            text = (IUIAutomationTextPattern*)el->GetCurrentPatternAs((UIA_PATTERN_ID)Uia.TextPattern, &iid);
        }
        catch (Exception e) when (e is not HelperError)
        {
            return null;
        }
        if (text == null) return null;
        IUIAutomationTextRangeArray* ranges = null;
        IUIAutomationTextRange* start = null;
        try
        {
            ranges = text->GetSelection();
            if (ranges == null || ranges->Length < 1) return null;
            start = ranges->GetElement(0);
            if (start == null) return null;
            // Collapse it to its start.
            start->MoveEndpointByRange(TextPatternRangeEndpoint.TextPatternRangeEndpoint_End, start, TextPatternRangeEndpoint.TextPatternRangeEndpoint_Start);
            if (First(start) is { Height: > 0 } empty) return empty with { Width = 0 };
            var next = start->Clone();
            try
            {
                if (next->MoveEndpointByUnit(TextPatternRangeEndpoint.TextPatternRangeEndpoint_End, TextUnit.TextUnit_Character, 1) == 1
                    && First(next) is { Height: > 0 } after)
                {
                    return after with { Width = 0 };
                }
            }
            finally
            {
                next->Release();
            }
            var previous = start->Clone();
            try
            {
                if (previous->MoveEndpointByUnit(TextPatternRangeEndpoint.TextPatternRangeEndpoint_Start, TextUnit.TextUnit_Character, -1) == -1
                    && First(previous) is { Height: > 0 } before)
                {
                    return new Rect(before.X + before.Width, before.Y, 0, before.Height);
                }
            }
            finally
            {
                previous->Release();
            }
            return null;
        }
        catch (Exception e) when (e is not HelperError)
        {
            return null;
        }
        finally
        {
            if (start != null) start->Release();
            if (ranges != null) ranges->Release();
            text->Release();
        }
    }

    /// <summary>The first bounding rectangle of a text range, or null.</summary>
    private static Rect? First(IUIAutomationTextRange* range)
    {
        SAFEARRAY* sa = range->GetBoundingRectangles();
        if (sa == null) return null;
        try
        {
            int lo, hi;
            if (PInvoke.SafeArrayGetLBound(sa, 1, &lo).Failed || PInvoke.SafeArrayGetUBound(sa, 1, &hi).Failed || hi - lo + 1 < 4) return null;
            void* data;
            if (PInvoke.SafeArrayAccessData(sa, &data).Failed) return null;
            try
            {
                var d = new ReadOnlySpan<double>(data, 4);
                return new Rect(d[0], d[1], d[2], d[3]);
            }
            finally
            {
                PInvoke.SafeArrayUnaccessData(sa);
            }
        }
        finally
        {
            PInvoke.SafeArrayDestroy(sa);
        }
    }
}
