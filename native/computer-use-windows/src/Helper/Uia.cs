// UI Automation through CsWin32's unmanaged COM structs (no runtime
// marshalling, so NativeAOT-safe). STA thread only.
//
// A tree is read level by level: one FindAllBuildCache(Children) per parent,
// each returning its children with every property the walk needs already
// cached. A whole-subtree cache would pull a huge window (a long list, a big
// document) across before the node cap could stop it; this way the walk asks
// only while it still has node budget and time. Elements stay in Full mode,
// so the ones a snapshot keeps can still be acted on later.

using System.Runtime.InteropServices;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.System.Com;
using Windows.Win32.System.Variant;
using Windows.Win32.UI.Accessibility;
using WmuxComputerUse.Core;

namespace WmuxComputerUse;

internal static unsafe class Uia
{
    // Property ids (UIA_*PropertyId).
    public const int RuntimeIdProperty = 30000;
    public const int BoundingRectangleProperty = 30001;
    public const int ProcessIdProperty = 30002;
    public const int ControlTypeProperty = 30003;
    public const int NameProperty = 30005;
    public const int IsEnabledProperty = 30010;
    public const int AutomationIdProperty = 30011;
    public const int ClassNameProperty = 30012;
    public const int HelpTextProperty = 30013;
    public const int IsPasswordProperty = 30019;
    public const int IsOffscreenProperty = 30022;
    public const int IsExpandCollapseAvailableProperty = 30028;
    public const int IsInvokeAvailableProperty = 30031;
    public const int IsSelectionItemAvailableProperty = 30036;
    public const int IsToggleAvailableProperty = 30041;
    public const int IsValueAvailableProperty = 30043;
    public const int ValueValueProperty = 30045;
    public const int ValueIsReadOnlyProperty = 30046;
    public const int ExpandCollapseStateProperty = 30070;
    public const int SelectionItemIsSelectedProperty = 30079;
    public const int ToggleStateProperty = 30086;
    public const int FullDescriptionProperty = 30159;

    // Pattern ids (UIA_*PatternId).
    public const int InvokePattern = 10000;
    public const int ValuePattern = 10002;
    public const int ExpandCollapsePattern = 10005;
    public const int SelectionItemPattern = 10010;
    public const int TogglePattern = 10015;

    public const int DocumentControlType = 50030;

    // HRESULTs that say "the element is gone", classified by value, never by message.
    private const int UIA_E_ELEMENTNOTAVAILABLE = unchecked((int)0x80040201);
    private const int UIA_E_ELEMENTNOTENABLED = unchecked((int)0x80040200);
    private const int UIA_E_NOTSUPPORTED = unchecked((int)0x80040204);
    private const int UIA_E_INVALIDOPERATION = unchecked((int)0x80131509);
    private const int E_NOTIMPL = unchecked((int)0x80004001);
    private const int UIA_E_TIMEOUT = unchecked((int)0x80131505);
    private const int E_ACCESSDENIED = unchecked((int)0x80070005);
    private const int RPC_E_DISCONNECTED = unchecked((int)0x80010108);
    private const int RPC_E_SERVER_DIED = unchecked((int)0x80010007);
    private const int RPC_E_SERVERCALL_RETRYLATER = unchecked((int)0x8001010A);
    private const int CO_E_OBJNOTCONNECTED = unchecked((int)0x800401FD);
    private const int ERROR_TIMEOUT_HR = unchecked((int)0x800705B4);

    private static IUIAutomation2* automation;
    private static IUIAutomationCacheRequest* walkCache;
    private static IUIAutomationCondition* controlView;
    private static IUIAutomationTreeWalker* rawWalker;

    private static readonly Guid ClsidCUIAutomation8 = new(0xE22AD333, 0xB25F, 0x460C, 0x83, 0xD0, 0x05, 0x81, 0x10, 0x73, 0x95, 0xC9);

    /// <summary>The automation object, created on first use (after hello, on the STA thread).</summary>
    public static IUIAutomation2* Automation
    {
        get
        {
            if (automation != null) return automation;
            var clsid = ClsidCUIAutomation8;
            var iid = IUIAutomation2.IID_Guid;
            void* ppv;
            var hr = PInvoke.CoCreateInstance(&clsid, null, CLSCTX.CLSCTX_INPROC_SERVER, &iid, &ppv);
            if (hr.Failed) throw new HelperError("internal", $"UI Automation is unavailable (0x{hr.Value:x8})");
            automation = (IUIAutomation2*)ppv;
            // A hung target must cost an error reply, not a helper kill: both
            // stay well inside main's 8 s / 15 s request timeouts.
            automation->ConnectionTimeout = 2000;
            automation->TransactionTimeout = 6000;
            return automation;
        }
    }

    /// <summary>The control view: the usual UIA interactive set, without raw-view noise.</summary>
    public static IUIAutomationCondition* ControlView => controlView != null ? controlView : controlView = Automation->ControlViewCondition;

    private static IUIAutomationTreeWalker* RawWalker => rawWalker != null ? rawWalker : rawWalker = Automation->RawViewWalker;

    /// <summary>The properties every walked element is fetched with (TreeScope_Element: one element at a time).</summary>
    public static IUIAutomationCacheRequest* WalkCache
    {
        get
        {
            if (walkCache != null) return walkCache;
            var req = Automation->CreateCacheRequest();
            foreach (var id in new[]
            {
                RuntimeIdProperty, BoundingRectangleProperty, ProcessIdProperty, ControlTypeProperty, NameProperty,
                IsEnabledProperty, AutomationIdProperty, ClassNameProperty, HelpTextProperty, IsPasswordProperty, IsOffscreenProperty,
                IsExpandCollapseAvailableProperty, IsInvokeAvailableProperty, IsSelectionItemAvailableProperty,
                IsToggleAvailableProperty, IsValueAvailableProperty, ValueValueProperty, ExpandCollapseStateProperty,
                SelectionItemIsSelectedProperty, FullDescriptionProperty,
            })
            {
                try
                {
                    req->AddProperty((UIA_PROPERTY_ID)id);
                }
                catch (Exception e) when (e is not HelperError)
                {
                    // An older Windows 10 lacks a property (FullDescription
                    // arrived in 1703); the tree simply goes without it.
                }
            }
            walkCache = req;
            return walkCache;
        }
    }

    public static void Release(nint p)
    {
        if (p != 0) ((IUnknown*)p)->Release();
    }

    // MARK: Values

    public static string? Take(BSTR b)
    {
        if (b.Value == null) return null;
        var s = b.ToString();
        PInvoke.SysFreeString(b);
        return s;
    }

    /// <summary>A cached VARIANT property as text (strings and numbers), or null.</summary>
    public static string? CachedString(IUIAutomationElement* el, int property)
    {
        var v = el->GetCachedPropertyValue((UIA_PROPERTY_ID)property);
        try
        {
            return VariantText(ref v);
        }
        finally
        {
            PInvoke.VariantClear(&v);
        }
    }

    public static bool CachedBool(IUIAutomationElement* el, int property)
    {
        var v = el->GetCachedPropertyValue((UIA_PROPERTY_ID)property);
        try
        {
            return v.vt == VARENUM.VT_BOOL && v.boolVal.Value != 0;
        }
        finally
        {
            PInvoke.VariantClear(&v);
        }
    }

    public static int? CachedInt(IUIAutomationElement* el, int property)
    {
        var v = el->GetCachedPropertyValue((UIA_PROPERTY_ID)property);
        try
        {
            return v.vt == VARENUM.VT_I4 ? v.lVal : null;
        }
        finally
        {
            PInvoke.VariantClear(&v);
        }
    }

    public static string? CurrentString(IUIAutomationElement* el, int property)
    {
        var v = el->GetCurrentPropertyValue((UIA_PROPERTY_ID)property);
        try
        {
            return VariantText(ref v);
        }
        finally
        {
            PInvoke.VariantClear(&v);
        }
    }

    public static bool CurrentBool(IUIAutomationElement* el, int property)
    {
        var v = el->GetCurrentPropertyValue((UIA_PROPERTY_ID)property);
        try
        {
            return v.vt == VARENUM.VT_BOOL && v.boolVal.Value != 0;
        }
        finally
        {
            PInvoke.VariantClear(&v);
        }
    }

    private static string? VariantText(ref VARIANT v) => v.vt switch
    {
        VARENUM.VT_BSTR => v.bstrVal.ToString(),
        VARENUM.VT_I4 => v.lVal.ToString(System.Globalization.CultureInfo.InvariantCulture),
        VARENUM.VT_R8 => v.dblVal.ToString(System.Globalization.CultureInfo.InvariantCulture),
        _ => null,
    };

    /// <summary>A SAFEARRAY of VT_I4 (a RuntimeId) as an array; destroys the SAFEARRAY.</summary>
    public static int[] TakeIntArray(SAFEARRAY* sa)
    {
        if (sa == null) return [];
        try
        {
            int lo, hi;
            if (PInvoke.SafeArrayGetLBound(sa, 1, &lo).Failed || PInvoke.SafeArrayGetUBound(sa, 1, &hi).Failed || hi < lo) return [];
            void* data;
            if (PInvoke.SafeArrayAccessData(sa, &data).Failed) return [];
            try
            {
                return new ReadOnlySpan<int>(data, hi - lo + 1).ToArray();
            }
            finally
            {
                PInvoke.SafeArrayUnaccessData(sa);
            }
        }
        finally
        {
            PInvoke.SafeArrayDestroy(sa);
        }
    }

    public static int[] CachedRuntimeId(IUIAutomationElement* el)
    {
        var v = el->GetCachedPropertyValue((UIA_PROPERTY_ID)RuntimeIdProperty);
        try
        {
            if (v.vt != (VARENUM.VT_ARRAY | VARENUM.VT_I4) || v.parray == null) return [];
            var sa = v.parray;
            v.parray = null; // TakeIntArray destroys it; VariantClear must not.
            v.vt = VARENUM.VT_EMPTY;
            return TakeIntArray(sa);
        }
        finally
        {
            PInvoke.VariantClear(&v);
        }
    }

    public static int[] CurrentRuntimeId(IUIAutomationElement* el) => TakeIntArray(el->GetRuntimeId());

    public static Rect ToRect(RECT r) => new(r.left, r.top, r.right - r.left, r.bottom - r.top);

    /// <summary>The element that has keyboard focus (AddRef'd), or null.</summary>
    public static IUIAutomationElement* Focused()
    {
        try
        {
            return Automation->GetFocusedElement();
        }
        catch (Exception e) when (e is not HelperError)
        {
            return null;
        }
    }

    public enum Secrecy { Safe, Secret, Unknown }

    /// <summary>
    /// Whether the focused element is a password field (IsPassword, or a
    /// name that says it holds a secret: the rule that redacts its value in
    /// the tree), and its RuntimeId. Anything that cannot be read — no
    /// focused element, a timeout, a failed property — is Unknown, which
    /// callers refuse like Secret.
    /// </summary>
    public static Secrecy FocusSecrecy(out int[] runtimeId)
    {
        runtimeId = [];
        var el = Focused();
        if (el == null) return Secrecy.Unknown;
        try
        {
            runtimeId = CurrentRuntimeId(el);
            if (runtimeId.Length == 0) return Secrecy.Unknown;
            return IsSecretElement(el) ? Secrecy.Secret : Secrecy.Safe;
        }
        catch (Exception e) when (e is not HelperError)
        {
            return Secrecy.Unknown;
        }
        finally
        {
            el->Release();
        }
    }

    /// <summary>
    /// The element is a secret field, read live: IsPassword, a secret-looking
    /// name, AutomationId or class name, or a Win32 edit with ES_PASSWORD.
    /// An element that cannot be read counts as secret.
    /// </summary>
    public static bool IsSecretElement(IUIAutomationElement* el)
    {
        try
        {
            var info = new NodeInfo
            {
                Role = "Edit",
                IsPassword = el->CurrentIsPassword,
                AutomationId = Take(el->CurrentAutomationId),
                ClassName = Take(el->CurrentClassName),
            };
            if (Tree.IsSecretField(info, Take(el->CurrentName))) return true;
            var hwnd = el->CurrentNativeWindowHandle;
            const uint EsPassword = 0x20;
            return hwnd != HWND.Null && Win.ClassName(hwnd).Contains("Edit", StringComparison.OrdinalIgnoreCase)
                && ((uint)PInvoke.GetWindowLongPtr(hwnd, Windows.Win32.UI.WindowsAndMessaging.WINDOW_LONG_PTR_INDEX.GWL_STYLE) & EsPassword) != 0;
        }
        catch (Exception e) when (e is not HelperError)
        {
            return true;
        }
    }

    /// <summary>The RuntimeId of the focused element, or empty when it cannot be read.</summary>
    public static int[] FocusedRuntimeId()
    {
        var el = Focused();
        if (el == null) return [];
        try
        {
            return CurrentRuntimeId(el);
        }
        catch (Exception e) when (e is not HelperError)
        {
            return [];
        }
        finally
        {
            el->Release();
        }
    }

    /// <summary>
    /// The top-level window an element lives in: the first ancestor (itself
    /// included) with a native window handle, through the raw view. HWND.Null
    /// when none is found within a sane depth.
    /// </summary>
    public static HWND TopWindowOf(IUIAutomationElement* el)
    {
        el->AddRef();
        var current = el;
        try
        {
            for (int depth = 0; depth < 64 && current != null; depth++)
            {
                var hwnd = current->CurrentNativeWindowHandle;
                if (hwnd != HWND.Null) return Win.Root(hwnd);
                var parent = RawWalker->GetParentElement(current);
                current->Release();
                current = parent;
            }
            return HWND.Null;
        }
        finally
        {
            if (current != null) current->Release();
        }
    }

    // MARK: Errors

    /// <summary>The call certainly did nothing: the pattern or operation is not available.</summary>
    public static bool NotExecuted(int hr) =>
        hr is UIA_E_NOTSUPPORTED or UIA_E_ELEMENTNOTENABLED or UIA_E_INVALIDOPERATION or E_NOTIMPL;

    public static bool IsGone(int hr) =>
        hr is UIA_E_ELEMENTNOTAVAILABLE or RPC_E_DISCONNECTED or RPC_E_SERVER_DIED or CO_E_OBJNOTCONNECTED;

    /// <summary>An error code for an unexpected exception, from its HRESULT.</summary>
    public static string ErrorCode(Exception e) => e.HResult switch
    {
        UIA_E_ELEMENTNOTAVAILABLE or RPC_E_DISCONNECTED or RPC_E_SERVER_DIED or CO_E_OBJNOTCONNECTED => "element_stale",
        UIA_E_ELEMENTNOTENABLED or UIA_E_NOTSUPPORTED => "action_not_supported",
        UIA_E_TIMEOUT or ERROR_TIMEOUT_HR or RPC_E_SERVERCALL_RETRYLATER => "timeout",
        E_ACCESSDENIED => "target_elevated",
        _ => "internal",
    };

    public static string Describe(Exception e) => e.HResult switch
    {
        UIA_E_ELEMENTNOTAVAILABLE or RPC_E_DISCONNECTED or RPC_E_SERVER_DIED or CO_E_OBJNOTCONNECTED =>
            "the element or its app went away",
        UIA_E_ELEMENTNOTENABLED => "the element is disabled",
        UIA_E_NOTSUPPORTED => "the element does not support that",
        UIA_E_TIMEOUT or ERROR_TIMEOUT_HR or RPC_E_SERVERCALL_RETRYLATER =>
            "the app did not answer UI Automation in time (it may be hung)",
        E_ACCESSDENIED => "access denied (the app may run at a higher integrity level)",
        _ => $"unexpected failure (0x{e.HResult:x8})",
    };
}

/// <summary>Adapts cached UIA elements (as nint) to the Core walker; owns every element it hands out.</summary>
internal sealed unsafe class UiaTreeSource : ITreeSource<nint>, IDisposable
{
    private readonly List<nint> obtained = [];
    /// <summary>Set when a document has no children yet (Chromium builds its tree on first request).</summary>
    public bool SawEmptyDocument { get; private set; }

    /// <summary>Takes ownership of `root` (one reference).</summary>
    public nint Adopt(IUIAutomationElement* root)
    {
        obtained.Add((nint)root);
        return (nint)root;
    }

    /// <summary>Elements the walk saw as secret fields, so a snapshot remembers it.</summary>
    public HashSet<nint> Secrets { get; } = [];

    public NodeInfo? Info(nint node)
    {
        var el = (IUIAutomationElement*)node;
        try
        {
            int type = (int)el->CachedControlType;
            var role = ControlTypes.Name(type);
            var rect = Uia.ToRect(el->CachedBoundingRectangle);
            var description = Uia.CachedString(el, Uia.FullDescriptionProperty);
            if (string.IsNullOrEmpty(description)) description = Uia.Take(el->CachedHelpText);
            bool password = el->CachedIsPassword;
            var info = new NodeInfo
            {
                Role = role,
                Name = Uia.Take(el->CachedName),
                // A password field's value is never even read into the helper.
                Value = password ? null : Uia.CachedString(el, Uia.ValueValueProperty),
                Description = description,
                AutomationId = Uia.Take(el->CachedAutomationId),
                ClassName = Uia.Take(el->CachedClassName),
                Enabled = el->CachedIsEnabled,
                Selected = Uia.CachedBool(el, Uia.SelectionItemIsSelectedProperty),
                Expanded = Uia.CachedInt(el, Uia.ExpandCollapseStateProperty) == 1,
                IsPassword = password,
                IsOffscreen = el->CachedIsOffscreen,
                HasActions = Uia.CachedBool(el, Uia.IsInvokeAvailableProperty) || Uia.CachedBool(el, Uia.IsToggleAvailableProperty)
                    || Uia.CachedBool(el, Uia.IsValueAvailableProperty) || Uia.CachedBool(el, Uia.IsExpandCollapseAvailableProperty)
                    || Uia.CachedBool(el, Uia.IsSelectionItemAvailableProperty),
                Frame = rect.IsEmpty ? null : rect,
            };
            if (!Tree.IsSecretField(info, info.Name)) return info;
            Secrets.Add(node);
            return info with { Value = null };
        }
        catch (Exception e) when (e is not HelperError)
        {
            return null;
        }
    }

    public IReadOnlyList<nint> Children(nint node, NodeInfo info, int limit)
    {
        var el = (IUIAutomationElement*)node;
        IUIAutomationElementArray* arr;
        try
        {
            arr = el->FindAllBuildCache(TreeScope.TreeScope_Children, Uia.ControlView, Uia.WalkCache);
        }
        catch (Exception e) when (e is not HelperError)
        {
            return [];
        }
        if (arr == null)
        {
            if (info.Role == "Document") SawEmptyDocument = true;
            return [];
        }
        try
        {
            int length = arr->Length;
            if (length == 0 && info.Role == "Document") SawEmptyDocument = true;
            // The count comes from the target app: never more than the budget.
            int n = Math.Clamp(length, 0, limit);
            var children = new List<nint>(n);
            for (int i = 0; i < n; i++)
            {
                var child = arr->GetElement(i);
                if (child == null) continue;
                obtained.Add((nint)child);
                children.Add((nint)child);
            }
            return children;
        }
        finally
        {
            arr->Release();
        }
    }

    /// <summary>Removes `kept` from the release list: the snapshot owns them now.</summary>
    public void Keep(IEnumerable<nint> kept)
    {
        var set = new HashSet<nint>(kept);
        obtained.RemoveAll(set.Contains);
    }

    public void Dispose()
    {
        foreach (var p in obtained) Uia.Release(p);
        obtained.Clear();
    }
}
