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

    [Fact]
    public void SetValueComparesLineBreaksNormalized()
    {
        // Notepad's rich edit reads `a\nb` back as `a\rb`.
        Assert.True(Verify.SameValue("a\nb", "a\rb"));
        Assert.True(Verify.SameValue("a\nb\nc", "a\r\nb\rc"));
        Assert.True(Verify.SameValue("same", "same"));
        Assert.False(Verify.SameValue("a\n", "a"));
        Assert.False(Verify.SameValue("a", "a\r"));
        Assert.False(Verify.SameValue("", "\r"));
        Assert.False(Verify.SameValue("a\nb", "a\nc"));
        Assert.False(Verify.SameValue("x", null));
    }

    /// <summary>A fake clock: each sleep advances it.</summary>
    private sealed class Clock
    {
        public long Now;
        public void Sleep(int ms) => Now += ms;
    }

    [Fact]
    public void SettleStopsAtTheBaseWaitWhenTheValueIsStill()
    {
        var c = new Clock();
        var r = Verify.Settle(() => "old", v => v == "new", 300, 2000, () => c.Now, c.Sleep);
        Assert.False(r.Verified);
        Assert.Equal("old", r.Last);
        Assert.InRange(c.Now, 300, 300 + 15);
    }

    [Fact]
    public void SettleKeepsReadingWhileTheValueIsStillChanging()
    {
        // Keys still landing: the value grows every 30 ms until 900 ms, then matches.
        var c = new Clock();
        string Read() => c.Now >= 900 ? "done" : new string('x', (int)(c.Now / 30));
        var r = Verify.Settle(Read, v => v == "done", 300, 2000, () => c.Now, c.Sleep);
        Assert.True(r.Verified);
        Assert.InRange(c.Now, 900, 900 + 15);
    }

    [Fact]
    public void SettleNeverPassesTheHardCap()
    {
        var c = new Clock();
        var r = Verify.Settle(() => c.Now.ToString(System.Globalization.CultureInfo.InvariantCulture), _ => false, 300, 2000, () => c.Now, c.Sleep);
        Assert.False(r.Verified);
        Assert.InRange(c.Now, 2300, 2300 + 15);
    }

    [Fact]
    public void SettleVerifiesAtOnceWhenTheFirstReadMatches()
    {
        var c = new Clock();
        var r = Verify.Settle(() => "ok", v => v == "ok", 300, 2000, () => c.Now, c.Sleep);
        Assert.True(r.Verified);
        Assert.Equal(0, c.Now);
    }

    [Fact]
    public void ObservedShowsWhereTheTextWentWrong()
    {
        // "Agent-A line 5" typed at the end of Notepad's text, arrived reordered.
        var before = "Agent-A line 1\rAgent-A line 2\rAgent-A line 3\rAgent-A line 4\r";
        var observed = Verify.Observed(before, before + "AgentA- line 5", secret: false);
        Assert.NotNull(observed);
        Assert.StartsWith("…", observed);
        Assert.EndsWith("Agent-A line 4 AgentA- line 5", observed);
        Assert.True(observed!.Length <= Tree.TextPreviewChars);
    }

    [Fact]
    public void ObservedStartsAtTheTopWhenTheDifferenceIsNearIt()
    {
        Assert.Equal("Xhello world", Verify.Observed("hello world", "Xhello world", secret: false));
        Assert.Equal("a b", Verify.Observed(null, "a\r\nb", secret: false));
    }

    [Fact]
    public void ObservedIsCappedAndMasked()
    {
        // At most Tree.TextPreviewChars, ellipses included, from the top or from mid-text.
        var fromTop = Verify.Observed("", new string('y', 500), secret: false)!;
        Assert.Equal(Tree.TextPreviewChars, fromTop.Length);
        Assert.EndsWith("…", fromTop);
        var midText = Verify.Observed(new string('y', 200), new string('y', 200) + new string('z', 300), secret: false)!;
        Assert.Equal(Tree.TextPreviewChars, midText.Length);
        Assert.StartsWith("…", midText);
        Assert.Equal("[redacted]", Verify.Observed("", "hunter2", secret: true));
        // Nothing read: left out, even for a secret field.
        Assert.Null(Verify.Observed("x", null, secret: false));
        Assert.Null(Verify.Observed("x", null, secret: true));
    }

    [Fact]
    public void ObservedNeverReportsAFieldOfWhitespaceAsEmpty()
    {
        // Only blank lines from the excerpt's start: the field is shown from the top.
        var before = "title" + new string('\r', 60);
        Assert.Equal("title", Verify.Observed(before, before + "\r", secret: false));
    }

    [Fact]
    public void SettleInsertedNeedsAValueBefore()
    {
        var c = new Clock();
        int reads = 0;
        var r = Verify.SettleInserted(() => { reads++; return "ab"; }, null, "b", 300, () => c.Now, c.Sleep);
        Assert.False(r.Verified);
        Assert.Null(r.Last);
        Assert.Equal(0, reads);
        Assert.True(Verify.SettleInserted(() => "ab", "a", "b", 300, () => c.Now, c.Sleep).Verified);
    }

    [Fact]
    public void ObservedNeverStartsInsideASurrogatePair()
    {
        var before = new string('a', 60);
        var after = new string('a', 39) + "😀" + new string('a', 19) + "Z";
        var observed = Verify.Observed(before, after, secret: false)!;
        Assert.False(char.IsLowSurrogate(observed[1]));
    }
}
