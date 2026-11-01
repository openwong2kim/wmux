// One request at a time. The helper's retry-safety answers rest on it: a
// control error's disposition and the needs_foreground answer (protocol
// ForegroundMode) compare Input.Sent before and after the request, which is
// only that request's input while no other request runs. The server loop is
// single-threaded already (Sta.Run dequeues one line at a time, and
// Sta.Sleep pumps window messages but never dequeues a request), so the gate
// is an assertion: a second entry means that changed, and that request is
// refused before it sends anything.

namespace WmuxComputerUse.Core;

public sealed class RequestGate
{
    private int busy;

    /// <summary>True when no other request is in flight; the caller then must call Exit.</summary>
    public bool TryEnter() => Interlocked.CompareExchange(ref busy, 1, 0) == 0;

    public void Exit() => Interlocked.Exchange(ref busy, 0);

    public bool Busy => Volatile.Read(ref busy) != 0;
}
