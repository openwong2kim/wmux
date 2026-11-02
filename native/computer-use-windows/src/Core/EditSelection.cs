// A Win32 edit control's selection as EM_GETSEL reports it with no pointers:
// the start in the low word and the end in the high word of one 32-bit
// value. Positions past 65,535 do not fit that answer (the control cuts them
// or answers -1), and a selection at 65,535 packs to the same 0xFFFFFFFF as
// -1, so the answer is trusted only for text of at most 65,534 characters
// (WM_GETTEXTLENGTH). Used to keep a field's
// selection across a UIA SetFocus when it has no UIA TextPattern (a .NET
// Framework WinForms TextBox).

namespace WmuxComputerUse.Core;

public static class EditSelection
{
    /// <summary>The longest text whose selection EM_GETSEL's packed answer holds unambiguously.</summary>
    public const uint MaxPackedLength = 0xFFFE;

    /// <summary>
    /// The selection (start, end) from EM_GETSEL's answer `packed`, for text
    /// of `textLength` characters. Null when it cannot be trusted: the text
    /// is longer than MaxPackedLength, the answer is -1, or a position lies
    /// past the text or the end before the start.
    /// </summary>
    public static (uint Start, uint End)? Unpack(uint packed, uint textLength)
    {
        if (textLength > MaxPackedLength || packed == uint.MaxValue) return null;
        uint start = packed & 0xFFFF, end = packed >> 16;
        if (start > end || end > textLength) return null;
        return (start, end);
    }
}
