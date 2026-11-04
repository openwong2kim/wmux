using WmuxComputerUse.Core;

namespace WmuxComputerUse.Core.Tests;

public class OwnershipTests
{
    private const nint Target = 100;
    private const uint Pid = 7;

    /// <summary>A small window table: handle → (owner, pid).</summary>
    private static (Func<nint, nint> Owner, Func<nint, uint> PidOf) Windows(params (nint Hwnd, nint Owner, uint Pid)[] rows)
    {
        var table = rows.ToDictionary(r => r.Hwnd);
        return (h => table.TryGetValue(h, out var r) ? r.Owner : 0, h => table.TryGetValue(h, out var r) ? r.Pid : 0);
    }

    [Fact]
    public void TheTargetWindowItselfCounts()
    {
        var (owner, pid) = Windows((Target, 0, Pid));
        Assert.True(Ownership.InTargetWindow(Target, Target, Pid, owner, pid));
    }

    [Fact]
    public void APopupTheTargetOwnsCounts()
    {
        // Notepad's File menu: a PopupWindowSiteBridge window owned by the Notepad window.
        var (owner, pid) = Windows((Target, 0, Pid), (200, Target, Pid));
        Assert.True(Ownership.InTargetWindow(200, Target, Pid, owner, pid));
    }

    [Fact]
    public void ASubmenuOwnedThroughAnotherPopupCounts()
    {
        var (owner, pid) = Windows((Target, 0, Pid), (200, Target, Pid), (300, 200, Pid));
        Assert.True(Ownership.InTargetWindow(300, Target, Pid, owner, pid));
    }

    [Fact]
    public void AnOwnedWindowOfAnotherProcessIsRefused()
    {
        var (owner, pid) = Windows((Target, 0, Pid), (200, Target, Pid + 1));
        Assert.False(Ownership.InTargetWindow(200, Target, Pid, owner, pid));
    }

    [Fact]
    public void AnotherWindowOfTheSameAppIsRefused()
    {
        // A second Notepad window: same process, not owned by the target.
        var (owner, pid) = Windows((Target, 0, Pid), (400, 0, Pid));
        Assert.False(Ownership.InTargetWindow(400, Target, Pid, owner, pid));
    }

    [Fact]
    public void TheOwnerWalkIsBounded()
    {
        // An owner cycle that never reaches the target ends after MaxOwnerSteps.
        var (owner, pid) = Windows((Target, 0, Pid), (500, 501, Pid), (501, 500, Pid));
        Assert.False(Ownership.InTargetWindow(500, Target, Pid, owner, pid));
        // A chain longer than the bound is refused even if it would reach the target.
        var rows = new List<(nint, nint, uint)> { (Target, 0, Pid) };
        for (int i = 0; i <= Ownership.MaxOwnerSteps; i++) rows.Add((1000 + i, i == 0 ? Target : 1000 + i - 1, Pid));
        var (o2, p2) = Windows(rows.ToArray());
        Assert.False(Ownership.InTargetWindow(1000 + Ownership.MaxOwnerSteps, Target, Pid, o2, p2));
    }

    [Fact]
    public void NoWindowIsRefused()
    {
        var (owner, pid) = Windows((Target, 0, Pid));
        Assert.False(Ownership.InTargetWindow(0, Target, Pid, owner, pid));
    }
}
