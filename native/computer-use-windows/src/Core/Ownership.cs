// Which top-level windows count as part of the target window. A popup an
// app opens from its window (a XAML menu flyout, a dropdown, an owned
// dialog) is often a top-level window of its own, owned by the target
// window: Notepad's File menu lives in a
// Microsoft.UI.Content.PopupWindowSiteBridge window whose owner is the
// Notepad window, while UIA lists its items under the Notepad window's
// element. The pointer checks, the accessibility-call checks and the
// background popup check all walk the same GW_OWNER chain through Owns.

namespace WmuxComputerUse.Core;

public static class Ownership
{
    /// <summary>How many GW_OWNER steps are followed.</summary>
    public const int MaxOwnerSteps = 16;

    /// <summary>
    /// `window`'s owner chain (`ownerOf`, GW_OWNER; 0 ends it) reaches
    /// `owner` within MaxOwnerSteps. With `pidOf` and `pid`, every window on
    /// the way must belong to that process too.
    /// </summary>
    public static bool Owns(nint owner, nint window, Func<nint, nint> ownerOf, Func<nint, uint>? pidOf = null, uint pid = 0)
    {
        if (owner == 0 || window == 0) return false;
        var current = window;
        for (int i = 0; i < MaxOwnerSteps; i++)
        {
            current = ownerOf(current);
            if (current == 0) return false;
            if (current == owner) return true;
            if (pidOf != null && pidOf(current) != pid) return false;
        }
        return false;
    }

    /// <summary>
    /// The top-level window `top` is the target window itself, or a window
    /// of the target process (`pidOf`, read now) that the target window owns
    /// through windows of that process alone. A window of another process
    /// never counts, wherever its ownership points: a handle and its owner
    /// say nothing about who drew it.
    /// </summary>
    public static bool InTargetWindow(nint top, nint target, uint targetPid, Func<nint, nint> ownerOf, Func<nint, uint> pidOf)
    {
        if (top == 0 || target == 0) return false;
        if (top == target) return true;
        return pidOf(top) == targetPid && Owns(target, top, ownerOf, pidOf, targetPid);
    }
}
