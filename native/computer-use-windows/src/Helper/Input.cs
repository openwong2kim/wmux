// Synthetic input through SendInput, and the record of what is held.
//
// Every batch is ONE SendInput call that carries its own up events (modifiers
// down, key down/up, modifiers up; move, button down/up), so between calls
// nothing the helper pressed stays down, and no other input interleaves with
// a batch. Keys and buttons are still recorded (in memory and in the per-pid
// file of HeldStore.cs) before the call and cleared after it: if SendInput
// inserts only part of a batch, the ups for whatever is recorded go out at
// once, and a helper killed outright (TerminateProcess runs no handler)
// leaves a record the next helper's `releaseInput` turns into up events.
//
// Shutdown goes through one gate (Shutdown.Run): posting stops first, under
// the lock every SendInput takes, and only then is held input released.

using System.Runtime.InteropServices;
using Windows.Win32;
using Windows.Win32.Foundation;
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

    // MARK: Posting (everything goes through Post)

    /// <summary>
    /// Records `keys` / `button` as held, sends the batch, and clears them
    /// again. Returns false when posting has stopped (nothing sent) or the
    /// batch was cut short, in which case the ups for what was recorded have
    /// already gone out.
    /// </summary>
    private static bool Post(INPUT[] batch, IReadOnlyCollection<ushort> keys, (int Button, double X, double Y)? button = null)
    {
        lock (Lock)
        {
            if (stopping) return false;
            foreach (var k in keys) HeldKeys.Add(k);
            if (button is { } b) HeldButtons[b.Button] = (b.X, b.Y);
            if (keys.Count > 0 || button != null) Persist();
            uint sent = PInvoke.SendInput(batch, sizeof(INPUT));
            bool complete = sent == batch.Length;
            if (!complete)
            {
                // Some downs may be in without their ups: release now.
                var ups = new List<INPUT>();
                foreach (var k in keys) ups.Add(Key(k, up: true));
                if (button is { } bb) ups.Add(Mouse(bb.X, bb.Y, ButtonFlag(bb.Button, up: true)));
                PInvoke.SendInput(ups.ToArray(), sizeof(INPUT));
            }
            foreach (var k in keys) HeldKeys.Remove(k);
            if (button is { } c) HeldButtons.Remove(c.Button);
            if (keys.Count > 0 || button != null) Persist();
            return complete;
        }
    }

    private static void Persist() =>
        HeldStore.Write([.. HeldKeys], HeldButtons.Select(kv => new HeldButton(kv.Key, kv.Value.X, kv.Value.Y)).ToList());

    public static void StopPosting()
    {
        lock (Lock) stopping = true;
    }

    private static void Require(bool posted)
    {
        if (!posted) throw new HelperError("internal", "the input was not delivered (the helper is shutting down, or Windows refused part of it)");
    }

    // MARK: Batches

    /// <summary>`mods` down in protocol order, the key down and up, `mods` up in reverse — one batch.</summary>
    public static void Tap(KeySpec key, IReadOnlyList<ModifierKey> mods)
    {
        var batch = new List<INPUT>();
        foreach (var m in mods) batch.Add(Key(m.Vk, up: false));
        batch.Add(Key(key.Vk, up: false));
        batch.Add(Key(key.Vk, up: true));
        for (int i = mods.Count - 1; i >= 0; i--) batch.Add(Key(mods[i].Vk, up: true));
        Require(Post([.. batch], [.. mods.Select(m => m.Vk), key.Vk]));
    }

    /// <summary>One run of text as KEYEVENTF_UNICODE down/up pairs; never the clipboard.</summary>
    public static void TypeText(string text)
    {
        var batch = new INPUT[text.Length * 2];
        for (int i = 0; i < text.Length; i++)
        {
            batch[2 * i] = Unicode(text[i], up: false);
            batch[2 * i + 1] = Unicode(text[i], up: true);
        }
        // A Unicode event holds no virtual key; nothing to record.
        Require(Post(batch, []));
    }

    /// <summary>Move, then `count` clicks with `mods` held around them, at a screen pixel — one batch.</summary>
    public static void Click(double x, double y, int button, int count, IReadOnlyList<ModifierKey> mods)
    {
        var batch = new List<INPUT> { Mouse(x, y, 0) };
        foreach (var m in mods) batch.Add(Key(m.Vk, up: false));
        for (int n = 0; n < count; n++)
        {
            batch.Add(Mouse(x, y, ButtonFlag(button, up: false)));
            batch.Add(Mouse(x, y, ButtonFlag(button, up: true)));
        }
        for (int i = mods.Count - 1; i >= 0; i--) batch.Add(Key(mods[i].Vk, up: true));
        Require(Post([.. batch], [.. mods.Select(m => m.Vk)], (button, x, y)));
    }

    /// <summary>One wheel notch at a screen pixel (WHEEL_DELTA, about three lines).</summary>
    public static void Wheel(double x, double y, int dx, int dy)
    {
        var batch = new List<INPUT> { Mouse(x, y, 0) };
        if (dy != 0) batch.Add(Mouse(x, y, MOUSE_EVENT_FLAGS.MOUSEEVENTF_WHEEL, dy * WheelDelta));
        if (dx != 0) batch.Add(Mouse(x, y, MOUSE_EVENT_FLAGS.MOUSEEVENTF_HWHEEL, dx * WheelDelta));
        Require(Post([.. batch], []));
    }

    // MARK: Release

    /// <summary>
    /// releaseInput `{keys?, modifiers?, buttons?}`: what this helper tracked,
    /// what dead helpers recorded, plus what main lists from the request that
    /// was cut off. With no fields at all: the modifiers that are down and
    /// the three mouse buttons — never ordinary keys, because a stray key-up
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
            buttons.AddRange([0, 1, 2]);
        }
        return ReleaseAll(keys, buttons);
    }

    /// <summary>
    /// Releases what this helper holds, what dead helpers recorded, and the
    /// extras (extra buttons go up at the cursor). Returns true when every up
    /// event was inserted. `releasing` is the shutdown path, the one caller
    /// allowed to post after StopPosting.
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

            var ups = new List<INPUT>();
            // A Win key that goes up with nothing pressed in between opens
            // Start; an unassigned key in between stops the shell from
            // treating it as a lone tap.
            if (keys.Contains(Keys.VkLWin) && (PInvoke.GetAsyncKeyState(Keys.VkLWin) & 0x8000) != 0)
            {
                ups.Add(Key(Keys.VkStartMenuMask, up: false));
                ups.Add(Key(Keys.VkStartMenuMask, up: true));
            }
            foreach (var k in keys) ups.Add(Key(k, up: true));
            foreach (var (button, at) in buttons) ups.Add(Mouse(at.X, at.Y, ButtonFlag(button, up: true)));
            bool ok = ups.Count == 0 || PInvoke.SendInput(ups.ToArray(), sizeof(INPUT)) == ups.Count;

            HeldKeys.Clear();
            HeldButtons.Clear();
            foreach (var (path, _) in orphaned) HeldStore.Remove(path);
            HeldStore.RemoveOwn();
            return ok;
        }
    }
}
