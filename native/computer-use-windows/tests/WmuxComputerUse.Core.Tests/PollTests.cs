using WmuxComputerUse.Core;

namespace WmuxComputerUse.Core.Tests;

public class PollTests
{
    private sealed class Clock
    {
        public long Now;
        public int Reads;
        public void Sleep(int ms) => Now += ms;
    }

    [Fact]
    public void FocusThatLandsAfterActivationIsWaitedFor()
    {
        // Notepad behind: SetFocus returned, the editor took focus ~20 ms later.
        var c = new Clock();
        Assert.True(Poll.Until(() => c.Now >= 20, Poll.FocusSettleMs, () => c.Now, c.Sleep));
        Assert.InRange(c.Now, 20, 20 + Poll.IntervalMs);
    }

    [Fact]
    public void FocusAlreadyThereIsReadOnce()
    {
        var c = new Clock();
        Assert.True(Poll.Until(() => { c.Reads++; return true; }, Poll.FocusSettleMs, () => c.Now, c.Sleep));
        Assert.Equal(1, c.Reads);
        Assert.Equal(0, c.Now);
    }

    [Fact]
    public void FocusThatNeverLandsGivesUpAtTheBound()
    {
        var c = new Clock();
        Assert.False(Poll.Until(() => false, Poll.FocusSettleMs, () => c.Now, c.Sleep));
        Assert.InRange(c.Now, Poll.FocusSettleMs, Poll.FocusSettleMs + Poll.IntervalMs);
    }

    [Fact]
    public void TheDeadlineGetsOneLastRead()
    {
        // The state is reached exactly at the bound: still true.
        var c = new Clock();
        Assert.True(Poll.Until(() => c.Now >= 30, 30, () => c.Now, c.Sleep, pollMs: 15));
    }

    [Fact]
    public void FocusThatTheAppMovesAwayAgainIsNotTaken()
    {
        // The field reports focus at 20 ms, then the app's activation handling
        // gives it back to its last control at 40 ms and keeps it there.
        var c = new Clock();
        bool steady = Poll.UntilSteady(() => c.Now >= 20 && c.Now < 40, Poll.FocusSettleMs, Poll.FocusSteadyMs, () => c.Now, c.Sleep);
        Assert.False(steady);
        Assert.InRange(c.Now, Poll.FocusSettleMs, Poll.FocusSettleMs + Poll.IntervalMs);
    }

    [Fact]
    public void FocusThatStaysIsTakenOnceSteady()
    {
        // A first flicker at 20 ms, then focus lands for good at 100 ms.
        var c = new Clock();
        bool steady = Poll.UntilSteady(() => (c.Now >= 20 && c.Now < 30) || c.Now >= 100, Poll.FocusSettleMs, Poll.FocusSteadyMs, () => c.Now, c.Sleep);
        Assert.True(steady);
        Assert.InRange(c.Now, 100 + Poll.FocusSteadyMs, 100 + Poll.FocusSteadyMs + 2 * Poll.IntervalMs);
    }

    [Fact]
    public void SteadyTimeMayRunPastTheBound()
    {
        // Focus lands just before the bound: it still gets its steady time.
        var c = new Clock();
        Assert.True(Poll.UntilSteady(() => c.Now >= 495, Poll.FocusSettleMs, Poll.FocusSteadyMs, () => c.Now, c.Sleep));
    }
}
