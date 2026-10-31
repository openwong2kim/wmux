// Background input on Windows: PostMessage to one child window of the target,
// so the user's cursor, foreground window and focused control stay as they
// were (docs/computer-use-windows.md, "Background input").
//
// This file gathers what Core Background.Plan decides on (the target window's
// state, the window that would receive the messages), posts through
// Input.PostMessages, reads the effect back and probes for our own side
// effects. A refusal posts nothing, and the action then sends the same input
// as real input (the foreground path in Actions.cs). What the action itself
// asks for (Background.ActionRefusal) is decided before any window state is
// read, so a chord or a scroll costs no cross-process call.
//
// The receiver of a click is the child a real click at the point would hit:
// from the target window down, the topmost child in z-order that is visible,
// enabled, not WS_EX_TRANSPARENT, contains the point and does not answer
// WM_NCHITTEST with HTTRANSPARENT. It is looked up inside the target window
// whoever covers that point on screen: covering windows are what background
// input is for. A popup or menu of the target process over the point (in any
// z-order), or a point on a frame or scroll bar, goes the real way.

using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.System.Com;
using Windows.Win32.System.Variant;
using Windows.Win32.UI.Accessibility;
using Windows.Win32.UI.Shell;
using Windows.Win32.UI.WindowsAndMessaging;
using WmuxComputerUse.Core;

namespace WmuxComputerUse;

internal static unsafe class BackgroundInput
{
    /// <summary>How long after posting the cursor and foreground are compared with before (the app handles the messages asynchronously).</summary>
    private const int SettleMs = 60;
    /// <summary>How long the field may take to report keyboard focus after the posted click.</summary>
    private const int FocusWaitMs = 300;
    /// <summary>WM_NCHITTEST budget per window on the way to the receiver.</summary>
    private const uint HitTestTimeoutMs = 100;
    /// <summary>Cursor within this many pixels of the target point counts as "at the point".</summary>
    private const int CursorTolerance = 2;
    private const int EditControlType = 50004;
    private const int HasKeyboardFocusProperty = 30008;
    private const uint WmNcHitTest = 0x0084;
    private const nint HtTransparent = -1;

    private static readonly Guid ClsidVirtualDesktopManager = new(0xAA509086, 0x5CA9, 0x4C25, 0x8F, 0x95, 0x58, 0x9D, 0x3C, 0x07, 0xB4, 0x8A);
    private static IVirtualDesktopManager* desktops;
    private static bool desktopsUnavailable;
    private static IUIAutomationCondition* hasFocusCondition;

    /// <summary>A window that would receive posted messages, and the point in its client coordinates.</summary>
    private readonly record struct Target(HWND Hwnd, Receiver Info, int ClientX, int ClientY);

    // MARK: Actions

    /// <summary>A single left click with no modifiers, posted; anything else is refused before posting.</summary>
    public static BackgroundOutcome Click(ControlTarget target, double x, double y, int button, int count, int modifiers)
    {
        var request = new BackgroundRequest(InputAction.Click, button, count, modifiers);
        var early = Background.ActionRefusal(request);
        if (early != BackgroundRefusal.None) return BackgroundOutcome.Refused(early);
        var window = WindowState(target);
        Target? at = Background.WindowRefusal(window) == BackgroundRefusal.None ? AtPoint(target, x, y, secrecy: false) : null;
        var plan = Background.Plan(window, request, at?.Info);
        return Run("click", plan, target, (x, y),
            click: () => Input.PostMessages(at!.Value.Hwnd, Background.Click(at.Value.ClientX, at.Value.ClientY)),
            focusConfirmed: null, keys: null, readBack: () => false);
    }

    /// <summary>
    /// Text posted as WM_CHAR (a trailing newline as an Enter press). With a
    /// field (`type` with an index) the field is clicked first at
    /// `fieldPoint`, must then report keyboard focus, and the keys go to the
    /// window under the click; verified by the field's value. Without one
    /// the keys go to the target thread's focused control, which must be a
    /// plain text control whose focused element is not a password field.
    /// Text with a Tab or another control character is never posted (one
    /// focus check could not cover where the rest lands).
    /// </summary>
    public static BackgroundOutcome Type(ControlTarget target, string text, IUIAutomationElement* field, int[]? fieldRuntimeId, int index, (double X, double Y)? fieldPoint)
    {
        var request = new BackgroundRequest(InputAction.Type, HasField: field != null, Text: text);
        var early = Background.ActionRefusal(request);
        if (early != BackgroundRefusal.None) return BackgroundOutcome.Refused(early);
        var window = WindowState(target);
        Target? receiver = null;
        if (Background.WindowRefusal(window) == BackgroundRefusal.None)
        {
            receiver = field != null
                ? fieldPoint is { } fp ? AtPoint(target, fp.X, fp.Y, secrecy: true) : null
                : Focused(target);
        }
        var plan = Background.Plan(window, request, receiver?.Info);
        if (plan.Refused) return Run("type", plan, target, null, null, null, null, () => false);

        var to = receiver!.Value;
        Func<string?> value = field != null ? () => ElementValue(field) : () => WindowValue(to.Hwnd);
        var before = value();
        var chunks = Chunks.Unicode(text);
        int total = chunks.Sum(c => c.GraphemeCount);
        var outcome = Run("type", plan, target, plan.ClickFirst ? fieldPoint : null,
            click: () => Input.PostMessages(to.Hwnd, Background.Click(to.ClientX, to.ClientY)),
            focusConfirmed: field != null ? () => WaitFieldFocus(field, fieldRuntimeId ?? []) : null,
            keys: () =>
            {
                int posted = 0, typed = 0;
                foreach (var chunk in chunks)
                {
                    var messages = chunk.Text != null ? Background.Text(chunk.Text) : KeyMessages(chunk.Key!);
                    int n;
                    try
                    {
                        n = Input.PostMessages(to.Hwnd, messages);
                    }
                    catch (HelperError e)
                    {
                        throw new HelperError(e.Code, $"{e.Message} (after {typed} of {total} characters; the rest was not typed)");
                    }
                    if (n == 0)
                    {
                        if (posted == 0) return 0;
                        throw new HelperError("internal", $"Windows stopped taking posted messages after {typed} of {total} characters; the rest was not typed. Check the app state before retrying");
                    }
                    posted += n;
                    typed += chunk.GraphemeCount;
                }
                return posted;
            },
            readBack: () => WaitInserted(value, before, text, total < 64 ? 300 : 1000));
        return outcome.Stop switch
        {
            BackgroundStop.FocusUnconfirmed => throw new HelperError("action_not_supported",
                $"the click on element {index} was posted, but the field did not report keyboard focus, so nothing was typed. Call getAppState before retrying"),
            BackgroundStop.KeysNotPosted => throw new HelperError("internal",
                $"the click on element {index} was posted, but Windows did not take the keys, so nothing was typed. Call getAppState before retrying"),
            _ => outcome,
        };
    }

    /// <summary>`repeat` presses of a named key (or a hotkey with no modifiers) into the target thread's focused text control.</summary>
    public static BackgroundOutcome Key(ControlTarget target, string key, int repeat, int modifiers, string action)
    {
        var request = new BackgroundRequest(action == "hotkey" ? InputAction.Hotkey : InputAction.PressKey, Modifiers: modifiers);
        var early = Background.ActionRefusal(request);
        if (early != BackgroundRefusal.None) return BackgroundOutcome.Refused(early);
        var window = WindowState(target);
        var receiver = Background.WindowRefusal(window) == BackgroundRefusal.None ? Focused(target) : null;
        var plan = Background.Plan(window, request, receiver?.Info);
        return Run(action, plan, target, null, null, null,
            keys: () =>
            {
                var press = KeyMessages(key);
                var messages = new List<PostedMessage>(press.Count * repeat);
                for (int n = 0; n < repeat; n++) messages.AddRange(press);
                return Input.PostMessages(receiver!.Value.Hwnd, messages);
            },
            readBack: () => false);
    }

    private static List<PostedMessage> KeyMessages(string name)
    {
        var spec = Keys.Lookup(name) ?? throw new HelperError("invalid_argument", $"\"{(name.Length > 20 ? name[..20] : name)}\" is not a canonical key name");
        uint scan = PInvoke.MapVirtualKey(spec.Vk, Windows.Win32.UI.Input.KeyboardAndMouse.MAP_VIRTUAL_KEY_TYPE.MAPVK_VK_TO_VSC) & 0xFF;
        return Background.Key(spec.Vk, scan, Keys.IsExtended(spec.Vk));
    }

    /// <summary>Refuse (logged, left to the caller's real-input path), or run the steps in Core's order and probe for our side effects.</summary>
    private static BackgroundOutcome Run(string action, BackgroundPlan plan, ControlTarget target, (double X, double Y)? point,
        Func<int>? click, Func<bool>? focusConfirmed, Func<int>? keys, Func<bool> readBack)
    {
        if (plan.Refused)
        {
            Wire.Log($"{action}: real input, not background ({Background.Describe(plan.Refusal)})");
            return BackgroundOutcome.Refused(plan.Refusal);
        }
        // Never act while the lock screen or a secure desktop is up (an error, not a fallback).
        InputDesktop.Require();
        bool cursorBefore = CursorAt(point);
        var foregroundBefore = PInvoke.GetForegroundWindow();
        long postedAt = 0;
        Func<int>? Stamped(Func<int>? post) => post == null ? null : () =>
        {
            int n = post();
            postedAt = Environment.TickCount64;
            return n;
        };
        var steps = new BackgroundSteps(Stamped(click), focusConfirmed, Stamped(keys), readBack, () =>
        {
            long wait = SettleMs - (Environment.TickCount64 - postedAt);
            if (wait > 0) Sta.Sleep((int)wait);
            var foreground = PInvoke.GetForegroundWindow();
            return new SideEffectProbe(cursorBefore, CursorAt(point), (nint)foregroundBefore.Value, (nint)foreground.Value,
                foreground != HWND.Null && InTargetProcess(foreground, target));
        });
        var outcome = Background.Execute(plan, steps);
        if (outcome.FallBack) Wire.Log($"{action}: real input, not background ({Background.Describe(outcome.Refusal)})");
        return outcome;
    }

    // MARK: Window state

    private static TargetWindowState WindowState(ControlTarget target) => new(
        Iconic: PInvoke.IsIconic(target.Window),
        Visible: PInvoke.IsWindowVisible(target.Window) && !Win.IsCloaked(target.Window),
        OnCurrentDesktop: OnCurrentDesktop(target.Window),
        Elevated: Integrity.IsAboveSelf(target.Pid));

    /// <summary>IVirtualDesktopManager's answer, or null when it cannot be asked (then it is no reason to refuse).</summary>
    private static bool? OnCurrentDesktop(HWND hwnd)
    {
        if (desktops == null && !desktopsUnavailable)
        {
            var clsid = ClsidVirtualDesktopManager;
            var iid = IVirtualDesktopManager.IID_Guid;
            void* ppv;
            var hr = PInvoke.CoCreateInstance(&clsid, null, CLSCTX.CLSCTX_ALL, &iid, &ppv);
            if (hr.Failed)
            {
                desktopsUnavailable = true;
                return null;
            }
            desktops = (IVirtualDesktopManager*)ppv;
        }
        if (desktops == null) return null;
        try
        {
            BOOL on;
            desktops->IsWindowOnCurrentVirtualDesktop(hwnd, &on);
            return on;
        }
        catch (Exception e) when (e is not HelperError)
        {
            return null;
        }
    }

    /// <summary>The window belongs to the target process (a UWP frame counts by its app's pid).</summary>
    private static bool InTargetProcess(HWND hwnd, ControlTarget target) =>
        Win.OwnerPid(hwnd) == target.Pid || Win.EffectivePid(Win.Root(hwnd)) == target.Pid;

    private static bool CursorAt((double X, double Y)? point)
    {
        if (point is not { } p || !PInvoke.GetCursorPos(out var cursor)) return false;
        return Math.Abs(cursor.X - p.X) <= CursorTolerance && Math.Abs(cursor.Y - p.Y) <= CursorTolerance;
    }

    // MARK: Receivers

    private static bool RectContains(HWND hwnd, System.Drawing.Point p) =>
        PInvoke.GetWindowRect(hwnd, out var r) && p.X >= r.left && p.X < r.right && p.Y >= r.top && p.Y < r.bottom;

    private static HitTest NcHitTest(HWND hwnd, System.Drawing.Point screen)
    {
        nuint result;
        if (PInvoke.SendMessageTimeout(hwnd, WmNcHitTest, 0, Background.PointLParam(screen.X, screen.Y),
            SEND_MESSAGE_TIMEOUT_FLAGS.SMTO_ABORTIFHUNG, HitTestTimeoutMs, &result) == 0)
        {
            return HitTest.Failed;
        }
        return (nint)result == HtTransparent ? HitTest.Transparent : HitTest.Hit;
    }

    /// <summary>
    /// The child a real click at a screen pixel would hit inside the target
    /// window (Core Background.HitChild at each level), and the pixel in its
    /// client coordinates. Null when the point is outside the window.
    /// `secrecy`: also read whether the receiver's UIA element is a password
    /// field (keys will follow).
    /// </summary>
    private static Target? AtPoint(ControlTarget target, double x, double y, bool secrecy)
    {
        var screen = new System.Drawing.Point((int)Math.Round(x), (int)Math.Round(y));
        if (!RectContains(target.Window, screen)) return null;
        var current = target.Window;
        for (int depth = 0; depth < 32; depth++)
        {
            var handles = new List<HWND>();
            var children = new List<ChildWindow>();
            for (var c = PInvoke.GetWindow(current, GET_WINDOW_CMD.GW_CHILD); c != HWND.Null && handles.Count < 512; c = PInvoke.GetWindow(c, GET_WINDOW_CMD.GW_HWNDNEXT))
            {
                var exStyle = (WINDOW_EX_STYLE)(uint)PInvoke.GetWindowLongPtr(c, WINDOW_LONG_PTR_INDEX.GWL_EXSTYLE);
                handles.Add(c);
                children.Add(new ChildWindow(PInvoke.IsWindowVisible(c), PInvoke.IsWindowEnabled(c),
                    (exStyle & WINDOW_EX_STYLE.WS_EX_TRANSPARENT) != 0, RectContains(c, screen)));
            }
            var pick = Background.HitChild(children, i => NcHitTest(handles[i], screen));
            if (pick is null) return new Target(current, new Receiver(Win.ClassName(current), false, HitTestFailed: true), 0, 0);
            if (pick < 0) break;
            current = handles[pick.Value];
        }
        var client = screen;
        if (!PInvoke.ScreenToClient(current, ref client)) return null;
        bool inClient = PInvoke.GetClientRect(current, out var rect)
            && client.X >= rect.left && client.X < rect.right && client.Y >= rect.top && client.Y < rect.bottom;
        var info = new Receiver(
            ClassName: Win.ClassName(current),
            InTargetProcess: Win.OwnerPid(current) == target.Pid,
            InClientArea: inClient,
            PopupAtPoint: TargetPopupAt(target, screen),
            Secret: secrecy && WindowIsSecret(current));
        return new Target(current, info, client.X, client.Y);
    }

    /// <summary>
    /// A popup or menu of the target process lies over the point, in any
    /// z-order (another app may cover it, so WindowFromPoint would miss it):
    /// the click is meant for it, and it gets real input.
    /// </summary>
    private static bool TargetPopupAt(ControlTarget target, System.Drawing.Point screen)
    {
        foreach (var hwnd in Win.TopLevelWindows())
        {
            if (hwnd == target.Window || Win.OwnerPid(hwnd) != target.Pid) continue;
            var exStyle = (WINDOW_EX_STYLE)(uint)PInvoke.GetWindowLongPtr(hwnd, WINDOW_LONG_PTR_INDEX.GWL_EXSTYLE);
            var window = new TopLevelWindow(
                IsTarget: false,
                Visible: PInvoke.IsWindowVisible(hwnd) && !Win.IsCloaked(hwnd),
                ContainsPoint: RectContains(hwnd, screen),
                IsMenu: Win.ClassName(hwnd) == "#32768",
                OwnedByTarget: OwnedBy(hwnd, target.Window),
                ToolWindow: (exStyle & WINDOW_EX_STYLE.WS_EX_TOOLWINDOW) != 0);
            if (Background.BlocksPoint(window)) return true;
        }
        return false;
    }

    private static bool OwnedBy(HWND hwnd, HWND owner)
    {
        var current = hwnd;
        for (int i = 0; i < 16; i++)
        {
            current = PInvoke.GetWindow(current, GET_WINDOW_CMD.GW_OWNER);
            if (current == HWND.Null) return false;
            if (current == owner) return true;
        }
        return false;
    }

    /// <summary>
    /// The target thread's focused window (GetGUIThreadInfo), when it lies
    /// inside the target window. A thread that is not in front may have none.
    /// Its secrecy is that of the element with keyboard focus inside it (a
    /// windowless password field in a Document host counts), unreadable
    /// counting as secret.
    /// </summary>
    private static Target? Focused(ControlTarget target)
    {
        uint thread = PInvoke.GetWindowThreadProcessId(target.Window);
        var info = new GUITHREADINFO { cbSize = (uint)sizeof(GUITHREADINFO) };
        if (thread == 0 || !PInvoke.GetGUIThreadInfo(thread, &info) || info.hwndFocus == HWND.Null) return null;
        var focus = info.hwndFocus;
        bool inside = Win.Root(focus) == target.Window && Win.OwnerPid(focus) == target.Pid;
        var className = Win.ClassName(focus);
        // Only a window posted keys may go to is worth the cross-process reads.
        if (!inside || !Background.AcceptsPostedInput(className) || Background.IsChromiumWidget(className))
        {
            return new Target(focus, new Receiver(className, inside), 0, 0);
        }
        var (text, secret) = TextAndFocusSecrecy(focus);
        return new Target(focus, new Receiver(className, inside, TextControl: text, Secret: secret), 0, 0);
    }

    /// <summary>
    /// Whether a window's own UIA element is an Edit or Document, and whether
    /// the element with keyboard focus inside it (the window's element or a
    /// descendant) is a password field. No focused element found, or any
    /// read failing, counts as secret.
    /// </summary>
    private static (bool Text, bool Secret) TextAndFocusSecrecy(HWND hwnd)
    {
        IUIAutomationElement* el = null;
        IUIAutomationElement* focused = null;
        try
        {
            el = Uia.Automation->ElementFromHandle(hwnd);
            if (el == null) return (false, true);
            int type = (int)el->CurrentControlType;
            bool text = type is EditControlType or Uia.DocumentControlType;
            if (el->CurrentHasKeyboardFocus)
            {
                return (text, Uia.IsSecretElement(el));
            }
            focused = el->FindFirst(TreeScope.TreeScope_Descendants, HasFocusCondition);
            return (text, focused == null || Uia.IsSecretElement(focused));
        }
        catch (Exception e) when (e is not HelperError)
        {
            return (false, true);
        }
        finally
        {
            if (focused != null) focused->Release();
            if (el != null) el->Release();
        }
    }

    private static IUIAutomationCondition* HasFocusCondition
    {
        get
        {
            if (hasFocusCondition != null) return hasFocusCondition;
            var v = new VARIANT();
            v.vt = VARENUM.VT_BOOL;
            v.boolVal = VARIANT_BOOL.VARIANT_TRUE;
            hasFocusCondition = Uia.Automation->CreatePropertyCondition((UIA_PROPERTY_ID)HasKeyboardFocusProperty, v);
            return hasFocusCondition;
        }
    }

    /// <summary>The receiver's own UIA element is (or may be) a password field.</summary>
    private static bool WindowIsSecret(HWND hwnd)
    {
        IUIAutomationElement* el = null;
        try
        {
            el = Uia.Automation->ElementFromHandle(hwnd);
            return el == null || Uia.IsSecretElement(el);
        }
        catch (Exception e) when (e is not HelperError)
        {
            return true;
        }
        finally
        {
            if (el != null) el->Release();
        }
    }

    /// <summary>
    /// After the posted click: the field reports keyboard focus, either as
    /// the system's focused element (the foreground path's RuntimeId check)
    /// or through its own HasKeyboardFocus.
    /// </summary>
    private static bool WaitFieldFocus(IUIAutomationElement* field, int[] runtimeId)
    {
        long deadline = Environment.TickCount64 + FocusWaitMs;
        while (true)
        {
            if (runtimeId.Length > 0 && Uia.FocusedRuntimeId().AsSpan().SequenceEqual(runtimeId)) return true;
            try
            {
                if (field->CurrentHasKeyboardFocus) return true;
            }
            catch (Exception e) when (e is not HelperError)
            {
                return false;
            }
            if (Environment.TickCount64 >= deadline) return false;
            Sta.Sleep(15);
        }
    }

    // MARK: Read-back

    private static string? ElementValue(IUIAutomationElement* el)
    {
        try
        {
            return Uia.CurrentString(el, Uia.ValueValueProperty);
        }
        catch (Exception e) when (e is not HelperError)
        {
            return null;
        }
    }

    private static string? WindowValue(HWND hwnd)
    {
        IUIAutomationElement* el = null;
        try
        {
            el = Uia.Automation->ElementFromHandle(hwnd);
            return el == null ? null : Uia.CurrentString(el, Uia.ValueValueProperty);
        }
        catch (Exception e) when (e is not HelperError)
        {
            return null;
        }
        finally
        {
            if (el != null) el->Release();
        }
    }

    /// <summary>Verified only when the field's value is the value before with exactly the typed text inserted (Core Verify).</summary>
    private static bool WaitInserted(Func<string?> value, string? before, string text, int timeoutMs)
    {
        if (before == null) return false;
        long deadline = Environment.TickCount64 + timeoutMs;
        while (true)
        {
            if (Verify.Inserted(before, value(), text)) return true;
            if (Environment.TickCount64 >= deadline) return false;
            Sta.Sleep(15);
        }
    }
}
