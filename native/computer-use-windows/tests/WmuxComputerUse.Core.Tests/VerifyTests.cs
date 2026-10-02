using WmuxComputerUse.Core;

namespace WmuxComputerUse.Core.Tests;

public class VerifyTests
{
    [Fact]
    public void InsertionAnywhereVerifies()
    {
        Assert.True(Verify.Inserted("", "abc", "abc"));
        Assert.True(Verify.Inserted("hello world", "hello abcworld", "abc"));
        Assert.True(Verify.Inserted("xyz", "xyzabc", "abc"));
        Assert.True(Verify.Inserted("xyz", "abcxyz", "abc"));
    }

    [Fact]
    public void TextThatWasAlreadyThereDoesNotVerifyAMissedInsert()
    {
        // "abc" typed three times, one landed: the value contains "abc" but
        // did not grow by the second attempt.
        Assert.False(Verify.Inserted("abc", "abc", "abc"));
        Assert.False(Verify.Inserted("abcabc", "abcabc", "abc"));
        Assert.True(Verify.Inserted("abc", "abcabc", "abc"));
    }

    [Fact]
    public void RepeatedRunsFindTheRightGap()
    {
        Assert.True(Verify.Inserted("aaaa", "aaaaaa", "aa"));
        Assert.True(Verify.Inserted("abab", "ababab", "ab"));
        Assert.False(Verify.Inserted("abab", "abXbab", "ab"));
    }

    [Fact]
    public void SelectionReplacementAndEditsAreUnverified()
    {
        Assert.False(Verify.Inserted("hello world", "hello abc", "abc"));
        Assert.False(Verify.Inserted("x", "xab", "abc"));
        Assert.False(Verify.Inserted(null, "abc", "abc"));
        Assert.False(Verify.Inserted("abc", null, "abc"));
    }

    [Fact]
    public void NewlinesCompareAcrossConventions()
    {
        Assert.True(Verify.Inserted("a\r\nb", "a\r\nX\r\nb", "X\n"));
        Assert.True(Verify.Inserted("a\rb", "a\rline\rb", "line\n"));
    }
}
