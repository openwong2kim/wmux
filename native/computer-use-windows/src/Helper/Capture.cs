// Window-only screenshots: PrintWindow with PW_RENDERFULLCONTENT (works for a
// covered window and for DirectComposition / GPU content), falling back to a
// BitBlt of the screen when PrintWindow comes back black; cropped to DWM's
// extended frame bounds (no invisible border, no shadow), scaled to the shared
// screenshot budget and encoded as JPEG quality 80, all through GDI and WIC.
//
// Windows.Graphics.Capture is not used: an unpackaged exe cannot hide its
// yellow capture border.

using System.Text.Json.Nodes;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.Graphics.Gdi;
using Windows.Win32.Graphics.Imaging;
using Windows.Win32.Storage.Xps;
using Windows.Win32.System.Com;
using Windows.Win32.System.Com.StructuredStorage;
using Windows.Win32.System.Variant;
using WmuxComputerUse.Core;

namespace WmuxComputerUse;

internal static unsafe class Capture
{
    private const float JpegQuality = 0.8f;
    /// <summary>Largest window captured (40 MP: 160 MB of 32-bit pixels); bigger ones fail instead of exhausting memory.</summary>
    private const long MaxPixels = 40_000_000;
    private static IWICImagingFactory* factory;

    private static IWICImagingFactory* Factory
    {
        get
        {
            if (factory != null) return factory;
            var clsid = PInvoke.CLSID_WICImagingFactory;
            var iid = IWICImagingFactory.IID_Guid;
            void* ppv;
            var hr = PInvoke.CoCreateInstance(&clsid, null, CLSCTX.CLSCTX_INPROC_SERVER, &iid, &ppv);
            if (hr.Failed) throw new HelperError("screenshot_failed", $"the image encoder is unavailable (0x{hr.Value:x8})");
            factory = (IWICImagingFactory*)ppv;
            return factory;
        }
    }

    public static JsonObject Window(HWND hwnd)
    {
        if (PInvoke.IsIconic(hwnd)) throw new HelperError("screenshot_failed", "the window is minimized; nothing was captured");
        var outer = Win.WindowRect(hwnd);
        var frame = Win.Bounds(hwnd);
        int w = (int)outer.Width, h = (int)outer.Height;
        if (w <= 0 || h <= 0 || w > 16384 || h > 16384) throw new HelperError("screenshot_failed", "the window has no capturable size");
        if ((long)w * h > MaxPixels) throw new HelperError("screenshot_failed", "the window is too large to capture; make it smaller");
        // The visible frame inside the window rectangle.
        var crop = new Rect(frame.X - outer.X, frame.Y - outer.Y, frame.Width, frame.Height).Intersection(new Rect(0, 0, w, h));
        if (crop.IsEmpty) crop = new Rect(0, 0, w, h);

        var screen = PInvoke.GetDC(HWND.Null);
        var mem = PInvoke.CreateCompatibleDC(screen);
        HBITMAP bitmap = default;
        HGDIOBJ previous = default;
        try
        {
            var info = new BITMAPINFO();
            info.bmiHeader.biSize = (uint)sizeof(BITMAPINFOHEADER);
            info.bmiHeader.biWidth = w;
            info.bmiHeader.biHeight = -h; // top-down rows
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = 0; // BI_RGB
            void* bits;
            bitmap = PInvoke.CreateDIBSection(mem, &info, DIB_USAGE.DIB_RGB_COLORS, &bits, HANDLE.Null, 0);
            if (bitmap.IsNull || bits == null) throw new HelperError("screenshot_failed", "could not allocate the capture bitmap");
            previous = PInvoke.SelectObject(mem, (HGDIOBJ)bitmap.Value);

            int stride = w * 4;
            bool printed = PInvoke.PrintWindow(hwnd, mem, (PRINT_WINDOW_FLAGS)2 /* PW_RENDERFULLCONTENT */);
            if (!printed || IsBlack((byte*)bits, stride, crop))
            {
                // Some windows render nothing through PrintWindow. A copy of
                // the screen shows whatever covers the window (a blocked app,
                // say), so it is used only when nothing does.
                if (IsCovered(hwnd, frame))
                {
                    throw new HelperError("screenshot_failed", "the window did not render for capture and another window covers it; bring it to the front and retry");
                }
                if (!PInvoke.BitBlt(mem, 0, 0, w, h, screen, (int)outer.X, (int)outer.Y, ROP_CODE.SRCCOPY | ROP_CODE.CAPTUREBLT))
                {
                    throw new HelperError("screenshot_failed", "the window could not be captured");
                }
            }
            return Encode((byte*)bits, stride, crop);
        }
        finally
        {
            if (!previous.IsNull) PInvoke.SelectObject(mem, previous);
            if (!bitmap.IsNull) PInvoke.DeleteObject((HGDIOBJ)bitmap.Value);
            PInvoke.DeleteDC(mem);
            PInvoke.ReleaseDC(HWND.Null, screen);
        }
    }

    /// <summary>A visible window above `hwnd` in z-order overlaps `frame`.</summary>
    private static bool IsCovered(HWND hwnd, Rect frame)
    {
        foreach (var other in Win.TopLevelWindows())
        {
            if (other == hwnd) return false;
            if (!PInvoke.IsWindowVisible(other) || PInvoke.IsIconic(other) || Win.IsCloaked(other)) continue;
            if (Win.Bounds(other).Intersects(frame)) return true;
        }
        return false;
    }

    /// <summary>
    /// Every sampled pixel of the visible frame is exactly black (PrintWindow
    /// drew nothing). Samples across the whole frame, about a million points,
    /// so a dark window with any detail is not mistaken for an empty one.
    /// </summary>
    private static bool IsBlack(byte* bits, int stride, Rect crop)
    {
        int stepX = Math.Max(1, (int)crop.Width / 1024), stepY = Math.Max(1, (int)crop.Height / 1024);
        for (int y = (int)crop.Y; y < (int)crop.Bottom; y += stepY)
        {
            var row = bits + (long)y * stride;
            for (int x = (int)crop.X; x < (int)crop.Right; x += stepX)
            {
                var px = row + x * 4;
                if (px[0] != 0 || px[1] != 0 || px[2] != 0) return false;
            }
        }
        return true;
    }

    private static JsonObject Encode(byte* bits, int stride, Rect crop)
    {
        int cw = (int)crop.Width, ch = (int)crop.Height;
        double scale = Geometry.ScreenshotScale(cw, ch);
        var (tw, th) = Geometry.ScaledSize(cw, ch, scale);
        var start = bits + (long)crop.Y * stride + (long)crop.X * 4;
        uint size = (uint)((ch - 1) * stride + cw * 4);

        IWICBitmap* source = null;
        IWICBitmapScaler* scaler = null;
        IWICFormatConverter* converter = null;
        IStream* stream = null;
        IWICBitmapEncoder* encoder = null;
        IWICBitmapFrameEncode* frameEncode = null;
        IPropertyBag2* options = null;
        try
        {
            // 32bppBGR: GDI leaves the alpha byte undefined, so it is ignored.
            var bgr32 = PInvoke.GUID_WICPixelFormat32bppBGR;
            Factory->CreateBitmapFromMemory((uint)cw, (uint)ch, &bgr32, (uint)stride, size, start, &source);
            var input = (IWICBitmapSource*)source;
            if (tw != cw || th != ch)
            {
                Factory->CreateBitmapScaler(&scaler);
                scaler->Initialize(input, (uint)tw, (uint)th, WICBitmapInterpolationMode.WICBitmapInterpolationModeFant);
                input = (IWICBitmapSource*)scaler;
            }
            var bgr24 = PInvoke.GUID_WICPixelFormat24bppBGR;
            Factory->CreateFormatConverter(&converter);
            converter->Initialize(input, &bgr24, WICBitmapDitherType.WICBitmapDitherTypeNone, null, 0, WICBitmapPaletteType.WICBitmapPaletteTypeCustom);

            var hr = PInvoke.CreateStreamOnHGlobal(HGLOBAL.Null, true, &stream);
            if (hr.Failed) throw new HelperError("screenshot_failed", $"could not allocate the image stream (0x{hr.Value:x8})");
            var jpeg = PInvoke.GUID_ContainerFormatJpeg;
            encoder = Factory->CreateEncoder(&jpeg, null);
            encoder->Initialize(stream, WICBitmapEncoderCacheOption.WICBitmapEncoderNoCache);
            encoder->CreateNewFrame(&frameEncode, &options);
            fixed (char* name = "ImageQuality")
            {
                var bag = new PROPBAG2 { pstrName = new PWSTR(name) };
                var value = new VARIANT();
                value.vt = VARENUM.VT_R4;
                value.fltVal = JpegQuality;
                options->Write(1, &bag, &value);
            }
            frameEncode->Initialize(options);
            frameEncode->SetSize((uint)tw, (uint)th);
            frameEncode->SetPixelFormat(&bgr24);
            frameEncode->WriteSource((IWICBitmapSource*)converter, null);
            frameEncode->Commit();
            encoder->Commit();

            ulong length;
            stream->Seek(0, System.IO.SeekOrigin.Current, &length);
            HGLOBAL global;
            hr = PInvoke.GetHGlobalFromStream(stream, &global);
            if (hr.Failed || length == 0 || length > int.MaxValue) throw new HelperError("screenshot_failed", "JPEG encoding produced no data");
            var data = PInvoke.GlobalLock(global);
            string base64;
            try
            {
                base64 = Convert.ToBase64String(new ReadOnlySpan<byte>(data, (int)length));
            }
            finally
            {
                PInvoke.GlobalUnlock(global);
            }
            return new JsonObject
            {
                ["mime"] = "image/jpeg",
                ["data"] = base64,
                ["width"] = tw,
                ["height"] = th,
                // Image pixels per window pixel, from what was actually encoded.
                ["scale"] = (double)tw / cw,
            };
        }
        catch (HelperError)
        {
            throw;
        }
        catch (Exception e)
        {
            throw new HelperError("screenshot_failed", $"encoding the screenshot failed (0x{e.HResult:x8})");
        }
        finally
        {
            if (options != null) options->Release();
            if (frameEncode != null) frameEncode->Release();
            if (encoder != null) encoder->Release();
            if (stream != null) stream->Release();
            if (converter != null) converter->Release();
            if (scaler != null) scaler->Release();
            if (source != null) source->Release();
        }
    }
}
