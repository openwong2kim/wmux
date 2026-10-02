// HangWindow [seconds-before-hang]
//
// Shows a window titled "wmux hang target", then blocks its UI thread for
// three minutes after `seconds-before-hang` (default 3), so the window stops
// answering messages. Ghosting is turned off, so Windows keeps the real
// window on screen instead of swapping in a ghost owned by dwm.exe.

using System.Runtime.InteropServices;

internal static class Program
{
    [DllImport("user32.dll")]
    private static extern void DisableProcessWindowsGhosting();

    [STAThread]
    private static void Main(string[] args)
    {
        int delay = args.Length > 0 && int.TryParse(args[0], out var s) && s > 0 ? s : 3;
        DisableProcessWindowsGhosting();
        ApplicationConfiguration.Initialize();
        var form = new Form { Text = "wmux hang target", Width = 480, Height = 320 };
        var timer = new System.Windows.Forms.Timer { Interval = delay * 1000 };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            Thread.Sleep(TimeSpan.FromMinutes(3));
        };
        form.Shown += (_, _) => timer.Start();
        Application.Run(form);
    }
}
