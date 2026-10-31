// Background ("target-only") input: what can be posted to the target window
// alone, so the user's cursor, foreground window and focused control stay as
// they were. Pure logic; the helper (Helper/BackgroundInput.cs) gathers the
// window state, posts the messages and reads the effect back.
//
// The order is fixed:
//   1. What the action asks for (ActionRefusal): a chord, the wheel, another
//      button, a multi-click, text that moves focus. Decided before any
//      window state is read, so these go straight to real input.
//   2. The target's state and the window that would receive (Plan).
//   3. Post: the click, then (for `type` with a field) confirm that the field
//      took focus before any key is posted, then the keys.
//   4. Read the effect back, then compare cursor and foreground with before.
// - A refusal in 1 or 2, or a first post that Windows did not take, posts
//   nothing (not_delivered), so the action may fall back to real input
//   (SendInput), the default path.
// - Once a message was posted there is no fallback: the same input must never
//   arrive twice. PostMessage has no delivery ack, so a post is unverified
//   until a re-read confirms its effect.
// - If, after posting, the cursor sits on the target point and did not
//   before, or the foreground window changed to a window of the target
//   process, the posting caused it: delivered_unverified, never verified,
//   never a fallback. The user moving their own mouse or switching to
//   another app is not such a side effect.

namespace WmuxComputerUse.Core;

public enum InputAction { Click, Type, PressKey, Hotkey, Scroll }

/// <summary>Why an action was not posted in the background. None = it can be.</summary>
public enum BackgroundRefusal
{
    None,
    Minimized,
    Hidden,
    OtherDesktop,
    Elevated,
    Modifiers,
    Button,
    MultiClick,
    Scroll,
    Chord,
    FocusMovingText,
    NoReceiver,
    HitTestFailed,
    NonClientArea,
    NoFocusedControl,
    PopupAtPoint,
    UnsupportedFramework,
    ChromiumNeedsClick,
    NotATextControl,
    SecretField,
    NothingPosted,
}

/// <summary>The target top-level window as read right before posting.</summary>
/// <param name="OnCurrentDesktop">IVirtualDesktopManager's answer; null when that call failed (then it is not a reason to refuse).</param>
public readonly record struct TargetWindowState(bool Iconic, bool Visible, bool? OnCurrentDesktop, bool Elevated);

/// <summary>
/// What the action needs. `HasField`: `type` with an element index, so there
/// is a field to click before the keys. `Text`: what `type` types.
/// </summary>
public readonly record struct BackgroundRequest(InputAction Action, int Button = 0, int ClickCount = 1, int Modifiers = 0, bool HasField = false, string? Text = null);

/// <summary>
/// The window that would get the messages. For a pointer action (and `type`
/// with an index) it is the child a real click at the point would hit; for
/// keys without an index it is the target thread's focused window.
/// </summary>
/// <param name="ClassName">Window class of the receiver.</param>
/// <param name="InTargetProcess">The receiver belongs to the target pid (and, for keys, to the target window).</param>
/// <param name="InClientArea">The point is inside the receiver's client area (a click on a frame or scroll bar would need non-client messages).</param>
/// <param name="PopupAtPoint">A popup or menu of the target process lies over the point (it would take a real click, not the window under it).</param>
/// <param name="TextControl">The receiver's own UIA element is an Edit or Document.</param>
/// <param name="Secret">
/// With an index: the receiver's UIA element is (or may be) a password field.
/// Without one: the element that has keyboard focus inside the receiver is,
/// or no focused element could be read there.
/// </param>
/// <param name="HitTestFailed">A window on the way to the receiver did not answer WM_NCHITTEST in time.</param>
public readonly record struct Receiver(string ClassName, bool InTargetProcess, bool InClientArea = true, bool PopupAtPoint = false, bool TextControl = false, bool Secret = false, bool HitTestFailed = false);

/// <summary>A plan: refused, or post (a click first, then keys, or a click alone, or keys alone).</summary>
public readonly record struct BackgroundPlan(BackgroundRefusal Refusal, bool ClickFirst, bool Keys)
{
    public bool Refused => Refusal != BackgroundRefusal.None;

    public static BackgroundPlan Refuse(BackgroundRefusal reason) => new(reason, false, false);
}

public enum Disposition { NotDelivered, DeliveredUnverified, Delivered }

/// <summary>Why a posted action stopped before its keys: the click went in, so it ends delivered_unverified.</summary>
public enum BackgroundStop { None, FocusUnconfirmed, KeysNotPosted }

/// <summary>
/// How an action ended. `FallBack`: nothing was posted, so the foreground
/// (SendInput) path may send the same input instead; its own result then
/// reports `foreground`. `Stop`: the click was posted and the keys were not.
/// </summary>
public readonly record struct BackgroundOutcome(Disposition Disposition, bool FallBack, bool Verified, bool SideEffect, BackgroundRefusal Refusal, BackgroundStop Stop = BackgroundStop.None)
{
    public static BackgroundOutcome Refused(BackgroundRefusal reason) => new(Disposition.NotDelivered, true, false, false, reason);

    /// <summary>protocol ActionDelivery for a posted action: our side effect means the user's pointer or foreground did not stay as it was.</summary>
    public string Delivery => SideEffect ? "foreground" : "background";
}

/// <summary>
/// Cursor and foreground as seen before and after posting. `ForegroundAfterInTarget`:
/// the foreground window after posting belongs to the target process (the
/// target, a dialog or popup it owns, or another of its windows).
/// </summary>
public readonly record struct SideEffectProbe(bool CursorAtPointBefore, bool CursorAtPointAfter, nint ForegroundBefore, nint ForegroundAfter, bool ForegroundAfterInTarget)
{
    public bool Ours => (!CursorAtPointBefore && CursorAtPointAfter)
        || (ForegroundAfter != ForegroundBefore && ForegroundAfterInTarget);
}

/// <summary>The steps of a posted action; Execute calls them in its fixed order.</summary>
/// <param name="Click">Posts the click; returns how many messages went in (0: none).</param>
/// <param name="FocusConfirmed">After the click, before any key: whether the field took keyboard focus.</param>
/// <param name="Keys">Posts the keys; returns how many messages went in (0: none). Throws for a failure after its first message.</param>
/// <param name="ReadBack">Re-reads the effect; true only when it is confirmed.</param>
/// <param name="Probe">Cursor and foreground compared with before posting.</param>
public sealed record BackgroundSteps(Func<int>? Click, Func<bool>? FocusConfirmed, Func<int>? Keys, Func<bool> ReadBack, Func<SideEffectProbe> Probe);

/// <summary>A child window in z-order, as a real click at the point would test it.</summary>
public readonly record struct ChildWindow(bool Visible, bool Enabled, bool Transparent, bool ContainsPoint);

/// <summary>The answer to WM_NCHITTEST: the window takes the click, lets it through (HTTRANSPARENT), or did not answer.</summary>
public enum HitTest { Hit, Transparent, Failed }

/// <summary>A top-level window of the target process (EnumWindows), for the popup check.</summary>
public readonly record struct TopLevelWindow(bool IsTarget, bool Visible, bool ContainsPoint, bool IsMenu, bool OwnedByTarget, bool ToolWindow);

/// <summary>A message to post: PostMessage(receiver, Msg, WParam, LParam).</summary>
public readonly record struct PostedMessage(uint Msg, nuint WParam, nint LParam);

public static class Background
{
    public const uint WmMouseMove = 0x0200;
    public const uint WmLButtonDown = 0x0201;
    public const uint WmLButtonUp = 0x0202;
    public const uint WmKeyDown = 0x0100;
    public const uint WmKeyUp = 0x0101;
    public const uint WmChar = 0x0102;
    public const uint WmCancelMode = 0x001F;
    public const nuint MkLButton = 0x0001;

    /// <summary>Chromium's (and so Electron's) render widget.</summary>
    public const string ChromiumWidgetClass = "Chrome_RenderWidgetHostHWND";

    /// <summary>
    /// A Chromium or Electron window (the render widget or a Chrome_WidgetWin_*
    /// frame, which handles input for the page too): its posted keys need a
    /// posted click first.
    /// </summary>
    public static bool IsChromiumWidget(string className) =>
        string.Equals(className, ChromiumWidgetClass, StringComparison.OrdinalIgnoreCase)
        || className.StartsWith("Chrome_WidgetWin_", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// The window classes posted input goes to: measured (Chromium's render
    /// widget and its Chrome_WidgetWin_* frames, Notepad's RichEditD2DPT) or
    /// standard Win32 controls that act on their own mouse and key messages
    /// (Edit, the RichEdit family, Button, ComboBox, ListBox, the list view
    /// and the tree view). Anything else (WPF, UWP / WinUI / XAML islands,
    /// Qt, Java, Flutter, SDL, games reading raw input, custom controls) may
    /// drop posted input without a trace, so it gets real input instead.
    /// Window class names are case-insensitive.
    /// </summary>
    public static bool AcceptsPostedInput(string className)
    {
        if (className.Length == 0) return false;
        if (className.StartsWith("Chrome_WidgetWin_", StringComparison.OrdinalIgnoreCase)) return true;
        if (className.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase)) return true; // RichEdit20W, RICHEDIT50W, RichEditD2DPT
        foreach (var known in PostedInputClasses)
        {
            if (string.Equals(className, known, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static readonly string[] PostedInputClasses =
    [
        ChromiumWidgetClass, "Edit", "Button", "ComboBox", "ListBox", "SysListView32", "SysTreeView32",
    ];

    /// <summary>
    /// Text a single focus check cannot cover: a Tab (or any other control
    /// character) can move focus (the next DOM field, IsDialogMessage) so the
    /// rest would land somewhere unchecked, maybe a password field. Only one
    /// trailing newline (Enter at the end) is allowed.
    /// </summary>
    public static bool MovesFocus(string text)
    {
        var body = text;
        if (body.EndsWith("\r\n", StringComparison.Ordinal)) body = body[..^2];
        else if (body.EndsWith('\n') || body.EndsWith('\r')) body = body[..^1];
        foreach (var c in body)
        {
            if (char.IsControl(c)) return true;
        }
        return false;
    }

    /// <summary>
    /// What the action asks for that is never posted, whatever the target:
    /// messages carry no keyboard state (modifiers, chords), only a single
    /// left click was measured, the wheel was not, and text that can move
    /// focus needs the per-chunk check of real input.
    /// </summary>
    public static BackgroundRefusal ActionRefusal(BackgroundRequest r)
    {
        switch (r.Action)
        {
            case InputAction.Scroll:
                return BackgroundRefusal.Scroll;
            case InputAction.Click:
                if (r.Button != 0) return BackgroundRefusal.Button;
                if (r.Modifiers > 0) return BackgroundRefusal.Modifiers;
                if (r.ClickCount != 1) return BackgroundRefusal.MultiClick;
                return BackgroundRefusal.None;
            case InputAction.Hotkey when r.Modifiers > 0:
                return BackgroundRefusal.Chord;
            case InputAction.Type when r.Text != null && MovesFocus(r.Text):
                return BackgroundRefusal.FocusMovingText;
            default:
                return BackgroundRefusal.None;
        }
    }

    /// <summary>
    /// The refusals every action shares, in order: the target window must be
    /// on screen here (not minimized, visible, on this virtual desktop) and
    /// not elevated (UIPI drops posted messages to it).
    /// </summary>
    public static BackgroundRefusal WindowRefusal(TargetWindowState w)
    {
        if (w.Iconic) return BackgroundRefusal.Minimized;
        if (!w.Visible) return BackgroundRefusal.Hidden;
        if (w.OnCurrentDesktop == false) return BackgroundRefusal.OtherDesktop;
        if (w.Elevated) return BackgroundRefusal.Elevated;
        return BackgroundRefusal.None;
    }

    /// <summary>What a pointer receiver must be (a click, or the click before `type` keys).</summary>
    private static BackgroundRefusal PointerReceiverRefusal(Receiver? r)
    {
        if (r is { HitTestFailed: true }) return BackgroundRefusal.HitTestFailed;
        if (r is not { } rec || !rec.InTargetProcess) return BackgroundRefusal.NoReceiver;
        if (rec.PopupAtPoint) return BackgroundRefusal.PopupAtPoint;
        if (!rec.InClientArea) return BackgroundRefusal.NonClientArea;
        if (!AcceptsPostedInput(rec.ClassName)) return BackgroundRefusal.UnsupportedFramework;
        return BackgroundRefusal.None;
    }

    /// <summary>Whether and how to post `request` to `receiver`: the action first, then the window, then the receiver.</summary>
    public static BackgroundPlan Plan(TargetWindowState window, BackgroundRequest request, Receiver? receiver)
    {
        var refusal = ActionRefusal(request);
        if (refusal != BackgroundRefusal.None) return BackgroundPlan.Refuse(refusal);
        refusal = WindowRefusal(window);
        if (refusal != BackgroundRefusal.None) return BackgroundPlan.Refuse(refusal);
        switch (request.Action)
        {
            case InputAction.Click:
                refusal = PointerReceiverRefusal(receiver);
                return refusal != BackgroundRefusal.None ? BackgroundPlan.Refuse(refusal) : new(BackgroundRefusal.None, true, false);
            case InputAction.Type when request.HasField:
                // The field is clicked first, always: Chromium drops posted
                // keys that no posted click preceded, and for any other app it
                // moves focus inside the target without UIA SetFocus (which
                // can raise the window).
                refusal = PointerReceiverRefusal(receiver);
                if (refusal != BackgroundRefusal.None) return BackgroundPlan.Refuse(refusal);
                if (receiver!.Value.Secret) return BackgroundPlan.Refuse(BackgroundRefusal.SecretField);
                return new(BackgroundRefusal.None, true, true);
            default:
                // Keys into whatever the target thread has focused.
                if (receiver is not { } r) return BackgroundPlan.Refuse(BackgroundRefusal.NoFocusedControl);
                if (!r.InTargetProcess) return BackgroundPlan.Refuse(BackgroundRefusal.NoFocusedControl);
                if (IsChromiumWidget(r.ClassName)) return BackgroundPlan.Refuse(BackgroundRefusal.ChromiumNeedsClick);
                if (!AcceptsPostedInput(r.ClassName)) return BackgroundPlan.Refuse(BackgroundRefusal.UnsupportedFramework);
                if (r.Secret) return BackgroundPlan.Refuse(BackgroundRefusal.SecretField);
                if (!r.TextControl) return BackgroundPlan.Refuse(BackgroundRefusal.NotATextControl);
                return new(BackgroundRefusal.None, false, true);
        }
    }

    /// <summary>
    /// Runs a plan in the fixed order (see the top of this file). Nothing
    /// posted counts as a refusal, so the caller may fall back. After a
    /// posted click whose field did not take focus, no key is posted and
    /// there is no fallback.
    /// </summary>
    public static BackgroundOutcome Execute(BackgroundPlan plan, BackgroundSteps steps)
    {
        if (plan.Refused) return BackgroundOutcome.Refused(plan.Refusal);
        int posted = 0;
        if (plan.ClickFirst)
        {
            posted = steps.Click!();
            if (posted == 0) return BackgroundOutcome.Refused(BackgroundRefusal.NothingPosted);
        }
        if (plan.Keys)
        {
            if (plan.ClickFirst && !steps.FocusConfirmed!()) return Stopped(BackgroundStop.FocusUnconfirmed, steps);
            int keys = steps.Keys!();
            if (keys == 0)
            {
                if (posted == 0) return BackgroundOutcome.Refused(BackgroundRefusal.NothingPosted);
                return Stopped(BackgroundStop.KeysNotPosted, steps);
            }
        }
        bool confirmed = steps.ReadBack();
        bool ours = steps.Probe().Ours;
        bool verified = confirmed && !ours;
        return new(verified ? Disposition.Delivered : Disposition.DeliveredUnverified, false, verified, ours, BackgroundRefusal.None);
    }

    private static BackgroundOutcome Stopped(BackgroundStop stop, BackgroundSteps steps) =>
        new(Disposition.DeliveredUnverified, false, false, steps.Probe().Ours, BackgroundRefusal.None, stop);

    /// <summary>
    /// The child a real click hits among `zOrder` (topmost first): the first
    /// one that is visible, enabled, not WS_EX_TRANSPARENT, contains the point,
    /// and does not answer WM_NCHITTEST with HTTRANSPARENT (a group box lets
    /// the click through to the sibling behind it). -1 when none does; null
    /// when a hit test went unanswered (then nothing is posted).
    /// </summary>
    public static int? HitChild(IReadOnlyList<ChildWindow> zOrder, Func<int, HitTest> hitTest)
    {
        for (int i = 0; i < zOrder.Count; i++)
        {
            var c = zOrder[i];
            if (!c.Visible || !c.Enabled || c.Transparent || !c.ContainsPoint) continue;
            switch (hitTest(i))
            {
                case HitTest.Hit: return i;
                case HitTest.Failed: return null;
            }
        }
        return -1;
    }

    /// <summary>
    /// Whether a top-level window of the target process lies over the point
    /// as a popup would, whatever the screen z-order (another app may cover
    /// it): a menu, a window the target owns (a dropdown, a dialog), or a
    /// tool window (tooltips, unowned popups).
    /// </summary>
    public static bool BlocksPoint(TopLevelWindow w) =>
        !w.IsTarget && w.Visible && w.ContainsPoint && (w.IsMenu || w.OwnedByTarget || w.ToolWindow);

    /// <summary>
    /// After `messages[failed]` was not taken: what to post to undo what the
    /// messages before it pressed. A key-down whose key-up failed gets the
    /// key-up again; a button-down whose button-up failed gets the button-up
    /// again and WM_CANCELMODE (ends a capture or a drag the app started).
    /// </summary>
    public static List<PostedMessage> Repair(IReadOnlyList<PostedMessage> messages, int failed)
    {
        if (failed <= 0 || failed >= messages.Count) return [];
        var before = messages[failed - 1];
        var m = messages[failed];
        if (before.Msg == WmKeyDown && m.Msg == WmKeyUp) return [m];
        if (before.Msg == WmLButtonDown && m.Msg == WmLButtonUp) return [m, new(WmCancelMode, 0, 0)];
        return [];
    }

    /// <summary>Text for a refusal, used in notes and logs.</summary>
    public static string Describe(BackgroundRefusal r) => r switch
    {
        BackgroundRefusal.Minimized => "the target window is minimized",
        BackgroundRefusal.Hidden => "the target window is hidden",
        BackgroundRefusal.OtherDesktop => "the target window is on another virtual desktop",
        BackgroundRefusal.Elevated => "the target runs at a higher integrity level",
        BackgroundRefusal.Modifiers => "posted clicks cannot carry modifier keys",
        BackgroundRefusal.Button => "only a left click is posted",
        BackgroundRefusal.MultiClick => "only a single click is posted",
        BackgroundRefusal.Scroll => "the wheel is not posted",
        BackgroundRefusal.Chord => "posted keys cannot carry modifier keys",
        BackgroundRefusal.FocusMovingText => "the text has a Tab or another control character that can move focus",
        BackgroundRefusal.NoReceiver => "no window of the target process is at that point",
        BackgroundRefusal.HitTestFailed => "a window at that point did not answer a hit test in time",
        BackgroundRefusal.NonClientArea => "the point is on a window frame or scroll bar",
        BackgroundRefusal.NoFocusedControl => "the target has no focused control to post keys to",
        BackgroundRefusal.PopupAtPoint => "a popup or menu of the target is at that point",
        BackgroundRefusal.UnsupportedFramework => "that window is not one posted input is known to work with",
        BackgroundRefusal.ChromiumNeedsClick => "a Chromium-based app takes posted keys only after a posted click; pass the field's index",
        BackgroundRefusal.NotATextControl => "the focused control is not a plain text control",
        BackgroundRefusal.SecretField => "the field is a password field, or wmux could not tell",
        BackgroundRefusal.NothingPosted => "Windows did not accept the posted message",
        _ => "",
    };

    // MARK: Messages

    /// <summary>MAKELPARAM of two coordinates, each a signed 16-bit value.</summary>
    public static nint PointLParam(int x, int y) => (nint)(uint)((ushort)(short)x | ((uint)(ushort)(short)y << 16));

    /// <summary>A single left click at a client point of the receiver: a move, then button down and up.</summary>
    public static List<PostedMessage> Click(int clientX, int clientY)
    {
        var at = PointLParam(clientX, clientY);
        return
        [
            new(WmMouseMove, 0, at),
            new(WmLButtonDown, MkLButton, at),
            new(WmLButtonUp, 0, at),
        ];
    }

    /// <summary>
    /// WM_KEYDOWN / WM_KEYUP lParam: repeat count 1, the scan code in bits
    /// 16-23, the extended flag in bit 24; a key-up also sets the previous
    /// state and transition bits (30 and 31).
    /// </summary>
    public static nint KeyLParam(uint scanCode, bool extended, bool up)
    {
        uint l = 1u | ((scanCode & 0xFF) << 16);
        if (extended) l |= 1u << 24;
        if (up) l |= 0xC0000000u;
        return unchecked((nint)(int)l);
    }

    /// <summary>
    /// A named key: down and up only. The target's own TranslateMessage
    /// makes the WM_CHAR for Enter, Tab or Backspace, so posting one too
    /// would type it twice.
    /// </summary>
    public static List<PostedMessage> Key(ushort vk, uint scanCode, bool extended) =>
    [
        new(WmKeyDown, vk, KeyLParam(scanCode, extended, false)),
        new(WmKeyUp, vk, KeyLParam(scanCode, extended, true)),
    ];

    /// <summary>Text as one WM_CHAR per UTF-16 unit (both halves of a surrogate pair, in order).</summary>
    public static List<PostedMessage> Text(string text)
    {
        var list = new List<PostedMessage>(text.Length);
        foreach (var unit in text) list.Add(new(WmChar, unit, 1));
        return list;
    }
}
