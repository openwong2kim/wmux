// Background ("target-only") input: what can be posted to the target window
// alone, so the user's cursor, foreground window and focused control stay as
// they were. Pure logic; the helper (Helper/Background.cs) gathers the window
// state, posts the messages and reads the effect back.
//
// The order is fixed: refuse -> post -> verify -> side-effect check.
//   - A refusal happens before anything is posted (not_delivered), so the
//     action may fall back to real input (SendInput), the default path.
//   - Once a message was posted there is no fallback: the same input must
//     never arrive twice. PostMessage has no delivery ack, so a post is
//     unverified until a re-read confirms its effect.
//   - If, after posting, the cursor sits on the target point or the target
//     window is in front and neither was so before, the posting caused it
//     (an app that activates itself on click): delivered_unverified, never
//     verified, never a fallback. The user moving their own mouse is not
//     such a side effect, so only "now at our point" counts.

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
    NoReceiver,
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
/// is a field to click before the keys.
/// </summary>
public readonly record struct BackgroundRequest(InputAction Action, int Button = 0, int ClickCount = 1, int Modifiers = 0, bool HasField = false);

/// <summary>
/// The child window that would get the messages. For a pointer action (and
/// `type` with an index) it is the deepest child at the point; for keys
/// without an index it is the target thread's focused window.
/// </summary>
/// <param name="ClassName">Window class of the receiver.</param>
/// <param name="InTargetProcess">The receiver belongs to the target pid (and, for keys, to the target window).</param>
/// <param name="InClientArea">The point is inside the receiver's client area (a click on a frame or scroll bar would need non-client messages).</param>
/// <param name="PopupAtPoint">An owned popup or menu of the target covers the point (it would take a real click, not the window under it).</param>
/// <param name="TextControl">The receiver's own UIA element is an Edit or Document (keys without an index go only into a text control that is itself the window).</param>
/// <param name="Secret">The receiver's UIA element is a password field, or could not be read.</param>
public readonly record struct Receiver(string ClassName, bool InTargetProcess, bool InClientArea = true, bool PopupAtPoint = false, bool TextControl = false, bool Secret = false);

/// <summary>A plan: refused, or post (a click first, then keys, or a click alone).</summary>
public readonly record struct BackgroundPlan(BackgroundRefusal Refusal, bool ClickFirst, bool Keys)
{
    public bool Refused => Refusal != BackgroundRefusal.None;

    public static BackgroundPlan Refuse(BackgroundRefusal reason) => new(reason, false, false);
}

public enum Disposition { NotDelivered, DeliveredUnverified, Delivered }

/// <summary>
/// How an action ended. `FallBack`: nothing was posted, so the foreground
/// (SendInput) path may send the same input instead; its own result then
/// reports `foreground`.
/// </summary>
public readonly record struct BackgroundOutcome(Disposition Disposition, bool FallBack, bool Verified, bool SideEffect, BackgroundRefusal Refusal)
{
    public static BackgroundOutcome Refused(BackgroundRefusal reason) => new(Disposition.NotDelivered, true, false, false, reason);

    /// <summary>protocol ActionDelivery for a posted action: our side effect means the user's pointer or foreground did not stay as it was.</summary>
    public string Delivery => SideEffect ? "foreground" : "background";
}

/// <summary>Cursor and foreground as seen before and after posting.</summary>
public readonly record struct SideEffectProbe(bool CursorAtPointBefore, bool CursorAtPointAfter, bool TargetInFrontBefore, bool TargetInFrontAfter)
{
    public bool Ours => (!CursorAtPointBefore && CursorAtPointAfter) || (!TargetInFrontBefore && TargetInFrontAfter);
}

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
    public const nuint MkLButton = 0x0001;

    /// <summary>Chromium's (and so Electron's) render widget: its posted keys need a posted click first.</summary>
    public const string ChromiumWidgetClass = "Chrome_RenderWidgetHostHWND";

    public static bool IsChromiumWidget(string className) => className == ChromiumWidgetClass;

    /// <summary>
    /// Window classes whose content takes input through something other than
    /// the window's own mouse and key messages (WPF, UWP / WinUI / XAML
    /// islands, which read pointer input from the system), or which nobody
    /// has measured with posted messages. Their actions use real input.
    /// </summary>
    public static bool AcceptsPostedInput(string className)
    {
        if (className.Length == 0) return false;
        if (className.StartsWith("HwndWrapper[", StringComparison.Ordinal)) return false; // WPF
        return className is not (
            "Windows.UI.Core.CoreWindow"
            or "ApplicationFrameWindow"
            or "ApplicationFrameInputSinkWindow"
            or "Windows.UI.Input.InputSite.WindowClass"
            or "Microsoft.UI.Content.DesktopChildSiteBridge"
            or "Microsoft.UI.Input.InputSite.WindowClass"
            or "InputSiteWindowClass"
            or "Windows.UI.Composition.DesktopWindowContentBridge"
            or "DesktopWindowXamlSource"
            or "#32768"); // a menu: real input only
    }

    /// <summary>
    /// The refusals every action shares, in order: the target window must be
    /// on screen here (not minimized, visible, on this virtual desktop) and
    /// not elevated (UIPI drops posted messages to it).
    /// </summary>
    private static BackgroundRefusal WindowRefusal(TargetWindowState w)
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
        if (r is not { } rec || !rec.InTargetProcess) return BackgroundRefusal.NoReceiver;
        if (rec.PopupAtPoint) return BackgroundRefusal.PopupAtPoint;
        if (!rec.InClientArea) return BackgroundRefusal.NonClientArea;
        if (!AcceptsPostedInput(rec.ClassName)) return BackgroundRefusal.UnsupportedFramework;
        return BackgroundRefusal.None;
    }

    /// <summary>
    /// Whether and how to post `request` to `receiver`. Messages carry no
    /// keyboard state, so a click with modifiers and a chord are refused;
    /// only a single left click is posted (other buttons, multi-click and
    /// the wheel were not measured).
    /// </summary>
    public static BackgroundPlan Plan(TargetWindowState window, BackgroundRequest request, Receiver? receiver)
    {
        var refusal = WindowRefusal(window);
        if (refusal != BackgroundRefusal.None) return BackgroundPlan.Refuse(refusal);
        switch (request.Action)
        {
            case InputAction.Scroll:
                return BackgroundPlan.Refuse(BackgroundRefusal.Scroll);
            case InputAction.Click:
                if (request.Button != 0) return BackgroundPlan.Refuse(BackgroundRefusal.Button);
                if (request.Modifiers > 0) return BackgroundPlan.Refuse(BackgroundRefusal.Modifiers);
                if (request.ClickCount != 1) return BackgroundPlan.Refuse(BackgroundRefusal.MultiClick);
                refusal = PointerReceiverRefusal(receiver);
                return refusal != BackgroundRefusal.None ? BackgroundPlan.Refuse(refusal) : new(BackgroundRefusal.None, true, false);
            case InputAction.Hotkey when request.Modifiers > 0:
                return BackgroundPlan.Refuse(BackgroundRefusal.Chord);
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
                // A host window (Qt, a custom framework) may have a windowless
                // password field focused inside it; only a window that is
                // itself the text control is known to be what gets the keys.
                if (!r.TextControl) return BackgroundPlan.Refuse(BackgroundRefusal.NotATextControl);
                return new(BackgroundRefusal.None, false, true);
        }
    }

    /// <summary>
    /// Runs a plan in the fixed order. `post` posts everything and returns
    /// how many messages went in before the first failure (it throws for a
    /// failure after the first); `readBack` re-reads the effect; `probe`
    /// compares cursor and foreground with before. Nothing posted counts as a
    /// refusal, so the caller may fall back.
    /// </summary>
    public static BackgroundOutcome Execute(BackgroundPlan plan, Func<int> post, Func<bool> readBack, Func<SideEffectProbe> probe)
    {
        if (plan.Refused) return BackgroundOutcome.Refused(plan.Refusal);
        int posted = post();
        if (posted == 0) return BackgroundOutcome.Refused(BackgroundRefusal.NothingPosted);
        bool confirmed = readBack();
        bool ours = probe().Ours;
        bool verified = confirmed && !ours;
        return new(verified ? Disposition.Delivered : Disposition.DeliveredUnverified, false, verified, ours, BackgroundRefusal.None);
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
        BackgroundRefusal.NoReceiver => "no window of the target process is at that point",
        BackgroundRefusal.NonClientArea => "the point is on a window frame or scroll bar",
        BackgroundRefusal.NoFocusedControl => "the target has no focused control to post keys to",
        BackgroundRefusal.PopupAtPoint => "a popup or menu of the target is at that point",
        BackgroundRefusal.UnsupportedFramework => "that part of the app does not take posted input",
        BackgroundRefusal.ChromiumNeedsClick => "a Chromium-based app takes posted keys only after a posted click; pass the field's index",
        BackgroundRefusal.NotATextControl => "the focused control is not a plain text control",
        BackgroundRefusal.SecretField => "the field is a password field, or wmux could not tell",
        BackgroundRefusal.NothingPosted => "Windows did not accept the posted message",
        _ => "",
    };

    // MARK: Messages

    /// <summary>MAKELPARAM of client coordinates, each a signed 16-bit value.</summary>
    public static nint PointLParam(int clientX, int clientY) => (nint)(uint)((ushort)(short)clientX | ((uint)(ushort)(short)clientY << 16));

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
