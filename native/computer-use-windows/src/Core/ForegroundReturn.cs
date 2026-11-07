namespace WmuxComputerUse.Core;

/// <summary>What happens to the foreground after an input action moved it to the target.</summary>
public enum ReturnDecision
{
    /// <summary>The foreground did not move to the target (or was already in it): nothing to return.</summary>
    NotNeeded,
    /// <summary>Give the front back to the window that had it.</summary>
    Return,
    /// <summary>
    /// The front should have gone back, but Windows refused the change: the
    /// helper sent no input of its own (posted input), so it may not set the
    /// foreground.
    /// </summary>
    ReturnRefused,
    /// <summary>The action asked to keep the target in front (`keepFront`).</summary>
    SkipKeepFront,
    /// <summary>The user's own input arrived after ours: the front is theirs to decide.</summary>
    SkipUserInput,
    /// <summary>A key or button the helper pressed is still down.</summary>
    SkipHeldInput,
    /// <summary>The target thread is in menu or popup-menu mode.</summary>
    SkipMenuMode,
    /// <summary>The action opened a window (a dialog, a dropdown, a popup menu).</summary>
    SkipNewWindow,
    /// <summary>The window that had the front is gone.</summary>
    SkipPreviousGone,
    /// <summary>The window that had the front is minimized.</summary>
    SkipPreviousMinimized,
    /// <summary>The window that had the front runs above the helper's integrity level.</summary>
    SkipPreviousElevated,
}

/// <summary>What the helper read after the action, for <see cref="ForegroundReturn.Decide"/>.</summary>
public readonly record struct ReturnState(
    bool PreviousInTarget,
    bool ForegroundInTarget,
    bool ForegroundNone,
    bool KeepFront,
    bool UserInput,
    bool InputHeld,
    bool MenuMode,
    bool NewTargetWindow,
    bool PreviousAlive,
    bool PreviousMinimized,
    bool PreviousElevated);

/// <summary>What to do before an action that may take the front, while the user may be typing.</summary>
public enum PreWaitStep
{
    Proceed,
    Wait,
    Busy,
}

/// <summary>
/// Giving the foreground back after real input (docs/computer-use-windows.md,
/// Giving the front back). Real input and most UIA pattern calls bring the
/// target window to the front; the window the user had in front gets it back
/// once the action is done, unless one of the skip reasons holds.
/// </summary>
public static class ForegroundReturn
{
    /// <summary>The user's input counts as active when it is younger than this.</summary>
    public const int QuietMs = 1000;

    /// <summary>The longest an action waits for the user to stop before answering user_input_active.</summary>
    public const int MaxPreWaitMs = 1000;

    /// <summary>The bound of the WM_NULL round trip that lets the target handle our input before the front goes back.</summary>
    public const int InputHandledTimeoutMs = 200;

    /// <summary>When the one re-check runs after the front went back (the target may take it back after a click).</summary>
    public const int RecheckMs = 300;

    /// <summary>
    /// How long after our own SendInput a GetLastInputInfo tick still counts
    /// as ours: the system stamps an injected event when it handles it, a few
    /// milliseconds after SendInput returns. Real input inside this window
    /// reads as ours, which errs toward giving the front back.
    /// </summary>
    public const int OwnInputSlackMs = 50;

    /// <summary>
    /// The order is the order of the reasons a result names: the first that
    /// holds wins. `ForegroundNone`: no window is in front after the action
    /// (a UIA call deactivated the user's window and the target did not
    /// activate); the user's window gets the front back then too, and
    /// keepFront has nothing to keep. The user's own input still wins: they
    /// may be switching windows themselves.
    /// </summary>
    public static ReturnDecision Decide(ReturnState s)
    {
        if (s.PreviousInTarget || !(s.ForegroundInTarget || s.ForegroundNone)) return ReturnDecision.NotNeeded;
        if (s.KeepFront && !s.ForegroundNone) return ReturnDecision.SkipKeepFront;
        if (s.UserInput) return ReturnDecision.SkipUserInput;
        if (s.InputHeld) return ReturnDecision.SkipHeldInput;
        if (s.MenuMode) return ReturnDecision.SkipMenuMode;
        if (s.NewTargetWindow) return ReturnDecision.SkipNewWindow;
        if (!s.PreviousAlive) return ReturnDecision.SkipPreviousGone;
        if (s.PreviousMinimized) return ReturnDecision.SkipPreviousMinimized;
        if (s.PreviousElevated) return ReturnDecision.SkipPreviousElevated;
        return ReturnDecision.Return;
    }

    /// <summary>
    /// Before an action that may take the front: `userInputAgeMs` is how long
    /// ago the user's own input arrived (null: none since the helper's own
    /// input, or never read), `waitedMs` how long this action has waited.
    /// </summary>
    public static PreWaitStep PreWait(uint? userInputAgeMs, int waitedMs)
    {
        if (userInputAgeMs is not { } age || age >= QuietMs) return PreWaitStep.Proceed;
        return waitedMs >= MaxPreWaitMs ? PreWaitStep.Busy : PreWaitStep.Wait;
    }

    /// <summary>
    /// The last tick that still counts as our own input, or null before any.
    /// A UIA call injects its key pair at some point while it runs, so while
    /// the action that made it is still going (`callOpen`), every tick so far
    /// is ours; after our SendInput, or once that action ended, only the
    /// slack after `ownTick` is.
    /// </summary>
    public static uint? OwnUntil(uint? ownTick, bool callOpen, uint now) =>
        ownTick is not { } own ? null : callOpen ? now : unchecked(own + (uint)OwnInputSlackMs);

    /// <summary>`tick` is later than `than`, on the wrapping 32-bit millisecond clock of GetTickCount.</summary>
    public static bool Later(uint tick, uint than) => unchecked((int)(tick - than)) > 0;

    /// <summary>
    /// The user's input arrived after ours. `ownUntil` is the last tick that
    /// still counts as our own input (null: the helper sent nothing yet, so
    /// every tick after `since` is the user's).
    /// </summary>
    public static bool UserInputAfter(uint lastInput, uint since, uint? ownUntil) =>
        Later(lastInput, since) && (ownUntil is not { } own || Later(lastInput, own));

    /// <summary>
    /// The sentence a result's note or an error's message gets.
    /// `noWindowInFront`: the foreground was no window at all, so a sentence
    /// never claims the target is in front.
    /// </summary>
    public static string? Describe(ReturnDecision d, bool noWindowInFront = false)
    {
        var sentence = Sentence(d);
        if (!noWindowInFront || sentence == null) return sentence;
        if (d == ReturnDecision.ReturnRefused) return "No window is in front, and Windows refused to give the front back to the window that had it.";
        const string Left = "The target was left in front";
        return sentence.StartsWith(Left, StringComparison.Ordinal) ? "No window was given the front" + sentence[Left.Length..] : sentence;
    }

    private static string? Sentence(ReturnDecision d) => d switch
    {
        ReturnDecision.NotNeeded => null,
        ReturnDecision.Return => "The window that was in front before got the front back; anything in the target that closes when it loses focus (a menu, a palette, a flyout) may have closed. Pass keepFront: true to keep the target in front.",
        ReturnDecision.ReturnRefused => "The target came to the front and Windows refused to give the front back to the window that had it; the target is still in front.",
        ReturnDecision.SkipKeepFront => "The target was left in front (keepFront).",
        ReturnDecision.SkipUserInput => "The target was left in front: the user's own input arrived meanwhile.",
        ReturnDecision.SkipHeldInput => "The target was left in front: input is still held.",
        ReturnDecision.SkipMenuMode => "The target was left in front: it has a menu open.",
        ReturnDecision.SkipNewWindow => "The target was left in front: the action opened a window.",
        ReturnDecision.SkipPreviousGone => "The target was left in front: the window that was in front before is gone.",
        ReturnDecision.SkipPreviousMinimized => "The target was left in front: the window that was in front before is minimized.",
        ReturnDecision.SkipPreviousElevated => "The target was left in front: the window that was in front before runs as administrator, or its process could not be read.",
        _ => null,
    };
}
