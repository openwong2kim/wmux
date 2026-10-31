// Background input on Windows: PostMessage to one child window of the target,
// so the user's cursor, foreground window and focused control stay as they
// were (docs/computer-use-windows.md, "Background input").
//
// This file gathers what Core Background.Plan decides on (the target window's
// state, the window that would receive the messages), posts through
// Input.PostMessages, reads the effect back and probes for our own side
// effects. A refusal posts nothing, and the action then sends the same input
// as real input (the foreground path in Actions.cs).
//
// The receiver of a click is the deepest child of the target window at the
// point (ChildWindowFromPointEx, skipping invisible, disabled and transparent
// children), whoever covers that point on screen: covering windows are what
// background input is for. A popup or menu of the target at the point, or a
// point on a frame or scroll bar, goes the real way.

using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.System.Com;
using Windows.Win32.UI.Accessibility;
using Windows.Win32.UI.Shell;
using Windows.Win32.UI.WindowsAndMessaging;
using WmuxComputerUse.Core;

namespace WmuxComputerUse;

internal static unsafe class BackgroundInput
{
    /// <summary>How long after posting the cursor and foreground are compared with before (the app handles the messages asynchronously).</summary>
    private const int SettleMs = 60;
    /// <summary>Between the click on a field and the keys for it.</summary>
    private const int ClickToKeysMs = 30;
    /// <summary>Cursor within this many pixels of the target point counts as "at the point".</summary>
    private const int CursorTolerance = 2;
    private const int EditControlType = 50004;

    private static readonly Guid ClsidVirtualDesktopManager = new(0xAA509086, 0x5CA9, 0x4C25, 0x8F, 0x95, 0x58, 0x9D, 0x3C, 0x07, 0xB4, 0x8A);
    private static IVirtualDesktopManager* desktops;
    private static bool desktopsUnavailable;

    /// <summary>A window that would receive posted messages, and the point in its client coordinates.</summary>
    private readonly record struct Target(HWND Hwnd, Receiver Info, int ClientX, int ClientY);

    // MARK: Actions

    /// <summary>A single left click with no modifiers, posted; anything else is refused before posting.</summary>
    public static BackgroundOutcome Click(ControlTarget target, double x, double y, int button, int count, int modifiers)
    {
        var request = new BackgroundRequest(InputAction.Click, button, count, modifiers);
        var window = WindowState(target);
        Target? at = button == 0 && count == 1 && modifiers == 0 ? AtPoint(target, x, y, secrecy: false) : null;
        var plan = Background.Plan(window, request, at?.Info);
        return Run("click", plan, target, (x, y),
            post: () => Input.PostMessages(at!.Value.Hwnd, Background.Click(at.Value.ClientX, at.Value.ClientY)),
            readBack: () => false);
    }

    /// <summary>
    /// Text posted as WM_CHAR (Enter and Tab as key presses). With a field
    /// (`type` with an index) the field is clicked first at `fieldPoint` and
    /// the keys go to the window under it; verified by its value. Without
    /// one the keys go to the target thread's focused control, which must be
    /// a plain text control.
    /// </summary>
    public static BackgroundOutcome Type(ControlTarget target, string text, IUIAutomationElement* field, (double X, double Y)? fieldPoint)
    {
        var window = WindowState(target);
        Target? receiver;
        BackgroundPlan plan;
        if (field != null)
        {
            receiver = fieldPoint is { } fp ? AtPoint(target, fp.X, fp.Y, secrecy: true) : null;
            plan = Background.Plan(window, new BackgroundRequest(InputAction.Type, HasField: true), receiver?.Info);
        }
        else
        {
            receiver = Focused(target);
            plan = Background.Plan(window, new BackgroundRequest(InputAction.Type), receiver?.Info);
        }
        if (plan.Refused) return Run("type", plan, target, null, () => 0, () => false);

        var to = receiver!.Value;
        Func<string?> value = field != null ? () => ElementValue(field) : () => WindowValue(to.Hwnd);
        var before = value();
        var chunks = Chunks.Unicode(text);
        int total = chunks.Sum(c => c.GraphemeCount);
        return Run("type", plan, target, plan.ClickFirst ? fieldPoint : null,
            post: () =>
            {
                int posted = 0;
                if (plan.ClickFirst)
                {
                    posted = Input.PostMessages(to.Hwnd, Background.Click(to.ClientX, to.ClientY));
                    if (posted == 0) return 0;
                    Sta.Sleep(ClickToKeysMs);
                }
                int typed = 0;
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
    }

    /// <summary>`repeat` presses of a named key (or a hotkey with no modifiers) into the target thread's focused text control.</summary>
    public static BackgroundOutcome Key(ControlTarget target, string key, int repeat, int modifiers, string action)
    {
        var receiver = Focused(target);
        var request = new BackgroundRequest(action == "hotkey" ? InputAction.Hotkey : InputAction.PressKey, Modifiers: modifiers);
        var plan = Background.Plan(WindowState(target), request, receiver?.Info);
        return Run(action, plan, target, null,
            post: () =>
            {
                var press = KeyMessages(key);
                var messages = new List<PostedMessage>(press.Count * repeat);
                for (int n = 0; n < repeat; n++) messages.AddRange(press);
                return Input.PostMessages(receiver!.Value.Hwnd, messages);
            },
            readBack: () => false);
    }

    /// <summary>The wheel is not posted (not measured); this only records the refusal.</summary>
    public static BackgroundOutcome Scroll(ControlTarget target) =>
        Run("scroll", Background.Plan(WindowState(target), new BackgroundRequest(InputAction.Scroll), null), target, null, () => 0, () => false);

    private static List<PostedMessage> KeyMessages(string name)
    {
        var spec = Keys.Lookup(name) ?? throw new HelperError("invalid_argument", $"\"{(name.Length > 20 ? name[..20] : name)}\" is not a canonical key name");
        uint scan = PInvoke.MapVirtualKey(spec.Vk, Windows.Win32.UI.Input.KeyboardAndMouse.MAP_VIRTUAL_KEY_TYPE.MAPVK_VK_TO_VSC) & 0xFF;
        return Background.Key(spec.Vk, scan, Keys.IsExtended(spec.Vk));
    }

    /// <summary>Refuse, or post, read back and probe, in Core's order. A refusal is logged and left to the caller's real-input path.</summary>
    private static BackgroundOutcome Run(string action, BackgroundPlan plan, ControlTarget target, (double X, double Y)? point, Func<int> post, Func<bool> readBack)
    {
        if (plan.Refused)
        {
            Wire.Log($"{action}: real input, not background ({Background.Describe(plan.Refusal)})");
            return BackgroundOutcome.Refused(plan.Refusal);
        }
        // Never act while the lock screen or a secure desktop is up (an error, not a fallback).
        InputDesktop.Require();
        bool cursorBefore = CursorAt(point);
        bool frontBefore = TargetInFront(target);
        long postedAt = 0;
        var outcome = Background.Execute(plan,
            () =>
            {
                int n = post();
                postedAt = Environment.TickCount64;
                return n;
            },
            readBack,
            () =>
            {
                long wait = SettleMs - (Environment.TickCount64 - postedAt);
                if (wait > 0) Sta.Sleep((int)wait);
                return new SideEffectProbe(cursorBefore, CursorAt(point), frontBefore, TargetInFront(target));
            });
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

    private static bool TargetInFront(ControlTarget target) => Win.Root(PInvoke.GetForegroundWindow()) == target.Window;

    private static bool CursorAt((double X, double Y)? point)
    {
        if (point is not { } p || !PInvoke.GetCursorPos(out var cursor)) return false;
        return Math.Abs(cursor.X - p.X) <= CursorTolerance && Math.Abs(cursor.Y - p.Y) <= CursorTolerance;
    }

    // MARK: Receivers

    /// <summary>
    /// The deepest child of the target window at a screen pixel, and the
    /// pixel in its client coordinates. Null when the point is outside the
    /// window. `secrecy`: also read whether the receiver's UIA element is a
    /// password field (keys will follow).
    /// </summary>
    private static Target? AtPoint(ControlTarget target, double x, double y, bool secrecy)
    {
        var screen = new System.Drawing.Point((int)Math.Round(x), (int)Math.Round(y));
        const CWP_FLAGS Skip = CWP_FLAGS.CWP_SKIPINVISIBLE | CWP_FLAGS.CWP_SKIPDISABLED | CWP_FLAGS.CWP_SKIPTRANSPARENT;
        var current = target.Window;
        for (int depth = 0; depth < 32; depth++)
        {
            var pt = screen;
            if (!PInvoke.ScreenToClient(current, ref pt)) return null;
            var child = PInvoke.ChildWindowFromPointEx(current, pt, Skip);
            if (child == HWND.Null)
            {
                if (current == target.Window) return null;
                break;
            }
            if (child == current) break;
            current = child;
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
    /// A menu or a window the target owns (a dropdown, a dialog) is on screen
    /// at the point: the click is meant for it, and it gets real input.
    /// </summary>
    private static bool TargetPopupAt(ControlTarget target, System.Drawing.Point screen)
    {
        var hit = PInvoke.WindowFromPoint(screen);
        if (hit == HWND.Null || Win.OwnerPid(hit) != target.Pid) return false;
        var root = Win.Root(hit);
        if (root == target.Window) return false;
        if (Win.ClassName(root) == "#32768") return true;
        var owner = root;
        for (int i = 0; i < 16; i++)
        {
            owner = PInvoke.GetWindow(owner, GET_WINDOW_CMD.GW_OWNER);
            if (owner == HWND.Null) return false;
            if (owner == target.Window) return true;
        }
        return false;
    }

    /// <summary>
    /// The target thread's focused window (GetGUIThreadInfo), when it lies
    /// inside the target window. A thread that is not in front may have none.
    /// </summary>
    private static Target? Focused(ControlTarget target)
    {
        uint thread = PInvoke.GetWindowThreadProcessId(target.Window);
        var info = new GUITHREADINFO { cbSize = (uint)sizeof(GUITHREADINFO) };
        if (thread == 0 || !PInvoke.GetGUIThreadInfo(thread, &info) || info.hwndFocus == HWND.Null) return null;
        var focus = info.hwndFocus;
        bool inside = Win.Root(focus) == target.Window && Win.OwnerPid(focus) == target.Pid;
        var (text, secret) = TextAndSecrecy(focus);
        return new Target(focus, new Receiver(Win.ClassName(focus), inside, TextControl: text, Secret: secret), 0, 0);
    }

    /// <summary>Whether a window's own UIA element is an Edit or Document, and whether it is (or may be) a password field.</summary>
    private static (bool Text, bool Secret) TextAndSecrecy(HWND hwnd)
    {
        IUIAutomationElement* el = null;
        try
        {
            el = Uia.Automation->ElementFromHandle(hwnd);
            if (el == null) return (false, true);
            int type = (int)el->CurrentControlType;
            return (type is EditControlType or Uia.DocumentControlType, Uia.IsSecretElement(el));
        }
        catch (Exception e) when (e is not HelperError)
        {
            return (false, true);
        }
        finally
        {
            if (el != null) el->Release();
        }
    }

    private static bool WindowIsSecret(HWND hwnd) => TextAndSecrecy(hwnd).Secret;

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
