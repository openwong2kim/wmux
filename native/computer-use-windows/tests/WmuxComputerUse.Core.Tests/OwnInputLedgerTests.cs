using WmuxComputerUse.Core;

namespace WmuxComputerUse.Core.Tests;

public class OwnInputLedgerTests
{
    [Fact]
    public void AnOpenCallHidesInputUntilItReturns()
    {
        var own = new OwnInputLedger();
        own.BeginAction(1_000);
        own.Note(call: true, now: 1_100, lastBefore: 1_000);
        // While the call runs, every tick so far is ours.
        Assert.False(own.UserInputSince(1_000, lastInput: 1_500, now: 1_600));
        own.CallDone(1_600);
        // After it returned (plus the slack), a later tick is the user's.
        Assert.True(own.UserInputSince(1_000, lastInput: 1_700, now: 1_800));
    }

    // GLM review: a DoDefaultAction that did not run (UncountSemantic) left
    // the call open, so the user's input during the rest of the ladder read
    // as ours and the front could go back while the user typed.
    [Fact]
    public void ACallThatDidNotRunHidesNothing()
    {
        var own = new OwnInputLedger();
        own.BeginAction(1_000);
        own.Note(call: true, now: 1_100, lastBefore: 1_000);
        own.UndoCall();
        Assert.False(own.ActionSent);
        Assert.True(own.UserInputSince(1_000, lastInput: 1_500, now: 1_600));
    }

    [Fact]
    public void UndoKeepsEarlierInputOfTheSameAction()
    {
        var own = new OwnInputLedger();
        own.BeginAction(1_000);
        own.Note(call: false, now: 1_050, lastBefore: 1_000);
        own.Note(call: true, now: 1_100, lastBefore: 1_050);
        own.UndoCall();
        Assert.True(own.ActionSent);
        // Our SendInput at 1_050 still counts as ours, within the slack.
        Assert.False(own.UserInputSince(1_000, lastInput: 1_050, now: 1_200));
    }

    [Fact]
    public void InputBetweenTwoBatchesOfOneActionIsTheUsers()
    {
        var own = new OwnInputLedger();
        own.BeginAction(1_000);
        own.Note(call: false, now: 1_010, lastBefore: 1_000);
        // The user typed at 1_200; our next batch then moves the clock past it.
        own.Note(call: false, now: 1_300, lastBefore: 1_200);
        Assert.True(own.UserInputSince(1_000, lastInput: 1_300, now: 1_310));
    }

    [Fact]
    public void InputBeforeTheActionIsNeverItsOwn()
    {
        var own = new OwnInputLedger();
        // The user's input at 900, before the action began at 1_000.
        own.BeginAction(1_000);
        own.Note(call: false, now: 1_010, lastBefore: 1_000);
        Assert.False(own.UserInputSince(1_000, lastInput: 1_010, now: 1_020));
    }
}
