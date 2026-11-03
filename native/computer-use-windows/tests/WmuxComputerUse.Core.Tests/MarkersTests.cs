using System.Text.Json.Nodes;
using WmuxComputerUse.Core;

namespace WmuxComputerUse.Core.Tests;

public class MarkersTests
{
    [Fact]
    public void ParsesHexColours()
    {
        Assert.Equal(new MarkerRgb(0x5A, 0xA2, 0xFF), AgentMarker.ParseColor("#5AA2FF"));
        Assert.Equal(AgentMarker.DefaultColor, AgentMarker.ParseColor("#ff8a3d"));
        foreach (var bad in new[] { "5AA2FF", "#5AA2F", "#5AA2FFF", "#GGGGGG", "#+1A2B3", "", null })
        {
            Assert.Null(AgentMarker.ParseColor(bad));
        }
    }

    [Fact]
    public void MarkerFromWire()
    {
        var m = AgentMarker.FromWire(JsonNode.Parse("""{"id":"a1","label":"  #api-1 · Claude Code ","color":"#2FD4C0"}"""));
        Assert.Equal(new AgentMarker("a1", "#api-1 · Claude Code", new MarkerRgb(0x2F, 0xD4, 0xC0)), m);
    }

    [Fact]
    public void MarkerFallsBackFieldByField()
    {
        // No marker, or no id: the default marker, as an older main gets.
        Assert.Same(AgentMarker.Fallback, AgentMarker.FromWire(null));
        Assert.Same(AgentMarker.Fallback, AgentMarker.FromWire(JsonNode.Parse("""{"label":"x","color":"#2FD4C0"}""")));
        Assert.Same(AgentMarker.Fallback, AgentMarker.FromWire(JsonNode.Parse("""{"id":""}""")));
        Assert.Same(AgentMarker.Fallback, AgentMarker.FromWire(JsonNode.Parse("\"a1\"")));
        Assert.Same(AgentMarker.Fallback, AgentMarker.FromWire(JsonNode.Parse("""{"id":7}""")));
        // A bad colour or label keeps the id.
        var m = AgentMarker.FromWire(JsonNode.Parse("""{"id":"a1","label":" \n ","color":"red"}"""));
        Assert.Equal(new AgentMarker("a1", AgentMarker.DefaultLabel, AgentMarker.DefaultColor), m);
    }

    [Fact]
    public void LabelIsOneLineOfAtMostSixtyCharacters()
    {
        Assert.Equal("a b c d", AgentMarker.Text("a\nb\t\u0007c   d"));
        Assert.Equal(AgentMarker.LabelMaxCharacters, AgentMarker.Text(new string('가', 80))!.Length);
        // A cut that ends on a space does not leave it at the end.
        Assert.Equal(new string('a', 59), AgentMarker.Text(new string('a', 59) + " bcd"));
        // A surrogate pair is one character and is never cut in half.
        var emoji = string.Concat(Enumerable.Repeat("😀", 70));
        Assert.Equal(string.Concat(Enumerable.Repeat("😀", 60)), AgentMarker.Text(emoji));
        // Bidi overrides and zero-width marks cannot reorder or hide the label.
        Assert.Equal("#api-1 evil", AgentMarker.Text("#api-1‮ evil​"));
        Assert.Equal("a b", AgentMarker.Text("a⁦b⁩"));
        Assert.Null(AgentMarker.Text("   "));
        Assert.Null(AgentMarker.Text(null));
    }

    [Fact]
    public void ChipLabelIsTheLabelUpToTheFirstSeparator()
    {
        Assert.Equal("#api-1", AgentMarker.ChipLabel("#api-1 · Claude Code"));
        Assert.Equal("web", AgentMarker.ChipLabel("web · Codex · extra"));
        Assert.Equal("wmux agent", AgentMarker.ChipLabel("wmux agent"));
        Assert.Equal(" · Codex", AgentMarker.ChipLabel(" · Codex"));
    }

    [Fact]
    public void Verbs()
    {
        Assert.Equal(" · typing", MarkerVerb.Typing.Text(false));
        Assert.Equal(" · clicking", MarkerVerb.Clicking.Text(false));
        Assert.Equal(" · setting value", MarkerVerb.SettingValue.Text(false));
        Assert.Equal(" · scrolling", MarkerVerb.Scrolling.Text(false));
        Assert.Equal(" · using your mouse", MarkerVerb.Clicking.Text(true));
        Assert.Equal(" · using your mouse", MarkerVerb.Scrolling.Text(true));
        Assert.Equal(" · using your keyboard", MarkerVerb.Typing.Text(true));
        Assert.Equal(" · using your keyboard", MarkerVerb.SettingValue.Text(true));
        Assert.Equal(" · waiting for #web-2", MarkerVerb.Waiting("#web-2").Text(true));
    }

    [Fact]
    public void HalosStackOutwardInArrivalOrder()
    {
        Assert.Equal(3, Markers.HaloOutset(0));
        // The second ring starts 3 px outside the first and is 3 px wide.
        Assert.Equal(9, Markers.HaloOutset(1));
        Assert.Equal(15, Markers.HaloOutset(2));
        var byWindow = Markers.ByWindow(
        [
            new("b", "7", 5),
            new("a", "7", 2),
            new("c", "9", 1),
            new("d", "7", 9),
        ]);
        Assert.Equal(2, byWindow.Count);
        Assert.Equal(["a", "b", "d"], byWindow["7"]);
        Assert.Equal(["c"], byWindow["9"]);
    }

    [Fact]
    public void RingsGoAroundTheWindow()
    {
        var window = new Rect(200, 300, 800, 600);
        var monitor = new Rect(0, 0, 1920, 1080);
        // The stroke's centre line: 1.5 px out for the first 3 px ring, 7.5 for the second.
        Assert.Equal(new Rect(198.5, 298.5, 803, 603), Markers.RingRect(window, 0, 1, monitor));
        Assert.Equal(new Rect(192.5, 292.5, 815, 615), Markers.RingRect(window, 1, 1, monitor));
        // At 200 % every length doubles.
        Assert.Equal(new Rect(197, 297, 806, 606), Markers.RingRect(window, 0, 2, monitor));
    }

    [Fact]
    public void RingsOfAMaximizedWindowStayOnItsMonitor()
    {
        // Maximized: the frame is the work area, the taskbar below it.
        var window = new Rect(1920, 0, 1920, 1040);
        var monitor = new Rect(1920, 0, 1920, 1080);
        Assert.Equal(new Rect(1921.5, 1.5, 1917, 1040), Markers.RingRect(window, 0, 1, monitor));
        // The second ring stays a ring and a gap inside the first.
        Assert.Equal(new Rect(1927.5, 7.5, 1905, 1040), Markers.RingRect(window, 1, 1, monitor));
        // A window that spans two monitors is not pulled in.
        var spanning = new Rect(1800, 100, 400, 300);
        Assert.Equal(new Rect(1798.5, 98.5, 403, 303), Markers.RingRect(spanning, 0, 1, monitor));
        Assert.Equal(new Rect(1798.5, 98.5, 403, 303), Markers.RingRect(spanning, 0, 1, null));
    }

    [Fact]
    public void PillsSitSideBySideThenWrapWithinTheWindow()
    {
        static string[] Place(double[] widths, double rowWidth) =>
            Markers.PillGrid(widths, 6, rowWidth).Select(p => $"{p.Row}:{p.X}").ToArray();
        Assert.Equal(["0:0", "0:106", "0:192"], Place([100, 80, 120], 400));
        // Too wide for one row over a 300 px window: the third pill starts a new row.
        Assert.Equal(["0:0", "0:106", "1:0"], Place([100, 80, 120], 300));
        // A pill wider than the window still gets its own row; nothing is dropped.
        Assert.Equal(["0:0", "1:0"], Place([420, 90], 300));
        Assert.Empty(Place([], 300));
    }

    [Fact]
    public void TwoLongPillsOverANarrowWindowStackUpwardAboveIt()
    {
        // A waiting pill is long: side by side they would run past the
        // window's right edge into the next window's pills.
        var window = new Rect(1000, 300, 300, 400);
        var at = Markers.PillLayout(window, [200, 250], outset: 9, pillHeight: 24, lift: 4, gap: 6, topLimit: 0);
        Assert.Equal([(991.0, 263.0), (991.0, 233.0)], at);
        // Wide enough: side by side, as before.
        var wide = Markers.PillLayout(new Rect(200, 300, 800, 600), [200, 250], 9, 24, 4, 6, 0);
        Assert.Equal([(191.0, 263.0), (397.0, 263.0)], wide);
    }

    [Fact]
    public void RowsThatDoNotFitAboveGoInsideStackedDownward()
    {
        // Room for one row above, not two: every row goes inside, 8 px in,
        // wrapped to the window's width less 16.
        var window = new Rect(0, 40, 300, 400);
        var at = Markers.PillLayout(window, [200, 250], outset: 9, pillHeight: 24, lift: 4, gap: 6, topLimit: 0);
        Assert.Equal([(8.0, 48.0), (8.0, 78.0)], at);
        Assert.Empty(Markers.PillLayout(window, [], 9, 24, 4, 6, 0));
    }

    [Fact]
    public void PillRowAboveTheWindowOrInsideBelowTheWorkAreaTop()
    {
        var window = new Rect(200, 300, 800, 600);
        // Above the outermost ring, aligned with its left edge.
        Assert.Equal((191.0, 263.0), Markers.PillRowOrigin(window, 9, 24, 4, 0));
        // A maximized window at the top of the work area: inside its top-left corner.
        var top = new Rect(0, 0, 800, 600);
        Assert.Equal((8.0, 8.0), Markers.PillRowOrigin(top, 3, 24, 4, 0));
        // Partly above the work area (a taskbar on top): still below it.
        var under = new Rect(0, 30, 800, 600);
        Assert.Equal((8.0, 56.0), Markers.PillRowOrigin(under, 3, 24, 4, 48));
        // Two rows fit above a window with room for them; not above one with room for only one.
        Assert.Equal((191.0, 263.0), Markers.PillRowOrigin(window, 9, 24, 4, 0, rows: 2, rowGap: 6));
        var tight = new Rect(0, 70, 800, 600);
        Assert.Equal((-3.0, 39.0), Markers.PillRowOrigin(tight, 3, 24, 4, 25));
        Assert.Equal((8.0, 78.0), Markers.PillRowOrigin(tight, 3, 24, 4, 25, rows: 2, rowGap: 6));
    }

    [Fact]
    public void AgentsBarText()
    {
        Assert.Equal("1 wmux agent is using apps", Markers.BarText(1));
        Assert.Equal("10 wmux agents are using apps", Markers.BarText(10));
        Assert.Equal("Stop all Ctrl+Alt+Shift+Esc", Markers.BarStopHint);
    }

    [Fact]
    public void CaretAtTheInsertionPoint()
    {
        var window = new Rect(100, 100, 600, 400);
        var line = new Rect(240, 180, 0, 16);
        Assert.Equal(new Rect(239, 180, 2, 16), Markers.CaretRect(line, null, window));
        // At 200 %: 2 px becomes 4, and a 32 px line is still a line.
        Assert.Equal(new Rect(238, 180, 4, 32), Markers.CaretRect(new Rect(240, 180, 0, 32), null, window, 2));
    }

    [Fact]
    public void CaretFallsBackToTheElementsLeadingEdge()
    {
        var window = new Rect(100, 100, 600, 400);
        var field = new Rect(120, 150, 300, 24);
        var expected = new Rect(126, 151, 2, 22);
        // No answer, a zero-height answer, (0,0) off the window, a non-finite answer.
        foreach (Rect? bad in new Rect?[] { null, new Rect(240, 180, 0, 0), new Rect(0, 0, 0, 16), new Rect(double.NaN, 180, 0, 16) })
        {
            Assert.Equal(expected, Markers.CaretRect(bad, field, window));
        }
        // A text area: its first line, not its middle.
        var area = new Rect(120, 150, 300, 200);
        Assert.Equal(new Rect(126, 156, 2, 22), Markers.CaretRect(null, area, window));
        Assert.Null(Markers.CaretRect(null, null, window));
        Assert.Null(Markers.CaretRect(null, new Rect(0, 0, 0, 0), window));
    }
}
