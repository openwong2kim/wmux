// The one thread that does COM: UIA, WIC and every request, one at a time.
// It is a real single-threaded apartment with a message pump, because UIA
// marshals calls through window messages; stdin is read on the main thread,
// so a UIA call stuck in a hung app never blocks shutdown.

using System.Collections.Concurrent;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.System.Com;
using Windows.Win32.UI.WindowsAndMessaging;

namespace WmuxComputerUse;

internal static unsafe class Sta
{
    /// <summary>
    /// Longer than main's 5-minute idle timer, so main always closes an idle
    /// helper first and never sends a request into one that is exiting.
    /// </summary>
    public static readonly TimeSpan IdleExit = TimeSpan.FromMinutes(6);

    private static readonly ConcurrentQueue<byte[]> Queue = new();
    private static readonly AutoResetEvent Signal = new(false);

    public static void Start()
    {
        var thread = new Thread(Run) { IsBackground = true, Name = "computer-use STA" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
    }

    public static void Post(byte[] line)
    {
        Queue.Enqueue(line);
        Signal.Set();
    }

    private static void Run()
    {
        var hr = PInvoke.CoInitializeEx(null, COINIT.COINIT_APARTMENTTHREADED);
        if (hr.Failed && hr.Value != unchecked((int)0x80010106) /* RPC_E_CHANGED_MODE */)
        {
            Wire.Log($"CoInitializeEx failed (0x{hr.Value:x8})");
        }
        var handle = new HANDLE(Signal.SafeWaitHandle.DangerousGetHandle());
        var lastActivity = Environment.TickCount64;
        while (true)
        {
            while (Queue.TryDequeue(out var line))
            {
                Server.Handle(line);
                lastActivity = Environment.TickCount64;
            }
            long remaining = (long)IdleExit.TotalMilliseconds - (Environment.TickCount64 - lastActivity);
            if (remaining <= 0)
            {
                Shutdown.Run($"idle for {(int)IdleExit.TotalSeconds} s");
                return;
            }
            var wait = PInvoke.MsgWaitForMultipleObjectsEx(1, &handle, (uint)Math.Min(remaining, int.MaxValue),
                QUEUE_STATUS_FLAGS.QS_ALLINPUT, MSG_WAIT_FOR_MULTIPLE_OBJECTS_EX_FLAGS.MWMO_INPUTAVAILABLE);
            if (wait == WAIT_EVENT.WAIT_FAILED) Thread.Sleep(10);
            Pump();
        }
    }

    /// <summary>Dispatches pending window messages (UIA and COM use them on an STA).</summary>
    public static void Pump()
    {
        MSG msg;
        while (PInvoke.PeekMessage(&msg, HWND.Null, 0, 0, PEEK_MESSAGE_REMOVE_TYPE.PM_REMOVE))
        {
            PInvoke.TranslateMessage(&msg);
            PInvoke.DispatchMessage(&msg);
        }
    }

    /// <summary>Waits `ms` while still pumping messages (a plain Sleep would stall COM callbacks).</summary>
    public static void Sleep(int ms)
    {
        long until = Environment.TickCount64 + ms;
        while (true)
        {
            long left = until - Environment.TickCount64;
            if (left <= 0) return;
            PInvoke.MsgWaitForMultipleObjectsEx(0, null, (uint)left, QUEUE_STATUS_FLAGS.QS_ALLINPUT, MSG_WAIT_FOR_MULTIPLE_OBJECTS_EX_FLAGS.MWMO_INPUTAVAILABLE);
            Pump();
        }
    }
}

/// <summary>
/// The one way out (stdin EOF, idle, a console control event, stdout gone),
/// safe from any thread: stop all posting first (waiting out an in-flight
/// SendInput, which holds the same lock), then release held input once, then
/// exit. A second caller parks instead of exiting in the middle of the
/// release.
/// </summary>
internal static class Shutdown
{
    private static int started;

    public static void Run(string why)
    {
        if (Interlocked.Exchange(ref started, 1) == 1)
        {
            Thread.Sleep(Timeout.Infinite);
        }
        Wire.Log($"{why}; exiting");
        try
        {
            Input.StopPosting();
            Input.ReleaseAll(releasing: true);
        }
        catch (Exception e)
        {
            Wire.Log($"release on exit failed: {e.Message}");
        }
        Environment.Exit(0);
    }
}
