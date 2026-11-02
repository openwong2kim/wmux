using WmuxComputerUse.Core;

namespace WmuxComputerUse.Core.Tests;

public class EditSelectionTests
{
    [Fact]
    public void ReadsTheStartFromTheLowWordAndTheEndFromTheHighWord()
    {
        Assert.Equal((2u, 5u), EditSelection.Unpack((5u << 16) | 2u, 5));
        Assert.Equal((5u, 5u), EditSelection.Unpack((5u << 16) | 5u, 5));
        Assert.Equal((0u, 0u), EditSelection.Unpack(0, 0));
    }

    [Fact]
    public void TrustsNoAnswerForTextLongerThanTheWordsCanHold()
    {
        // A caret at 70,000 would come back cut to 16 bits as a wrong position.
        Assert.Null(EditSelection.Unpack((4464u << 16) | 4464u, 80_000));
        Assert.NotNull(EditSelection.Unpack((10u << 16) | 10u, EditSelection.MaxPackedLength));
    }

    [Fact]
    public void RefusesMinusOneAndPositionsOutsideTheText()
    {
        Assert.Null(EditSelection.Unpack(uint.MaxValue, 10));
        Assert.Null(EditSelection.Unpack((11u << 16) | 0u, 10));
        Assert.Null(EditSelection.Unpack((2u << 16) | 3u, 10));
    }
}
