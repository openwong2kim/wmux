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

    // Our own input, told from the user's (Core OwnInputLedger).
    private static readonly OwnInputLedger Own = new();

    // Keys went to a Chromium window: when the front may go back.
    private static long keysSettleUntil;

    // The one pending re-check; a new request or a stop cancels it.
    private static int generation;
    private static Timer? recheck;

    private static uint Now => (uint)Environment.TickCount;

    private static uint LastInput()
    {
        return BackgroundInput.LastInputTick();
    }


    /// <summary>
    /// Right before (a UIA call) or right after (SendInput) the helper injects
    /// input. `call`: a UIA pattern or SetFocus call, which may inject a key
    /// pair while it runs; CallDone closes it. `lastBefore`: GetLastInputInfo
    /// read right before SendInput, since the batch's own events are stamped
    /// while it runs and would otherwise read as the user's.
    /// </summary>
    public static void NoteOwnInput(bool call, uint? lastBefore = null)
    {
        lock (Lock) Own.Note(call, Now, lastBefore ?? LastInput());
    }

    /// <summary>The UIA call just noted certainly did not run (Input.UncountSemantic).</summary>
    public static void CallNotRun()
    {
        lock (Lock) Own.UndoCall();
    }

    /// <summary>
    /// Keys (pressKey, hotkey) went to the target. Chromium hands them to a
    /// renderer process, which handles them after SendInput and after the
    /// browser window answers WM_NULL; a window that loses the front first
    /// drops them. There is no Win32 signal for the renderer being done, so
    /// the give-back waits ForegroundReturn.ChromiumKeySettleMs (measured;
    /// docs/computer-use-windows.md, Keys after a click).
    /// </summary>
    public static void KeysSent(HWND window)
    {
        if (!Win.ClassName(window).StartsWith("Chrome_WidgetWin", StringComparison.Ordinal)) return;
        lock (Lock) keysSettleUntil = Environment.TickCount64 + ForegroundReturn.ChromiumKeySettleMs;
    }


    /// <summary>
    /// A UIA call returned: its key pair has arrived, and input after the
    /// slack is the user's again. Input during the call reads as ours.
    /// </summary>
    public static void CallDone()
    {
        lock (Lock) Own.CallDone(Now);
    }

    /// <summary>What Begin read before the action; End decides from it.</summary>
    public sealed class Scope
    {
        public bool Active;
        public HWND Previous;
        public uint PreviousPid;
        public string PreviousClass = "";
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
            keysSettleUntil = 0;
            scope.Since = LastInput();
            Own.BeginAction(scope.Since);
        }
        scope.Previous = Win.Root(PInvoke.GetForegroundWindow());
        scope.Target = target.Window;
        scope.TargetPid = target.Pid;
        // The user already had the target in front: nothing to give back.
        if (scope.Previous == HWND.Null || Win.InTargetWindow(scope.Previous, target.Window, target.Pid)) return scope;
        scope.PreviousPid = Win.OwnerPid(scope.Previous);
        scope.PreviousClass = Win.ClassName(scope.Previous);
        scope.KeepFront = KeepFront(p);
        scope.Refuse = refuseForeground;
        if (PInvoke.GetCursorPos(out var cursor)) scope.CursorBefore = cursor;
        uint thread = PInvoke.GetWindowThreadProcessId(target.Window);
        foreach (var h in Win.TopLevelWindows())
        {
            if (CountsAsWindow(h, target.Pid, thread)) scope.TargetWindowsBefore.Add(h);
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
                age = last == 0 || !ForegroundReturn.UserInputAfter(last, unchecked(now - (uint)ForegroundReturn.QuietMs), Own.OwnUntil(now))
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
        long settle;
        lock (Lock)
        {
            sent = Own.ActionSent;
            settle = keysSettleUntil - Environment.TickCount64;
        }
        if (settle > 0) Sta.Sleep((int)settle);
        if (sent && !scope.Refuse)
        {
            // Let the target handle our input first: a click or a UIA call can
            // activate it on its own thread a moment after the call returns.
            nuint ignored;
            PInvoke.SendMessageTimeout(scope.Target, 0 /* WM_NULL */, 0, 0, SEND_MESSAGE_TIMEOUT_FLAGS.SMTO_ABORTIFHUNG,
                (uint)ForegroundReturn.InputHandledTimeoutMs, &ignored);
        }
        var decision = Decide(scope);
        if (decision == ReturnDecision.Return && !ReturnFront(scope))
        {
            decision = ReturnDecision.ReturnRefused;
            // The target took the front by itself (posted input: the helper
            // sent nothing, so Windows refuses it the foreground change).
            // Once, and only while no user input arrived since the action
            // began (Decide checks it again): send the no-op key pair UIA
            // sends for the same reason, then try once more.
            if (Decide(scope) == ReturnDecision.Return && Input.SendNoOpKeyPair())
            {
                Wire.Log("foreground: refused; retrying after the no-op key pair");
                if (Decide(scope) == ReturnDecision.Return && ReturnFront(scope)) decision = ReturnDecision.Return;
            }
        }
        // An activation later than the round trip still gets the one re-check.
        else if (decision == ReturnDecision.NotNeeded && sent && !scope.Refuse) ScheduleRecheck(scope);
        if (decision != ReturnDecision.NotNeeded)
        {
            Wire.Log($"foreground: {decision}");
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
        lock (Lock) userInput = Own.UserInputSince(scope.Since, LastInput(), now);
        bool newWindow = false;
        uint thread = PInvoke.GetWindowThreadProcessId(target.Window);
        foreach (var h in Win.TopLevelWindows())
        {
            if (CountsAsWindow(h, target.Pid, thread) && !scope.TargetWindowsBefore.Contains(h))
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
            PreviousAlive: PreviousIsSame(scope),
            PreviousMinimized: PInvoke.IsIconic(scope.Previous),
            PreviousElevated: Integrity.IsAboveSelf(Win.OwnerPid(scope.Previous))));
    }

    /// <summary>
    /// A visible top-level window of the target process that can take the
    /// front. A tooltip, a hover card or a click-through overlay
    /// (WS_EX_NOACTIVATE, WS_EX_TRANSPARENT) is not "a window the action
    /// opened"; a dropdown list or a popup menu is. Only windows of the
    /// target's GUI thread count (a UWP frame's thread is its frame host's).
    /// </summary>
    private static bool CountsAsWindow(HWND h, uint pid, uint thread)
    {
        if (!PInvoke.IsWindowVisible(h) || (Win.OwnerPid(h) != pid && Win.EffectivePid(h) != pid)) return false;
        if (thread != 0 && PInvoke.GetWindowThreadProcessId(h) != thread) return false;
        var ex = (WINDOW_EX_STYLE)(uint)PInvoke.GetWindowLongPtr(h, WINDOW_LONG_PTR_INDEX.GWL_EXSTYLE);
        return (ex & (WINDOW_EX_STYLE.WS_EX_NOACTIVATE | WINDOW_EX_STYLE.WS_EX_TRANSPARENT)) == 0 && Win.ClassName(h) != "tooltips_class32";
    }

    /// <summary>The previous window is still the window Begin saw: its handle was not reused.</summary>
    private static bool PreviousIsSame(Scope scope) =>
        PInvoke.IsWindow(scope.Previous) && Win.OwnerPid(scope.Previous) == scope.PreviousPid && Win.ClassName(scope.Previous) == scope.PreviousClass;

    /// <summary>
    /// SetForegroundWindow's return is not proof: the foreground is read
    /// back, once more a clock tick later if it has not settled yet.
    /// </summary>
    private static bool PreviousInFront(Scope scope)
    {
        if (Win.Root(PInvoke.GetForegroundWindow()) == scope.Previous) return true;
        Sta.Sleep(16);
        return Win.Root(PInvoke.GetForegroundWindow()) == scope.Previous;
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
        // A handle that now names another window is never raised.
        if (!PreviousIsSame(scope) || !PInvoke.SetForegroundWindow(scope.Previous) || !PreviousInFront(scope)) return false;
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
                        if (decision == ReturnDecision.Return && PreviousIsSame(scope)) PInvoke.SetForegroundWindow(scope.Previous);
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
