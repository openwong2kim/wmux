// Waiting for a state another process reaches on its own time. UIA SetFocus
// on an element of a window that is not in front activates that window
// asynchronously: the call returns before the app has moved its focus, so a
// single read right after it sees the old focus. The helper reads again until
// the state is reached or a bound passes.

namespace WmuxComputerUse.Core;

public static class Poll
{
    /// <summary>
    /// How long focus may take to land after UIA SetFocus brought a background
    /// window forward. Longer than BackgroundInput's FocusWaitMs (300 ms, a
    /// posted click inside a window that stays where it is): here the whole
    /// window is activated first.
    /// </summary>
    public const int FocusSettleMs = 500;
    /// <summary>
    /// After activating a background window, focus must stay on the element
    /// this long: the app's own activation handling (WM_ACTIVATE restoring
    /// its last focused control) can move it once more right after.
    /// </summary>
    public const int FocusSteadyMs = 50;
    public const int IntervalMs = 15;

    /// <summary>
    /// True as soon as `reached` holds, false once `timeoutMs` has passed
    /// without it. Reads at least once, and once more at the deadline.
    /// `now` and `sleep` are injected for tests.
    /// </summary>
    public static bool Until(Func<bool> reached, int timeoutMs, Func<long> now, Action<int> sleep, int pollMs = IntervalMs) =>
        UntilSteady(reached, timeoutMs, 0, now, sleep, pollMs);

    /// <summary>
    /// True once `reached` has held on every read for `steadyMs` (0: the
    /// first read that holds), false when that has not happened by
    /// `timeoutMs` plus `steadyMs`. A read that does not hold starts the
    /// steady time over.
    /// </summary>
    public static bool UntilSteady(Func<bool> reached, int timeoutMs, int steadyMs, Func<long> now, Action<int> sleep, int pollMs = IntervalMs)
    {
        long start = now();
        long deadline = start + timeoutMs + steadyMs;
        long? since = null;
        while (true)
        {
            long t = now();
            if (reached())
            {
                since ??= t;
                if (t - since.Value >= steadyMs) return true;
            }
            else
            {
                since = null;
                if (t >= start + timeoutMs) return false;
            }
            if (t >= deadline) return false;
            sleep(pollMs);
        }
    }
}
