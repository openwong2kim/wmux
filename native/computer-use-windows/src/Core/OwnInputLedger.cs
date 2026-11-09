namespace WmuxComputerUse.Core;

/// <summary>
/// The helper's own input, told from the user's, on GetLastInputInfo's clock
/// (docs/computer-use-windows.md, Giving the front back). SendInput and a UIA
/// pattern or SetFocus call (which injects a VK 0xB9 key pair) both move that
/// clock; the helper notes each of its own, and any later tick is the user's.
/// Not thread-safe: Helper GiveBack calls it under its lock.
/// </summary>
public sealed class OwnInputLedger
{
    private uint ownTick;
    private bool haveOwn;
    private bool callOpen;

    // A tick newer than our own input, seen before our next one:
    // GetLastInputInfo keeps only the latest tick, so the user's input in the
    // middle of an action would otherwise be hidden by ours after it.
    private bool userSeen;

    // GetLastInputInfo's tick when the running action began: input before it
    // (between two actions) is never this action's.
    private uint actionSince;

    // The running action sent input of its own.
    private bool actionSent;

    // The state before the open UIA call, for a call that certainly did not run.
    private uint savedTick;
    private bool savedHave;
    private bool savedSent;

    public bool ActionSent => actionSent;

    public void BeginAction(uint lastInput)
    {
        userSeen = false;
        actionSent = false;
        actionSince = lastInput;
    }

    /// <summary>The last tick that still counts as our own input, or null before any.</summary>
    public uint? OwnUntil(uint now) => ForegroundReturn.OwnUntil(haveOwn ? ownTick : null, callOpen, now);

    /// <summary>
    /// Our own input: `call` right before a UIA call (it may inject while it
    /// runs, until CallDone), otherwise right after SendInput. `lastBefore` is
    /// GetLastInputInfo read before our input, since SendInput's own events
    /// are stamped while it runs and would otherwise read as the user's.
    /// </summary>
    public void Note(bool call, uint now, uint lastBefore)
    {
        if (!callOpen && ForegroundReturn.UserInputAfter(lastBefore, actionSince, OwnUntil(now))) userSeen = true;
        if (call)
        {
            savedTick = ownTick;
            savedHave = haveOwn;
            savedSent = actionSent;
        }
        ownTick = now;
        haveOwn = true;
        callOpen = call;
        actionSent = true;
    }

    /// <summary>A UIA call returned: input after the slack is the user's again.</summary>
    public void CallDone(uint now)
    {
        if (!haveOwn || !callOpen) return;
        ownTick = now;
        callOpen = false;
    }

    /// <summary>
    /// The open UIA call certainly did not run (not supported, not enabled),
    /// so it injected nothing: as if it had not been noted.
    /// </summary>
    public void UndoCall()
    {
        if (!callOpen) return;
        callOpen = false;
        ownTick = savedTick;
        haveOwn = savedHave;
        actionSent = savedSent;
    }

    /// <summary>The user's own input arrived after `since` (GetLastInputInfo now reads `lastInput`).</summary>
    public bool UserInputSince(uint since, uint lastInput, uint now) =>
        userSeen || ForegroundReturn.UserInputAfter(lastInput, since, OwnUntil(now));
}
