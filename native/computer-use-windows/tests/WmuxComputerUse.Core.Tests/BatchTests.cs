using WmuxComputerUse.Core;
using E = WmuxComputerUse.Core.InputEvent;

namespace WmuxComputerUse.Core.Tests;

public class BatchTests
{
    // ctrl+shift+t: ctrl down, shift down, t down, t up, shift up, ctrl up
    private static readonly E[] Chord =
    [
        E.KeyDown(Keys.VkLControl), E.KeyDown(Keys.VkLShift), E.KeyDown('T'),
        E.KeyUp('T'), E.KeyUp(Keys.VkLShift), E.KeyUp(Keys.VkLControl),
    ];

    [Fact]
    public void NothingHeldAfterAFullOrEmptyBatch()
    {
        Assert.Empty(Batch.HeldAfter(Chord, Chord.Length));
        Assert.Empty(Batch.HeldAfter(Chord, 0));
    }

    [Fact]
    public void PartialBatchReleasesMainKeyFirstThenModifiersInReverse()
    {
        var held = Batch.HeldAfter(Chord, 3);
        Assert.Equal([E.KeyDown(Keys.VkLControl), E.KeyDown(Keys.VkLShift), E.KeyDown('T')], held);
        Assert.Equal([E.KeyUp('T'), E.KeyUp(Keys.VkLShift), E.KeyUp(Keys.VkLControl)], Batch.ReleaseSequence(held));
        Assert.Equal([E.KeyDown(Keys.VkLControl)], Batch.HeldAfter(Chord, 5));
    }

    [Fact]
    public void WinKeyUpIsMasked()
    {
        var ups = Batch.ReleaseSequence([E.KeyDown(Keys.VkLWin), E.KeyDown('D')]);
        Assert.Equal([E.KeyUp('D'), E.KeyDown(Keys.VkStartMenuMask), E.KeyUp(Keys.VkStartMenuMask), E.KeyUp(Keys.VkLWin)], ups);
    }

    [Fact]
    public void TracksUnicodeUnitsAndButtons()
    {
        E[] text = [E.UnitDown('h'), E.UnitUp('h'), E.UnitDown('i'), E.UnitUp('i')];
        Assert.Equal([E.UnitDown('i')], Batch.HeldAfter(text, 3));
        Assert.Equal([E.UnitUp('i')], Batch.ReleaseSequence(Batch.HeldAfter(text, 3)));

        E[] click = [E.Move(5, 6), E.ButtonDown(1, 5, 6), E.ButtonUp(1, 5, 6)];
        Assert.Equal([E.ButtonUp(1, 5, 6)], Batch.ReleaseSequence(Batch.HeldAfter(click, 2)));
    }

    [Fact]
    public void UnorderedSetsReleaseOrdinaryKeysFirstThenMetaShiftAltCtrl()
    {
        var pressed = Batch.AsPressed([Keys.VkLControl, (ushort)'A', Keys.VkLWin, Keys.VkLShift], [new HeldButton(0, 1, 2)]);
        var ups = Batch.ReleaseSequence(pressed);
        Assert.Equal(
        [
            E.KeyUp('A'), E.KeyDown(Keys.VkStartMenuMask), E.KeyUp(Keys.VkStartMenuMask), E.KeyUp(Keys.VkLWin),
            E.KeyUp(Keys.VkLShift), E.KeyUp(Keys.VkLControl), E.ButtonUp(0, 1, 2),
        ], ups);
    }
}
