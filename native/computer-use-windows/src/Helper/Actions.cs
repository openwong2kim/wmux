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

    /// <summary>
    /// The fast keyboard check: the normal input desktop, the target window
    /// in the foreground and owned by the target pid, and keyboard focus
    /// inside it. Anything that cannot be confirmed refuses. Returns the
    /// window that has keyboard focus.
    /// </summary>
    public static HWND KeyboardPreflight(ControlTarget target)
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
        if (thread == 0 || !PInvoke.GetGUIThreadInfo(thread, &info))
        {
            throw new HelperError("window_not_focused", "could not confirm which window has keyboard focus; nothing was sent");
        }
        // No focused control: keys go to the active window, which must be the target.
        var keyboardWindow = info.hwndFocus != HWND.Null ? info.hwndFocus : info.hwndActive;
        if (keyboardWindow == HWND.Null || Win.Root(keyboardWindow) != target.Window)
        {
            throw new HelperError("window_not_focused", "keyboard focus is outside the target window; nothing was sent");
        }
        return keyboardWindow;
    }

    /// <summary>
    /// The full check before a keyboard batch: the fast one, the integrity
    /// level, and the focused element, which must be confirmed not to be a
    /// password field (unknown counts as no). Returns a preflight for Post,
    /// run under the input lock right before SendInput, that repeats the fast
    /// check and requires keyboard focus to still be on the same window
    /// (HWND) as at this check. That is window-level: a move between
    /// windowless controls inside one HWND (most Chromium, WPF and XAML
    /// content) is caught only by the element check here, not at SendInput.
    /// </summary>
    public static Action RequireKeyboard(ControlTarget target)
    {
        var focusWindow = KeyboardPreflight(target);
        RequireNotElevated(target);
        var secrecy = Uia.FocusSecrecy(out var focusedId);
        if (secrecy == Uia.Secrecy.Secret)
        {
            throw new HelperError("app_blocked", "the focused field is a password field; wmux does not type into it");
        }
        if (secrecy == Uia.Secrecy.Unknown)
        {
            throw new HelperError("app_blocked", "wmux could not confirm that the focused field is not a password field, so nothing was typed. Click the field first, then retry");
        }
        // Focus may have moved during the (slow) password check.
        if (!Uia.FocusedRuntimeId().AsSpan().SequenceEqual(focusedId))
        {
            throw new HelperError("window_not_focused", "focus moved while it was being checked; nothing was sent");
        }
        return () =>
        {
            if (KeyboardPreflight(target) != focusWindow)
            {
                throw new HelperError("window_not_focused", "keyboard focus moved to another control; nothing was sent");
            }
        };
    }

    /// <summary>
    /// The point lands on the target window, on a menu of the same app (a
    /// menu the previous click opened), or on a window the target owns (a
    /// dropdown or dialog it opened). WS_POPUP alone does not count: frameless
    /// Chromium / Electron top-level windows are WS_POPUP too, and another
    /// normal window of the same app must never take the click. The window
    /// actually hit must belong to the target pid right now (a window handle
    /// can be reused by another process).
    /// </summary>
    public static bool PointerHitsTarget(ControlTarget target, double x, double y)
    {
        var hit = PInvoke.WindowFromPoint(new System.Drawing.Point((int)Math.Round(x), (int)Math.Round(y)));
        if (hit == HWND.Null || Win.OwnerPid(hit) != target.Pid) return false;
        var root = Win.Root(hit);
        if (root == target.Window || Win.ClassName(root) == "#32768") return true;
        var owner = root;
        for (int i = 0; i < 16; i++)
        {
            owner = PInvoke.GetWindow(owner, GET_WINDOW_CMD.GW_OWNER);
            if (owner == HWND.Null) return false;
            if (owner == target.Window) return true;
        }
        return false;
    }

    /// <summary>The fast pointer check, run under the input lock immediately before SendInput.</summary>
    public static void PointerPreflight(ControlTarget target, double x, double y)
    {
        InputDesktop.Require();
        if (!PointerHitsTarget(target, x, y))
        {
            throw new HelperError("window_not_focused", "another window covers that point; nothing was sent");
        }
    }

    /// <summary>
    /// Requires the point to land on the target. A covered target is asked to
    /// come forward once (UIA SetFocus on its window, then SetForegroundWindow,
    /// which Windows may refuse to a background process); never
    /// AttachThreadInput or Alt-key tricks. If it still does not hit, nothing
    /// is sent. Returns the preflight for Post.
    /// </summary>
    public static Action RequirePointer(ControlTarget target, double x, double y)
    {
        InputDesktop.Require();
        RequireNotElevated(target);
        Action preflight = () => PointerPreflight(target, x, y);
        if (PointerHitsTarget(target, x, y)) return preflight;
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
        catch (Exception e) when (e is not HelperError)
        {
        }
        if (!PointerHitsTarget(target, x, y)) PInvoke.SetForegroundWindow(target.Window);
        for (int i = 0; i < 10; i++)
        {
            if (PointerHitsTarget(target, x, y)) return preflight;
            Sta.Sleep(50);
        }
        throw new HelperError("window_not_focused", "another window covers that point; nothing was clicked");
    }

    /// <summary>
    /// Before every UIA pattern call (Invoke, Toggle, SetValue, SetFocus…).
    /// Parity with the macOS helper: AXPress works on a covered background
    /// window, so a semantic action here does not need the target in front
    /// either; it is not input. But it still needs the normal input desktop,
    /// a target that is not elevated, a helper that is not shutting down, and
    /// the element itself still in the target process and inside the target
    /// window.
    /// </summary>
    public static void RequireSemantic(ControlTarget target, IUIAutomationElement* el)
    {
        Input.ThrowIfStopping();
        InputDesktop.Require();
        RequireNotElevated(target);
        if (!PInvoke.IsWindow(target.Window) || Win.EffectivePid(target.Window) != target.Pid)
        {
            throw new HelperError("window_not_found", "the target window is gone");
        }
        int pid;
        HWND top;
        try
        {
            pid = el->CurrentProcessId;
            top = Uia.TopWindowOf(el);
        }
        catch (Exception e) when (e is not HelperError)
        {
            throw new HelperError("element_stale", "the element went away");
        }
        if (pid != target.Pid || top != target.Window)
        {
            throw new HelperError("element_stale", "the element is no longer in the target window");
        }
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
        catch (Exception e) when (e is not HelperError)
        {
            return null;
        }
    }

    /// <summary>
    /// A pattern call failed. If it certainly did nothing (not supported,
    /// disabled, not implemented) the ladder may try the next way; anything
    /// else may have run (a timeout on a call the app is still executing), so
    /// the action ends here rather than doing it a second way.
    /// </summary>
    private static void EndIfAmbiguous(Exception e, string call)
    {
        if (Uia.NotExecuted(e.HResult)) return;
        throw new HelperError(Uia.ErrorCode(e) is "action_not_supported" ? "internal" : Uia.ErrorCode(e),
            $"{call} failed after it was sent ({Uia.Describe(e)}); it may have taken effect. Call getAppState before retrying");
    }

    /// <summary>
    /// The action ladder for a plain left click on an element: its primary
    /// UIA pattern (Invoke; Toggle for a check box; SelectionItem; then
    /// ExpandCollapse). Null when no pattern applies; then the caller clicks.
    /// </summary>
    private static string? ClickSemantically(ControlTarget target, IUIAutomationElement* el)
    {
        int type;
        try
        {
            type = (int)el->CurrentControlType;
        }
        catch (Exception e) when (e is not HelperError)
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
                    Focus.RequireSemantic(target, el);
                    invoke->Invoke();
                    return "pressed through accessibility (Invoke)";
                }
                catch (Exception e) when (e is not HelperError)
                {
                    EndIfAmbiguous(e, "Invoke");
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
                Focus.RequireSemantic(target, el);
                toggle->Toggle();
                return "toggled through accessibility (Toggle)";
            }
            catch (Exception e) when (e is not HelperError)
            {
                EndIfAmbiguous(e, "Toggle");
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
                Focus.RequireSemantic(target, el);
                select->Select();
                return "selected through accessibility (SelectionItem)";
            }
            catch (Exception e) when (e is not HelperError)
            {
                EndIfAmbiguous(e, "Select");
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
                bool collapsed;
                try
                {
                    collapsed = expand->CurrentExpandCollapseState == ExpandCollapseState.ExpandCollapseState_Collapsed;
                }
                catch (Exception e) when (e is not HelperError)
                {
                    return null;
                }
                try
                {
                    Focus.RequireSemantic(target, el);
                    if (collapsed) expand->Expand();
                    else expand->Collapse();
                    return "expanded or collapsed through accessibility (ExpandCollapse)";
                }
                catch (Exception e) when (e is not HelperError)
                {
                    EndIfAmbiguous(e, collapsed ? "Expand" : "Collapse");
                }
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
            var note = ClickSemantically(target, (IUIAutomationElement*)element);
            if (note != null) return Result("accessibility", false, note);
        }
        var preflight = Focus.RequirePointer(target, x, y);
        Input.Click(x, y, button, count, mods, preflight);
        return Result("synthetic", false);
    }

    /// <summary>
    /// Refuses a secret field before anything else is done with it: what the
    /// snapshot saw (the tree showed it as [redacted]) or what it is now
    /// (Uia.IsSecretElement; unreadable counts as secret).
    /// </summary>
    private static void RefuseSecretElement(Snapshot snap, IUIAutomationElement* el, int index, string what)
    {
        if (snap.Secret[index] || Uia.IsSecretElement(el))
        {
            throw new HelperError("app_blocked", $"element {index} is a password field (or wmux could not tell); wmux does not {what} it");
        }
    }

    public static JsonObject SetValue(Params p)
    {
        var (snap, target) = Begin(p);
        var index = p.Int("index") ?? throw new HelperError("invalid_argument", "setValue needs an element index");
        var value = p.RequireString("value");
        var el = snap.Element(index);
        RefuseSecretElement(snap, el, index, "fill");
        var pattern = (IUIAutomationValuePattern*)Pattern(el, Uia.ValuePattern, IUIAutomationValuePattern.IID_Guid);
        if (pattern == null) throw new HelperError("value_not_settable", $"element {index} does not accept a value through accessibility");
        try
        {
            bool readOnly;
            try
            {
                readOnly = pattern->CurrentIsReadOnly;
            }
            catch (Exception e) when (e is not HelperError)
            {
                throw new HelperError(Uia.IsGone(e.HResult) ? "element_stale" : "value_not_settable", $"element {index}: {Uia.Describe(e)}");
            }
            if (readOnly) throw new HelperError("value_not_settable", $"element {index} is read-only");
            Focus.RequireSemantic(target, el);
            var bstr = Marshal.StringToBSTR(value);
            try
            {
                pattern->SetValue(new BSTR((char*)bstr));
            }
            catch (Exception e) when (e is not HelperError)
            {
                EndIfAmbiguous(e, "SetValue");
                throw new HelperError("value_not_settable", $"the app refused the value ({Uia.Describe(e)})");
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
            catch (Exception e) when (e is not HelperError)
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
        catch (Exception e) when (e is not HelperError)
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
            RefuseSecretElement(snap, el, index, "type into");
            try
            {
                Focus.RequireSemantic(target, el);
                el->SetFocus();
            }
            catch (Exception e) when (e is not HelperError)
            {
                if (Uia.IsGone(e.HResult)) throw new HelperError("element_stale", $"element {index} went away");
            }
            // Typing into whatever else has focus would put the text in the wrong field.
            if (!Uia.FocusedRuntimeId().AsSpan().SequenceEqual(snap.RuntimeIds[index]))
            {
                throw new HelperError("action_not_supported", $"element {index} did not take keyboard focus; nothing was typed. Click it first");
            }
        }

        // Checked before anything is sent; FocusedValue below is the baseline for verification.
        Action? preflight = Focus.RequireKeyboard(target);
        var before = FocusedValue();
        var chunks = Chunks.Unicode(text);
        int total = chunks.Sum(c => c.GraphemeCount), typed = 0;
        foreach (var chunk in chunks)
        {
            try
            {
                // The full check (focused element, password field, integrity)
                // runs before the first chunk and again after every Enter or
                // Tab, the keys that move focus. Between text chunks the fast
                // Win32 check inside Post, right before SendInput, requires
                // the same foreground window and the same focused HWND as at
                // the last full check.
                preflight ??= Focus.RequireKeyboard(target);
                if (chunk.Text != null)
                {
                    Input.TypeText(chunk.Text, preflight);
                }
                else
                {
                    Input.Tap(Key(chunk.Key!), [], preflight);
                    preflight = null;
                }
            }
            catch (HelperError e)
            {
                throw new HelperError(e.Code, $"{e.Message} (after {typed} of {total} characters; the rest was not typed)");
            }
            typed += chunk.GraphemeCount;
        }
        bool verified = WaitForEffect(text, before, total < 64 ? 300 : 1000);
        return Result("synthetic", verified);
    }

    /// <summary>
    /// Verified only when the focused element's value is the value before
    /// with exactly the typed text inserted at one position (Core Verify).
    /// </summary>
    private static bool WaitForEffect(string text, string? before, int timeoutMs)
    {
        if (before == null) return false;
        long deadline = Environment.TickCount64 + timeoutMs;
        while (true)
        {
            if (Verify.Inserted(before, FocusedValue(), text)) return true;
            if (Environment.TickCount64 >= deadline) return false;
            Sta.Sleep(15);
        }
    }

    public static JsonObject PressKey(Params p)
    {
        var (_, target) = Begin(p);
        var key = Key(p.RequireString("key"));
        int repeat = Math.Clamp(p.Int("repeat") ?? 1, 1, 50);
        for (int n = 0; n < repeat; n++)
        {
            if (n > 0) Sta.Sleep(4);
            try
            {
                Input.Tap(key, [], Focus.RequireKeyboard(target));
            }
            catch (HelperError e) when (n > 0)
            {
                throw new HelperError(e.Code, $"{e.Message} (after {n} of {repeat} presses; the rest were not sent)");
            }
        }
        return Result("synthetic", false);
    }

    public static JsonObject Hotkey(Params p)
    {
        var (_, target) = Begin(p);
        var key = Key(p.RequireString("key"));
        var mods = Modifiers(p);
        Input.Tap(key, mods, Focus.RequireKeyboard(target));
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
        // The preflight re-runs the hit-test before every notch: a window that
        // moves over the point mid-scroll must not receive the rest.
        var preflight = Focus.RequirePointer(target, x, y);
        for (int n = 0; n < amount; n++)
        {
            if (n > 0) Sta.Sleep(8);
            try
            {
                Input.Wheel(x, y, dx, dy, preflight);
            }
            catch (HelperError e) when (n > 0)
            {
                throw new HelperError(e.Code, $"{e.Message} (after {n} of {amount} notches; the rest was not sent)");
            }
        }
        return Result("synthetic", false);
    }
}
