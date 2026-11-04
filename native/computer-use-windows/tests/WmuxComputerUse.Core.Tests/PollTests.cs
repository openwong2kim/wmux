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
        bool landed = Poll.Until(() => { c.Reads++; return c.Now >= 20; }, Poll.FocusSettleMs, () => c.Now, c.Sleep);
        Assert.True(landed);
        Assert.InRange(c.Now, 20, 20 + Poll.IntervalMs);
        Assert.True(c.Reads > 1);
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
}
