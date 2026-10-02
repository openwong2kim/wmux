// Synthetic input through SendInput, and the record of what is held.
//
// Every batch is ONE SendInput call that carries its own up events (modifiers
// down, key down/up, modifiers up; move, button down/up), so between calls
// nothing the helper pressed stays down, and no other input interleaves with
// a batch. Keys and buttons are still recorded (in memory and in the per-pid
// file of HeldStore.cs) before the call:
//   - if SendInput inserts only part of a batch, exactly what that prefix
//     left down (Core Batch.HeldAfter, Unicode units included) goes up at
//     once, main key first, then modifiers in reverse; the record is cleared
//     only when those ups were inserted, and the batch reports an error
//     either way so main can schedule a releaseInput;
//   - a helper killed outright (TerminateProcess runs no handler) leaves a
//     record that the next helper releases before its first control request.
//
// The safety checks run twice per batch: the slow ones (UIA focus, password
// field) just before Post, and the fast Win32 ones (input desktop,
// foreground window, keyboard focus, or the window under the point) inside
// Post, under the lock, immediately before SendInput.
//
// Shutdown goes through one gate (Shutdown.Run): posting stops first, under
// the lock every SendInput takes, and only then is held input released.

using Windows.Win32;
using Windows.Win32.UI.Input.KeyboardAndMouse;
using Windows.Win32.UI.WindowsAndMessaging;
using WmuxComputerUse.Core;

namespace WmuxComputerUse;

internal static unsafe class Input
{
    private const int WheelDelta = 120;

    /// <summary>Guards the held record, the stop flag and every SendInput.</summary>
    private static readonly object Lock = new();
    private static readonly HashSet<ushort> HeldKeys = [];
    private static readonly Dictionary<int, (double X, double Y)> HeldButtons = [];
    private static bool stopping;
    /// <summary>Whether what dead helpers recorded has been released (checked before every control request).</summary>
    private static bool orphansReleased;

    // MARK: Event builders

    private static INPUT Key(ushort vk, bool up)
    {
        var input = new INPUT { type = INPUT_TYPE.INPUT_KEYBOARD };
        input.ki.wVk = (VIRTUAL_KEY)vk;
        input.ki.wScan = (ushort)(PInvoke.MapVirtualKey(vk, MAP_VIRTUAL_KEY_TYPE.MAPVK_VK_TO_VSC) & 0xFF);
        var flags = Keys.IsExtended(vk) ? KEYBD_EVENT_FLAGS.KEYEVENTF_EXTENDEDKEY : 0;
        if (up) flags |= KEYBD_EVENT_FLAGS.KEYEVENTF_KEYUP;
        input.ki.dwFlags = flags;
        return input;
    }

    private static INPUT Unicode(char unit, bool up)
    {
        var input = new INPUT { type = INPUT_TYPE.INPUT_KEYBOARD };
        input.ki.wVk = 0;
        input.ki.wScan = unit;
        input.ki.dwFlags = KEYBD_EVENT_FLAGS.KEYEVENTF_UNICODE | (up ? KEYBD_EVENT_FLAGS.KEYEVENTF_KEYUP : 0);
        return input;
    }

    private static INPUT Mouse(double x, double y, MOUSE_EVENT_FLAGS flags, int data = 0)
    {
        int left = PInvoke.GetSystemMetrics(SYSTEM_METRICS_INDEX.SM_XVIRTUALSCREEN);
        int top = PInvoke.GetSystemMetrics(SYSTEM_METRICS_INDEX.SM_YVIRTUALSCREEN);
        int width = PInvoke.GetSystemMetrics(SYSTEM_METRICS_INDEX.SM_CXVIRTUALSCREEN);
        int height = PInvoke.GetSystemMetrics(SYSTEM_METRICS_INDEX.SM_CYVIRTUALSCREEN);
        var input = new INPUT { type = INPUT_TYPE.INPUT_MOUSE };
        input.mi.dx = Geometry.NormalizeVirtualDesk(x, left, width);
        input.mi.dy = Geometry.NormalizeVirtualDesk(y, top, height);
        input.mi.mouseData = unchecked((uint)data);
        input.mi.dwFlags = flags | MOUSE_EVENT_FLAGS.MOUSEEVENTF_MOVE | MOUSE_EVENT_FLAGS.MOUSEEVENTF_ABSOLUTE | MOUSE_EVENT_FLAGS.MOUSEEVENTF_VIRTUALDESK;
        return input;
    }

    private static MOUSE_EVENT_FLAGS ButtonFlag(int button, bool up) => (button, up) switch
    {
        (0, false) => MOUSE_EVENT_FLAGS.MOUSEEVENTF_LEFTDOWN,
        (0, true) => MOUSE_EVENT_FLAGS.MOUSEEVENTF_LEFTUP,
        (1, false) => MOUSE_EVENT_FLAGS.MOUSEEVENTF_RIGHTDOWN,
        (1, true) => MOUSE_EVENT_FLAGS.MOUSEEVENTF_RIGHTUP,
        (_, false) => MOUSE_EVENT_FLAGS.MOUSEEVENTF_MIDDLEDOWN,
        _ => MOUSE_EVENT_FLAGS.MOUSEEVENTF_MIDDLEUP,
    };

    private static INPUT ToInput(InputEvent e) => e.Kind switch
    {
        InputKind.Key => Key(e.Code, e.Up),
        InputKind.Unicode => Unicode((char)e.Code, e.Up),
        InputKind.Button => Mouse(e.X, e.Y, ButtonFlag(e.Code, e.Up)),
        _ => Mouse(e.X, e.Y, 0),
    };

    /// <summary>A batch: the INPUTs to send and, in parallel, what each one presses or lifts.</summary>
    private sealed class BatchBuilder
    {
        public List<InputEvent> Events { get; } = [];
        public List<INPUT> Inputs { get; } = [];

        public BatchBuilder Add(InputEvent e)
        {
            Events.Add(e);
            Inputs.Add(ToInput(e));
            return this;
        }

        /// <summary>An event that presses nothing (a move or a wheel notch).</summary>
        public BatchBuilder AddRaw(INPUT input, double x, double y)
        {
            Events.Add(InputEvent.Move(x, y));
            Inputs.Add(input);
            return this;
        }
    }

    // MARK: Posting (everything goes through Post)

    /// <summary>Throws once shutdown has begun: no new input, semantic actions included.</summary>
    public static void ThrowIfStopping()
    {
        lock (Lock)
        {
            if (stopping) throw new HelperError("internal", "the helper is shutting down; nothing was sent");
        }
    }

    /// <summary>
    /// Sends one batch. `events` describe the presses in it (moves and wheel
    /// notches are `Other`), `inputs` are the matching INPUTs. `preflight`
    /// runs under the lock right before SendInput and throws to send nothing.
    /// </summary>
    private static void Post(BatchBuilder batch, Action preflight)
    {
        var events = batch.Events;
        var inputs = batch.Inputs.ToArray();
        lock (Lock)
        {
            if (stopping) throw new HelperError("internal", "the helper is shutting down; nothing was sent");
            preflight();
            var recorded = events.Where(e => !e.Up && e.Kind is InputKind.Key or InputKind.Button).ToList();
            foreach (var e in recorded) Record(e);
            if (recorded.Count > 0) Persist();

            uint sent = PInvoke.SendInput(inputs, sizeof(INPUT));
            if (sent == inputs.Length)
            {
                foreach (var e in recorded) Forget(e);
                if (recorded.Count > 0) Persist();
                return;
            }

            // Part of the batch went in: lift exactly what that prefix left down.
            var held = Batch.HeldAfter(events, (int)sent);
            var ups = Batch.ReleaseSequence(held);
            bool released = ups.Count == 0 || PInvoke.SendInput(ups.Select(ToInput).ToArray(), sizeof(INPUT)) == ups.Count;
            foreach (var e in recorded)
            {
                // Keep the record of anything still possibly down until an up is confirmed.
                if (released || !held.Any(h => h.Kind == e.Kind && h.Code == e.Code)) Forget(e);
            }
            Persist();
            if (released)
            {
                throw new HelperError("internal", $"Windows accepted only {sent} of {inputs.Length} input events (another app may have blocked input); what went down was released. Check the app state before retrying");
            }
            throw new HelperError("internal", $"Windows accepted only {sent} of {inputs.Length} input events and refused the releases; keys or buttons may still be held");
        }
    }

    private static void Record(InputEvent e)
    {
        if (e.Kind == InputKind.Key) HeldKeys.Add(e.Code);
        else if (e.Kind == InputKind.Button) HeldButtons[e.Code] = (e.X, e.Y);
    }

    private static void Forget(InputEvent e)
    {
        if (e.Kind == InputKind.Key) HeldKeys.Remove(e.Code);
        else if (e.Kind == InputKind.Button) HeldButtons.Remove(e.Code);
    }

    private static void Persist() =>
        HeldStore.Write([.. HeldKeys], HeldButtons.Select(kv => new HeldButton(kv.Key, kv.Value.X, kv.Value.Y)).ToList());

    public static void StopPosting()
    {
        lock (Lock) stopping = true;
    }

    // MARK: Batches

    /// <summary>`mods` down in protocol order, the key down and up, `mods` up in reverse — one batch.</summary>
    public static void Tap(KeySpec key, IReadOnlyList<ModifierKey> mods, Action preflight)
    {
        var b = new BatchBuilder();
        foreach (var m in mods) b.Add(InputEvent.KeyDown(m.Vk));
        b.Add(InputEvent.KeyDown(key.Vk)).Add(InputEvent.KeyUp(key.Vk));
        for (int i = mods.Count - 1; i >= 0; i--) b.Add(InputEvent.KeyUp(mods[i].Vk));
        Post(b, preflight);
    }

    /// <summary>One run of text as KEYEVENTF_UNICODE down/up pairs; never the clipboard.</summary>
    public static void TypeText(string text, Action preflight)
    {
        var b = new BatchBuilder();
        foreach (var unit in text) b.Add(InputEvent.UnitDown(unit)).Add(InputEvent.UnitUp(unit));
        Post(b, preflight);
    }

    /// <summary>Move, then `count` clicks with `mods` held around them, at a screen pixel — one batch.</summary>
    public static void Click(double x, double y, int button, int count, IReadOnlyList<ModifierKey> mods, Action preflight)
    {
        var b = new BatchBuilder().AddRaw(Mouse(x, y, 0), x, y);
        foreach (var m in mods) b.Add(InputEvent.KeyDown(m.Vk));
        for (int n = 0; n < count; n++) b.Add(InputEvent.ButtonDown(button, x, y)).Add(InputEvent.ButtonUp(button, x, y));
        for (int i = mods.Count - 1; i >= 0; i--) b.Add(InputEvent.KeyUp(mods[i].Vk));
        Post(b, preflight);
    }

    /// <summary>One wheel notch at a screen pixel (WHEEL_DELTA, about three lines).</summary>
    public static void Wheel(double x, double y, int dx, int dy, Action preflight)
    {
        var b = new BatchBuilder().AddRaw(Mouse(x, y, 0), x, y);
        if (dy != 0) b.AddRaw(Mouse(x, y, MOUSE_EVENT_FLAGS.MOUSEEVENTF_WHEEL, dy * WheelDelta), x, y);
        if (dx != 0) b.AddRaw(Mouse(x, y, MOUSE_EVENT_FLAGS.MOUSEEVENTF_HWHEEL, dx * WheelDelta), x, y);
        Post(b, preflight);
    }

    // MARK: Release

    /// <summary>
    /// releaseInput `{keys?, modifiers?, buttons?}`: what this helper tracked,
    /// what dead helpers recorded, plus what main lists from the request that
    /// was cut off. With no fields at all: the modifiers and mouse buttons
    /// that are down — never ordinary keys, because a stray key-up
    /// lands in whatever window is in front and pages act on key-up.
    /// </summary>
    public static bool ReleaseInput(Params p)
    {
        var keys = new HashSet<ushort>();
        foreach (var name in p.Strings("keys") ?? [])
        {
            var spec = Keys.Lookup(name) ?? throw new HelperError("invalid_argument", $"\"{(name.Length > 20 ? name[..20] : name)}\" is not a canonical key name");
            keys.Add(spec.Vk);
        }
        var mods = Keys.OrderedModifiers(p.Strings("modifiers") ?? [])
            ?? throw new HelperError("invalid_argument", "modifiers must be ctrl, alt, shift or meta");
        foreach (var m in mods) keys.Add(m.Vk);
        var buttons = new List<int>();
        foreach (var name in p.Strings("buttons") ?? [])
        {
            buttons.Add(name switch
            {
                "left" => 0,
                "right" => 1,
                "middle" => 2,
                _ => throw new HelperError("invalid_argument", "buttons must be left, right or middle"),
            });
        }
        bool listed = p.Has("keys") || p.Has("modifiers") || p.Has("buttons");
        if (!listed)
        {
            foreach (var m in Keys.Modifiers)
            {
                if ((PInvoke.GetAsyncKeyState(m.Vk) & 0x8000) != 0) keys.Add(m.Vk);
            }
            // Only buttons that are down: on Windows a stray right-button up
            // makes DefWindowProc open the context menu under the cursor.
            // Left and right are both checked for each, because with swapped
            // buttons the async state names the physical one.
            bool left = Down(0x01), right = Down(0x02);
            if (left || right) buttons.AddRange([0, 1]);
            if (Down(0x04)) buttons.Add(2);
        }
        return ReleaseAll(keys, buttons);
    }

    private static bool Down(int vk) => (PInvoke.GetAsyncKeyState(vk) & 0x8000) != 0;

    /// <summary>
    /// Releases what this helper holds, what dead helpers recorded, and the
    /// extras (extra buttons go up at the cursor): ordinary keys first, then
    /// meta, shift, alt, ctrl, then buttons where they went down. Returns true
    /// only when every up event was inserted; otherwise the records (in
    /// memory and on disk) stay, so the next release tries again. `releasing`
    /// is the shutdown path, the one caller allowed to post after
    /// StopPosting.
    /// </summary>
    public static bool ReleaseAll(IEnumerable<ushort>? extraKeys = null, IEnumerable<int>? extraButtons = null, bool releasing = false)
    {
        lock (Lock)
        {
            if (stopping && !releasing) return false;
            var keys = new HashSet<ushort>(HeldKeys);
            if (extraKeys != null) keys.UnionWith(extraKeys);
            var buttons = new Dictionary<int, (double X, double Y)>(HeldButtons);
            var orphaned = HeldStore.ReadOrphaned();
            foreach (var (_, state) in orphaned)
            {
                keys.UnionWith(state.Keys);
                foreach (var b in state.Buttons) buttons.TryAdd(b.Button, (b.X, b.Y));
            }
            if (extraButtons != null)
            {
                PInvoke.GetCursorPos(out var cursor);
                foreach (var b in extraButtons) buttons.TryAdd(b, (cursor.X, cursor.Y));
            }

            var pressed = Batch.AsPressed(keys, buttons.Select(kv => new HeldButton(kv.Key, kv.Value.X, kv.Value.Y)));
            var ups = Batch.ReleaseSequence(pressed);
            bool ok = ups.Count == 0 || PInvoke.SendInput(ups.Select(ToInput).ToArray(), sizeof(INPUT)) == ups.Count;
            if (!ok) return false;

            HeldKeys.Clear();
            HeldButtons.Clear();
            foreach (var (path, _) in orphaned) HeldStore.Remove(path);
            HeldStore.RemoveOwn();
            orphansReleased = true;
            return true;
        }
    }

    /// <summary>
    /// Before the first control request (and every one after, until it
    /// works): release what a dead helper recorded. A helper that cannot
    /// sends no new input.
    /// </summary>
    public static void EnsureOrphansReleased()
    {
        lock (Lock)
        {
            if (orphansReleased) return;
        }
        if (!ReleaseAll())
        {
            throw new HelperError("internal", "keys or buttons a previous helper left down could not be released, so no input is sent. Retry once; if it fails again, tell the user");
        }
    }
}
