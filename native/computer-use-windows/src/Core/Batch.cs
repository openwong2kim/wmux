// What a SendInput batch leaves held when Windows inserts only part of it,
// and the order the matching up events go out in. Pure, so it is tested.
//
// SendInput inserts events in order and returns how many went in, so the
// held set after a partial batch is exactly the downs in that prefix without
// their ups. Releasing goes in reverse press order: the main key first, then
// the modifiers in reverse, so no chord fires on the way out. A Win key that
// goes up with nothing pressed since it went down opens Start, so an
// unassigned key (0xE8) is tapped right before the Win key-up.

namespace WmuxComputerUse.Core;

public enum InputKind { Key, Unicode, Button, Other }

/// <summary>
/// One event of a batch. `Code` is the virtual key (Key), the UTF-16 unit
/// (Unicode) or the button 0–2 (Button); X/Y is where a button event happens.
/// </summary>
public readonly record struct InputEvent(InputKind Kind, ushort Code, bool Up, double X = 0, double Y = 0)
{
    public static InputEvent KeyDown(ushort vk) => new(InputKind.Key, vk, false);
    public static InputEvent KeyUp(ushort vk) => new(InputKind.Key, vk, true);
    public static InputEvent UnitDown(char unit) => new(InputKind.Unicode, unit, false);
    public static InputEvent UnitUp(char unit) => new(InputKind.Unicode, unit, true);
    public static InputEvent ButtonDown(int button, double x, double y) => new(InputKind.Button, (ushort)button, false, x, y);
    public static InputEvent ButtonUp(int button, double x, double y) => new(InputKind.Button, (ushort)button, true, x, y);
    public static InputEvent Move(double x, double y) => new(InputKind.Other, 0, false, x, y);
}

public static class Batch
{
    /// <summary>The downs among the first `inserted` events that have no up there, in press order.</summary>
    public static List<InputEvent> HeldAfter(IReadOnlyList<InputEvent> batch, int inserted)
    {
        var held = new List<InputEvent>();
        for (int i = 0; i < Math.Min(inserted, batch.Count); i++)
        {
            var e = batch[i];
            if (e.Kind == InputKind.Other) continue;
            if (!e.Up)
            {
                if (!held.Any(h => h.Kind == e.Kind && h.Code == e.Code)) held.Add(e);
            }
            else
            {
                held.RemoveAll(h => h.Kind == e.Kind && h.Code == e.Code);
            }
        }
        return held;
    }

    /// <summary>Up events for `held` (press order), in reverse, with the Start-menu mask before a Win key-up.</summary>
    public static List<InputEvent> ReleaseSequence(IReadOnlyList<InputEvent> held)
    {
        var ups = new List<InputEvent>();
        for (int i = held.Count - 1; i >= 0; i--)
        {
            var h = held[i];
            if (h.Kind == InputKind.Key && h.Code == Keys.VkLWin)
            {
                ups.Add(InputEvent.KeyDown(Keys.VkStartMenuMask));
                ups.Add(InputEvent.KeyUp(Keys.VkStartMenuMask));
            }
            ups.Add(h with { Up = true });
        }
        return ups;
    }

    /// <summary>
    /// Press order for a set of keys whose real order is unknown (a release
    /// request, a dead helper's record): ordinary keys are treated as pressed
    /// last and modifiers in protocol order, so the release lifts the ordinary
    /// keys first and then meta, shift, alt, ctrl.
    /// </summary>
    public static List<InputEvent> AsPressed(IEnumerable<ushort> keys, IEnumerable<HeldButton> buttons)
    {
        var set = new HashSet<ushort>(keys);
        var pressed = new List<InputEvent>();
        foreach (var b in buttons) pressed.Add(InputEvent.ButtonDown(b.Button, b.X, b.Y));
        foreach (var m in Keys.Modifiers) if (set.Remove(m.Vk)) pressed.Add(InputEvent.KeyDown(m.Vk));
        foreach (var k in set.Order()) pressed.Add(InputEvent.KeyDown(k));
        return pressed;
    }
}
