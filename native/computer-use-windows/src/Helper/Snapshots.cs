// Snapshot binding: indexes are valid only with the snapshotId they came from.
// The last 16 snapshots are kept for 2 minutes. Each holds one reference to
// every indexed element, released on eviction (on the STA thread, where the
// store lives).

using System.Security.Cryptography;
using Windows.Win32.Foundation;
using Windows.Win32.UI.Accessibility;
using WmuxComputerUse.Core;

namespace WmuxComputerUse;

internal sealed unsafe class Snapshot(string id, uint pid, HWND window, List<nint> elements, List<int[]> runtimeIds, List<bool> secret)
{
    public string Id { get; } = id;
    public uint Pid { get; } = pid;
    public HWND Window { get; } = window;
    public List<nint> Elements { get; } = elements;
    public List<int[]> RuntimeIds { get; } = runtimeIds;
    /// <summary>Elements the walk saw as secret fields (rendered as [redacted]).</summary>
    public List<bool> Secret { get; } = secret;
    public long Created { get; } = Environment.TickCount64;

    /// <summary>
    /// Re-resolves one indexed element and checks it is still the element the
    /// snapshot saw: the same RuntimeId, in the same process. The whole tree
    /// is not re-walked.
    /// </summary>
    public IUIAutomationElement* Element(int index)
    {
        if (index < 0 || index >= Elements.Count)
        {
            throw new HelperError("element_not_found", $"index {index} is not in snapshot {Id} (0…{Elements.Count - 1})");
        }
        var el = (IUIAutomationElement*)Elements[index];
        int[] now;
        int pid;
        try
        {
            now = Uia.CurrentRuntimeId(el);
            pid = el->CurrentProcessId;
        }
        catch (Exception e) when (Uia.IsGone(e.HResult))
        {
            throw new HelperError("element_stale", $"element {index} no longer exists");
        }
        if (pid != Pid || now.Length == 0 || !now.AsSpan().SequenceEqual(RuntimeIds[index]))
        {
            throw new HelperError("element_stale", $"element {index} changed since snapshot {Id} was taken");
        }
        return el;
    }

    /// <summary>The window's current frame (it may have moved since the snapshot).</summary>
    public Rect WindowFrame()
    {
        if (!Windows.Win32.PInvoke.IsWindow(Window)) throw new HelperError("window_not_found", "the snapshot's window is gone");
        return Win.Bounds(Window);
    }

    public void Release()
    {
        foreach (var p in Elements) Uia.Release(p);
        Elements.Clear();
    }
}

internal static class Snapshots
{
    public const int CacheSize = 16;
    public static readonly long TtlMs = 120_000;

    private static readonly List<Snapshot> Order = [];
    private static int counter;
    // Unique per helper process: a restarted helper must never re-issue an id
    // main still maps to the dead helper's elements.
    private static readonly string Prefix = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(4));

    public static string NextId() => $"{Prefix}-{++counter}";

    public static void Add(Snapshot snapshot)
    {
        Order.Add(snapshot);
        while (Order.Count > CacheSize)
        {
            Order[0].Release();
            Order.RemoveAt(0);
        }
        // Expired snapshots give their element references back early.
        foreach (var old in Order.Where(s => Environment.TickCount64 - s.Created > TtlMs).ToList())
        {
            old.Release();
            Order.Remove(old);
        }
    }

    public static Snapshot Get(string id)
    {
        var snap = Order.FirstOrDefault(s => s.Id == id);
        if (snap == null || Environment.TickCount64 - snap.Created > TtlMs)
        {
            throw new HelperError("snapshot_unknown", $"snapshot {id} is unknown or expired");
        }
        return snap;
    }
}
