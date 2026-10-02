// Control actions. Each one re-checks its target right before sending input
// (protocol ControlTarget), and again between typed chunks, repeated keys and
// scroll notches:
//   - the input desktop is the normal one (not locked, no UAC / secure desktop);
//   - keyboard batches: the foreground window is the target window, owned by
//     the target pid, and the focused control belongs to it;
//   - pointer batches: the window under the point is the target window, or a
//     popup / menu of the same app;
//   - the target does not run at a higher integrity level (UIPI would drop
//     the input silently);
//   - keystrokes never go into a password field.
// Otherwise nothing is sent and the answer says why.

using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.UI.Accessibility;
using Windows.Win32.UI.WindowsAndMessaging;
using WmuxComputerUse.Core;

namespace WmuxComputerUse;

internal readonly record struct ControlTarget(uint Pid, HWND Window)
{
    public static ControlTarget From(Params p)
    {
        var t = p.Object("target");
        var pid = t?.Int("pid");
        var window = t?.String("windowId");
        if (t == null || pid is null || pid <= 0 || window == null) throw new HelperError("invalid_argument", "target {pid, windowId} is required");
        return new ControlTarget((uint)pid.Value, Win.ParseWindowId(window));
    }
}

internal static unsafe class Focus
{
    public static void RequireNotElevated(ControlTarget target)
    {
        if (Integrity.IsAboveSelf(target.Pid))
        {
            throw new HelperError("target_elevated", "the target app runs as administrator (or its integrity level cannot be read); Windows would drop the input, so nothing was sent");
        }
    }

    /// <summary>The target window is the foreground window and owns keyboard focus.</summary>
    public static void RequireKeyboard(ControlTarget target)
    {
        InputDesktop.Require();
        var foreground = PInvoke.GetForegroundWindow();
        if (foreground == HWND.Null)
        {
            throw new HelperError("window_not_focused", "no window is in the foreground (a secure desktop may be up); nothing was sent");
        }
        var root = Win.Root(foreground);
        if (root != target.Window || Win.EffectivePid(root) != target.Pid)
        {
            throw new HelperError("window_not_focused", "the target window is not in the foreground; nothing was sent");
        }
        uint thread = PInvoke.GetWindowThreadProcessId(foreground);
        var info = new GUITHREADINFO { cbSize = (uint)sizeof(GUITHREADINFO) };
        if (PInvoke.GetGUIThreadInfo(thread, &info) && info.hwndFocus != HWND.Null && Win.Root(info.hwndFocus) != target.Window)
        {
            throw new HelperError("window_not_focused", "keyboard focus is outside the target window; nothing was sent");
        }
        RequireNotElevated(target);
    }

    /// <summary>Keystrokes never go into a password field.</summary>
    public static void RefuseSecret()
    {
        if (Uia.FocusIsSecret())
        {
            throw new HelperError("app_blocked", "the focused field is a password field; wmux does not type into it");
        }
    }

    /// <summary>The re-check before every typed chunk and every repeated key.</summary>
    public static void RequireStillSafe(ControlTarget target)
    {
        RequireKeyboard(target);
        RefuseSecret();
    }

    /// <summary>
    /// The point lands on the target window, or on a popup or menu of the same
    /// app (a menu the previous click opened). Another normal window of the
    /// same app does not count.
    /// </summary>
    public static bool PointerHitsTarget(ControlTarget target, double x, double y)
    {
        var hit = PInvoke.WindowFromPoint(new System.Drawing.Point((int)Math.Round(x), (int)Math.Round(y)));
        if (hit == HWND.Null) return false;
        var root = Win.Root(hit);
        if (root == target.Window) return true;
        if (Win.EffectivePid(root) != target.Pid && Win.OwnerPid(root) != target.Pid) return false;
        var style = (WINDOW_STYLE)(uint)PInvoke.GetWindowLongPtr(root, WINDOW_LONG_PTR_INDEX.GWL_STYLE);
        return (style & WINDOW_STYLE.WS_POPUP) != 0 || Win.ClassName(root) == "#32768";
    }

    /// <summary>
    /// Requires the point to land on the target. A covered target is asked to
    /// come forward once (UIA SetFocus on its window, then SetForegroundWindow,
    /// which Windows may refuse to a background process); never
    /// AttachThreadInput or Alt-key tricks. If it still does not hit, nothing
    /// is sent.
    /// </summary>
    public static void RequirePointer(ControlTarget target, double x, double y)
    {
        InputDesktop.Require();
        RequireNotElevated(target);
        if (PointerHitsTarget(target, x, y)) return;
        try
        {
            var el = Uia.Automation->ElementFromHandle(target.Window);
            if (el != null)
            {
                try
                {
                    el->SetFocus();
                }
                finally
                {
                    el->Release();
                }
            }
        }
        catch (COMException)
        {
        }
        if (!PointerHitsTarget(target, x, y)) PInvoke.SetForegroundWindow(target.Window);
        for (int i = 0; i < 10; i++)
        {
            if (PointerHitsTarget(target, x, y)) return;
            Sta.Sleep(50);
        }
        throw new HelperError("window_not_focused", "another window covers that point; nothing was clicked");
    }
}

internal static unsafe class Actions
{
    private static JsonObject Result(string method, bool verified, string? note = null)
    {
        var o = new JsonObject { ["method"] = method, ["verification"] = verified ? "verified" : "unverified" };
        if (note != null) o["note"] = note;
        return o;
    }

    private static (Snapshot Snap, ControlTarget Target) Begin(Params p)
    {
        var snap = Snapshots.Get(p.RequireString("snapshotId"));
        var target = ControlTarget.From(p);
        if (snap.Pid != target.Pid || snap.Window != target.Window)
        {
            throw new HelperError("invalid_argument", "target does not match the snapshot's window");
        }
        return (snap, target);
    }

    private static List<ModifierKey> Modifiers(Params p) =>
        Keys.OrderedModifiers(p.Strings("modifiers") ?? []) ?? throw new HelperError("invalid_argument", "modifiers must be ctrl, alt, shift or meta");

    private static KeySpec Key(string key) =>
        Keys.Lookup(key) ?? throw new HelperError("invalid_argument", $"\"{(key.Length > 20 ? key[..20] : key)}\" is not a canonical key name");

    /// <summary>A screen pixel for an element (its fresh frame, clipped to the window) or a window point.</summary>
    private static (double X, double Y, nint Element) ScreenPoint(Snapshot snap, int? index, (double X, double Y)? point)
    {
        if (index is int i)
        {
            var el = snap.Element(i);
            Rect frame;
            try
            {
                frame = Uia.ToRect(el->CurrentBoundingRectangle);
            }
            catch (Exception e) when (Uia.IsGone(e.HResult))
            {
                throw new HelperError("element_stale", $"element {i} went away");
            }
            if (frame.IsEmpty) throw new HelperError("action_not_supported", $"element {i} has no on-screen frame; use coordinates from a screenshot");
            // The fresh frame, clipped to the window, so a moved window is no misclick.
            var visible = frame.Intersection(snap.WindowFrame());
            var box = visible.IsEmpty ? frame : visible;
            return (box.X + box.Width / 2, box.Y + box.Height / 2, (nint)el);
        }
        if (point is not { } pt) throw new HelperError("invalid_argument", "index or point is required");
        var window = snap.WindowFrame();
        if (pt.X < 0 || pt.Y < 0 || pt.X >= window.Width || pt.Y >= window.Height)
        {
            throw new HelperError("invalid_argument", "point is outside the window");
        }
        return (window.X + pt.X, window.Y + pt.Y, 0);
    }

    private static void* Pattern(IUIAutomationElement* el, int patternId, Guid iid)
    {
        try
        {
            return el->GetCurrentPatternAs((UIA_PATTERN_ID)patternId, &iid);
        }
        catch (COMException)
        {
            return null;
        }
    }

    /// <summary>
    /// The action ladder for a plain left click on an element: its primary
    /// UIA pattern (Invoke; Toggle for a check box; SelectionItem; then
    /// ExpandCollapse). Null when none applies or the app refused.
    /// </summary>
    private static string? ClickSemantically(IUIAutomationElement* el)
    {
        int type;
        try
        {
            type = (int)el->CurrentControlType;
        }
        catch (COMException)
        {
            return null;
        }
        if (type != 50002 /* CheckBox */)
        {
            var invoke = (IUIAutomationInvokePattern*)Pattern(el, Uia.InvokePattern, IUIAutomationInvokePattern.IID_Guid);
            if (invoke != null)
            {
                try
                {
                    invoke->Invoke();
                    return "pressed through accessibility (Invoke)";
                }
                catch (COMException)
                {
                }
                finally
                {
                    invoke->Release();
                }
            }
        }
        var toggle = (IUIAutomationTogglePattern*)Pattern(el, Uia.TogglePattern, IUIAutomationTogglePattern.IID_Guid);
        if (toggle != null)
        {
            try
            {
                toggle->Toggle();
                return "toggled through accessibility (Toggle)";
            }
            catch (COMException)
            {
            }
            finally
            {
                toggle->Release();
            }
        }
        var select = (IUIAutomationSelectionItemPattern*)Pattern(el, Uia.SelectionItemPattern, IUIAutomationSelectionItemPattern.IID_Guid);
        if (select != null)
        {
            try
            {
                select->Select();
                return "selected through accessibility (SelectionItem)";
            }
            catch (COMException)
            {
            }
            finally
            {
                select->Release();
            }
        }
        var expand = (IUIAutomationExpandCollapsePattern*)Pattern(el, Uia.ExpandCollapsePattern, IUIAutomationExpandCollapsePattern.IID_Guid);
        if (expand != null)
        {
            try
            {
                if (expand->CurrentExpandCollapseState == ExpandCollapseState.ExpandCollapseState_Collapsed) expand->Expand();
                else expand->Collapse();
                return "expanded or collapsed through accessibility (ExpandCollapse)";
            }
            catch (COMException)
            {
            }
            finally
            {
                expand->Release();
            }
        }
        return null;
    }

    public static JsonObject Click(Params p)
    {
        var (snap, target) = Begin(p);
        int button = (p.String("button") ?? "left") switch
        {
            "left" => 0,
            "right" => 1,
            "middle" => 2,
            _ => throw new HelperError("invalid_argument", "button must be left, right or middle"),
        };
        int count = Math.Clamp(p.Int("clickCount") ?? 1, 1, 3);
        var mods = Modifiers(p);
        var (x, y, element) = ScreenPoint(snap, p.Int("index"), p.Point("point"));

        if (element != 0 && button == 0 && count == 1 && mods.Count == 0)
        {
            var note = ClickSemantically((IUIAutomationElement*)element);
            if (note != null) return Result("accessibility", false, note);
        }
        Focus.RequirePointer(target, x, y);
        Input.Click(x, y, button, count, mods);
        return Result("synthetic", false);
    }

    public static JsonObject SetValue(Params p)
    {
        var (snap, target) = Begin(p);
        var index = p.Int("index") ?? throw new HelperError("invalid_argument", "setValue needs an element index");
        var value = p.RequireString("value");
        var el = snap.Element(index);
        bool secret;
        try
        {
            secret = el->CurrentIsPassword || Tree.IsSensitive(false, Uia.Take(el->CurrentName));
        }
        catch (Exception e) when (Uia.IsGone(e.HResult))
        {
            throw new HelperError("element_stale", $"element {index} went away");
        }
        if (secret || Uia.FocusIsSecret())
        {
            throw new HelperError("app_blocked", "that is a password field (or one has focus); wmux does not fill it");
        }
        Focus.RequireNotElevated(target);
        var pattern = (IUIAutomationValuePattern*)Pattern(el, Uia.ValuePattern, IUIAutomationValuePattern.IID_Guid);
        if (pattern == null) throw new HelperError("value_not_settable", $"element {index} does not accept a value through accessibility");
        try
        {
            if (pattern->CurrentIsReadOnly) throw new HelperError("value_not_settable", $"element {index} is read-only");
            var bstr = Marshal.StringToBSTR(value);
            try
            {
                pattern->SetValue(new BSTR((char*)bstr));
            }
            catch (COMException e)
            {
                if (Uia.IsGone(e.HResult)) throw new HelperError("element_stale", $"element {index} went away");
                throw new HelperError("value_not_settable", $"the app refused the value (0x{e.HResult:x8})");
            }
            finally
            {
                Marshal.FreeBSTR(bstr);
            }
            string? readBack;
            try
            {
                readBack = Uia.Take(pattern->CurrentValue);
            }
            catch (COMException)
            {
                readBack = null;
            }
            return readBack == value
                ? Result("accessibility", true)
                : Result("accessibility", false, "the value read back differs from what was set");
        }
        finally
        {
            pattern->Release();
        }
    }

    /// <summary>The focused element's value (ValuePattern), for verifying typed text.</summary>
    private static string? FocusedValue()
    {
        var el = Uia.Focused();
        if (el == null) return null;
        try
        {
            return Uia.CurrentString(el, Uia.ValueValueProperty);
        }
        catch (COMException)
        {
            return null;
        }
        finally
        {
            el->Release();
        }
    }

    public static JsonObject Type(Params p)
    {
        var (snap, target) = Begin(p);
        var text = p.RequireString("text");
        if (text.Length == 0) throw new HelperError("invalid_argument", "type needs text");
        if (p.Int("index") is int index)
        {
            var el = snap.Element(index);
            try
            {
                if (el->CurrentIsPassword || Tree.IsSensitive(false, Uia.Take(el->CurrentName)))
                {
                    throw new HelperError("app_blocked", "that is a password field; wmux does not type into it");
                }
                el->SetFocus();
            }
            catch (COMException e)
            {
                if (Uia.IsGone(e.HResult)) throw new HelperError("element_stale", $"element {index} went away");
            }
            // Typing into whatever else has focus would put the text in the wrong field.
            var focused = Uia.Focused();
            bool same = false;
            if (focused != null)
            {
                try
                {
                    same = Uia.CurrentRuntimeId(focused).AsSpan().SequenceEqual(snap.RuntimeIds[index]);
                }
                catch (COMException)
                {
                }
                finally
                {
                    focused->Release();
                }
            }
            if (!same)
            {
                throw new HelperError("action_not_supported", $"element {index} did not take keyboard focus; nothing was typed. Click it first");
            }
        }
        Focus.RequireKeyboard(target);
        Focus.RefuseSecret();

        var before = FocusedValue();
        var chunks = Chunks.Unicode(text);
        int total = chunks.Sum(c => c.GraphemeCount), typed = 0;
        foreach (var chunk in chunks)
        {
            try
            {
                Focus.RequireStillSafe(target);
            }
            catch (HelperError e)
            {
                throw new HelperError(e.Code, $"{e.Message} (after {typed} of {total} characters; the rest was not typed)");
            }
            if (chunk.Text != null) Input.TypeText(chunk.Text);
            else Input.Tap(Key(chunk.Key!), []);
            typed += chunk.GraphemeCount;
        }
        bool verified = WaitForEffect(text, before, total < 64 ? 300 : 1000);
        return Result("synthetic", verified);
    }

    private static string Lines(string s) => s.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');

    /// <summary>Verified only when the focused element's value changed and now holds the end of the text.</summary>
    private static bool WaitForEffect(string text, string? before, int timeoutMs)
    {
        var normalized = Lines(text);
        var needle = normalized.Length > 32 ? normalized[^32..] : normalized;
        long deadline = Environment.TickCount64 + timeoutMs;
        do
        {
            var v = FocusedValue();
            if (v != null && v != before && Lines(v).Contains(needle, StringComparison.Ordinal)) return true;
            Sta.Sleep(50);
        } while (Environment.TickCount64 < deadline);
        return false;
    }

    public static JsonObject PressKey(Params p)
    {
        var (_, target) = Begin(p);
        var key = Key(p.RequireString("key"));
        int repeat = Math.Clamp(p.Int("repeat") ?? 1, 1, 50);
        Focus.RequireKeyboard(target);
        Focus.RefuseSecret();
        for (int n = 0; n < repeat; n++)
        {
            if (n > 0)
            {
                try
                {
                    Focus.RequireStillSafe(target);
                }
                catch (HelperError e)
                {
                    throw new HelperError(e.Code, $"{e.Message} (after {n} of {repeat} presses; the rest were not sent)");
                }
                Sta.Sleep(4);
            }
            Input.Tap(key, []);
        }
        return Result("synthetic", false);
    }

    public static JsonObject Hotkey(Params p)
    {
        var (_, target) = Begin(p);
        var key = Key(p.RequireString("key"));
        var mods = Modifiers(p);
        Focus.RequireKeyboard(target);
        Focus.RefuseSecret();
        Input.Tap(key, mods);
        return Result("synthetic", false);
    }

    public static JsonObject Scroll(Params p)
    {
        var (snap, target) = Begin(p);
        int amount = Math.Clamp(p.Int("amount") ?? 3, 1, 50);
        var (dx, dy) = (p.String("direction") ?? "down") switch
        {
            "up" => (0, 1),
            "down" => (0, -1),
            "left" => (-1, 0),
            "right" => (1, 0),
            _ => throw new HelperError("invalid_argument", "direction must be up, down, left or right"),
        };
        var (x, y, _) = ScreenPoint(snap, p.Int("index"), p.Point("point"));
        Focus.RequirePointer(target, x, y);
        for (int n = 0; n < amount; n++)
        {
            // Re-run the hit-test before every notch: a window that moves over
            // the point mid-scroll must not receive the rest.
            if (n > 0 && (!InputDesktop.IsDefault() || !Focus.PointerHitsTarget(target, x, y)))
            {
                throw new HelperError("window_not_focused", $"another window covered the point after {n} of {amount} notches; the rest was not sent");
            }
            Input.Wheel(x, y, dx, dy);
            Sta.Sleep(8);
        }
        return Result("synthetic", false);
    }
}
