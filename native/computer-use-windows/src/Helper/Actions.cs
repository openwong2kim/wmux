// Control actions. Input actions try background input first (posted to the
// target window alone, BackgroundInput.cs); what cannot be posted, or is
// refused before anything was posted, goes the real way below. Real input
// re-checks its target right before sending (protocol ControlTarget), and
// again between typed chunks, repeated keys and scroll notches:
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
    /// Real input needs the target window on screen. A hidden window
    /// (SW_HIDE, no WS_VISIBLE) or a cloaked one (on another virtual
    /// desktop) can take neither a click nor keys without being brought up,
    /// and what would bring it forward (UIA SetFocus, SetForegroundWindow)
    /// gives it the foreground while it stays hidden, shows it, or switches
    /// the user's desktop: each undoes the app's or the user's choice. So it
    /// is refused before anything is done to it (Win.IsShown, the
    /// background path's "hidden" check too).
    /// </summary>
    public static void RequireShown(ControlTarget target)
    {
        if (!Win.IsShown(target.Window))
        {
            throw new HelperError("window_not_focused", "the target window is hidden or on another virtual desktop; real input would have to show it or give it the foreground, so nothing was sent. Ask the user to bring the window up first");
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
        RequireShown(target);
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
        return Ownership.Owns((nint)target.Window.Value, (nint)root.Value, Win.OwnerOf);
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
        RequireShown(target);
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
                    GiveBack.NoteOwnInput(call: true);
                    el->SetFocus();
                    GiveBack.CallDone();
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
    /// After UIA SetFocus on an element: whether keyboard focus reaches it.
    /// SetFocus on an element of a window that is not in front activates the
    /// window and returns before the app has moved its focus (Notepad's
    /// editor got it about 20 ms later), so the focused element is read until
    /// it is this one or Poll.FocusSettleMs passes. `activated`: the window
    /// was not in front before SetFocus, so the app's own activation handling
    /// may move focus once more; then focus must also stay on the element for
    /// Poll.FocusSteadyMs.
    /// </summary>
    public static bool Lands(int[] runtimeId, bool activated) =>
        Poll.UntilSteady(() => Uia.FocusedRuntimeId().AsSpan().SequenceEqual(runtimeId), Poll.FocusSettleMs,
            activated ? Poll.FocusSteadyMs : 0, () => Environment.TickCount64, Sta.Sleep);

    /// <summary>
    /// The target window is the foreground window, or a window of the target
    /// process it owns is (an open menu flyout or owned dialog: the app is the
    /// active one, and nothing has to come forward).
    /// </summary>
    public static bool InFront(ControlTarget target) => Win.InTargetWindow(Win.Root(PInvoke.GetForegroundWindow()), target.Window, target.Pid);

    /// <summary>
    /// Under `allow`, a keyboard action (pressKey, hotkey, type without an
    /// index) on a target that is not in front brings it forward first, as a
    /// click does: UIA SetFocus on its window (activation gives keyboard
    /// focus back to the control that had it), then SetForegroundWindow.
    /// Keys go out only once the target is in front with keyboard focus
    /// inside it (KeyboardPreflight, and again right before SendInput), so
    /// they can never land in another window; if Windows refuses the change,
    /// the action fails and nothing is sent. GiveBack then returns the front.
    /// </summary>
    public static void BringForwardForKeys(ControlTarget target)
    {
        InputDesktop.Require();
        RequireShown(target);
        RequireNotElevated(target);
        if (KeyboardReady(target, out _)) return;
        // SetForegroundWindow first: activation gives focus back to the
        // control that had it. UIA SetFocus on the window element would move
        // Chromium's focus to the document root, so it is only the fallback
        // (it carries the foreground right a background process lacks).
        PInvoke.SetForegroundWindow(target.Window);
        if (!InFront(target))
        {
            try
            {
                var el = Uia.Automation->ElementFromHandle(target.Window);
                if (el != null)
                {
                    try
                    {
                        GiveBack.NoteOwnInput(call: true);
                        el->SetFocus();
                        GiveBack.CallDone();
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
            if (!InFront(target)) PInvoke.SetForegroundWindow(target.Window);
        }
        // Activation hands keyboard focus back to the control that had it a
        // moment later: WinForms moves it from the form to its ActiveControl,
        // and Chromium restores the focused element in the page through its
        // renderer, so the first key after activation can be lost. The focus
        // must read the same twice, both the window (Win32) and the element
        // (UIA), before the keys go out.
        for (int i = 0; i < 10; i++)
        {
            if (KeyboardReady(target, out var first))
            {
                var element = Uia.FocusedRuntimeId();
                Sta.Sleep(50);
                if (KeyboardReady(target, out var again) && again == first && element.Length > 0
                    && Uia.FocusedRuntimeId().AsSpan().SequenceEqual(element)) return;
            }
            Sta.Sleep(50);
        }
        throw new HelperError("window_not_focused", "the target window could not be brought to the front with keyboard focus (Windows may have refused the change); nothing was sent");
    }

    private static bool KeyboardReady(ControlTarget target, out HWND focus)
    {
        try
        {
            focus = KeyboardPreflight(target);
            return true;
        }
        catch (HelperError)
        {
            focus = HWND.Null;
            return false;
        }
    }

    /// <summary>
    /// Before every UIA pattern call (Invoke, Toggle, SetValue, SetFocus…).
    /// A pattern call is not input, but it brings a covered target window to
    /// the front (Core Background.PatternCallAllowed), so it is foreground
    /// input for the lanes. It needs the normal input desktop, a target that
    /// is not elevated, a helper that is not shutting down, and the element
    /// itself still in the target process and inside the target window.
    /// Under `refuse` (no foreground lease in main) the target window must
    /// also be the foreground window right now, read last, right before the
    /// call; otherwise needs_foreground, and main re-sends the action under
    /// its lease.
    /// </summary>
    public static void RequireSemantic(ControlTarget target, IUIAutomationElement* el, bool refuseForeground)
    {
        RequireSemanticTarget(target, el);
        if (!Background.PatternCallAllowed(refuseForeground, InFront(target)))
        {
            Wire.Log("accessibility call: needs foreground (it would bring the target window to the front)");
            throw new HelperError("needs_foreground", "an accessibility call would bring the target window to the front; nothing was sent");
        }
    }

    /// <summary>
    /// RequireSemantic without the foreground gate, for the one call that does
    /// not bring a covered target to the front (DoDefaultAction).
    /// </summary>
    public static void RequireSemanticTarget(ControlTarget target, IUIAutomationElement* el)
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
        // A popup the target window owns (a menu flyout) counts as inside it.
        if (pid != target.Pid || !Win.InTargetWindow(top, target.Window, target.Pid))
        {
            throw new HelperError("element_stale", "the element is no longer in the target window" + CoveredChromiumHint(target));
        }
    }

    /// <summary>
    /// Chromium (Chrome, Edge, Electron, VS Code) drops a window's page from
    /// accessibility while the window is fully covered (its native occlusion
    /// tracking), so every element of the last snapshot reads as gone. Say so,
    /// and what works instead, rather than only "the element went away".
    /// </summary>
    private static string CoveredChromiumHint(ControlTarget target)
    {
        if (!Win.ClassName(target.Window).StartsWith("Chrome_WidgetWin", StringComparison.Ordinal) || InFront(target)) return "";
        return ". This is a Chromium window (Chrome, Edge, Electron, VS Code) behind other windows: Chromium stops exposing a fully covered window's page to accessibility, so its elements cannot be pressed in the background. Ask the user to bring the window up, then call getAppState again; keys (pressKey, hotkey, type without an index) still bring it forward themselves";
    }
}

internal static unsafe class Actions
{
    /// <summary>`delivery` is protocol ActionDelivery: background (posted, or a UIA call) or foreground (real input).</summary>
    private static JsonObject Result(string method, bool verified, string delivery, string? note = null)
    {
        var o = new JsonObject { ["method"] = method, ["verification"] = verified ? "verified" : "unverified", ["delivery"] = delivery };
        if (note != null) o["note"] = note;
        return o;
    }

    /// <summary>A posted action's result. Our own side effect (cursor or foreground moved) is said in the note.</summary>
    private static JsonObject Posted(BackgroundOutcome outcome) => outcome.SideEffect
        ? Result("synthetic", false, outcome.Delivery, "the target window came to the front or the pointer moved onto the target while the input was posted; check the app state")
        : WithObserved(Result("synthetic", outcome.Verified, outcome.Delivery), outcome.Verified ? null : outcome.Observed);

    /// <summary>protocol ActionResult.observedValue: on an unverified result, what the field holds now (Verify.Observed).</summary>
    private static JsonObject WithObserved(JsonObject result, string? observed)
    {
        if (observed != null) result["observedValue"] = observed;
        return result;
    }


    /// <summary>
    /// A UIA call is not input, so it is background unless the target window
    /// came to the front during it (macOS does the same with the frontmost app).
    /// </summary>
    private static string SemanticDelivery(ControlTarget target, bool frontBefore) =>
        !frontBefore && Focus.InFront(target) ? "foreground" : "background";

    /// <summary>
    /// The error path of the same check: a pattern call can bring the target
    /// to the front and still fail. An Invoke or ExpandCollapse call made the
    /// covered target the foreground window with WinForms and Electron
    /// (ScrollIntoView did not), and Electron's menu-bar buttons, which offer
    /// ExpandCollapse but do not implement it, then answer Expand with
    /// E_FAIL. The error has no `delivery`, so its message says so.
    /// </summary>
    private static HelperError SayIfCameToFront(HelperError e, ControlTarget target, bool frontBefore) =>
        !frontBefore && Focus.InFront(target)
            ? new HelperError(e.Code, $"{e.Message}. The target window came to the front during the call")
            : e;

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
    /// The background rung of the click ladder: LegacyIAccessible
    /// DoDefaultAction, only on an element whose default action is a press
    /// (Core Background.DefaultActionIsPress) and that is not a secret field.
    /// The target checks of the other rungs run first, without the foreground
    /// gate. An error that certainly did nothing (Chromium answers
    /// UIA_E_ELEMENTNOTENABLED on a covered window) returns null, and the
    /// ladder goes on to answer needs_foreground; a returned success is never
    /// followed by another way, since the press may have happened. Verified
    /// only when a check box's toggle state or a radio button's selection is
    /// read back changed.
    /// </summary>
    private static (string Note, bool Verified)? PressByDefaultAction(ControlTarget target, IUIAutomationElement* el, int type)
    {
        string? action;
        try
        {
            action = Uia.CurrentString(el, Uia.LegacyIAccessibleDefaultActionProperty);
        }
        catch (Exception e) when (e is not HelperError)
        {
            return null;
        }
        if (!Background.DefaultActionIsPress(type, action) || Uia.IsSecretElement(el)) return null;
        var legacy = (IUIAutomationLegacyIAccessiblePattern*)Pattern(el, Uia.LegacyIAccessiblePattern, IUIAutomationLegacyIAccessiblePattern.IID_Guid);
        if (legacy == null) return null;
        try
        {
            Focus.RequireSemanticTarget(target, el);
            int? toggleBefore = ReadQuietly(() => Uia.CurrentInt(el, Uia.ToggleStateProperty));
            bool? selectedBefore = ReadQuietly(() => (bool?)Uia.CurrentBool(el, Uia.SelectionItemIsSelectedProperty));
            try
            {
                Input.CountSemantic();
                legacy->DoDefaultAction();
                GiveBack.CallDone();
            }
            catch (Exception e) when (e is not HelperError)
            {
                EndIfAmbiguous(e, "DoDefaultAction");
                Wire.Log($"click: DoDefaultAction did not run ({Uia.Describe(e)})");
                return null;
            }
            bool verified = type switch
            {
                50002 /* CheckBox */ => toggleBefore is int t0 && ReadQuietly(() => Uia.CurrentInt(el, Uia.ToggleStateProperty)) is int t1 && t1 != t0,
                50013 /* RadioButton */ => selectedBefore == false && ReadQuietly(() => (bool?)Uia.CurrentBool(el, Uia.SelectionItemIsSelectedProperty)) == true,
                _ => false,
            };
            return ("pressed through accessibility (DoDefaultAction), without bringing the window to the front", verified);
        }
        finally
        {
            legacy->Release();
        }
    }

    private static T? ReadQuietly<T>(Func<T?> read) where T : struct
    {
        try
        {
            return read();
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
        if (Uia.NotExecuted(e.HResult))
        {
            Input.UncountSemantic();
            return;
        }
        throw new HelperError(Uia.ErrorCode(e) is "action_not_supported" ? "internal" : Uia.ErrorCode(e),
            $"{call} failed after it was sent ({Uia.Describe(e)}); it may have taken effect. Call getAppState before retrying");
    }

    /// <summary>
    /// The action ladder for a plain left click on an element. Under `refuse`
    /// with the target not in front it starts with DoDefaultAction, the one
    /// press that does not bring the window to the front
    /// (Core Background.DefaultActionFirst). Then its primary UIA pattern
    /// (Invoke; Toggle for a check box; SelectionItem; then ExpandCollapse).
    /// Null when no pattern applies; then the caller clicks.
    /// </summary>
    private static (string Note, bool Verified)? ClickSemantically(ControlTarget target, IUIAutomationElement* el, bool refuse)
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
        if (Background.DefaultActionFirst(refuse, Focus.InFront(target)) && PressByDefaultAction(target, el, type) is { } pressed)
        {
            return pressed;
        }
        if (type != 50002 /* CheckBox */)
        {
            var invoke = (IUIAutomationInvokePattern*)Pattern(el, Uia.InvokePattern, IUIAutomationInvokePattern.IID_Guid);
            if (invoke != null)
            {
                try
                {
                    Focus.RequireSemantic(target, el, refuse);
                    Input.CountSemantic();
                    invoke->Invoke();
                    GiveBack.CallDone();
                    return ("pressed through accessibility (Invoke)", false);
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
                Focus.RequireSemantic(target, el, refuse);
                Input.CountSemantic();
                toggle->Toggle();
                GiveBack.CallDone();
                return ("toggled through accessibility (Toggle)", false);
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
                Focus.RequireSemantic(target, el, refuse);
                Input.CountSemantic();
                select->Select();
                GiveBack.CallDone();
                return ("selected through accessibility (SelectionItem)", false);
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
                    Focus.RequireSemantic(target, el, refuse);
                    Input.CountSemantic();
                    if (collapsed) expand->Expand();
                    else expand->Collapse();
                    GiveBack.CallDone();
                    return ("expanded or collapsed through accessibility (ExpandCollapse)", false);
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

    /// <summary>
    /// protocol ForegroundMode: `refuse` means background only; where real
    /// input would be needed the action answers needs_foreground instead.
    /// </summary>
    private static bool RefuseForeground(Params p)
    {
        if (!p.Has("foreground")) return false;
        return p.String("foreground") switch
        {
            "allow" => false,
            "refuse" => true,
            _ => throw new HelperError("invalid_argument", "foreground must be allow or refuse"),
        };
    }

    /// <summary>
    /// After a background attempt (Core Background.Next): its result, or null
    /// to go on with real input. needs_foreground only when nothing at all
    /// went out during the action (the protocol's rule: main re-sends it with
    /// real input, so anything sent before would arrive twice).
    /// </summary>
    private static JsonObject? AfterBackground(string action, BackgroundOutcome posted, bool refuseForeground, long sentAtStart)
    {
        var next = Background.Next(posted, refuseForeground, Input.Sent != sentAtStart);
        // Refusals that depend on the target's state are logged; what the
        // action asks for (a chord, the wheel) never posts, so it is not.
        if (next is AfterAttempt.RealInput or AfterAttempt.NeedsForeground && !Background.IsActionRefusal(posted.Refusal))
        {
            var why = Background.Describe(posted.Refusal);
            Wire.Log(next == AfterAttempt.NeedsForeground ? $"{action}: needs foreground ({why})" : $"{action}: real input, not background ({why})");
        }
        switch (next)
        {
            case AfterAttempt.UseResult:
                return Posted(posted);
            case AfterAttempt.RealInput:
                return null;
            case AfterAttempt.NeedsForeground:
                throw new HelperError("needs_foreground", $"this needs real input ({Background.Describe(posted.Refusal)}); nothing was sent");
            default:
                throw new HelperError("internal", "input may have reached the app before wmux found this needs real input, so nothing more was sent. Call getAppState before retrying");
        }
    }

    public static JsonObject Click(Params p, AgentMarker marker)
    {
        long sentAtStart = Input.Sent;
        bool refuse = RefuseForeground(p);
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
        // The agent's pointer moves to the point (Overlay.cs: a posted command, no wait).
        Overlay.Show(marker, MarkerVerb.Clicking, target, (x, y));

        // Whether a pattern call of the ladder brought the target to the front
        // and then certainly did not run, so the click goes on another way:
        // that way's own probe starts after the change, so it is said here.
        bool ladderRaised = false;
        if (element != 0 && button == 0 && count == 1 && mods.Count == 0)
        {
            bool frontBefore = Focus.InFront(target);
            (string Note, bool Verified)? pressed;
            try
            {
                // Under `refuse` a pattern call on a covered target answers
                // needs_foreground (Focus.RequireSemantic) before it is made,
                // after DoDefaultAction, which stays in the background.
                pressed = ClickSemantically(target, (IUIAutomationElement*)element, refuse);
            }
            catch (HelperError e)
            {
                throw SayIfCameToFront(e, target, frontBefore);
            }
            if (pressed is { } done)
            {
                Overlay.Press(marker.Id, x, y);
                return Result("accessibility", done.Verified, SemanticDelivery(target, frontBefore), done.Note);
            }
            ladderRaised = !frontBefore && Focus.InFront(target);
        }
        try
        {
            // Background first; RequirePointer (which may raise the window) only on the real-input path.
            Input.ThrowIfStopping();
            var posted = BackgroundInput.Click(target, x, y, button, count, mods.Count);
            if (AfterBackground("click", posted, refuse, sentAtStart) is { } result)
            {
                Overlay.Press(marker.Id, x, y);
                if (ladderRaised && result["delivery"]?.GetValue<string>() == "background")
                {
                    result["delivery"] = "foreground";
                    result["note"] = "the target window came to the front during an accessibility call before the click was posted; check the app state";
                }
                return result;
            }
            // Real input: a ring where the user's own pointer goes.
            var preflight = Focus.RequirePointer(target, x, y);
            Overlay.Show(marker, MarkerVerb.Clicking, target, (x, y), realInput: true);
            Input.Click(x, y, button, count, mods, preflight);
            Overlay.Press(marker.Id, x, y);
            return Result("synthetic", false, "foreground");
        }
        catch (HelperError e) when (ladderRaised)
        {
            throw new HelperError(e.Code, $"{e.Message}. The target window came to the front during an accessibility call");
        }
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

    /// <summary>How long setValue's read-back waits for the value (longer only while it is still changing).</summary>
    private const int SetValueSettleMs = 400;

    public static JsonObject SetValue(Params p, AgentMarker marker)
    {
        // A UIA ValuePattern call brings a covered target to the front, so
        // under `refuse` it is made only for a target in front; otherwise
        // needs_foreground before anything is sent (Focus.RequireSemantic).
        bool refuse = RefuseForeground(p);
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
            // The caret lookup (UIA calls into the app) comes before the checks below.
            Overlay.Show(marker, MarkerVerb.SettingValue, target, caret: Caret.For(target, el));
            // Read before the checks, as the click path does.
            bool frontBefore = Focus.InFront(target);
            Focus.RequireSemantic(target, el, refuse);
            var bstr = Marshal.StringToBSTR(value);
            try
            {
                Input.CountSemantic();
                pattern->SetValue(new BSTR((char*)bstr));
                GiveBack.CallDone();
            }
            catch (Exception e) when (e is not HelperError)
            {
                try
                {
                    EndIfAmbiguous(e, "SetValue");
                }
                catch (HelperError ambiguous)
                {
                    throw SayIfCameToFront(ambiguous, target, frontBefore);
                }
                throw SayIfCameToFront(new HelperError("value_not_settable", $"the app refused the value ({Uia.Describe(e)})"), target, frontBefore);
            }
            finally
            {
                Marshal.FreeBSTR(bstr);
            }
            // Read until it settles: an app may apply the value a moment later.
            var readBack = Verify.Settle(() =>
            {
                try
                {
                    return Uia.Take(pattern->CurrentValue);
                }
                catch (Exception e) when (e is not HelperError)
                {
                    return null;
                }
            }, now => Verify.SameValue(value, now), SetValueSettleMs, Verify.SettleExtraMs, () => Environment.TickCount64, Sta.Sleep);
            if (readBack.Verified)
            {
                var caret = CaretToEnd(el, target, refuse);
                return Result("accessibility", true, SemanticDelivery(target, frontBefore),
                    caret == CaretMove.Failed ? "the value was set, but wmux could not put the caret at its end, so a type that follows may not land after it" : null);
            }
            return WithObserved(Result("accessibility", false, SemanticDelivery(target, frontBefore), "the value read back differs from what was set"),
                    Verify.Observed(value, readBack.Last, Uia.IsSecretElement(el)));
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

    public static JsonObject Type(Params p, AgentMarker marker)
    {
        long sentAtStart = Input.Sent;
        bool refuse = RefuseForeground(p);
        var (snap, target) = Begin(p);
        var text = p.RequireString("text");
        if (text.Length == 0) throw new HelperError("invalid_argument", "type needs text");
        Input.ThrowIfStopping();
        if (p.Int("index") is int index)
        {
            var el = snap.Element(index);
            RefuseSecretElement(snap, el, index, "type into");
            // Background first, before UIA SetFocus (which can raise the window).
            (double X, double Y)? fieldPoint;
            try
            {
                var (fx, fy, _) = ScreenPoint(snap, index, null);
                fieldPoint = (fx, fy);
            }
            catch (HelperError)
            {
                fieldPoint = null;
            }
            // The caret lookup (UIA calls into the app) comes before every
            // check the background path makes before its first key.
            Overlay.Show(marker, MarkerVerb.Typing, target, caret: Caret.For(target, el));
            var posted = BackgroundInput.Type(target, text, el, snap.RuntimeIds[index], index, fieldPoint);
            if (AfterBackground("type", posted, refuse, sentAtStart) is { } result)
            {
                // The caret moves on to where the text ended: read again only
                // once the field shows the text (posted keys land later).
                if (Verified(result)) Overlay.Show(marker, MarkerVerb.Typing, target, caret: Caret.For(target, el));
                return result;
            }
            // UIA SetFocus is a keyboard (Tab-like) focus, and a field may
            // select its whole text on such a focus (a WinForms TextBox does
            // on its first one), so the keys would replace the text. Focusing
            // must not change what the field had selected: its selection is
            // read before and, if focusing changed it, put back. Through UIA
            // TextPattern, or, for a Win32 edit control without it (a .NET
            // Framework WinForms TextBox exposes none), EM_GETSEL/EM_SETSEL.
            Focus.RequireShown(target);
            // The element checks (input desktop, elevation, still in the
            // target) come before any message to the field: an elevated
            // target must answer target_elevated, not an unread selection.
            Focus.RequireSemantic(target, el, refuse);
            var selection = Selection(el);
            var edit = selection == null ? EditWindow(el, target, index) : HWND.Null;
            (uint Start, uint End)? editBefore = null;
            if (edit != HWND.Null)
            {
                // Read before anything is done to the field; `selection` is null here.
                editBefore = ReadEditSelection(edit);
                if (editBefore == null)
                {
                    throw new HelperError("action_not_supported", $"wmux could not read element {index}'s selection (the field did not answer, or holds more than 65,534 characters), so nothing was typed: focusing it may select its whole text. Click where the text should go, then type without an index");
                }
            }
            bool kept = selection != null || edit != HWND.Null;
            bool activated = !Focus.InFront(target);
            try
            {
                try
                {
                    Focus.RequireSemantic(target, el, refuse);
                    GiveBack.NoteOwnInput(call: true);
                    el->SetFocus();
                    GiveBack.CallDone();
                }
                catch (Exception e) when (e is not HelperError)
                {
                    if (Uia.IsGone(e.HResult)) throw new HelperError("element_stale", $"element {index} went away");
                }
                // Typing into whatever else has focus would put the text in the
                // wrong field. A window behind others is activated by SetFocus
                // asynchronously, so the focus is waited for, not read once.
                if (!Focus.Lands(snap.RuntimeIds[index], activated))
                {
                    throw new HelperError("action_not_supported", $"element {index} did not take keyboard focus; nothing was typed. Click it first");
                }
                bool lost = selection != null ? !KeepSelection(el, selection)
                    : edit != HWND.Null ? !KeepEditSelection(edit, editBefore!.Value)
                    : SelectsText(el);
                if (lost)
                {
                    throw new HelperError("action_not_supported", kept
                        ? $"element {index} changed its selection when it took focus, and wmux could not put it back, so nothing was typed (the keys would have replaced the selected text). Click where the text should go, then type without an index"
                        : $"element {index} has text selected after it took focus, and wmux could not read what was selected before, so nothing was typed (the keys would have replaced it). Click where the text should go, then type without an index");
                }
                // Selecting the old range again must not have moved focus.
                if (kept && !Uia.FocusedRuntimeId().AsSpan().SequenceEqual(snap.RuntimeIds[index]))
                {
                    throw new HelperError("action_not_supported", $"element {index} lost keyboard focus while its selection was put back; nothing was typed. Click it first");
                }
            }
            finally
            {
                if (selection != null) selection->Release();
            }
        }
        else
        {
            Overlay.Show(marker, MarkerVerb.Typing, target, caret: Caret.For(target));
            var posted = BackgroundInput.Type(target, text, null, null, -1, null);
            if (AfterBackground("type", posted, refuse, sentAtStart) is { } result)
            {
                if (Verified(result)) Overlay.Show(marker, MarkerVerb.Typing, target, caret: Caret.For(target));
                return result;
            }
            if (!refuse) Focus.BringForwardForKeys(target);
        }

        // The marker's caret lookup is UIA work, so it comes before the
        // keyboard check below, which is the last thing before the first key;
        // the marker says "using your keyboard" only once that check passed
        // (showing it is a posted command, not UIA).
        var realCaret = Caret.For(target);
        // Checked before anything is sent; FocusedValue below is the baseline for verification.
        Action? preflight = Focus.RequireKeyboard(target);
        Overlay.Show(marker, MarkerVerb.Typing, target, caret: realCaret, realInput: true);
        var before = FocusedValue();
        // The element the keys go into, for showing its value if they do not verify.
        var typedInto = Uia.FocusedRuntimeId();
        var chunks = Chunks.Unicode(text);
        int total = chunks.Sum(c => c.GraphemeCount), typed = 0;
        foreach (var chunk in chunks)
        {
            try
            {
                // The full check (focused element, password field with
                // unknown refused, integrity) before every chunk; the first
                // chunk reuses the one made just above. The fast Win32 check
                // inside Post, right before SendInput, then requires the same
                // foreground window and focused HWND.
                preflight ??= Focus.RequireKeyboard(target);
                if (chunk.Text != null) Input.TypeText(chunk.Text, preflight);
                else Input.Tap(Key(chunk.Key!), [], preflight);
                preflight = null;
            }
            catch (HelperError e)
            {
                throw new HelperError(e.Code, $"{e.Message} (after {typed} of {total} characters; the rest was not typed)");
            }
            typed += chunk.GraphemeCount;
        }
        var effect = Verify.SettleInserted(FocusedValue, before, text, total < 64 ? 300 : 1000, () => Environment.TickCount64, Sta.Sleep);
        if (effect.Verified)
        {
            Overlay.Show(marker, MarkerVerb.Typing, target, caret: Caret.For(target), realInput: true);
            return Result("synthetic", true, "foreground");
        }
        return WithObserved(Result("synthetic", false, "foreground"), ObservedFocused(before, typedInto));
    }

    /// <summary>
    /// What the field the keys went into holds now, for an unverified `type`
    /// (Verify.Observed). The focused element is read once and used for
    /// everything: it must still be the element the keys went into
    /// (`typedInto`, read before the keys), its password check decides
    /// `[redacted]`, and its own value is read. Focus that moved to another
    /// field shows nothing, never that field's value; an element that cannot
    /// be read shows nothing either.
    /// </summary>
    private static string? ObservedFocused(string? before, int[] typedInto)
    {
        if (typedInto.Length == 0) return null;
        var el = Uia.Focused();
        if (el == null) return null;
        try
        {
            if (!Uia.CurrentRuntimeId(el).AsSpan().SequenceEqual(typedInto)) return null;
            if (Uia.IsSecretElement(el)) return "[redacted]";
            return Verify.Observed(before, Uia.CurrentString(el, Uia.ValueValueProperty), secret: false);
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

    private static bool Verified(JsonObject result) => result["verification"]?.GetValue<string>() == "verified";

    /// <summary>
    /// The field's one selected range (a caret is an empty one) through UIA
    /// TextPattern, or null when the field has no TextPattern, reports no
    /// single range, or cannot be read. The caller releases it.
    /// </summary>
    private static IUIAutomationTextRange* Selection(IUIAutomationElement* el)
    {
        var text = (IUIAutomationTextPattern*)Pattern(el, Uia.TextPattern, IUIAutomationTextPattern.IID_Guid);
        if (text == null) return null;
        IUIAutomationTextRangeArray* ranges = null;
        try
        {
            ranges = text->GetSelection();
            return ranges != null && ranges->Length == 1 ? ranges->GetElement(0) : null;
        }
        catch (Exception e) when (e is not HelperError)
        {
            return null;
        }
        finally
        {
            if (ranges != null) ranges->Release();
            text->Release();
        }
    }

    /// <summary>
    /// The field (whose selection before the focus could not be read) now
    /// has a non-empty selection; unreadable counts as yes. False only when
    /// it has no readable TextPattern at all (then it is focused as before)
    /// or its selection is a caret.
    /// </summary>
    private static bool SelectsText(IUIAutomationElement* el)
    {
        var text = (IUIAutomationTextPattern*)Pattern(el, Uia.TextPattern, IUIAutomationTextPattern.IID_Guid);
        if (text == null) return false;
        text->Release();
        var now = Selection(el);
        if (now == null) return true;
        try
        {
            return now->CompareEndpoints(TextPatternRangeEndpoint.TextPatternRangeEndpoint_Start, now, TextPatternRangeEndpoint.TextPatternRangeEndpoint_End) != 0;
        }
        catch (Exception e) when (e is not HelperError)
        {
            return true;
        }
        finally
        {
            now->Release();
        }
    }

    /// <summary>What putting the caret at the end of a set value did.</summary>
    private enum CaretMove { Done, NotATextField, Failed }

    /// <summary>
    /// After a verified setValue: the caret goes to the end of the new value,
    /// so a `type` that follows appends to it. ValuePattern.SetValue leaves
    /// the selection wherever the app puts it (Notepad: position 0), and a
    /// later `type` with an index keeps the field's selection across its
    /// focus, so the text used to land at the start. Through UIA TextPattern
    /// (an empty range at the document's end, selected), then, if that is
    /// not confirmed, EM_SETSEL at the text's length for a Win32 edit
    /// control. Confirmed when the selection reads back as a caret with only
    /// line breaks after it (a rich edit keeps the caret before its final
    /// paragraph mark). A field with neither (a combo box, a slider) has no
    /// caret: NotATextField. Select is a pattern call, so it is made only
    /// while the helper is not stopping and the element still passes
    /// Focus.RequireSemantic; otherwise Failed, never an error, because the
    /// value was already set.
    /// </summary>
    private static CaretMove CaretToEnd(IUIAutomationElement* el, ControlTarget target, bool refuseForeground)
    {
        var text = (IUIAutomationTextPattern*)Pattern(el, Uia.TextPattern, IUIAutomationTextPattern.IID_Guid);
        HWND edit;
        try
        {
            edit = EditWindow(el, target, -1);
        }
        catch (HelperError)
        {
            edit = HWND.Null;
        }
        if (text == null && edit == HWND.Null) return CaretMove.NotATextField;
        try
        {
            Input.ThrowIfStopping();
            Focus.RequireSemantic(target, el, refuseForeground);
        }
        catch (HelperError)
        {
            if (text != null) text->Release();
            return CaretMove.Failed;
        }
        if (text != null)
        {
            bool placed;
            try
            {
                placed = SelectEnd(el, text);
            }
            finally
            {
                text->Release();
            }
            if (placed) return CaretMove.Done;
        }
        if (edit == HWND.Null) return CaretMove.Failed;
        nuint length;
        if (PInvoke.SendMessageTimeout(edit, WmGetTextLength, 0, 0, SEND_MESSAGE_TIMEOUT_FLAGS.SMTO_ABORTIFHUNG, EditMessageTimeoutMs, &length) == 0) return CaretMove.Failed;
        if (length > EditSelection.MaxPackedLength) return CaretMove.Failed;
        return KeepEditSelection(edit, ((uint)length, (uint)length)) ? CaretMove.Done : CaretMove.Failed;
    }

    /// <summary>Selects an empty range at the document's end through `text`; true when the selection reads back as a caret with only line breaks after it.</summary>
    private static bool SelectEnd(IUIAutomationElement* el, IUIAutomationTextPattern* text)
    {
        IUIAutomationTextRange* end = null;
        IUIAutomationTextRange* now = null;
        IUIAutomationTextRange* tail = null;
        try
        {
            end = text->DocumentRange;
            if (end == null) return false;
            end->MoveEndpointByRange(TextPatternRangeEndpoint.TextPatternRangeEndpoint_Start, end, TextPatternRangeEndpoint.TextPatternRangeEndpoint_End);
            Input.CountSemantic();
            end->Select();
            GiveBack.CallDone();
            now = Selection(el);
            if (now == null) return false;
            if (SameRange(end, now)) return true;
            if (now->CompareEndpoints(TextPatternRangeEndpoint.TextPatternRangeEndpoint_Start, now, TextPatternRangeEndpoint.TextPatternRangeEndpoint_End) != 0) return false;
            // A caret short of the end: fine when only line breaks follow it.
            tail = text->DocumentRange;
            tail->MoveEndpointByRange(TextPatternRangeEndpoint.TextPatternRangeEndpoint_Start, now, TextPatternRangeEndpoint.TextPatternRangeEndpoint_Start);
            return Verify.OnlyLineBreaks(Uia.Take(tail->GetText(64)));
        }
        catch (Exception e) when (e is not HelperError)
        {
            return false;
        }
        finally
        {
            if (tail != null) tail->Release();
            if (now != null) now->Release();
            if (end != null) end->Release();
        }
    }

    private const uint EmGetSel = 0x00B0;
    private const uint EmSetSel = 0x00B1;
    private const uint WmGetTextLength = 0x000E;
    private const uint EditMessageTimeoutMs = 1000;

    /// <summary>
    /// The element's own window when it is a Win32 edit control
    /// (RealGetWindowClass "Edit", so a WinForms TextBox's
    /// WindowsForms10.EDIT.* counts);
    /// null when it is not one. An edit control outside the target window
    /// or process is refused: its selection could not be kept, and it would
    /// be focused unprotected.
    /// </summary>
    private static HWND EditWindow(IUIAutomationElement* el, ControlTarget target, int index)
    {
        HWND hwnd;
        try
        {
            hwnd = el->CurrentNativeWindowHandle;
        }
        catch (Exception e) when (e is not HelperError)
        {
            return HWND.Null;
        }
        if (hwnd == HWND.Null || !PInvoke.IsWindow(hwnd) || Win.RealClassName(hwnd) != "Edit") return HWND.Null;
        if (Win.OwnerPid(hwnd) != target.Pid || !Win.InTargetWindow(Win.Root(hwnd), target.Window, target.Pid))
        {
            throw new HelperError("element_stale", $"element {index}'s edit window is no longer in the target window; nothing was typed");
        }
        return hwnd;
    }

    /// <summary>
    /// An edit control's selection: EM_GETSEL with no pointers (so it works
    /// across processes), trusted only for text that EM_GETSEL's packed
    /// answer can hold (Core EditSelection.Unpack). Null when either message
    /// went unanswered or the answer cannot be trusted.
    /// </summary>
    private static (uint Start, uint End)? ReadEditSelection(HWND edit)
    {
        nuint length, packed;
        if (PInvoke.SendMessageTimeout(edit, WmGetTextLength, 0, 0, SEND_MESSAGE_TIMEOUT_FLAGS.SMTO_ABORTIFHUNG, EditMessageTimeoutMs, &length) == 0) return null;
        if (PInvoke.SendMessageTimeout(edit, EmGetSel, 0, 0, SEND_MESSAGE_TIMEOUT_FLAGS.SMTO_ABORTIFHUNG, EditMessageTimeoutMs, &packed) == 0) return null;
        return EditSelection.Unpack((uint)packed, (uint)length);
    }

    /// <summary>
    /// The edit control's selection is `before` again. Unless it already
    /// reads back as `before`, it is put back with EM_SETSEL (also when the
    /// read failed) and read back once more.
    /// </summary>
    private static bool KeepEditSelection(HWND edit, (uint Start, uint End) before)
    {
        if (ReadEditSelection(edit) == before) return true;
        nuint ignored;
        if (PInvoke.SendMessageTimeout(edit, EmSetSel, before.Start, (nint)before.End, SEND_MESSAGE_TIMEOUT_FLAGS.SMTO_ABORTIFHUNG, EditMessageTimeoutMs, &ignored) == 0) return false;
        return ReadEditSelection(edit) == before;
    }

    private static bool SameRange(IUIAutomationTextRange* a, IUIAutomationTextRange* b)
    {
        try
        {
            return a->Compare(b);
        }
        catch (Exception e) when (e is not HelperError)
        {
            return false;
        }
    }

    /// <summary>
    /// After focusing: the field's selection is `before` again. If focusing
    /// changed it (a select-all on focus), `before` is selected again and
    /// read back. False when that cannot be confirmed.
    /// </summary>
    private static bool KeepSelection(IUIAutomationElement* el, IUIAutomationTextRange* before)
    {
        var now = Selection(el);
        if (now == null) return false;
        try
        {
            if (SameRange(before, now)) return true;
        }
        finally
        {
            now->Release();
        }
        try
        {
            GiveBack.NoteOwnInput(call: true);
            before->Select();
            GiveBack.CallDone();
        }
        catch (Exception e) when (e is not HelperError)
        {
            return false;
        }
        var again = Selection(el);
        if (again == null) return false;
        try
        {
            return SameRange(before, again);
        }
        finally
        {
            again->Release();
        }
    }

    public static JsonObject PressKey(Params p, AgentMarker marker)
    {
        long sentAtStart = Input.Sent;
        bool refuse = RefuseForeground(p);
        var (_, target) = Begin(p);
        var keyName = p.RequireString("key");
        var key = Key(keyName);
        int repeat = Math.Clamp(p.Int("repeat") ?? 1, 1, 50);
        Input.ThrowIfStopping();
        // The caret lookup (UIA) comes before every check before the first key.
        var caret = Caret.For(target);
        Overlay.Show(marker, MarkerVerb.Typing, target, caret: caret);
        var posted = BackgroundInput.Key(target, keyName, repeat, 0, "pressKey");
        if (AfterBackground("pressKey", posted, refuse, sentAtStart) is { } result) return result;
        if (!refuse) Focus.BringForwardForKeys(target);
        for (int n = 0; n < repeat; n++)
        {
            if (n > 0) Sta.Sleep(4);
            try
            {
                var preflight = Focus.RequireKeyboard(target);
                // "using your keyboard" once the check passed; a posted command, not UIA.
                if (n == 0) Overlay.Show(marker, MarkerVerb.Typing, target, caret: caret, realInput: true);
                Input.Tap(key, [], preflight);
            }
            catch (HelperError e) when (n > 0)
            {
                throw new HelperError(e.Code, $"{e.Message} (after {n} of {repeat} presses; the rest were not sent)");
            }
        }
        GiveBack.KeysSent(target.Window);
        return Result("synthetic", false, "foreground");
    }

    public static JsonObject Hotkey(Params p, AgentMarker marker)
    {
        long sentAtStart = Input.Sent;
        bool refuse = RefuseForeground(p);
        var (_, target) = Begin(p);
        var keyName = p.RequireString("key");
        var key = Key(keyName);
        var mods = Modifiers(p);
        Input.ThrowIfStopping();
        // The caret lookup (UIA) comes before every check before the key.
        var caret = Caret.For(target);
        Overlay.Show(marker, MarkerVerb.Typing, target, caret: caret);
        // Posted keys carry no modifier state, so a chord is always real input.
        var posted = BackgroundInput.Key(target, keyName, 1, mods.Count, "hotkey");
        if (AfterBackground("hotkey", posted, refuse, sentAtStart) is { } result) return result;
        if (!refuse) Focus.BringForwardForKeys(target);
        var keyPreflight = Focus.RequireKeyboard(target);
        // "using your keyboard" once the check passed; a posted command, not UIA.
        Overlay.Show(marker, MarkerVerb.Typing, target, caret: caret, realInput: true);
        Input.Tap(key, mods, keyPreflight);
        GiveBack.KeysSent(target.Window);
        return Result("synthetic", false, "foreground");
    }

    public static JsonObject Scroll(Params p, AgentMarker marker)
    {
        long sentAtStart = Input.Sent;
        bool refuse = RefuseForeground(p);
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
        // Always real input: WM_MOUSEWHEEL was not measured (Core Background.ActionRefusal).
        AfterBackground("scroll", BackgroundOutcome.Refused(BackgroundRefusal.Scroll), refuse, sentAtStart);
        // The preflight re-runs the hit-test before every notch: a window that
        // moves over the point mid-scroll must not receive the rest.
        var preflight = Focus.RequirePointer(target, x, y);
        Overlay.Show(marker, MarkerVerb.Scrolling, target, (x, y), realInput: true);
        var back = new CursorReturn();
        for (int n = 0; n < amount; n++)
        {
            if (n > 0) Sta.Sleep(8);
            try
            {
                Input.Wheel(x, y, dx, dy, preflight, back);
            }
            catch (HelperError e) when (n > 0)
            {
                throw new HelperError(e.Code, $"{e.Message} (after {n} of {amount} notches; the rest was not sent)");
            }
        }
        return Result("synthetic", false, "foreground");
    }
}
