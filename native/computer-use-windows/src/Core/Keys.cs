// The canonical key vocabulary of src/shared/computer/protocol.ts (NAMED_KEYS,
// a–z, 0–9 and the four modifiers) mapped to Windows virtual-key codes. Main
// normalizes aliases, so anything outside this closed set is refused, never
// guessed.
//
// Letter and digit virtual keys are layout-relative on Windows already: VK_A
// is whichever key types `a` on the person's layout, so `ctrl+a` on AZERTY
// presses the key labelled A without a layout table.

namespace WmuxComputerUse.Core;

public readonly record struct KeySpec(ushort Vk, bool Extended);

public readonly record struct ModifierKey(string Name, ushort Vk, bool Extended);

public static class Keys
{
    public const ushort VkLShift = 0xA0;
    public const ushort VkLControl = 0xA2;
    public const ushort VkLMenu = 0xA4;
    public const ushort VkLWin = 0x5B;
    /// <summary>Unassigned. Pressed between a Win down and up so the shell does not open Start.</summary>
    public const ushort VkStartMenuMask = 0xE8;

    /// <summary>Positional keys. Extended: the navigation block and arrows, as a real keyboard sends them.</summary>
    public static readonly IReadOnlyDictionary<string, KeySpec> Named = new Dictionary<string, KeySpec>(StringComparer.Ordinal)
    {
        ["Enter"] = new(0x0D, false),
        ["Tab"] = new(0x09, false),
        ["Escape"] = new(0x1B, false),
        ["Backspace"] = new(0x08, false),
        ["Delete"] = new(0x2E, true),
        ["Space"] = new(0x20, false),
        ["ArrowUp"] = new(0x26, true),
        ["ArrowDown"] = new(0x28, true),
        ["ArrowLeft"] = new(0x25, true),
        ["ArrowRight"] = new(0x27, true),
        ["Home"] = new(0x24, true),
        ["End"] = new(0x23, true),
        ["PageUp"] = new(0x21, true),
        ["PageDown"] = new(0x22, true),
        ["F1"] = new(0x70, false), ["F2"] = new(0x71, false), ["F3"] = new(0x72, false),
        ["F4"] = new(0x73, false), ["F5"] = new(0x74, false), ["F6"] = new(0x75, false),
        ["F7"] = new(0x76, false), ["F8"] = new(0x77, false), ["F9"] = new(0x78, false),
        ["F10"] = new(0x79, false), ["F11"] = new(0x7A, false), ["F12"] = new(0x7B, false),
    };

    /// <summary>In protocol MODIFIERS order: pressed in this order, released in reverse.</summary>
    public static readonly IReadOnlyList<ModifierKey> Modifiers =
    [
        new("ctrl", VkLControl, false),
        new("alt", VkLMenu, false),
        new("shift", VkLShift, false),
        new("meta", VkLWin, true),
    ];

    /// <summary>The virtual key for a canonical key name, or null when it is not in the vocabulary.</summary>
    public static KeySpec? Lookup(string key)
    {
        if (Named.TryGetValue(key, out var spec)) return spec;
        if (key.Length == 1)
        {
            char c = key[0];
            if (c >= 'a' && c <= 'z') return new KeySpec((ushort)('A' + (c - 'a')), false);
            if (c >= '0' && c <= '9') return new KeySpec((ushort)c, false);
        }
        return null;
    }

    public static ModifierKey? Modifier(string name)
    {
        foreach (var m in Modifiers) if (m.Name == name) return m;
        return null;
    }

    /// <summary>Modifiers in press order, or null if any name is not a modifier.</summary>
    public static List<ModifierKey>? OrderedModifiers(IEnumerable<string> names)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        foreach (var n in names)
        {
            if (Modifier(n) == null) return null;
            set.Add(n);
        }
        return Modifiers.Where(m => set.Contains(m.Name)).ToList();
    }

    /// <summary>Whether a virtual key is sent with KEYEVENTF_EXTENDEDKEY.</summary>
    public static bool IsExtended(ushort vk)
    {
        if (vk == VkLWin) return true;
        foreach (var spec in Named.Values) if (spec.Vk == vk) return spec.Extended;
        return false;
    }

    /// <summary>
    /// Every virtual key a helper can ever press: the named keys, letters,
    /// digits and the four modifiers. A held-state file may only ever turn
    /// into up events for these.
    /// </summary>
    public static readonly IReadOnlySet<ushort> Pressable = BuildPressable();

    private static HashSet<ushort> BuildPressable()
    {
        var set = new HashSet<ushort>(Named.Values.Select(s => s.Vk));
        for (ushort c = 'A'; c <= 'Z'; c++) set.Add(c);
        for (ushort c = '0'; c <= '9'; c++) set.Add(c);
        foreach (var m in Modifiers) set.Add(m.Vk);
        return set;
    }
}
