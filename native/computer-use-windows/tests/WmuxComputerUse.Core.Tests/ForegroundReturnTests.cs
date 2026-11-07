using WmuxComputerUse.Core;

namespace WmuxComputerUse.Core.Tests;

public class ForegroundReturnTests
{
    // The front moved to the driven window, nothing else going on.
    private static readonly ReturnState Moved = new(
        PreviousInTarget: false,
        ForegroundInTarget: true,
        ForegroundNone: false,
        KeepFront: false,
        UserInput: false,
        InputHeld: false,
        MenuMode: false,
        NewTargetWindow: false,
        PreviousAlive: true,
        PreviousMinimized: false,
        PreviousElevated: false);

    [Fact]
    public void GivesTheFrontBackWhenTheActionTookIt()
    {
        Assert.Equal(ReturnDecision.Return, ForegroundReturn.Decide(Moved));
    }

    [Fact]
    public void NothingToReturnWhenTheFrontDidNotMoveToTheTarget()
    {
        // Already in the target before the action.
        Assert.Equal(ReturnDecision.NotNeeded, ForegroundReturn.Decide(Moved with { PreviousInTarget = true }));
        // Someone else has the front now.
        Assert.Equal(ReturnDecision.NotNeeded, ForegroundReturn.Decide(Moved with { ForegroundInTarget = false }));
    }

    [Fact]
    public void EachReasonKeepsTheTargetInFront()
    {
        Assert.Equal(ReturnDecision.SkipKeepFront, ForegroundReturn.Decide(Moved with { KeepFront = true }));
        Assert.Equal(ReturnDecision.SkipUserInput, ForegroundReturn.Decide(Moved with { UserInput = true }));
        Assert.Equal(ReturnDecision.SkipHeldInput, ForegroundReturn.Decide(Moved with { InputHeld = true }));
        Assert.Equal(ReturnDecision.SkipMenuMode, ForegroundReturn.Decide(Moved with { MenuMode = true }));
        Assert.Equal(ReturnDecision.SkipNewWindow, ForegroundReturn.Decide(Moved with { NewTargetWindow = true }));
        Assert.Equal(ReturnDecision.SkipPreviousGone, ForegroundReturn.Decide(Moved with { PreviousAlive = false }));
        Assert.Equal(ReturnDecision.SkipPreviousMinimized, ForegroundReturn.Decide(Moved with { PreviousMinimized = true }));
        Assert.Equal(ReturnDecision.SkipPreviousElevated, ForegroundReturn.Decide(Moved with { PreviousElevated = true }));
    }

    // A UIA call deactivated the user's window and the target did not come
    // forward: nobody is in front, and the user's window gets it back.
    [Fact]
    public void GivesTheFrontBackWhenNoWindowIsInFront()
    {
        var none = Moved with { ForegroundInTarget = false, ForegroundNone = true };
        Assert.Equal(ReturnDecision.Return, ForegroundReturn.Decide(none));
        Assert.Equal(ReturnDecision.Return, ForegroundReturn.Decide(none with { KeepFront = true }));
        // The user may be switching windows themselves.
        Assert.Equal(ReturnDecision.SkipUserInput, ForegroundReturn.Decide(none with { UserInput = true }));
        Assert.Equal(ReturnDecision.SkipPreviousGone, ForegroundReturn.Decide(none with { PreviousAlive = false }));
        Assert.Equal(ReturnDecision.NotNeeded, ForegroundReturn.Decide(none with { PreviousInTarget = true }));
    }

    [Fact]
    public void TheUsersInputOutranksTheStateOfThePreviousWindow()
    {
        Assert.Equal(ReturnDecision.SkipUserInput, ForegroundReturn.Decide(Moved with { UserInput = true, PreviousAlive = false, MenuMode = true }));
    }

    [Theory]
    [InlineData(null, 0, PreWaitStep.Proceed)]
    [InlineData(null, 900, PreWaitStep.Proceed)]
    [InlineData(1000u, 0, PreWaitStep.Proceed)]
    [InlineData(5000u, 0, PreWaitStep.Proceed)]
    [InlineData(200u, 0, PreWaitStep.Wait)]
    [InlineData(200u, 950, PreWaitStep.Wait)]
    [InlineData(999u, 1000, PreWaitStep.Busy)]
    [InlineData(10u, 1050, PreWaitStep.Busy)]
    public void WaitsAtMostASecondForTheUserToStop(uint? userInputAgeMs, int waitedMs, PreWaitStep step)
    {
        Assert.Equal(step, ForegroundReturn.PreWait(userInputAgeMs, waitedMs));
    }

    [Fact]
    public void ComparesTicksAcrossTheWrap()
    {
        Assert.True(ForegroundReturn.Later(5, uint.MaxValue - 5));
        Assert.False(ForegroundReturn.Later(uint.MaxValue - 5, 5));
        Assert.False(ForegroundReturn.Later(100, 100));
    }

    // GetLastInputInfo moves with our own SendInput and with a UIA call's
    // injected key: a tick up to our own input's end is ours, never the user's.
    [Fact]
    public void OurOwnInputIsNotTheUsers()
    {
        const uint since = 1_000;
        // Our SendInput at 2_000 counts until 2_050: its tick at 2_010 is ours.
        Assert.False(ForegroundReturn.UserInputAfter(lastInput: 2_010, since, ownUntil: 2_050));
        // A tick after that is the user's.
        Assert.True(ForegroundReturn.UserInputAfter(lastInput: 2_051, since, ownUntil: 2_050));
        // Nothing newer than the baseline: no input at all.
        Assert.False(ForegroundReturn.UserInputAfter(lastInput: 1_000, since, ownUntil: null));
        // Before any input of ours, every newer tick is the user's.
        Assert.True(ForegroundReturn.UserInputAfter(lastInput: 1_001, since, ownUntil: null));
        // Across the wrap.
        Assert.False(ForegroundReturn.UserInputAfter(lastInput: 3, since: uint.MaxValue - 100, ownUntil: 10));
        Assert.True(ForegroundReturn.UserInputAfter(lastInput: 11, since: uint.MaxValue - 100, ownUntil: 10));
    }

    [Fact]
    public void AUiaCallsWindowEndsWithItsAction()
    {
        // Nothing of ours yet.
        Assert.Null(ForegroundReturn.OwnUntil(null, callOpen: false, now: 5_000));
        // While the action that made the call runs, every tick so far is ours.
        Assert.Equal(5_000u, ForegroundReturn.OwnUntil(1_000, callOpen: true, now: 5_000));
        // Once it ended (or after our SendInput), only the slack is.
        Assert.Equal(1_000u + ForegroundReturn.OwnInputSlackMs, ForegroundReturn.OwnUntil(1_000, callOpen: false, now: 5_000));
        // So the user's input a second after a finished call is theirs.
        Assert.True(ForegroundReturn.UserInputAfter(lastInput: 2_000, since: 900, ForegroundReturn.OwnUntil(1_000, callOpen: false, now: 2_100)));
    }

    [Fact]
    public void NeverSaysTheTargetIsInFrontWhenNoWindowIs()
    {
        foreach (var d in Enum.GetValues<ReturnDecision>())
        {
            var s = ForegroundReturn.Describe(d, noWindowInFront: true);
            if (s != null) Assert.DoesNotContain("target was left in front", s);
            if (s != null) Assert.DoesNotContain("target is still in front", s);
        }
    }

    [Fact]
    public void SaysWhatHappenedForEveryDecisionButNotNeeded()
    {
        foreach (var d in Enum.GetValues<ReturnDecision>())
        {
            if (d == ReturnDecision.NotNeeded) Assert.Null(ForegroundReturn.Describe(d));
            else Assert.False(string.IsNullOrWhiteSpace(ForegroundReturn.Describe(d)));
        }
    }
}
