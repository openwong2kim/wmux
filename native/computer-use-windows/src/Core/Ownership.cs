// Which top-level windows count as part of the target window for an
// accessibility call. A popup an app opens from its window (a XAML menu
// flyout, a dropdown) is often a top-level window of its own, owned by the
// target window: Notepad's File menu lives in a
// Microsoft.UI.Content.PopupWindowSiteBridge window whose owner is the
// Notepad window, while UIA lists its items under the Notepad window's
// element. Such a window counts, the way the pointer checks already count
// windows the target owns; any other window does not.

namespace WmuxComputerUse.Core;

public static class Ownership
{
    /// <summary>How many GW_OWNER steps are followed (the same bound the pointer checks use).</summary>
    public const int MaxOwnerSteps = 16;

    /// <summary>
    /// The element's top-level window `top` is the target window itself, or
    /// a window of the target process (`pidOf`, read now) whose owner chain
    /// (`ownerOf`, GW_OWNER; 0 ends it) reaches the target window within
    /// MaxOwnerSteps. An owned window of another process is refused: a window
    /// handle and its ownership say nothing about who drew it.
    /// </summary>
    public static bool InTargetWindow(nint top, nint target, uint targetPid, Func<nint, nint> ownerOf, Func<nint, uint> pidOf)
    {
        if (top == 0 || target == 0) return false;
        if (top == target) return true;
        if (pidOf(top) != targetPid) return false;
        var current = top;
        for (int i = 0; i < MaxOwnerSteps; i++)
        {
            current = ownerOf(current);
            if (current == 0) return false;
            if (current == target) return true;
        }
        return false;
    }
}
