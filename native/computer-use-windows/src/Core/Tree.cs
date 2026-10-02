// Accessibility-tree walking, pruning and rendering, independent of UIA itself.
//
// The helper adapts cached IUIAutomationElements to `ITreeSource<T>`; tests use
// a fake source. The text format is the one in docs/computer-use-design.md
// ("Observation") and matches the macOS helper line for line:
//
//   App: Notepad (pid 4812) · Window: "notes.txt - Notepad"
//   0 window notes.txt - Notepad
//   	1 menu bar Application
//   		2 menu item File
//   	3 document Text editor, Value: hello world
//   Focused: 3

using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace WmuxComputerUse.Core;

public readonly record struct Rect(double X, double Y, double Width, double Height)
{
    public double Right => X + Width;
    public double Bottom => Y + Height;
    public bool IsEmpty => !(Width > 0) || !(Height > 0);

    public bool Intersects(Rect other) =>
        !IsEmpty && !other.IsEmpty && X < other.Right && other.X < Right && Y < other.Bottom && other.Y < Bottom;

    public Rect Intersection(Rect other)
    {
        double x = Math.Max(X, other.X), y = Math.Max(Y, other.Y);
        double r = Math.Min(Right, other.Right), b = Math.Min(Bottom, other.Bottom);
        return r > x && b > y ? new Rect(x, y, r - x, b - y) : new Rect(x, y, 0, 0);
    }
}

/// <summary>The properties one element contributes to the tree, read from one UIA cache.</summary>
public sealed record NodeInfo
{
    /// <summary>UIA control type name (`Button`, `Edit`, `MenuItem`…), see <see cref="ControlTypes"/>.</summary>
    public required string Role { get; init; }
    public string? Name { get; init; }
    public string? Value { get; init; }
    public string? Description { get; init; }
    public string? AutomationId { get; init; }
    /// <summary>The UI framework's class name (`Edit`, `PasswordBox`…).</summary>
    public string? ClassName { get; init; }
    public bool Enabled { get; init; } = true;
    public bool Selected { get; init; }
    public bool Expanded { get; init; }
    public bool IsPassword { get; init; }
    public bool IsOffscreen { get; init; }
    /// <summary>Invoke, Toggle, Value, ExpandCollapse or SelectionItem is available.</summary>
    public bool HasActions { get; init; }
    /// <summary>Screen rectangle in physical pixels, when the element reports one.</summary>
    public Rect? Frame { get; init; }
}

public interface ITreeSource<TNode>
{
    /// <summary>null when the element is gone; the walker skips it.</summary>
    NodeInfo? Info(TNode node);
    /// <summary>
    /// At most `limit` children (the walker's remaining node budget plus one,
    /// so a cut list still shows up as truncated). A child
    /// count comes from the target app, so it is never trusted as a size.
    /// </summary>
    IReadOnlyList<TNode> Children(TNode node, NodeInfo info, int limit);
}

public readonly record struct WalkRoot<TNode>(TNode Node, int Depth, Rect? Clip);

public readonly record struct WalkResult<TNode>(List<string> Lines, List<TNode> Elements, bool Truncated);

/// <summary>UIA control type ids (UIA_*ControlTypeId) and their names.</summary>
public static class ControlTypes
{
    private static readonly string[] Names =
    [
        "Button", "Calendar", "CheckBox", "ComboBox", "Edit", "Hyperlink", "Image", "ListItem", "List",
        "Menu", "MenuBar", "MenuItem", "ProgressBar", "RadioButton", "ScrollBar", "Slider", "Spinner",
        "StatusBar", "Tab", "TabItem", "Text", "ToolBar", "ToolTip", "Tree", "TreeItem", "Custom", "Group",
        "Thumb", "DataGrid", "DataItem", "Document", "SplitButton", "Window", "Pane", "Header", "HeaderItem",
        "Table", "TitleBar", "Separator", "SemanticZoom", "AppBar",
    ];

    public const int First = 50000;

    /// <summary>`Edit` for 50004; `Custom` for an id outside the table.</summary>
    public static string Name(int id) => id >= First && id - First < Names.Length ? Names[id - First] : "Custom";
}

public static class Tree
{
    public const int TextPreviewChars = 120;
    public const int MaxNodes = 800;
    public const int MaxDepth = 40;

    // Containers that orient the reader even without a name.
    private static readonly HashSet<string> LandmarkRoles =
    [
        "Window", "MenuBar", "Menu", "ToolBar", "Tab", "List", "Tree", "Table", "DataGrid", "AppBar",
    ];

    // The usual UIA interactive set.
    private static readonly HashSet<string> InteractiveRoles =
    [
        "Button", "CheckBox", "ComboBox", "Edit", "Hyperlink", "ListItem", "MenuItem", "RadioButton",
        "Slider", "Spinner", "SplitButton", "TabItem", "TreeItem", "DataItem", "Document", "HeaderItem",
        "Calendar",
    ];

    // Rows of a list, tree or grid: one the app reports as off-screen is
    // skipped (a 10 000-row list would otherwise eat the node budget).
    private static readonly HashSet<string> RowRoles = ["ListItem", "TreeItem", "DataItem"];

    private enum Keep { Always, IfText, IfNamed, IfNamedOrActionable }

    private static Keep KeepRule(string role) =>
        LandmarkRoles.Contains(role) || InteractiveRoles.Contains(role) ? Keep.Always
        : role == "Text" ? Keep.IfText
        : role == "Image" ? Keep.IfNamed
        : Keep.IfNamedOrActionable;

    /// <summary>Collapses whitespace (one line per element) and caps the preview length in graphemes.</summary>
    public static string Preview(string? text, int limit = TextPreviewChars)
    {
        if (string.IsNullOrEmpty(text)) return "";
        var sb = new StringBuilder(Math.Min(text.Length, limit * 2 + 8));
        bool space = false;
        foreach (var ch in text)
        {
            if (char.IsWhiteSpace(ch))
            {
                space = sb.Length > 0;
                continue;
            }
            if (space) sb.Append(' ');
            space = false;
            sb.Append(ch);
        }
        var collapsed = sb.ToString();
        var info = new StringInfo(collapsed);
        if (info.LengthInTextElements <= limit) return collapsed;
        return info.SubstringByTextElements(0, limit) + "…";
    }

    /// <summary>`SplitButton` → `split button`, `MenuItem` → `menu item`.</summary>
    public static string HumanizeRole(string role)
    {
        var sb = new StringBuilder(role.Length + 4);
        for (int i = 0; i < role.Length; i++)
        {
            var ch = role[i];
            if (char.IsUpper(ch) && i > 0) sb.Append(' ');
            sb.Append(char.ToLowerInvariant(ch));
        }
        return sb.ToString();
    }

    private static readonly Regex SensitiveNamePattern = new(
        @"\b(password|passcode|passphrase|pin|one[- ]time|otp|verification code|security code)\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    // Labels in other languages, matched as substrings (no word boundaries in
    // CJK). Korean, Japanese, Chinese, German, French, Spanish, Portuguese,
    // Italian, Russian. The same list as the macOS helper.
    private static readonly string[] SensitiveNameFragments =
    [
        "비밀번호", "암호", "인증번호", "パスワード", "暗証番号", "密码", "密碼", "口令", "验证码",
        "passwort", "kennwort", "mot de passe", "contraseña", "senha", "password", "пароль",
    ];

    /// <summary>A field whose value must never reach the model: UIA IsPassword, or a name that says it holds a secret.</summary>
    public static bool IsSensitive(bool isPassword, string? name)
    {
        if (isPassword) return true;
        if (string.IsNullOrEmpty(name)) return false;
        if (SensitiveNamePattern.IsMatch(name)) return true;
        var lower = name.ToLowerInvariant();
        foreach (var fragment in SensitiveNameFragments)
        {
            if (lower.Contains(fragment, StringComparison.Ordinal)) return true;
        }
        return false;
    }

    /// <summary>
    /// A developer-chosen identifier (AutomationId, class name) that says the
    /// field holds a secret: `txtPassword`, `PasswordBox`, `pwdField`. Matched
    /// as substrings, since identifiers have no word boundaries.
    /// </summary>
    public static bool IsSensitiveIdentifier(string? identifier)
    {
        if (string.IsNullOrEmpty(identifier)) return false;
        var lower = identifier.ToLowerInvariant();
        return lower.Contains("password", StringComparison.Ordinal) || lower.Contains("passwd", StringComparison.Ordinal)
            || lower.Contains("passcode", StringComparison.Ordinal) || lower.Contains("pwd", StringComparison.Ordinal)
            || lower.Contains("pincode", StringComparison.Ordinal);
    }

    /// <summary>Everything that marks an element as a secret field, for the tree and for refusing input.</summary>
    public static bool IsSecretField(NodeInfo info, string? name) =>
        IsSensitive(info.IsPassword, name) || IsSensitiveIdentifier(info.AutomationId) || IsSensitiveIdentifier(info.ClassName);

    /// <summary>
    /// One rendered line, without indentation:
    /// `&lt;index&gt; &lt;role&gt; &lt;name&gt;[, Value: …][, Description: …][, State: a b]`.
    /// </summary>
    public static string RenderLine(int index, NodeInfo info)
    {
        var role = HumanizeRole(info.Role);
        var name = Preview(info.Name);
        string? value = null;
        string? description = null;
        if (info.Role == "Text")
        {
            // Static text carries its text as its name; a value that only
            // repeats it is noise. Text that reads like a secret (a one-time
            // code shown on screen) is redacted like a password field.
            if (name.Length == 0) name = Preview(info.Value);
            if (IsSecretField(info, name)) name = "[redacted]";
        }
        else if (IsSecretField(info, name))
        {
            value = "[redacted]";
        }
        else
        {
            var v = Preview(info.Value);
            if (v.Length > 0 && v != name) value = v;
        }
        var desc = Preview(info.Description);
        if (desc.Length > 0 && desc != name) description = desc;

        var line = new StringBuilder();
        line.Append(index.ToString(CultureInfo.InvariantCulture)).Append(' ').Append(role);
        if (name.Length > 0) line.Append(' ').Append(name);
        if (value != null) line.Append(", Value: ").Append(value);
        if (description != null) line.Append(", Description: ").Append(description);
        var states = new List<string>(3);
        if (!info.Enabled) states.Add("disabled");
        if (info.Selected) states.Add("selected");
        if (info.Expanded) states.Add("expanded");
        if (states.Count > 0) line.Append(", State: ").Append(string.Join(' ', states));
        return line.ToString();
    }

    public static string RenderHeader(string appName, int pid, string windowTitle) =>
        $"App: {Preview(appName)} (pid {pid.ToString(CultureInfo.InvariantCulture)}) · Window: \"{Preview(windowTitle)}\"";

    /// <summary>
    /// Walks `roots` depth-first and renders every kept element with an index.
    /// Pruned (structural) nodes get no index, but their children are kept one
    /// level up. A subtree whose frame lies wholly outside its root's clip is
    /// skipped, and so is a row the app reports as off-screen. `maxNodes` caps
    /// indexed elements, `maxDepth` the raw UIA depth; hitting either, or the
    /// deadline, sets `Truncated`.
    /// </summary>
    public static WalkResult<TNode> Walk<TNode>(
        ITreeSource<TNode> source,
        IReadOnlyList<WalkRoot<TNode>> roots,
        int maxNodes,
        int maxDepth,
        Func<bool>? pastDeadline = null)
    {
        var lines = new List<string>();
        var elements = new List<TNode>();
        bool truncated = false;

        void Visit(TNode node, int rawDepth, int depth, Rect? clip, bool isRoot)
        {
            if (elements.Count >= maxNodes || rawDepth > maxDepth)
            {
                truncated = true;
                return;
            }
            if (pastDeadline != null && pastDeadline())
            {
                truncated = true;
                return;
            }
            var info = source.Info(node);
            if (info == null) return;
            if (!isRoot)
            {
                if (clip is Rect c && info.Frame is Rect f && !f.IsEmpty && !f.Intersects(c)) return;
                if (info.IsOffscreen && RowRoles.Contains(info.Role)) return;
            }
            bool keep = KeepRule(info.Role) switch
            {
                Keep.Always => true,
                Keep.IfText => !string.IsNullOrEmpty(info.Name) || !string.IsNullOrEmpty(info.Value),
                Keep.IfNamed => !string.IsNullOrEmpty(info.Name) || !string.IsNullOrEmpty(info.Description),
                _ => !string.IsNullOrEmpty(info.Name) || !string.IsNullOrEmpty(info.Value) || info.HasActions,
            };
            int childDepth = depth;
            if (keep)
            {
                int index = elements.Count;
                elements.Add(node);
                lines.Add(new string('\t', depth) + RenderLine(index, info));
                childDepth = depth + 1;
            }
            int limit = Math.Max(0, maxNodes - elements.Count) + 1;
            var children = source.Children(node, info, limit);
            // A list that reached the limit may have been cut, even if what
            // came back was pruned or skipped and never filled the budget.
            if (children.Count >= limit) truncated = true;
            foreach (var child in children)
            {
                Visit(child, rawDepth + 1, childDepth, clip, false);
                if (truncated && elements.Count >= maxNodes) return;
            }
        }

        foreach (var root in roots)
        {
            Visit(root.Node, 0, root.Depth, root.Clip, true);
        }
        return new WalkResult<TNode>(lines, elements, truncated);
    }
}
