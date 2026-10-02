// getAppState: the window's accessibility tree and / or its screenshot.

using System.Text.Json.Nodes;
using Windows.Win32;
using Windows.Win32.UI.Accessibility;
using WmuxComputerUse.Core;

namespace WmuxComputerUse;

internal static unsafe class Observe
{
    /// <summary>Inside the 15 s main allows getAppState, leaving room for the capture.</summary>
    private const int WalkBudgetMs = 7000;
    /// <summary>Chromium builds its tree after the first UIA query; one re-query after this long.</summary>
    private const int ChromiumSettleMs = 300;

    public static JsonObject GetAppState(Params p)
    {
        var mode = p.String("mode") ?? "both";
        if (mode is not ("ax" or "vision" or "both")) throw new HelperError("invalid_argument", "mode must be ax, vision or both");
        int maxNodes = Math.Clamp(p.Int("maxNodes") ?? Tree.MaxNodes, 1, Tree.MaxNodes);
        int maxDepth = Math.Clamp(p.Int("maxDepth") ?? Tree.MaxDepth, 1, Tree.MaxDepth);
        var (app, window) = Apps.ResolveTarget(p.RequireString("app"), p.String("window"));

        var snapshotId = Snapshots.NextId();
        var output = new JsonObject
        {
            ["snapshotId"] = snapshotId,
            ["app"] = app.Json(),
            ["window"] = window.Json(app),
        };
        var elements = new List<nint>();
        var runtimeIds = new List<int[]>();
        if (mode != "vision")
        {
            var walk = WalkWindow(window, maxNodes, maxDepth);
            elements = walk.Elements;
            runtimeIds = walk.RuntimeIds;
            var text = new List<string> { Tree.RenderHeader(app.Name, (int)app.Pid, window.Title) };
            text.AddRange(walk.Lines);
            var focus = FocusedIndex(runtimeIds);
            if (focus is int f) text.Add($"Focused: {f}");
            output["tree"] = string.Join("\n", text);
            output["elementCount"] = elements.Count;
            if (walk.Truncated) output["truncated"] = true;
        }

        if (mode == "ax")
        {
            output["screenshotStatus"] = new JsonObject { ["status"] = "skipped" };
        }
        else
        {
            try
            {
                output["screenshot"] = Capture.Window(window.Hwnd);
                output["screenshotStatus"] = new JsonObject { ["status"] = "captured" };
            }
            catch (HelperError e)
            {
                output["screenshotStatus"] = new JsonObject
                {
                    ["status"] = "failed",
                    ["error"] = new JsonObject { ["code"] = e.Code, ["message"] = e.Message },
                };
            }
        }

        Snapshots.Add(new Snapshot(snapshotId, app.Pid, window.Hwnd, elements, runtimeIds));
        return output;
    }

    private sealed record Walked(List<string> Lines, List<nint> Elements, List<int[]> RuntimeIds, bool Truncated);

    private static Walked WalkWindow(WindowEntry window, int maxNodes, int maxDepth)
    {
        bool chromium = window.ClassName.StartsWith("Chrome_WidgetWin", StringComparison.Ordinal);
        for (int attempt = 0; ; attempt++)
        {
            var source = new UiaTreeSource();
            try
            {
                IUIAutomationElement* root;
                try
                {
                    root = Uia.Automation->ElementFromHandleBuildCache(window.Hwnd, Uia.WalkCache);
                }
                catch (Exception e)
                {
                    if (Uia.IsGone(e.HResult)) throw new HelperError("window_not_found", "the window closed");
                    throw new HelperError(Uia.ErrorCode(e), $"could not read the window's accessibility tree: {Uia.Describe(e)}");
                }
                if (root == null) throw new HelperError("window_not_found", "the window has no accessibility element");
                var rootNode = source.Adopt(root);
                long deadline = Environment.TickCount64 + WalkBudgetMs;
                var result = Tree.Walk(source, [new WalkRoot<nint>(rootNode, 0, window.Bounds)], maxNodes, maxDepth,
                    () => Environment.TickCount64 >= deadline);
                if (chromium && attempt == 0 && source.SawEmptyDocument)
                {
                    // Chromium switches its accessibility tree on when a UIA
                    // client first asks; the content arrives a moment later.
                    Sta.Sleep(ChromiumSettleMs);
                    continue;
                }
                var ids = result.Elements.Select(e => Uia.CachedRuntimeId((IUIAutomationElement*)e)).ToList();
                source.Keep(result.Elements);
                return new Walked(result.Lines, result.Elements, ids, result.Truncated);
            }
            finally
            {
                source.Dispose();
            }
        }
    }

    /// <summary>The index of the focused element, matched on RuntimeId.</summary>
    private static int? FocusedIndex(List<int[]> runtimeIds)
    {
        var focused = Uia.Focused();
        if (focused == null) return null;
        try
        {
            var id = Uia.CurrentRuntimeId(focused);
            if (id.Length == 0) return null;
            for (int i = 0; i < runtimeIds.Count; i++)
            {
                if (runtimeIds[i].AsSpan().SequenceEqual(id)) return i;
            }
            return null;
        }
        catch (Exception)
        {
            return null;
        }
        finally
        {
            focused->Release();
        }
    }
}
