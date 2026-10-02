using WmuxComputerUse.Core;

namespace WmuxComputerUse.Core.Tests;

public class KeysTests
{
    [Fact]
    public void MapsTheWholeVocabulary()
    {
        string[] named = ["Enter", "Tab", "Escape", "Backspace", "Delete", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
            "Home", "End", "PageUp", "PageDown", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"];
        foreach (var k in named) Assert.NotNull(Keys.Lookup(k));
        for (char c = 'a'; c <= 'z'; c++) Assert.Equal((ushort)char.ToUpperInvariant(c), Keys.Lookup(c.ToString())!.Value.Vk);
        for (char c = '0'; c <= '9'; c++) Assert.Equal((ushort)c, Keys.Lookup(c.ToString())!.Value.Vk);
        Assert.Equal(new KeySpec(0x0D, false), Keys.Lookup("Enter"));
        Assert.Equal(new KeySpec(0x7B, false), Keys.Lookup("F12"));
    }

    [Fact]
    public void RefusesNamesOutsideTheVocabulary()
    {
        foreach (var k in new[] { "A", "enter", "Return", "Esc", "ctrl", "F13", "", "ab", "é", "Insert" }) Assert.Null(Keys.Lookup(k));
    }

    [Fact]
    public void ExtendedKeysAreTheNavigationBlock()
    {
        foreach (var k in new[] { "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Delete" })
            Assert.True(Keys.Lookup(k)!.Value.Extended, k);
        foreach (var k in new[] { "Enter", "Tab", "Backspace", "Space", "F5", "a", "1" }) Assert.False(Keys.Lookup(k)!.Value.Extended, k);
        Assert.True(Keys.IsExtended(Keys.VkLWin));
        Assert.False(Keys.IsExtended(Keys.VkLControl));
    }

    [Fact]
    public void ModifiersComeInProtocolOrder()
    {
        var mods = Keys.OrderedModifiers(["meta", "shift", "ctrl"])!;
        Assert.Equal(["ctrl", "shift", "meta"], mods.Select(m => m.Name));
        Assert.Equal([Keys.VkLControl, Keys.VkLShift, Keys.VkLWin], mods.Select(m => m.Vk));
        Assert.Null(Keys.OrderedModifiers(["ctrl", "hyper"]));
        Assert.Empty(Keys.OrderedModifiers([])!);
    }

    [Fact]
    public void PressableSetIsClosed()
    {
        Assert.Contains(Keys.VkLWin, Keys.Pressable);
        Assert.Contains((ushort)'Q', Keys.Pressable);
        Assert.DoesNotContain((ushort)0x2D, Keys.Pressable); // Insert
        Assert.DoesNotContain((ushort)0x5C, Keys.Pressable); // right Win
        Assert.DoesNotContain(Keys.VkStartMenuMask, Keys.Pressable);
    }
}

public class ChunksTests
{
    private static string Describe(List<TypeChunk> chunks) =>
        string.Join("|", chunks.Select(c => c.Text != null ? $"t:{c.Text}" : $"k:{c.Key}"));

    [Fact]
    public void SplitsNewlinesAndTabsIntoKeys()
    {
        Assert.Equal("t:ab|k:Enter|t:c|k:Tab|t:d|k:Enter|k:Enter|t:e", Describe(Chunks.Unicode("ab\nc\td\r\n\re")));
    }

    [Fact]
    public void ChunksAtSixteenUnits()
    {
        var chunks = Chunks.Unicode(new string('x', 40));
        Assert.Equal([16, 16, 8], chunks.Select(c => c.Text!.Length));
    }

    [Fact]
    public void NeverSplitsSurrogatePairsOrGraphemes()
    {
        // 15 ASCII + an emoji (2 units) would be 17: the emoji moves to the next chunk whole.
        var chunks = Chunks.Unicode(new string('a', 15) + "😀");
        Assert.Equal(["aaaaaaaaaaaaaaa", "😀"], chunks.Select(c => c.Text));

        var family = "👨‍👩‍👧‍👦"; // 11 UTF-16 units, one grapheme
        chunks = Chunks.Unicode("abcdefg" + family);
        Assert.Equal(["abcdefg", family], chunks.Select(c => c.Text));
        foreach (var c in Chunks.Unicode(string.Concat(Enumerable.Repeat(family, 5))))
            Assert.Equal(family, c.Text);

        // Precomposed Hangul and a decomposed jamo sequence both stay whole.
        var jamo = "한"; // 한 as three jamo
        chunks = Chunks.Unicode(new string('b', 14) + jamo);
        Assert.Equal([new string('b', 14), jamo], chunks.Select(c => c.Text));
        Assert.Equal("t:안녕하세요", Describe(Chunks.Unicode("안녕하세요")));
    }

    [Fact]
    public void GraphemeCountCountsKeysAsOne()
    {
        var chunks = Chunks.Unicode("a😀\nb");
        Assert.Equal(4, chunks.Sum(c => c.GraphemeCount));
    }
}

public class GeometryTests
{
    [Fact]
    public void ScaleMatchesTheSharedFormula()
    {
        Assert.Equal(1, Geometry.ScreenshotScale(800, 600));
        Assert.Equal(1280.0 / 2560, Geometry.ScreenshotScale(2560, 1000), 6);
        Assert.Equal(Math.Sqrt(1_150_000.0 / (1200 * 1200)), Geometry.ScreenshotScale(1200, 1200), 6);
        Assert.Equal(1, Geometry.ScreenshotScale(0, 100));
        Assert.Equal((640, 300), Geometry.ScaledSize(1280, 600, 0.5));
    }

    [Fact]
    public void NormalizesTheVirtualDesktopIncludingNegativeOrigins()
    {
        // Primary 1920 wide plus a monitor to its left at x = -1280.
        Assert.Equal(0, Geometry.NormalizeVirtualDesk(-1280, -1280, 3200));
        Assert.Equal(65535, Geometry.NormalizeVirtualDesk(1919, -1280, 3200));
        Assert.Equal((int)Math.Round(1280 * 65535.0 / 3199), Geometry.NormalizeVirtualDesk(0, -1280, 3200));
        Assert.Equal(0, Geometry.NormalizeVirtualDesk(-5000, -1280, 3200));
        Assert.Equal(65535, Geometry.NormalizeVirtualDesk(99999, -1280, 3200));
        Assert.Equal(0, Geometry.NormalizeVirtualDesk(double.NaN, 0, 1920));
    }
}
