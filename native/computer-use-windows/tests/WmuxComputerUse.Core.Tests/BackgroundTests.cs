using WmuxComputerUse.Core;

namespace WmuxComputerUse.Core.Tests;

public class BackgroundTests
{
    private static readonly TargetWindowState Normal = new(Iconic: false, Visible: true, OnCurrentDesktop: true, Elevated: false);
    private static readonly Receiver Win32Edit = new("Edit", InTargetProcess: true, TextControl: true);
    private static readonly Receiver Chromium = new(Background.ChromiumWidgetClass, InTargetProcess: true);
    private static readonly BackgroundRequest LeftClick = new(InputAction.Click);
    private static readonly SideEffectProbe Quiet = new(false, false, false, false);

    /// <summary>Runs a plan with fakes that record whether posting happened.</summary>
    private static (BackgroundOutcome Outcome, bool Posted, bool ReadBack) Run(BackgroundPlan plan, int posts = 3, bool confirmed = false, SideEffectProbe? probe = null)
    {
        bool posted = false, readBack = false;
        var outcome = Background.Execute(plan,
            () => { posted = true; return posts; },
            () => { readBack = true; return confirmed; },
            () => probe ?? Quiet);
        return (outcome, posted, readBack);
    }

    public static TheoryData<string, TargetWindowState, BackgroundRequest, Receiver?, BackgroundRefusal> Refusals => new()
    {
        { "minimized", Normal with { Iconic = true }, LeftClick, Win32Edit, BackgroundRefusal.Minimized },
        { "hidden", Normal with { Visible = false }, LeftClick, Win32Edit, BackgroundRefusal.Hidden },
        { "other desktop", Normal with { OnCurrentDesktop = false }, LeftClick, Win32Edit, BackgroundRefusal.OtherDesktop },
        { "elevated", Normal with { Elevated = true }, LeftClick, Win32Edit, BackgroundRefusal.Elevated },
        { "right button", Normal, LeftClick with { Button = 1 }, Win32Edit, BackgroundRefusal.Button },
        { "middle button", Normal, LeftClick with { Button = 2 }, Win32Edit, BackgroundRefusal.Button },
        { "click with modifiers", Normal, LeftClick with { Modifiers = 1 }, Win32Edit, BackgroundRefusal.Modifiers },
        { "double click", Normal, LeftClick with { ClickCount = 2 }, Win32Edit, BackgroundRefusal.MultiClick },
        { "scroll", Normal, new(InputAction.Scroll), Win32Edit, BackgroundRefusal.Scroll },
        { "hotkey chord", Normal, new(InputAction.Hotkey, Modifiers: 2), Win32Edit, BackgroundRefusal.Chord },
        { "nothing at the point", Normal, LeftClick, null, BackgroundRefusal.NoReceiver },
        { "another process at the point", Normal, LeftClick, Win32Edit with { InTargetProcess = false }, BackgroundRefusal.NoReceiver },
        { "frame or scroll bar", Normal, LeftClick, Win32Edit with { InClientArea = false }, BackgroundRefusal.NonClientArea },
        { "popup at the point", Normal, LeftClick, Win32Edit with { PopupAtPoint = true }, BackgroundRefusal.PopupAtPoint },
        { "WPF", Normal, LeftClick, new("HwndWrapper[App;;abc]", true), BackgroundRefusal.UnsupportedFramework },
        { "XAML island", Normal, LeftClick, new("Microsoft.UI.Content.DesktopChildSiteBridge", true), BackgroundRefusal.UnsupportedFramework },
        { "menu", Normal, LeftClick, new("#32768", true), BackgroundRefusal.UnsupportedFramework },
        { "no focused control", Normal, new(InputAction.PressKey), null, BackgroundRefusal.NoFocusedControl },
        { "focus outside the target", Normal, new(InputAction.Type), Win32Edit with { InTargetProcess = false }, BackgroundRefusal.NoFocusedControl },
        { "Chromium keys with no field", Normal, new(InputAction.Type), Chromium, BackgroundRefusal.ChromiumNeedsClick },
        { "Chromium pressKey", Normal, new(InputAction.PressKey), Chromium, BackgroundRefusal.ChromiumNeedsClick },
        { "host window, not a text control", Normal, new(InputAction.Type), new("Qt5QWindowIcon", true), BackgroundRefusal.NotATextControl },
        { "focused password field", Normal, new(InputAction.PressKey), Win32Edit with { Secret = true }, BackgroundRefusal.SecretField },
        { "password field under the click", Normal, new(InputAction.Type, HasField: true), Win32Edit with { Secret = true }, BackgroundRefusal.SecretField },
        { "field with no receiver", Normal, new(InputAction.Type, HasField: true), null, BackgroundRefusal.NoReceiver },
    };

    [Theory]
    [MemberData(nameof(Refusals))]
    public void EveryRefusalIsNotDeliveredAndFallsBackWithoutPosting(string why, TargetWindowState window, BackgroundRequest request, Receiver? receiver, BackgroundRefusal reason)
    {
        var plan = Background.Plan(window, request, receiver);
        Assert.True(plan.Refused, why);
        Assert.Equal(reason, plan.Refusal);
        var (outcome, posted, readBack) = Run(plan);
        Assert.False(posted);
        Assert.False(readBack);
        Assert.Equal(Disposition.NotDelivered, outcome.Disposition);
        Assert.True(outcome.FallBack);
        Assert.False(outcome.Verified);
        Assert.NotEqual("", Background.Describe(reason));
    }

    [Fact]
    public void WindowStateIsCheckedBeforeTheAction()
    {
        // A minimized target refuses as minimized even for an action that
        // would be refused anyway.
        Assert.Equal(BackgroundRefusal.Minimized, Background.Plan(Normal with { Iconic = true }, new(InputAction.Scroll), null).Refusal);
    }

    [Fact]
    public void AnUnknownDesktopIsNoReasonToRefuse()
    {
        var plan = Background.Plan(Normal with { OnCurrentDesktop = null }, LeftClick, Win32Edit);
        Assert.False(plan.Refused);
    }

    [Fact]
    public void APlainLeftClickIsPosted()
    {
        var plan = Background.Plan(Normal, LeftClick, new("Notepad", true));
        Assert.False(plan.Refused);
        Assert.True(plan.ClickFirst);
        Assert.False(plan.Keys);
    }

    [Fact]
    public void ChromiumTypingClicksTheFieldBeforeTheKeys()
    {
        var plan = Background.Plan(Normal, new(InputAction.Type, HasField: true), Chromium);
        Assert.False(plan.Refused);
        Assert.True(plan.ClickFirst);
        Assert.True(plan.Keys);
    }

    [Fact]
    public void TypingIntoTheFocusedTextControlPostsKeysOnly()
    {
        var plan = Background.Plan(Normal, new(InputAction.Type), new("RichEditD2DPT", true, TextControl: true));
        Assert.False(plan.Refused);
        Assert.False(plan.ClickFirst);
        Assert.True(plan.Keys);
    }

    [Fact]
    public void AHotkeyWithoutModifiersIsAPlainKey()
    {
        Assert.False(Background.Plan(Normal, new(InputAction.Hotkey), Win32Edit).Refused);
    }

    [Fact]
    public void APostWithoutAConfirmingReadBackIsUnverified()
    {
        var (outcome, posted, readBack) = Run(Background.Plan(Normal, LeftClick, Win32Edit), confirmed: false);
        Assert.True(posted);
        Assert.True(readBack);
        Assert.Equal(Disposition.DeliveredUnverified, outcome.Disposition);
        Assert.False(outcome.FallBack);
        Assert.False(outcome.Verified);
        Assert.Equal("background", outcome.Delivery);
    }

    [Fact]
    public void AConfirmedReadBackIsVerified()
    {
        var (outcome, _, _) = Run(Background.Plan(Normal, new(InputAction.Type, HasField: true), Chromium), confirmed: true);
        Assert.Equal(Disposition.Delivered, outcome.Disposition);
        Assert.True(outcome.Verified);
        Assert.False(outcome.FallBack);
        Assert.Equal("background", outcome.Delivery);
    }

    [Theory]
    [InlineData(false, true, false, false)] // the cursor arrived on our point
    [InlineData(false, false, false, true)] // the target came to the front
    [InlineData(false, true, false, true)]
    public void OurSideEffectIsDeliveredUnverifiedWithNoFallback(bool cursorBefore, bool cursorAfter, bool frontBefore, bool frontAfter)
    {
        var probe = new SideEffectProbe(cursorBefore, cursorAfter, frontBefore, frontAfter);
        // Even a confirmed read-back does not make it verified.
        var (outcome, posted, _) = Run(Background.Plan(Normal, LeftClick, Win32Edit), confirmed: true, probe: probe);
        Assert.True(posted);
        Assert.True(outcome.SideEffect);
        Assert.Equal(Disposition.DeliveredUnverified, outcome.Disposition);
        Assert.False(outcome.FallBack);
        Assert.False(outcome.Verified);
        Assert.Equal("foreground", outcome.Delivery);
    }

    [Theory]
    [InlineData(true, true, false, false)]  // the cursor was already there
    [InlineData(false, false, true, true)]  // the target was already in front
    [InlineData(true, false, false, false)] // the user moved the mouse away
    [InlineData(false, false, true, false)] // the user switched away
    public void WhatWasAlreadySoOrTheUserDidIsNotOurSideEffect(bool cursorBefore, bool cursorAfter, bool frontBefore, bool frontAfter)
    {
        var probe = new SideEffectProbe(cursorBefore, cursorAfter, frontBefore, frontAfter);
        Assert.False(probe.Ours);
        var (outcome, _, _) = Run(Background.Plan(Normal, LeftClick, Win32Edit), confirmed: true, probe: probe);
        Assert.Equal(Disposition.Delivered, outcome.Disposition);
    }

    [Fact]
    public void NothingPostedIsARefusalThatFallsBack()
    {
        var (outcome, posted, readBack) = Run(Background.Plan(Normal, LeftClick, Win32Edit), posts: 0);
        Assert.True(posted);
        Assert.False(readBack);
        Assert.Equal(Disposition.NotDelivered, outcome.Disposition);
        Assert.True(outcome.FallBack);
        Assert.Equal(BackgroundRefusal.NothingPosted, outcome.Refusal);
    }

    [Fact]
    public void AFailureAfterTheFirstPostEndsTheActionWithoutFallback()
    {
        // `post` throws once something went in: the exception reaches the
        // caller (an error with delivered_unverified), never a fallback.
        var plan = Background.Plan(Normal, LeftClick, Win32Edit);
        Assert.Throws<InvalidOperationException>(() =>
            Background.Execute(plan, () => throw new InvalidOperationException("posted 1 of 3"), () => true, () => Quiet));
    }

    [Fact]
    public void ClickMessagesCarryClientCoordinatesAndTheButton()
    {
        var m = Background.Click(10, 20);
        Assert.Equal([Background.WmMouseMove, Background.WmLButtonDown, Background.WmLButtonUp], m.Select(x => x.Msg));
        Assert.All(m, x => Assert.Equal((nint)(10 | (20 << 16)), x.LParam));
        Assert.Equal(Background.MkLButton, m[1].WParam);
        Assert.Equal((nuint)0, m[2].WParam);
        // Negative client coordinates stay signed 16-bit values.
        Assert.Equal(unchecked((nint)0xFFFF_FFFFL), Background.PointLParam(-1, -1)); // MAKELPARAM zero-extends through a DWORD
    }

    [Fact]
    public void KeyMessagesSetScanCodeExtendedAndUpBits()
    {
        var enter = Background.Key(0x0D, 0x1C, extended: false);
        Assert.Equal(Background.WmKeyDown, enter[0].Msg);
        Assert.Equal((nuint)0x0D, enter[0].WParam);
        Assert.Equal((nint)0x001C0001, enter[0].LParam);
        Assert.Equal(Background.WmKeyUp, enter[1].Msg);
        Assert.Equal(unchecked((nint)(int)0xC01C0001), enter[1].LParam);
        var left = Background.Key(0x25, 0x4B, extended: true);
        Assert.Equal((nint)0x014B0001, left[0].LParam);
        Assert.Equal(unchecked((nint)(int)0xC14B0001), left[1].LParam);
    }

    [Fact]
    public void TextIsOneCharMessagePerUnitWithSurrogatesInOrder()
    {
        var m = Background.Text("a\U0001F600");
        Assert.Equal(3, m.Count);
        Assert.All(m, x => Assert.Equal(Background.WmChar, x.Msg));
        Assert.Equal((nuint)'a', m[0].WParam);
        Assert.Equal((nuint)0xD83D, m[1].WParam);
        Assert.Equal((nuint)0xDE00, m[2].WParam);
    }

    [Theory]
    [InlineData("Chrome_RenderWidgetHostHWND", true)]
    [InlineData("RichEditD2DPT", true)]
    [InlineData("Edit", true)]
    [InlineData("HwndWrapper[x;;y]", false)]
    [InlineData("Windows.UI.Core.CoreWindow", false)]
    [InlineData("", false)]
    public void PostedInputIsLimitedToWindowsThatTakeIt(string className, bool accepts)
    {
        Assert.Equal(accepts, Background.AcceptsPostedInput(className));
    }
}
