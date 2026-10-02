// wmux-computer-use: the Windows computer-use helper. Speaks the NDJSON
// protocol of src/shared/computer/protocol.ts over stdio; see
// docs/computer-use-windows.md.
//
// Threads:
//   - main: reads stdin, hands each request to the STA thread, and runs the
//     shutdown gate on EOF (never blocked by a UIA call stuck in a hung app);
//   - the STA thread (Sta.cs): every COM / UIA / WIC call and every request,
//     one at a time, with a message pump;
//   - console control events arrive on a thread of their own.
//
// Termination: Node's child.kill() on Windows is TerminateProcess, which runs
// no handler at all. Held input therefore cannot be released "on SIGTERM" the
// way the macOS helper does it; instead every input batch is one SendInput
// call that carries its own up events, and the per-pid held-state file
// (HeldStore.cs) lets the fresh helper main starts for `releaseInput` release
// whatever a killed one had recorded.

using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using Windows.Win32;
using Windows.Win32.Foundation;

namespace WmuxComputerUse;

internal static unsafe class Program
{
    /// <summary>Exit code when the helper's own token is elevated.</summary>
    public const int ExitElevated = 72;
    /// <summary>Longest request line read from stdin; requests are small.</summary>
    private const int MaxRequestBytes = 1 << 20;

    private static int Main()
    {
        // wmux run as administrator would hand an elevated helper every
        // elevated window on the desktop; the helper refuses to be that.
        if (Integrity.SelfIsElevated())
        {
            Wire.Log("refusing to run elevated");
            return ExitElevated;
        }

        PInvoke.SetConsoleCtrlHandler(&OnConsoleCtrl, true);

        // hello first: permissions are static on Windows, so nothing has to be
        // probed before main may send a request.
        Wire.Send(Server.Hello());
        Sta.Start();
        ReadStdin();
        Shutdown.Run("stdin closed");
        return 0;
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvStdcall)])]
    private static BOOL OnConsoleCtrl(uint ctrlType)
    {
        Shutdown.Run($"console control event {ctrlType}");
        return true;
    }

    /// <summary>NDJSON lines from stdin until EOF. Lines longer than the cap are dropped whole.</summary>
    private static void ReadStdin()
    {
        using var stdin = Console.OpenStandardInput();
        var line = new MemoryStream();
        bool overlong = false;
        var buffer = new byte[64 * 1024];
        while (true)
        {
            int n;
            try
            {
                n = stdin.Read(buffer, 0, buffer.Length);
            }
            catch (IOException)
            {
                return;
            }
            if (n <= 0) return;
            int start = 0;
            for (int i = 0; i < n; i++)
            {
                if (buffer[i] != (byte)'\n') continue;
                if (!overlong) line.Write(buffer, start, i - start);
                if (!overlong && line.Length > 0) Sta.Post(line.ToArray());
                if (overlong) Wire.Log("dropping a request line over the size cap");
                line.SetLength(0);
                overlong = false;
                start = i + 1;
            }
            if (!overlong)
            {
                line.Write(buffer, start, n - start);
                if (line.Length > MaxRequestBytes)
                {
                    overlong = true;
                    line.SetLength(0);
                }
            }
        }
    }
}
