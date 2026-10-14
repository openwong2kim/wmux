// Screenshot scale (the formula of src/shared/computer/scale.ts) and the
// mapping of a screen pixel to SendInput's absolute virtual-desktop space.
//
// On Windows the helper is PerMonitorV2 DPI aware, so the protocol's "logical
// points" are physical pixels: window bounds, the screenshot's scale and the
// points main sends all use that one unit.

namespace WmuxComputerUse.Core;

public static class Geometry
{
    public const double ScreenshotMaxLongEdge = 1280;
    public const double ScreenshotMaxPixels = 1_150_000;

    public static double ScreenshotScale(double width, double height)
    {
        if (!(width > 0) || !(height > 0)) return 1;
        double longEdge = Math.Max(width, height);
        return Math.Min(1, Math.Min(ScreenshotMaxLongEdge / longEdge, Math.Sqrt(ScreenshotMaxPixels / (width * height))));
    }

    /// <summary>The image size a window of `width` x `height` is captured at, for `scale`.</summary>
    public static (int Width, int Height) ScaledSize(double width, double height, double scale) =>
        (Math.Max(1, (int)Math.Round(width * scale)), Math.Max(1, (int)Math.Round(height * scale)));

    /// <summary>
    /// The size a window of `width` x `height` physical pixels paints itself at
    /// through PrintWindow. A window that is not aware of its monitor's DPI
    /// (DPI-unaware, or system-aware on a monitor whose DPI differs from the
    /// system's) is DPI-virtualized: it paints at `windowDpi` and DWM stretches
    /// it to `monitorDpi` on screen, but PrintWindow gets the unstretched paint.
    /// The same size when either DPI is unknown or the two match.
    /// </summary>
    public static (int Width, int Height) PaintSize(int width, int height, uint windowDpi, uint monitorDpi)
    {
        if (windowDpi == 0 || monitorDpi == 0 || windowDpi == monitorDpi) return (width, height);
        double ratio = (double)windowDpi / monitorDpi;
        return (Math.Max(1, (int)Math.Round(width * ratio)), Math.Max(1, (int)Math.Round(height * ratio)));
    }

    /// <summary>
    /// `crop` (physical pixels inside a `width` x `height` window) in the
    /// window's paint space of `paintWidth` x `paintHeight`: scaled per axis,
    /// widened to whole pixels and kept inside the paint.
    /// </summary>
    public static Rect PaintCrop(Rect crop, int width, int height, int paintWidth, int paintHeight)
    {
        if (paintWidth == width && paintHeight == height) return crop;
        double sx = (double)paintWidth / width, sy = (double)paintHeight / height;
        double left = Math.Clamp(Math.Floor(crop.X * sx), 0, paintWidth);
        double top = Math.Clamp(Math.Floor(crop.Y * sy), 0, paintHeight);
        double right = Math.Clamp(Math.Ceiling(crop.Right * sx), left, paintWidth);
        double bottom = Math.Clamp(Math.Ceiling(crop.Bottom * sy), top, paintHeight);
        return new Rect(left, top, right - left, bottom - top);
    }

    /// <summary>
    /// A screen pixel on one axis to MOUSEEVENTF_ABSOLUTE | VIRTUALDESK
    /// coordinates: `(x - vsLeft) * 65535 / (vsWidth - 1)`, rounded and
    /// clamped, so the left and right edges of the virtual desktop (which may
    /// start at a negative coordinate) map to 0 and 65535.
    /// </summary>
    public static int NormalizeVirtualDesk(double pixel, int virtualOrigin, int virtualSize)
    {
        if (virtualSize <= 1) return 0;
        double n = (pixel - virtualOrigin) * 65535.0 / (virtualSize - 1);
        if (double.IsNaN(n)) return 0;
        return (int)Math.Clamp(Math.Round(n), 0, 65535);
    }
}
