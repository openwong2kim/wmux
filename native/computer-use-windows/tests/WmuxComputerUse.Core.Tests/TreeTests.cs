using WmuxComputerUse.Core;

namespace WmuxComputerUse.Core.Tests;

/// <summary>A tree built in memory, standing in for cached UIA elements.</summary>
public sealed class FakeNode(NodeInfo? info, params FakeNode[] children)
{
    public NodeInfo? Info { get; } = info;
    public FakeNode[] Children { get; } = children;
}

public sealed class FakeSource : ITreeSource<FakeNode>
{
    public NodeInfo? Info(FakeNode node) => node.Info;
    public List<int> Limits { get; } = [];
    public IReadOnlyList<FakeNode> Children(FakeNode node, NodeInfo info, int limit)
    {
        Limits.Add(limit);
        return node.Children.Take(limit).ToList();
    }
}

public class TreeTests
{
    private static FakeNode N(string role, string? name = null, string? value = null, Rect? frame = null,
        bool actions = false, bool password = false, bool offscreen = false, params FakeNode[] children) =>
        new(new NodeInfo { Role = role, Name = name, Value = value, Frame = frame, HasActions = actions, IsPassword = password, IsOffscreen = offscreen }, children);

    private static WalkResult<FakeNode> Walk(FakeNode root, Rect? clip = null, int maxNodes = 800, int maxDepth = 40) =>
        Tree.Walk(new FakeSource(), [new WalkRoot<FakeNode>(root, 0, clip)], maxNodes, maxDepth);

    [Fact]
    public void RendersTheDesignDocShape()
    {
        var window = N("Window", "notes.txt - Notepad", children:
        [
            N("MenuBar", children: [N("MenuItem", "File")]),
            N("Pane", children: // unnamed structural pane: dropped, children kept
            [
                N("Document", "Text editor", value: "hello world"),
            ]),
            N("Button", "Close"),
        ]);
        var result = Walk(window);
        var text = string.Join("\n",
            new[] { Tree.RenderHeader("Notepad", 4812, "notes.txt - Notepad") }.Concat(result.Lines).Append("Focused: 3"));
        Assert.Equal(
            "App: Notepad (pid 4812) · Window: \"notes.txt - Notepad\"\n" +
            "0 window notes.txt - Notepad\n" +
            "\t1 menu bar\n" +
            "\t\t2 menu item File\n" +
            "\t3 document Text editor, Value: hello world\n" +
            "\t4 button Close\n" +
            "Focused: 3",
            text);
        Assert.False(result.Truncated);
        Assert.Equal(5, result.Elements.Count);
    }

    [Fact]
    public void HumanizesControlTypes()
    {
        Assert.Equal("split button", Tree.HumanizeRole("SplitButton"));
        Assert.Equal("menu item", Tree.HumanizeRole("MenuItem"));
        Assert.Equal("edit", Tree.HumanizeRole("Edit"));
        Assert.Equal("Edit", ControlTypes.Name(50004));
        Assert.Equal("Window", ControlTypes.Name(50032));
        Assert.Equal("AppBar", ControlTypes.Name(50040));
        Assert.Equal("Custom", ControlTypes.Name(12));
    }

    [Fact]
    public void LineFieldsAndStates()
    {
        var info = new NodeInfo { Role = "CheckBox", Name = "Wrap lines", Description = "Wraps long lines", Value = "1", Enabled = false, Selected = true };
        Assert.Equal("7 check box Wrap lines, Value: 1, Description: Wraps long lines, State: disabled selected", Tree.RenderLine(7, info));
        // A value equal to the name is not repeated; text uses its value only without a name.
        Assert.Equal("1 edit Search", Tree.RenderLine(1, new NodeInfo { Role = "Edit", Name = "Search", Value = "Search" }));
        Assert.Equal("2 text Saved", Tree.RenderLine(2, new NodeInfo { Role = "Text", Value = "Saved" }));
        Assert.Equal("3 tree item src, State: expanded", Tree.RenderLine(3, new NodeInfo { Role = "TreeItem", Name = "src", Expanded = true }));
    }

    [Fact]
    public void RedactsPasswordFields()
    {
        Assert.Equal("0 edit, Value: [redacted]", Tree.RenderLine(0, new NodeInfo { Role = "Edit", Value = "hunter2", IsPassword = true }));
        Assert.Equal("1 edit Enter PIN, Value: [redacted]", Tree.RenderLine(1, new NodeInfo { Role = "Edit", Name = "Enter PIN", Value = "1234" }));
        Assert.Equal("2 edit 비밀번호, Value: [redacted]", Tree.RenderLine(2, new NodeInfo { Role = "Edit", Name = "비밀번호", Value = "x" }));
        Assert.True(Tree.IsSensitive(false, "One-time code"));
        Assert.True(Tree.IsSensitive(false, "Mot de passe"));
        Assert.False(Tree.IsSensitive(false, "Spinning wheel")); // no word "pin"
        Assert.False(Tree.IsSensitive(false, "Shipping address"));
    }

    [Fact]
    public void RedactsSecretLookingStaticText()
    {
        Assert.Equal("0 text [redacted]", Tree.RenderLine(0, new NodeInfo { Role = "Text", Name = "Your one-time code is 482913" }));
        Assert.Equal("1 text [redacted]", Tree.RenderLine(1, new NodeInfo { Role = "Text", Value = "인증번호 482913" }));
        Assert.Equal("2 text Saved", Tree.RenderLine(2, new NodeInfo { Role = "Text", Name = "Saved" }));
    }

    [Fact]
    public void ACutChildListIsTruncatedEvenWhenItsChildrenWereSkipped()
    {
        var rows = Enumerable.Range(0, 5).Select(i => N("ListItem", $"hidden {i}", offscreen: true))
            .Concat([N("ListItem", "visible")]).ToArray();
        var root = N("Window", "w", children: [N("List", children: rows)]);
        // Budget 3: the root and the list are indexed, so the list's children
        // are asked for with limit 2 and both come back off-screen.
        var result = Walk(root, maxNodes: 3);
        Assert.Equal(["0 window w", "\t1 list"], result.Lines);
        Assert.True(result.Truncated);
    }

    [Fact]
    public void AsksForNoMoreChildrenThanTheBudget()
    {
        var source = new FakeSource();
        var root = N("Window", "w", children: Enumerable.Range(0, 50).Select(i => N("Button", $"b{i}")).ToArray());
        var result = Tree.Walk(source, [new WalkRoot<FakeNode>(root, 0, null)], 10, 40);
        Assert.Equal(10, source.Limits[0]);
        Assert.Equal(10, result.Elements.Count);
        Assert.True(result.Truncated);
    }

    [Fact]
    public void PreviewCollapsesWhitespaceAndCapsGraphemes()
    {
        Assert.Equal("a b c", Tree.Preview("  a\n\tb   c  "));
        var longText = new string('x', 130);
        Assert.Equal(new string('x', 120) + "…", Tree.Preview(longText));
        // 121 family emoji: the cap counts graphemes, never cutting one in half.
        var family = "👨‍👩‍👧";
        var p = Tree.Preview(string.Concat(Enumerable.Repeat(family, 121)));
        Assert.Equal(string.Concat(Enumerable.Repeat(family, 120)) + "…", p);
    }

    [Fact]
    public void PrunesStructuralNodesButKeepsNamedAndActionable()
    {
        var root = N("Window", "w", children:
        [
            N("Group"),                              // dropped
            N("Group", "Toolbar group"),             // kept: named
            N("Custom", actions: true),              // kept: has a pattern
            N("Image"),                              // dropped: unnamed image
            N("Text"),                               // dropped: no text
            N("Text", "Ready"),                      // kept
        ]);
        var lines = Walk(root).Lines;
        Assert.Equal(["0 window w", "\t1 group Toolbar group", "\t2 custom", "\t3 text Ready"], lines);
    }

    [Fact]
    public void SkipsSubtreesOutsideTheWindowAndOffscreenRows()
    {
        var clip = new Rect(0, 0, 100, 100);
        var root = N("Window", "w", frame: clip, children:
        [
            N("Button", "inside", frame: new Rect(10, 10, 20, 20)),
            N("Button", "outside", frame: new Rect(500, 500, 20, 20), children: [N("Button", "child")]),
            N("List", children:
            [
                N("ListItem", "visible row", frame: new Rect(0, 50, 100, 10)),
                N("ListItem", "scrolled away", frame: new Rect(0, 50, 100, 10), offscreen: true),
            ]),
        ]);
        var lines = Walk(root, clip).Lines;
        Assert.Equal(["0 window w", "\t1 button inside", "\t2 list", "\t\t3 list item visible row"], lines);
    }

    [Fact]
    public void CapsNodesAndDepth()
    {
        var many = N("Window", "w", children: Enumerable.Range(0, 20).Select(i => N("Button", $"b{i}")).ToArray());
        var capped = Walk(many, maxNodes: 5);
        Assert.Equal(5, capped.Elements.Count);
        Assert.True(capped.Truncated);

        var deep = N("Button", "leaf");
        for (int i = 0; i < 10; i++) deep = N("Group", children: [deep]);
        var shallow = Walk(N("Window", "w", children: [deep]), maxDepth: 5);
        Assert.True(shallow.Truncated);
        Assert.Single(shallow.Elements);
    }

    [Fact]
    public void DeadlineTruncates()
    {
        var root = N("Window", "w", children: [N("Button", "a"), N("Button", "b")]);
        int calls = 0;
        var result = Tree.Walk(new FakeSource(), [new WalkRoot<FakeNode>(root, 0, null)], 800, 40, () => ++calls > 2);
        Assert.True(result.Truncated);
        Assert.Equal(2, result.Elements.Count);
    }
}
