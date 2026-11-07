using System.Text.Json.Nodes;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.UI.Input.KeyboardAndMouse;
using Windows.Win32.UI.WindowsAndMessaging;
using WmuxComputerUse.Core;

namespace WmuxComputerUse;

/// <summary>
/// Gives the foreground back after an input action moved it to the target
/// (Core ForegroundReturn; docs/computer-use-windows.md, Giving the front
/// back). Server wraps each input method in Begin/End, so every path that can
/// move the foreground is covered: SendInput, UIA pattern calls, UIA SetFocus
/// and SetForegroundWindow. The foreground window is compared, not the Z
/// order: WinForms activates a covered window without raising it, and the
/// user's next keys would go there.
///
/// The user's own input is told from ours by GetLastInputInfo against the
/// tick of our last injected event (NoteOwnInput): SendInput moves that tick,
/// and so does a UIA pattern call, which injects a VK 0xB9 key pair.
/// </summary>
internal static unsafe class GiveBack
{
    private static readonly object Lock = new();

    // Our own input: the tick of the last event we injected, and whether it
    // was a UIA call whose action is still running (its injected key arrives
    // during the call, so every tick up to the end of the action counts as
    // ours; End closes that window).
    private static uint ownTick;
    private static bool haveOwn;
    private static bool callOpen;

    // Set when a tick newer than our own input is seen before our next one:
    // GetLastInputInfo keeps only the latest tick, so the user's input in the
    // middle of an action would otherwise be hidden by ours after it.
    private static bool userSeen;

    // GetLastInputInfo's tick when the running action began: input before it
    // (between two actions) is never this action's.
    private static uint actionSince;

    // The running action sent input of its own (SendInput or a UIA call).
    private static bool actionSent;

    // The one pending re-check; a new request or a stop cancels it.
    private static int generation;
    private static Timer? recheck;

    // The window the front was last given back from (cleared when an action
    // leaves a window in front): keys sent to it next are refused, and the
    // refusal says how to keep it in front.
    private static HWND returnedFrom;

    private static uint Now => (uint)Environment.TickCount;

    /// <summary>
    /// For the keyboard refusal: when the front went back from this window
    /// after the previous action, say how to get it in front for keys. Not by
    /// repeating that action: a button or a check box would act twice.
    /// </summary>
    public static string KeysHint(HWND target)
    {
        lock (Lock)
        {
            if (returnedFrom == HWND.Null || returnedFrom != target) return "";
            // Once: if the next try cannot bring the window forward either
            // (posted under refuse), repeating the hint would loop.
            returnedFrom = HWND.Null;
            return ". The front went back to the user's window after your previous action on it. Click the field that should get the keys with keepFront: true first (not a button, which would act again), then send them";
        }
    }

    private static uint LastInput()
    {
        return BackgroundInput.LastInputTick();
    }

    private static uint? OwnUntil(uint now) => ForegroundReturn.OwnUntil(haveOwn ? ownTick : null, callOpen, now);

    /// <summary>
    /// Right before (a UIA call) or right after (SendInput) the helper injects
    /// input. `call`: a UIA pattern or SetFocus call, which may inject a key
    /// pair while it runs; CallDone closes it. `lastBefore`: GetLastInputInfo
    /// read right before SendInput, since the batch's own events are stamped
    /// while it runs and would otherwise read as the user's.
    /// </summary>
    public static void NoteOwnInput(bool call, uint? lastBefore = null)
    {
        lock (Lock)
        {
            uint now = Now;
            uint last = lastBefore ?? LastInput();
            if (!callOpen && ForegroundReturn.UserInputAfter(last, actionSince, OwnUntil(now))) userSeen = true;
            ownTick = now;
            haveOwn = true;
            callOpen = call;
            actionSent = true;
        }
    }

    /// <summary>
    /// A UIA call returned: its key pair has arrived, and input after the
    /// slack is the user's again. Input during the call reads as ours.
    /// </summary>
    public static void CallDone()
    {
        lock (Lock)
        {
            if (haveOwn && callOpen)
            {
                ownTick = Now;
                callOpen = false;
            }
        }
    }

    /// <summary>What Begin read before the action; End decides from it.</summary>
    public sealed class Scope
    {
        public bool Active;
        public HWND Previous;
        public HWND Target;
        public uint TargetPid;
        public bool KeepFront;
        public bool Refuse;
        public uint Since;
        public HashSet<HWND> TargetWindowsBefore = [];
        public System.Drawing.Point? CursorBefore;
    }

    /// <summary>
    /// Before an input method: cancels a pending re-check, and under `allow`
    /// waits up to a second while the user is typing or moving the mouse
    /// (then user_input_active, nothing sent). Never throws for anything
    /// else: a request it cannot read is the action's own error to report.
    /// </summary>
    public static Scope Begin(Params p, bool refuseForeground)
    {
        CancelRecheck();
        var scope = new Scope();
        ControlTarget target;
        try
        {
            target = ControlTarget.From(p);
        }
        catch (HelperError)
        {
            return scope;
        }
        if (!refuseForeground) WaitForUser();
        Input.ForgetPointerEnd();
        lock (Lock)
        {
            userSeen = false;
            actionSent = false;
            scope.Since = actionSince = LastInput();
        }
        scope.Previous = Win.Root(PInvoke.GetForegroundWindow());
        scope.Target = target.Window;
        scope.TargetPid = target.Pid;
        // The user already had the target in front: nothing to give back.
        if (scope.Previous == HWND.Null || Win.InTargetWindow(scope.Previous, target.Window, target.Pid)) return scope;
        scope.KeepFront = KeepFront(p);
        scope.Refuse = refuseForeground;
        if (PInvoke.GetCursorPos(out var cursor)) scope.CursorBefore = cursor;
        foreach (var h in Win.TopLevelWindows())
        {
            if (CountsAsWindow(h, target.Pid)) scope.TargetWindowsBefore.Add(h);
        }
        scope.Active = true;
        return scope;
    }

    private static bool KeepFront(Params p) =>
        p.Raw.TryGetPropertyValue("keepFront", out var n) && n is JsonValue v && v.TryGetValue<bool>(out var b) && b;

    /// <summary>
    /// The pre-wait: while the user's own input is younger than a second,
    /// wait in 50 ms slices, at most a second in all, then go on or answer
    /// user_input_active. Keys are never queued: nothing has been sent yet.
    /// </summary>
    private static void WaitForUser()
    {
        int waited = 0;
        while (true)
        {
            Input.ThrowIfStopping();
            uint? age;
            lock (Lock)
            {
                uint now = Now, last = LastInput();
                age = last == 0 || !ForegroundReturn.UserInputAfter(last, unchecked(now - (uint)ForegroundReturn.QuietMs), OwnUntil(now))
                    ? null
                    : unchecked(now - last);
            }
            switch (ForegroundReturn.PreWait(age, waited))
            {
                case PreWaitStep.Proceed:
                    return;
                case PreWaitStep.Busy:
                    throw new HelperError("user_input_active", "the user is typing or moving the mouse, so nothing was sent; try again shortly");
            }
            Sta.Sleep(50);
            waited += 50;
        }
    }

    /// <summary>
    /// After an input method, whether it succeeded or threw: gives the front
    /// back if the action moved it to the target and nothing says to keep it
    /// there. Returns the sentence for the result's note or the error's
    /// message, or null when the foreground did not move. The one re-check
    /// runs later on a timer, so the reply is not held for it.
    /// </summary>
    public static string? End(Scope scope)
    {
        // The action is over (it may have thrown inside a UIA call).
        CallDone();
        if (!scope.Active) return null;
        bool sent;
        lock (Lock) sent = actionSent;
        if (sent && !scope.Refuse)
        {
            // Let the target handle our input first: a click or a UIA call can
            // activate it on its own thread a moment after the call returns.
            nuint ignored;
            PInvoke.SendMessageTimeout(scope.Target, 0 /* WM_NULL */, 0, 0, SEND_MESSAGE_TIMEOUT_FLAGS.SMTO_ABORTIFHUNG,
                (uint)ForegroundReturn.InputHandledTimeoutMs, &ignored);
        }
        var decision = Decide(scope);
        if (decision == ReturnDecision.Return && !ReturnFront(scope)) decision = ReturnDecision.ReturnRefused;
        // An activation later than the round trip still gets the one re-check.
        else if (decision == ReturnDecision.NotNeeded && sent && !scope.Refuse) ScheduleRecheck(scope);
        if (decision != ReturnDecision.NotNeeded)
        {
            Wire.Log($"foreground: {decision}");
            lock (Lock) returnedFrom = decision == ReturnDecision.Return ? scope.Target : HWND.Null;
        }
        return ForegroundReturn.Describe(decision, PInvoke.GetForegroundWindow() == HWND.Null);
    }

    private static ReturnDecision Decide(ControlTarget target, Scope scope, HWND foreground)
    {
        bool previousInTarget = Win.InTargetWindow(scope.Previous, target.Window, target.Pid);
        bool foregroundInTarget = foreground != HWND.Null && Win.InTargetWindow(foreground, target.Window, target.Pid);
        // The common case, before the window enumeration and the token query.
        if (previousInTarget || !(foregroundInTarget || foreground == HWND.Null)) return ReturnDecision.NotNeeded;
        uint now = Now;
        bool userInput;
        lock (Lock) userInput = userSeen || ForegroundReturn.UserInputAfter(LastInput(), scope.Since, OwnUntil(now));
        bool newWindow = false;
        foreach (var h in Win.TopLevelWindows())
        {
            if (CountsAsWindow(h, target.Pid) && !scope.TargetWindowsBefore.Contains(h))
            {
                newWindow = true;
                break;
            }
        }
        return ForegroundReturn.Decide(new ReturnState(
            PreviousInTarget: previousInTarget,
            ForegroundInTarget: foregroundInTarget,
            ForegroundNone: foreground == HWND.Null,
            KeepFront: scope.KeepFront,
            UserInput: userInput,
            InputHeld: Input.AnyHeld,
            MenuMode: InMenuMode(target.Window),
            NewTargetWindow: newWindow,
            PreviousAlive: PInvoke.IsWindow(scope.Previous),
            PreviousMinimized: PInvoke.IsIconic(scope.Previous),
            PreviousElevated: Integrity.IsAboveSelf(Win.OwnerPid(scope.Previous))));
    }

    /// <summary>
    /// A visible top-level window of the target process that can take the
    /// front. A tooltip, a hover card or a click-through overlay
    /// (WS_EX_NOACTIVATE, WS_EX_TRANSPARENT) is not "a window the action
    /// opened"; a dropdown list or a popup menu is.
    /// </summary>
    private static bool CountsAsWindow(HWND h, uint pid)
    {
        if (!PInvoke.IsWindowVisible(h) || (Win.OwnerPid(h) != pid && Win.EffectivePid(h) != pid)) return false;
        var ex = (WINDOW_EX_STYLE)(uint)PInvoke.GetWindowLongPtr(h, WINDOW_LONG_PTR_INDEX.GWL_EXSTYLE);
        return (ex & (WINDOW_EX_STYLE.WS_EX_NOACTIVATE | WINDOW_EX_STYLE.WS_EX_TRANSPARENT)) == 0 && Win.ClassName(h) != "tooltips_class32";
    }

    private static ReturnDecision Decide(Scope scope) =>
        Decide(new ControlTarget(scope.TargetPid, scope.Target), scope, Win.Root(PInvoke.GetForegroundWindow()));

    /// <summary>The target's GUI thread is tracking a menu or a popup menu.</summary>
    private static bool InMenuMode(HWND window)
    {
        uint thread = PInvoke.GetWindowThreadProcessId(window);
        var info = new GUITHREADINFO { cbSize = (uint)sizeof(GUITHREADINFO) };
        if (thread == 0 || !PInvoke.GetGUIThreadInfo(thread, &info)) return false;
        return (info.flags & (GUITHREADINFO_FLAGS.GUI_INMENUMODE | GUITHREADINFO_FLAGS.GUI_POPUPMENUMODE)) != 0;
    }

    /// <summary>
    /// SetForegroundWindow to the previous window, the cursor back if it is
    /// still where our input left it, then one re-check on a timer.
    /// </summary>
    private static bool ReturnFront(Scope scope)
    {
        // Refused when the helper sent no input of its own (posted input) and
        // the target came forward by itself: say so instead of claiming it.
        if (!PInvoke.SetForegroundWindow(scope.Previous)) return false;
        var leftAt = Input.LastPointerEnd;
        if (scope.CursorBefore is { } before && leftAt is { } at && PInvoke.GetCursorPos(out var now)
            && Math.Abs(now.X - at.X) <= 1 && Math.Abs(now.Y - at.Y) <= 1 && (now.X != before.X || now.Y != before.Y))
        {
            PInvoke.SetCursorPos(before.X, before.Y);
        }
        ScheduleRecheck(scope);
        return true;
    }

    /// <summary>
    /// Once, ForegroundReturn.RecheckMs later: if the target took the front
    /// back by itself (Chrome activates after a click) and nothing else says
    /// otherwise, give it back once more. Silent; never loops. A new request
    /// or a stop cancels it.
    /// </summary>
    private static void ScheduleRecheck(Scope scope)
    {
        lock (Lock)
        {
            int mine = ++generation;
            recheck?.Dispose();
            recheck = new Timer(_ =>
            {
                // Input's lock is never taken under this one (Input.Post takes this one under its own).
                if (Input.Stopping) return;
                lock (Lock)
                {
                    if (mine != generation) return;
                }
                try
                {
                    var foreground = Win.Root(PInvoke.GetForegroundWindow());
                    var decision = Decide(new ControlTarget(scope.TargetPid, scope.Target), scope, foreground);
                    if (Input.Stopping) return;
                    lock (Lock)
                    {
                        if (mine != generation) return;
                        if (decision == ReturnDecision.Return && PInvoke.SetForegroundWindow(scope.Previous)) returnedFrom = scope.Target;
                    }
                    if (decision == ReturnDecision.Return) Wire.Log("foreground: returned again after the target took it back");
                }
                catch (Exception e)
                {
                    Wire.Log($"foreground: re-check failed ({e.GetType().Name})");
                }
            }, null, ForegroundReturn.RecheckMs, Timeout.Infinite);
        }
    }

    /// <summary>Cancels the pending re-check (a new request, or the stop key).</summary>
    public static void CancelRecheck()
    {
        lock (Lock)
        {
            generation++;
            recheck?.Dispose();
            recheck = null;
        }
    }
}
