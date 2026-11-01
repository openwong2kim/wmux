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
using Windows.Win32.Graphics.Gdi;
using Windows.Win32.System.Com;
using Windows.Win32.System.Variant;
using Windows.Win32.UI.Accessibility;
using Windows.Win32.UI.HiDpi;
using Windows.Win32.UI.Input.KeyboardAndMouse;
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
    /// <summary>Children read per window on the way to the receiver; a window with more is refused.</summary>
    private const int MaxChildren = 512;
    private const int EditControlType = 50004;
    private const int HasKeyboardFocusProperty = 30008;
    private const uint WmNcHitTest = 0x0084;
    private const nint HtTransparent = -1;

    private static readonly Guid ClsidVirtualDesktopManager = new(0xAA509086, 0x5CA9, 0x4C25, 0x8F, 0x95, 0x58, 0x9D, 0x3C, 0x07, 0xB4, 0x8A);
    private static IVirtualDesktopManager* desktops;
    private static bool desktopsUnavailable;
    private static IUIAutomationCondition* hasFocusCondition;

    /// <summary>A window that would receive posted messages, and the point in its client coordinates.</summary>
    /// <remarks>`Pid` and `Tid` own the window at resolve time; every post re-checks them (Input.PostMessages).</remarks>
    private readonly record struct Target(HWND Hwnd, Receiver Info, int ClientX, int ClientY, uint Pid, uint Tid);

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
        return Run(plan, target, (x, y),
            click: () => Post(at!.Value, Background.Click(at.Value.ClientX, at.Value.ClientY)),
            keys: null, readBack: () => false);
    }

    private static int Post(Target to, IReadOnlyList<PostedMessage> messages) => Input.PostMessages(to.Hwnd, to.Pid, to.Tid, messages);

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
        if (plan.Refused) return Run(plan, target, null, null, null, () => false);

        var to = receiver!.Value;
        Func<string?> value = field != null ? () => ElementValue(field) : () => WindowValue(to.Hwnd);
        var before = value();
        var chunks = Chunks.Unicode(text);
        int total = chunks.Sum(c => c.GraphemeCount);
        var runtimeId = fieldRuntimeId ?? [];
        // A plain Edit's focus is also read from its own thread: UIA reports
        // it only while the window is in front.
        bool plainEdit = Background.IsPlainEdit(to.Info.ClassName);
        Func<bool?> fieldFocus = () => Background.FieldFocused(FieldHasFocus(field, runtimeId), to.Info.ClassName, (nint)ThreadFocus(to.Tid).Value, (nint)to.Hwnd.Value);
        var outcome = Run(plan, target, plan.ClickFirst ? fieldPoint : null,
            click: () => Post(to, Background.Click(to.ClientX, to.ClientY)),
            keys: () =>
            {
                int posted = 0, typed = 0;
                foreach (var chunk in chunks)
                {
                    var messages = chunk.Text != null ? Background.Text(chunk.Text) : KeyMessages(chunk.Key!);
                    int n;
                    try
                    {
                        n = Post(to, messages);
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
            readBack: () => WaitInserted(value, before, text, total < 64 ? 300 : 1000),
            focusBefore: field != null ? () => fieldFocus() == true : null,
            fieldAfterClick: field != null && fieldPoint is { } clicked ? focusBefore => FieldAfterClick(field, fieldFocus, clicked, focusBefore) : null,
            receiverStill: field == null ? () => FocusWindow(target) == to.Hwnd : null,
            clickedReceiverFocused: field != null && plainEdit ? () => ThreadFocus(to.Tid) == to.Hwnd : null);
        return outcome.Stop switch
        {
            BackgroundStop.FocusUnconfirmed => throw new HelperError("action_not_supported",
                $"the click on element {index} was posted, but the field did not report keyboard focus, so nothing was typed. Call getAppState before retrying"),
            BackgroundStop.FieldMoved => throw new HelperError("action_not_supported",
                $"the click on element {index} was posted, but the field moved away from the clicked point, so nothing was typed. Call getAppState before retrying"),
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
        return Run(plan, target, null, null,
            keys: () =>
            {
                var press = KeyMessages(key);
                var messages = new List<PostedMessage>(press.Count * repeat);
                for (int n = 0; n < repeat; n++) messages.AddRange(press);
                return Post(receiver!.Value, messages);
            },
            readBack: () => false,
            receiverStill: () => FocusWindow(target) == receiver!.Value.Hwnd);
    }

    private static List<PostedMessage> KeyMessages(string name)
    {
        var spec = Keys.Lookup(name) ?? throw new HelperError("invalid_argument", $"\"{(name.Length > 20 ? name[..20] : name)}\" is not a canonical key name");
        uint scan = PInvoke.MapVirtualKey(spec.Vk, Windows.Win32.UI.Input.KeyboardAndMouse.MAP_VIRTUAL_KEY_TYPE.MAPVK_VK_TO_VSC) & 0xFF;
        return Background.Key(spec.Vk, scan, Keys.IsExtended(spec.Vk));
    }

    /// <summary>
    /// Refuse (left to the caller: real input or needs_foreground), or run
    /// the steps in Core's order and probe for our side effects. `focusBefore`
    /// and `fieldAfterClick` are for a field; `receiverStill` for keys
    /// without a click.
    /// </summary>
    private static BackgroundOutcome Run(BackgroundPlan plan, ControlTarget target, (double X, double Y)? point,
        Func<int>? click, Func<int>? keys, Func<bool> readBack,
        Func<bool>? focusBefore = null, Func<bool, FieldCheck>? fieldAfterClick = null, Func<bool>? receiverStill = null,
        Func<bool>? clickedReceiverFocused = null)
    {
        // A refusal is logged by the caller (Actions.AfterBackground), which
        // knows whether real input or needs_foreground follows.
        if (plan.Refused) return BackgroundOutcome.Refused(plan.Refusal);
        // Never act while the lock screen or a secure desktop is up (an error, not a fallback).
        InputDesktop.Require();
        bool cursorBefore = CursorAt(point);
        var foregroundBefore = PInvoke.GetForegroundWindow();
        uint inputBefore = LastInputTick();
        long postedAt = 0;
        Func<int>? Stamped(Func<int>? post) => post == null ? null : () =>
        {
            int n = post();
            postedAt = Environment.TickCount64;
            return n;
        };
        var steps = new BackgroundSteps(Stamped(click), fieldAfterClick, Stamped(keys), readBack, () =>
        {
            long wait = SettleMs - (Environment.TickCount64 - postedAt);
            if (wait > 0) Sta.Sleep((int)wait);
            var foreground = PInvoke.GetForegroundWindow();
            return new SideEffectProbe(cursorBefore, CursorAt(point), (nint)foregroundBefore.Value, (nint)foreground.Value,
                foreground != HWND.Null && InTargetProcess(foreground, target),
                UserInput: LastInputTick() != inputBefore);
        })
        {
            FocusBeforeClick = focusBefore,
            ReceiverStill = receiverStill,
            ClickedReceiverFocused = clickedReceiverFocused,
        };
        return Background.Execute(plan, steps);
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

    /// <summary>
    /// GetLastInputInfo's tick: it moves with the user's real input (and
    /// SendInput), never with posted messages. 0 when it cannot be read.
    /// </summary>
    private static uint LastInputTick()
    {
        var info = new LASTINPUTINFO { cbSize = (uint)sizeof(LASTINPUTINFO) };
        return PInvoke.GetLastInputInfo(ref info) ? info.dwTime : 0;
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
        // A window that reads coordinates in another DPI would also answer the
        // hit tests below in it: refuse before walking.
        uint monitorDpi = MonitorDpiAt(screen);
        uint rootDpi = PInvoke.GetDpiForWindow(target.Window);
        if (!Background.DpiMatches(rootDpi, monitorDpi))
        {
            return Resolved(target.Window, new Receiver(Win.ClassName(target.Window), true, WindowDpi: rootDpi, MonitorDpi: monitorDpi), 0, 0);
        }
        var current = target.Window;
        for (int depth = 0; depth < 32; depth++)
        {
            var handles = new List<HWND>();
            var children = new List<ChildWindow>();
            bool truncated = false;
            for (var c = PInvoke.GetWindow(current, GET_WINDOW_CMD.GW_CHILD); c != HWND.Null; c = PInvoke.GetWindow(c, GET_WINDOW_CMD.GW_HWNDNEXT))
            {
                if (handles.Count == MaxChildren)
                {
                    truncated = true;
                    break;
                }
                var exStyle = (WINDOW_EX_STYLE)(uint)PInvoke.GetWindowLongPtr(c, WINDOW_LONG_PTR_INDEX.GWL_EXSTYLE);
                handles.Add(c);
                children.Add(new ChildWindow(PInvoke.IsWindowVisible(c), PInvoke.IsWindowEnabled(c),
                    (exStyle & WINDOW_EX_STYLE.WS_EX_TRANSPARENT) != 0, RectContains(c, screen)));
            }
            // The child a real click hits may be past the cut: post nowhere.
            if (truncated) return Resolved(current, new Receiver(Win.ClassName(current), false, ChildrenTruncated: true), 0, 0);
            var pick = Background.HitChild(children, i => NcHitTest(handles[i], screen));
            if (pick is null) return Resolved(current, new Receiver(Win.ClassName(current), false, HitTestFailed: true), 0, 0);
            if (pick < 0) break;
            current = handles[pick.Value];
        }
        var client = screen;
        if (!PInvoke.ScreenToClient(current, ref client)) return null;
        bool inClient = PInvoke.GetClientRect(current, out var rect)
            && client.X >= rect.left && client.X < rect.right && client.Y >= rect.top && client.Y < rect.bottom;
        var className = Win.ClassName(current);
        var info = new Receiver(
            ClassName: className,
            InTargetProcess: Win.OwnerPid(current) == target.Pid,
            InClientArea: inClient,
            PopupAtPoint: TargetPopupAt(target, screen),
            Secret: secrecy && (Background.IsPlainEdit(className)
                ? Background.EditSecret(WindowIsSecret(current), WindowStyle(current))
                : WindowIsSecret(current)),
            WindowDpi: PInvoke.GetDpiForWindow(current),
            MonitorDpi: monitorDpi);
        return Resolved(current, info, client.X, client.Y);
    }

    /// <summary>A receiver with the process and thread that own it now, re-checked before every post.</summary>
    private static Target Resolved(HWND hwnd, Receiver info, int clientX, int clientY)
    {
        uint tid = PInvoke.GetWindowThreadProcessId(hwnd, out var pid);
        return new Target(hwnd, info, clientX, clientY, pid, tid);
    }

    /// <summary>The effective DPI of the monitor at a screen pixel; 0 when it cannot be read.</summary>
    private static uint MonitorDpiAt(System.Drawing.Point screen)
    {
        var monitor = PInvoke.MonitorFromPoint(screen, MONITOR_FROM_FLAGS.MONITOR_DEFAULTTONEAREST);
        if (monitor.IsNull) return 0;
        return PInvoke.GetDpiForMonitor(monitor, MONITOR_DPI_TYPE.MDT_EFFECTIVE_DPI, out var dpiX, out _).Succeeded ? dpiX : 0;
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
        var focus = FocusWindow(target);
        if (focus == HWND.Null) return null;
        bool inside = Win.Root(focus) == target.Window && Win.OwnerPid(focus) == target.Pid;
        var className = Win.ClassName(focus);
        // Only a window posted keys may go to is worth the cross-process reads.
        if (!inside || !Background.AcceptsPostedInput(className) || Background.IsChromiumWidget(className))
        {
            return Resolved(focus, new Receiver(className, inside), 0, 0);
        }
        var (text, secret) = TextAndFocusSecrecy(focus, className);
        return Resolved(focus, new Receiver(className, inside, TextControl: text, Secret: secret), 0, 0);
    }

    /// <summary>The target thread's focused window right now (GetGUIThreadInfo), or null.</summary>
    private static HWND FocusWindow(ControlTarget target) => ThreadFocus(PInvoke.GetWindowThreadProcessId(target.Window));

    /// <summary>A thread's focused window right now (GetGUIThreadInfo), or null.</summary>
    private static HWND ThreadFocus(uint thread)
    {
        var info = new GUITHREADINFO { cbSize = (uint)sizeof(GUITHREADINFO) };
        if (thread == 0 || !PInvoke.GetGUIThreadInfo(thread, &info)) return HWND.Null;
        return info.hwndFocus;
    }

    /// <summary>A window's GWL_STYLE, or null when it cannot be read (a live window always has some style bits).</summary>
    private static uint? WindowStyle(HWND hwnd)
    {
        var style = (uint)PInvoke.GetWindowLongPtr(hwnd, WINDOW_LONG_PTR_INDEX.GWL_STYLE);
        return style == 0 ? null : style;
    }

    /// <summary>
    /// Whether a window's own UIA element is an Edit or Document, and whether
    /// the element with keyboard focus inside it (the window's element or a
    /// descendant) is a password field. No focused element found, or any
    /// read failing, counts as secret. A window that is not a text control
    /// is refused anyway, so its tree is not searched (that walk can cover a
    /// whole large window). A plain Edit is the thread's focused window here,
    /// has no windowless children, and UIA does not report its focus in the
    /// background, so its own element and its ES_PASSWORD style decide.
    /// </summary>
    private static (bool Text, bool Secret) TextAndFocusSecrecy(HWND hwnd, string className)
    {
        IUIAutomationElement* el = null;
        IUIAutomationElement* focused = null;
        try
        {
            el = Uia.Automation->ElementFromHandle(hwnd);
            if (el == null) return (false, true);
            int type = (int)el->CurrentControlType;
            bool text = type is EditControlType or Uia.DocumentControlType;
            if (!text) return (false, true);
            if (Background.IsPlainEdit(className)) return (text, Background.EditSecret(Uia.IsSecretElement(el), WindowStyle(hwnd)));
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
    /// The field reports keyboard focus, either as the system's focused
    /// element (the foreground path's RuntimeId check) or through its own
    /// HasKeyboardFocus. Null when it cannot be read.
    /// </summary>
    private static bool? FieldHasFocus(IUIAutomationElement* field, int[] runtimeId)
    {
        if (runtimeId.Length > 0 && Uia.FocusedRuntimeId().AsSpan().SequenceEqual(runtimeId)) return true;
        try
        {
            return field->CurrentHasKeyboardFocus;
        }
        catch (Exception e) when (e is not HelperError)
        {
            return null;
        }
    }

    /// <summary>
    /// After the posted click, before any key: the field reports focus
    /// (waiting up to FocusWaitMs for the app to handle the click) and its
    /// fresh frame still contains the clicked point. A field that already
    /// had focus before the click is read only after a settle, so its old
    /// focus is not taken for the click's.
    /// </summary>
    private static FieldCheck FieldAfterClick(IUIAutomationElement* field, Func<bool?> fieldFocus, (double X, double Y) point, bool focusBefore)
    {
        if (focusBefore) Sta.Sleep(SettleMs);
        long deadline = Environment.TickCount64 + FocusWaitMs;
        bool focused;
        while (true)
        {
            var now = fieldFocus();
            if (now is null) return new FieldCheck(false, false);
            focused = now.Value;
            if (focused || Environment.TickCount64 >= deadline) break;
            Sta.Sleep(15);
        }
        bool atPoint;
        try
        {
            var frame = Uia.ToRect(field->CurrentBoundingRectangle);
            atPoint = !frame.IsEmpty && point.X >= frame.X && point.X < frame.X + frame.Width && point.Y >= frame.Y && point.Y < frame.Y + frame.Height;
        }
        catch (Exception e) when (e is not HelperError)
        {
            atPoint = false;
        }
        return new FieldCheck(focused, atPoint);
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
