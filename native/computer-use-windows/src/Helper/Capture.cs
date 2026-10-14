// Window-only screenshots: PrintWindow with PW_RENDERFULLCONTENT (works for a
// covered window and for DirectComposition / GPU content), never a copy of
// the screen; cropped to DWM's
// extended frame bounds (no invisible border, no shadow), scaled to the shared
// screenshot budget and encoded as JPEG quality 80, all through GDI and WIC.
//
// A DPI-virtualized window (DPI-unaware, or system-aware on a monitor of
// another DPI) paints at its own DPI and only DWM stretches it on screen, so
// it is captured at that paint size and scaled to its physical size here.
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
using Windows.Win32.UI.HiDpi;
using Windows.Win32.UI.WindowsAndMessaging;
using WmuxComputerUse.Core;

namespace WmuxComputerUse;

internal static unsafe class Capture
{
    private const float JpegQuality = 0.8f;
    /// <summary>Largest window captured (40 MP: 160 MB of 32-bit pixels); bigger ones fail instead of exhausting memory.</summary>
    private const long MaxPixels = 40_000_000;
    private static IWICImagingFactory* factory;

    /// <summary>Creates the WIC factory ahead of the first screenshot.</summary>
    public static void Warm()
    {
        try
        {
            _ = Factory;
        }
        catch (HelperError)
        {
        }
    }

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

    /// <summary>How long a capture may take before the window counts as not responding.</summary>
    private const int CaptureDeadlineMs = 2000;
    /// <summary>The WM_NULL probe that tells a hung window apart before PrintWindow can block on it.</summary>
    private const uint ProbeTimeoutMs = 500;
    /// <summary>Capture threads still stuck in a hung window; past this, captures are refused outright.</summary>
    private const int MaxStuckCaptures = 4;
    private static int stuckCaptures;

    public static JsonObject Window(HWND hwnd)
    {
        if (PInvoke.IsIconic(hwnd)) throw new HelperError("screenshot_failed", "the window is minimized; nothing was captured");
        // PrintWindow sends WM_PRINT to the window's thread and waits; a hung
        // window would block it for as long as the app stays hung.
        if (!Responds(hwnd)) throw NotResponding();
        var outer = Win.WindowRect(hwnd);
        var frame = Win.Bounds(hwnd);
        int w = (int)outer.Width, h = (int)outer.Height;
        if (w <= 0 || h <= 0 || w > 16384 || h > 16384) throw new HelperError("screenshot_failed", "the window has no capturable size");
        if ((long)w * h > MaxPixels) throw new HelperError("screenshot_failed", "the window is too large to capture; make it smaller");
        // The visible frame inside the window rectangle.
        var crop = new Rect(frame.X - outer.X, frame.Y - outer.Y, frame.Width, frame.Height).Intersection(new Rect(0, 0, w, h));
        if (crop.IsEmpty) crop = new Rect(0, 0, w, h);
        // PrintWindow gets the window's own paint, at the window's DPI.
        var (pw, ph) = Geometry.PaintSize(w, h, PInvoke.GetDpiForWindow(hwnd), MonitorDpi(hwnd));
        if (pw > 16384 || ph > 16384 || (long)pw * ph > MaxPixels) throw new HelperError("screenshot_failed", "the window is too large to capture; make it smaller");
        var paintCrop = Geometry.PaintCrop(crop, w, h, pw, ph);
        if (paintCrop.IsEmpty) paintCrop = new Rect(0, 0, pw, ph);

        if (Volatile.Read(ref stuckCaptures) >= MaxStuckCaptures) throw NotResponding();
        // The GDI part runs on a thread of its own, so a window that hangs
        // between the probe and PrintWindow costs this request its deadline,
        // not the helper. The job owns everything it touches (its DC, bitmap
        // and pixel copy); an abandoned job finishes on its own and is never
        // read. Only the copied pixels come back to the STA thread for WIC.
        var job = new CaptureJob(hwnd, pw, ph, paintCrop);
        var thread = new Thread(job.Run) { IsBackground = true, Name = "computer-use capture" };
        thread.Start();
        long deadline = Environment.TickCount64 + CaptureDeadlineMs;
        while (!job.Done.Wait(0))
        {
            if (Environment.TickCount64 >= deadline)
            {
                Interlocked.Increment(ref stuckCaptures);
                job.Abandon();
                throw NotResponding();
            }
            Sta.Sleep(5);
        }
        if (job.Error != null) throw new HelperError("screenshot_failed", job.Error);
        int pcw = (int)paintCrop.Width;
        fixed (byte* pixels = job.Pixels)
        {
            return Encode(pixels, pcw * 4, new Rect(0, 0, pcw, paintCrop.Height), (int)crop.Width, (int)crop.Height);
        }
    }

    /// <summary>The effective DPI of the monitor the window is on; 0 when it cannot be read.</summary>
    private static uint MonitorDpi(HWND hwnd)
    {
        var monitor = PInvoke.MonitorFromWindow(hwnd, MONITOR_FROM_FLAGS.MONITOR_DEFAULTTONEAREST);
        if (monitor.IsNull) return 0;
        return PInvoke.GetDpiForMonitor(monitor, MONITOR_DPI_TYPE.MDT_EFFECTIVE_DPI, out var dpiX, out _).Succeeded ? dpiX : 0;
    }

    private static HelperError NotResponding() =>
        new("screenshot_failed", "the window is not responding; nothing was captured");

    /// <summary>The window's thread answers a WM_NULL within the probe timeout.</summary>
    private static bool Responds(HWND hwnd)
    {
        if (PInvoke.IsHungAppWindow(hwnd)) return false;
        nuint result;
        if (PInvoke.SendMessageTimeout(hwnd, 0 /* WM_NULL */, 0, 0, SEND_MESSAGE_TIMEOUT_FLAGS.SMTO_ABORTIFHUNG, ProbeTimeoutMs, &result) != 0) return true;
        // Only a timeout means hung; a refused message (UIPI) is answered by
        // PrintWindow failing on its own.
        return System.Runtime.InteropServices.Marshal.GetLastPInvokeError() != 1460 /* ERROR_TIMEOUT */;
    }

    /// <summary>One PrintWindow into a private DIB, copied out as the cropped 32-bit pixels.</summary>
    private sealed class CaptureJob(HWND hwnd, int w, int h, Rect crop)
    {
        public ManualResetEventSlim Done { get; } = new(false);
        public byte[]? Pixels { get; private set; }
        public string? Error { get; private set; }
        private int abandoned, finished, released;

        /// <summary>The STA thread gave up on this job; it leaves the stuck count when it ends.</summary>
        public void Abandon()
        {
            Interlocked.Exchange(ref abandoned, 1);
            if (Volatile.Read(ref finished) == 1) LeaveStuck();
        }

        private void Finish()
        {
            Interlocked.Exchange(ref finished, 1);
            if (Volatile.Read(ref abandoned) == 1) LeaveStuck();
        }

        // Abandon and Finish can race; whichever sees both flags first counts it, once.
        private void LeaveStuck()
        {
            if (Interlocked.Exchange(ref released, 1) == 0) Interlocked.Decrement(ref stuckCaptures);
        }

        public void Run()
        {
            var mem = PInvoke.CreateCompatibleDC(HDC.Null);
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
                if (bitmap.IsNull || bits == null)
                {
                    Error = "could not allocate the capture bitmap";
                    return;
                }
                previous = PInvoke.SelectObject(mem, (HGDIOBJ)bitmap.Value);
                // The window's own rendering only. The screen is never copied:
                // a screen copy shows whatever covers the window, a blocked
                // app included. A window that renders nothing comes back black.
                if (!PInvoke.PrintWindow(hwnd, mem, (PRINT_WINDOW_FLAGS)2 /* PW_RENDERFULLCONTENT */))
                {
                    Error = "the window could not be captured";
                    return;
                }
                int stride = w * 4, cw = (int)crop.Width, ch = (int)crop.Height;
                var pixels = new byte[(long)cw * ch * 4];
                for (int y = 0; y < ch; y++)
                {
                    new ReadOnlySpan<byte>((byte*)bits + (long)(crop.Y + y) * stride + (long)crop.X * 4, cw * 4)
                        .CopyTo(pixels.AsSpan(y * cw * 4, cw * 4));
                }
                Pixels = pixels;
            }
            catch (Exception e)
            {
                Error = $"capture failed ({e.GetType().Name})";
            }
            finally
            {
                if (!previous.IsNull) PInvoke.SelectObject(mem, previous);
                if (!bitmap.IsNull) PInvoke.DeleteObject((HGDIOBJ)bitmap.Value);
                PInvoke.DeleteDC(mem);
                Done.Set();
                Finish();
            }
        }
    }

    /// <summary>Encodes `crop` of the captured pixels as the image of a `width` x `height` (physical) frame.</summary>
    private static JsonObject Encode(byte* bits, int stride, Rect crop, int width, int height)
    {
        int cw = (int)crop.Width, ch = (int)crop.Height;
        double scale = Geometry.ScreenshotScale(width, height);
        var (tw, th) = Geometry.ScaledSize(width, height, scale);
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
                // Image pixels per (physical) window pixel, from what was actually encoded.
                ["scale"] = (double)tw / width,
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
