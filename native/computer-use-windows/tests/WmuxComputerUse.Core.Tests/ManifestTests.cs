using System.Xml.Linq;

namespace WmuxComputerUse.Core.Tests;

/// <summary>
/// The helper is not a privilege boundary only while it runs as the invoking
/// user with no uiAccess; DPI awareness must come from the manifest so it
/// holds before the first instruction. Pinned here because nothing at runtime
/// would notice a manifest that drifted.
/// </summary>
public class ManifestTests
{
    private static XDocument Manifest()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "src", "Helper", "app.manifest"))) dir = dir.Parent;
        Assert.NotNull(dir);
        return XDocument.Load(Path.Combine(dir!.FullName, "src", "Helper", "app.manifest"));
    }

    [Fact]
    public void RunsAsInvokerWithoutUiAccess()
    {
        var level = Manifest().Descendants().Single(e => e.Name.LocalName == "requestedExecutionLevel");
        Assert.Equal("asInvoker", level.Attribute("level")?.Value);
        Assert.Equal("false", level.Attribute("uiAccess")?.Value);
    }

    [Fact]
    public void DeclaresPerMonitorV2()
    {
        var awareness = Manifest().Descendants().Single(e => e.Name.LocalName == "dpiAwareness");
        Assert.Equal("PerMonitorV2", awareness.Value.Trim());
    }

    [Fact]
    public void HelperProjectReferencesTheManifest()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "src", "Helper", "wmux-computer-use.csproj"))) dir = dir.Parent;
        var project = XDocument.Load(Path.Combine(dir!.FullName, "src", "Helper", "wmux-computer-use.csproj"));
        Assert.Equal("app.manifest", project.Descendants("ApplicationManifest").Single().Value);
        Assert.Equal("true", project.Descendants("PublishAot").Single().Value);
    }
}
