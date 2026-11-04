// Waiting for a state another process reaches on its own time. UIA SetFocus
// on an element of a window that is not in front activates that window
// asynchronously: the call returns before the app has moved its focus, so a
// single read right after it sees the old focus. The helper reads again until
// the state is reached or a bound passes.

namespace WmuxComputerUse.Core;

public static class Poll
{
    /// <summary>How long focus may take to land after UIA SetFocus brought a background window forward.</summary>
    public const int FocusSettleMs = 500;
    public const int IntervalMs = 15;

    /// <summary>
    /// True as soon as `reached` holds, false once `timeoutMs` has passed
    /// without it. Reads at least once, and once more at the deadline.
    /// `now` and `sleep` are injected for tests.
    /// </summary>
    public static bool Until(Func<bool> reached, int timeoutMs, Func<long> now, Action<int> sleep, int pollMs = IntervalMs)
    {
        long deadline = now() + timeoutMs;
        while (true)
        {
            if (reached()) return true;
            if (now() >= deadline) return false;
            sleep(pollMs);
        }
    }
}
