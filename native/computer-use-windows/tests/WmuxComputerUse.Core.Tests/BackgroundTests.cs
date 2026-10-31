using WmuxComputerUse.Core;

namespace WmuxComputerUse.Core.Tests;

public class BackgroundTests
{
    private static readonly TargetWindowState Normal = new(Iconic: false, Visible: true, OnCurrentDesktop: true, Elevated: false);
    private static readonly Receiver Win32Edit = new("Edit", InTargetProcess: true, TextControl: true);
    private static readonly Receiver Chromium = new(Background.ChromiumWidgetClass, InTargetProcess: true);
    private static readonly BackgroundRequest LeftClick = new(InputAction.Click);
    private static readonly BackgroundRequest FieldTyping = new(InputAction.Type, HasField: true, Text: "hi");
    private static readonly SideEffectProbe Quiet = new(false, false, 100, 100, false);

    /// <summary>Runs a plan with fakes that record whether posting happened.</summary>
    private static (BackgroundOutcome Outcome, bool Posted, bool ReadBack) Run(BackgroundPlan plan, int posts = 3, bool confirmed = false, SideEffectProbe? probe = null)
    {
        bool posted = false, readBack = false;
        Func<int> post = () => { posted = true; return posts; };
        var outcome = Background.Execute(plan, new BackgroundSteps(post, () => true, post,
            () => { readBack = true; return confirmed; },
            () => probe ?? Quiet));
        return (outcome, posted, readBack);
    }

    /// <summary>Records the order Execute calls its steps in.</summary>
    private static (BackgroundOutcome Outcome, List<string> Calls) Trace(BackgroundPlan plan, int clicks = 3, bool focus = true, int keys = 5, bool confirmed = true)
    {
        var calls = new List<string>();
        var outcome = Background.Execute(plan, new BackgroundSteps(
            () => { calls.Add("click"); return clicks; },
            () => { calls.Add("focus"); return focus; },
            () => { calls.Add("keys"); return keys; },
            () => { calls.Add("readBack"); return confirmed; },
            () => { calls.Add("probe"); return Quiet; }));
        return (outcome, calls);
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
        { "text with a Tab", Normal, FieldTyping with { Text = "user\tpass" }, Chromium, BackgroundRefusal.FocusMovingText },
        { "text with an inner newline", Normal, new(InputAction.Type, Text: "a\nb"), Win32Edit, BackgroundRefusal.FocusMovingText },
        { "text with a control character", Normal, new(InputAction.Type, Text: "a\u001Bb"), Win32Edit, BackgroundRefusal.FocusMovingText },
        { "nothing at the point", Normal, LeftClick, null, BackgroundRefusal.NoReceiver },
        { "another process at the point", Normal, LeftClick, Win32Edit with { InTargetProcess = false }, BackgroundRefusal.NoReceiver },
        { "hit test unanswered", Normal, LeftClick, Win32Edit with { HitTestFailed = true }, BackgroundRefusal.HitTestFailed },
        { "frame or scroll bar", Normal, LeftClick, Win32Edit with { InClientArea = false }, BackgroundRefusal.NonClientArea },
        { "popup at the point", Normal, LeftClick, Win32Edit with { PopupAtPoint = true }, BackgroundRefusal.PopupAtPoint },
        { "WPF", Normal, LeftClick, new("HwndWrapper[App;;abc]", true), BackgroundRefusal.UnsupportedFramework },
        { "XAML island", Normal, LeftClick, new("Microsoft.UI.Content.DesktopChildSiteBridge", true), BackgroundRefusal.UnsupportedFramework },
        { "menu", Normal, LeftClick, new("#32768", true), BackgroundRefusal.UnsupportedFramework },
        { "Qt", Normal, LeftClick, new("Qt5152QWindowIcon", true), BackgroundRefusal.UnsupportedFramework },
        { "Flutter", Normal, LeftClick, new("FLUTTERVIEW", true), BackgroundRefusal.UnsupportedFramework },
        { "Java", Normal, LeftClick, new("SunAwtCanvas", true), BackgroundRefusal.UnsupportedFramework },
        { "no focused control", Normal, new(InputAction.PressKey), null, BackgroundRefusal.NoFocusedControl },
        { "focus outside the target", Normal, new(InputAction.Type), Win32Edit with { InTargetProcess = false }, BackgroundRefusal.NoFocusedControl },
        { "Chromium keys with no field", Normal, new(InputAction.Type), Chromium, BackgroundRefusal.ChromiumNeedsClick },
        { "Chromium pressKey", Normal, new(InputAction.PressKey), Chromium, BackgroundRefusal.ChromiumNeedsClick },
        { "Chromium frame pressKey", Normal, new(InputAction.PressKey), new("Chrome_WidgetWin_1", true, TextControl: true), BackgroundRefusal.ChromiumNeedsClick },
        { "unmeasured focused window", Normal, new(InputAction.Type), new("Qt5QWindowIcon", true, TextControl: true), BackgroundRefusal.UnsupportedFramework },
        { "focused control is not text", Normal, new(InputAction.Type), new("SysListView32", true), BackgroundRefusal.NotATextControl },
        { "focused password field", Normal, new(InputAction.PressKey), Win32Edit with { Secret = true }, BackgroundRefusal.SecretField },
        { "password field under the click", Normal, FieldTyping, Win32Edit with { Secret = true }, BackgroundRefusal.SecretField },
        { "field with no receiver", Normal, FieldTyping, null, BackgroundRefusal.NoReceiver },
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

    [Theory]
    [InlineData(InputAction.Scroll, 0, 1, 0, BackgroundRefusal.Scroll)]
    [InlineData(InputAction.Click, 1, 1, 0, BackgroundRefusal.Button)]
    [InlineData(InputAction.Click, 0, 2, 0, BackgroundRefusal.MultiClick)]
    [InlineData(InputAction.Click, 0, 1, 1, BackgroundRefusal.Modifiers)]
    [InlineData(InputAction.Hotkey, 0, 1, 2, BackgroundRefusal.Chord)]
    public void WhatTheActionAsksForIsDecidedBeforeAnyWindowState(InputAction action, int button, int clicks, int modifiers, BackgroundRefusal reason)
    {
        // No window state or receiver is needed to refuse these, and the
        // action's refusal wins over the window's.
        var request = new BackgroundRequest(action, button, clicks, modifiers);
        Assert.Equal(reason, Background.ActionRefusal(request));
        Assert.Equal(reason, Background.Plan(Normal with { Iconic = true }, request, null).Refusal);
    }

    [Fact]
    public void PlainKeysAndClicksHaveNoActionRefusal()
    {
        Assert.Equal(BackgroundRefusal.None, Background.ActionRefusal(LeftClick));
        Assert.Equal(BackgroundRefusal.None, Background.ActionRefusal(new(InputAction.PressKey)));
        Assert.Equal(BackgroundRefusal.None, Background.ActionRefusal(new(InputAction.Hotkey)));
        Assert.Equal(BackgroundRefusal.None, Background.ActionRefusal(new(InputAction.Type, Text: "hello\n")));
    }

    [Theory]
    [InlineData("hello", false)]
    [InlineData("hello\n", false)]
    [InlineData("hello\r\n", false)]
    [InlineData("hello\r", false)]
    [InlineData("café \U0001F600", false)]
    [InlineData("a\tb", true)]
    [InlineData("\t", true)]
    [InlineData("hello\t", true)]
    [InlineData("a\nb", true)]
    [InlineData("hello\n\n", true)]
    [InlineData("a\bb", true)]
    [InlineData("a\u0000", true)]
    public void OnlyOneTrailingNewlineIsAllowedAmongControlCharacters(string text, bool moves)
    {
        Assert.Equal(moves, Background.MovesFocus(text));
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
        var plan = Background.Plan(Normal, LeftClick, new("RichEditD2DPT", true));
        Assert.False(plan.Refused);
        Assert.True(plan.ClickFirst);
        Assert.False(plan.Keys);
    }

    [Fact]
    public void ChromiumTypingClicksTheFieldBeforeTheKeys()
    {
        var plan = Background.Plan(Normal, FieldTyping, Chromium);
        Assert.False(plan.Refused);
        Assert.True(plan.ClickFirst);
        Assert.True(plan.Keys);
    }

    [Fact]
    public void TypingIntoTheFocusedTextControlPostsKeysOnly()
    {
        var plan = Background.Plan(Normal, new(InputAction.Type, Text: "hi"), new("RichEditD2DPT", true, TextControl: true));
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
        var (outcome, _, _) = Run(Background.Plan(Normal, FieldTyping, Chromium), confirmed: true);
        Assert.Equal(Disposition.Delivered, outcome.Disposition);
        Assert.True(outcome.Verified);
        Assert.False(outcome.FallBack);
        Assert.Equal("background", outcome.Delivery);
    }

    [Theory]
    [InlineData(false, true, 100, 100, false)] // the cursor arrived on our point
    [InlineData(false, false, 100, 200, true)] // the target came to the front
    [InlineData(false, false, 200, 300, true)] // the target was in front, then its dialog or popup took it
    [InlineData(false, true, 100, 200, true)]
    public void OurSideEffectIsDeliveredUnverifiedWithNoFallback(bool cursorBefore, bool cursorAfter, int frontBefore, int frontAfter, bool afterInTarget)
    {
        var probe = new SideEffectProbe(cursorBefore, cursorAfter, frontBefore, frontAfter, afterInTarget);
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
    [InlineData(true, true, 100, 100, false)]   // the cursor was already there
    [InlineData(false, false, 200, 200, true)]  // the target was already in front
    [InlineData(true, false, 100, 100, false)]  // the user moved the mouse away
    [InlineData(false, false, 200, 100, false)] // the user switched to another app
    public void WhatWasAlreadySoOrTheUserDidIsNotOurSideEffect(bool cursorBefore, bool cursorAfter, int frontBefore, int frontAfter, bool afterInTarget)
    {
        var probe = new SideEffectProbe(cursorBefore, cursorAfter, frontBefore, frontAfter, afterInTarget);
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
        // A step throws once something went in: the exception reaches the
        // caller (an error with delivered_unverified), never a fallback.
        var plan = Background.Plan(Normal, LeftClick, Win32Edit);
        Assert.Throws<InvalidOperationException>(() =>
            Background.Execute(plan, new BackgroundSteps(() => throw new InvalidOperationException("posted 1 of 3"), null, null, () => true, () => Quiet)));
    }

    [Fact]
    public void FieldTypingClicksThenConfirmsFocusThenPostsKeys()
    {
        var (outcome, calls) = Trace(Background.Plan(Normal, FieldTyping, Chromium));
        Assert.Equal(["click", "focus", "keys", "readBack", "probe"], calls);
        Assert.Equal(Disposition.Delivered, outcome.Disposition);
    }

    [Fact]
    public void AFieldThatDidNotTakeFocusGetsNoKeysAndNoFallback()
    {
        var (outcome, calls) = Trace(Background.Plan(Normal, FieldTyping, Chromium), focus: false);
        Assert.Equal(["click", "focus", "probe"], calls);
        Assert.Equal(BackgroundStop.FocusUnconfirmed, outcome.Stop);
        Assert.Equal(Disposition.DeliveredUnverified, outcome.Disposition);
        Assert.False(outcome.FallBack);
        Assert.False(outcome.Verified);
    }

    [Fact]
    public void KeysRefusedAfterAPostedClickEndWithoutFallback()
    {
        var (outcome, _) = Trace(Background.Plan(Normal, FieldTyping, Chromium), keys: 0);
        Assert.Equal(BackgroundStop.KeysNotPosted, outcome.Stop);
        Assert.Equal(Disposition.DeliveredUnverified, outcome.Disposition);
        Assert.False(outcome.FallBack);
    }

    [Fact]
    public void AClickThatWasNotTakenPostsNoKeysAndFallsBack()
    {
        var (outcome, calls) = Trace(Background.Plan(Normal, FieldTyping, Chromium), clicks: 0);
        Assert.Equal(["click"], calls);
        Assert.True(outcome.FallBack);
        Assert.Equal(Disposition.NotDelivered, outcome.Disposition);
    }

    [Fact]
    public void KeysWithoutAFieldNeedNoClickAndNoFocusCheck()
    {
        var (outcome, calls) = Trace(Background.Plan(Normal, new(InputAction.Type, Text: "hi"), Win32Edit));
        Assert.Equal(["keys", "readBack", "probe"], calls);
        Assert.Equal(Disposition.Delivered, outcome.Disposition);
        var (none, _) = Trace(Background.Plan(Normal, new(InputAction.PressKey), Win32Edit), keys: 0);
        Assert.True(none.FallBack);
    }

    [Fact]
    public void ARealClickPassesThroughTransparentAndHiddenChildren()
    {
        // z-order, topmost first: hidden, disabled, WS_EX_TRANSPARENT, not at
        // the point, a group box (HTTRANSPARENT), then the edit behind it.
        var children = new List<ChildWindow>
        {
            new(Visible: false, Enabled: true, Transparent: false, ContainsPoint: true),
            new(Visible: true, Enabled: false, Transparent: false, ContainsPoint: true),
            new(Visible: true, Enabled: true, Transparent: true, ContainsPoint: true),
            new(Visible: true, Enabled: true, Transparent: false, ContainsPoint: false),
            new(Visible: true, Enabled: true, Transparent: false, ContainsPoint: true),
            new(Visible: true, Enabled: true, Transparent: false, ContainsPoint: true),
        };
        var tested = new List<int>();
        var pick = Background.HitChild(children, i => { tested.Add(i); return i == 4 ? HitTest.Transparent : HitTest.Hit; });
        Assert.Equal(5, pick);
        Assert.Equal([4, 5], tested);
    }

    [Fact]
    public void NoChildAtThePointLeavesTheParentAndAnUnansweredHitTestRefuses()
    {
        var one = new List<ChildWindow> { new(true, true, false, true) };
        Assert.Equal(-1, Background.HitChild([], _ => HitTest.Hit));
        Assert.Equal(-1, Background.HitChild(one, _ => HitTest.Transparent));
        Assert.Null(Background.HitChild(one, _ => HitTest.Failed));
    }

    [Theory]
    [InlineData(false, true, true, true, false, false, true)]   // a menu
    [InlineData(false, true, true, false, true, false, true)]   // an owned dropdown or dialog
    [InlineData(false, true, true, false, false, true, true)]   // a tool window
    [InlineData(false, true, true, false, false, false, false)] // another normal window of the app
    [InlineData(false, true, false, true, false, false, false)] // a menu elsewhere
    [InlineData(false, false, true, true, false, false, false)] // a hidden menu
    [InlineData(true, true, true, false, true, true, false)]    // the target itself
    public void PopupsOfTheTargetOverThePointBlockPosting(bool isTarget, bool visible, bool contains, bool menu, bool owned, bool tool, bool blocks)
    {
        Assert.Equal(blocks, Background.BlocksPoint(new TopLevelWindow(isTarget, visible, contains, menu, owned, tool)));
    }

    [Fact]
    public void AButtonUpThatFailedIsRepairedWithCancelMode()
    {
        var click = Background.Click(5, 5);
        Assert.Equal([Background.WmLButtonUp, Background.WmCancelMode], Background.Repair(click, 2).Select(m => m.Msg));
        Assert.Empty(Background.Repair(click, 1)); // the down itself failed: nothing is pressed
    }

    [Fact]
    public void AKeyUpThatFailedIsPostedAgain()
    {
        var keys = Background.Key(0x0D, 0x1C, false).Concat(Background.Key(0x0D, 0x1C, false)).ToList();
        Assert.Equal([keys[1]], Background.Repair(keys, 1));
        Assert.Empty(Background.Repair(keys, 2)); // the next down failed: the first press is complete
        Assert.Empty(Background.Repair(Background.Text("ab"), 1));
        Assert.Empty(Background.Repair(keys, 0));
    }

    [Fact]
    public void ClickMessagesCarryClientCoordinatesAndTheButton()
    {
        var m = Background.Click(10, 20);
        Assert.Equal([Background.WmMouseMove, Background.WmLButtonDown, Background.WmLButtonUp], m.Select(x => x.Msg));
        Assert.All(m, x => Assert.Equal((nint)(10 | (20 << 16)), x.LParam));
        Assert.Equal(Background.MkLButton, m[1].WParam);
        Assert.Equal((nuint)0, m[2].WParam);
        // Negative coordinates stay signed 16-bit values; MAKELPARAM zero-extends through a DWORD.
        Assert.Equal(unchecked((nint)0xFFFF_FFFFL), Background.PointLParam(-1, -1));
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
    [InlineData("Chrome_WidgetWin_1", true)]
    [InlineData("RichEditD2DPT", true)]
    [InlineData("RICHEDIT50W", true)]
    [InlineData("RichEdit20W", true)]
    [InlineData("Edit", true)]
    [InlineData("EDIT", true)]
    [InlineData("Button", true)]
    [InlineData("ComboBox", true)]
    [InlineData("ListBox", true)]
    [InlineData("SysListView32", true)]
    [InlineData("SysTreeView32", true)]
    [InlineData("Notepad", false)]
    [InlineData("HwndWrapper[x;;y]", false)]
    [InlineData("Windows.UI.Core.CoreWindow", false)]
    [InlineData("Qt5152QWindowIcon", false)]
    [InlineData("SunAwtFrame", false)]
    [InlineData("FLUTTERVIEW", false)]
    [InlineData("SDL_app", false)]
    [InlineData("EditPlus", false)]
    [InlineData("", false)]
    public void PostedInputIsLimitedToMeasuredAndStandardWindows(string className, bool accepts)
    {
        Assert.Equal(accepts, Background.AcceptsPostedInput(className));
    }
}
