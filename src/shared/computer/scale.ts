// Screenshot scaling and coordinate conversion for computer use.
//
// Agents click in the pixel space of the screenshot they were shown, not in
// the real window's space (they ignore a reported "real size"). So the
// screenshot is downscaled once with a known factor, the factor is recorded
// against the snapshot, and incoming coordinates are divided by it here. The
// helper then maps window logical points to screen coordinates itself, since
// only it knows the window origin and the monitor DPI.

/** Longest edge of a computer-use screenshot, in pixels. */
export const SCREENSHOT_MAX_LONG_EDGE = 1280;
/** Pixel budget — keeps one screenshot near the model's per-image token cost. */
export const SCREENSHOT_MAX_PIXELS = 1_150_000;

/**
 * Downscale factor for a window of `width` x `height` logical points:
 * `min(1, maxLongEdge / longEdge, sqrt(maxPixels / (w*h)))`. Never upscales.
 */
export function computeScreenshotScale(
  width: number,
  height: number,
  maxLongEdge = SCREENSHOT_MAX_LONG_EDGE,
  maxPixels = SCREENSHOT_MAX_PIXELS,
): number {
  if (!(width > 0) || !(height > 0)) return 1;
  const longEdge = Math.max(width, height);
  return Math.min(1, maxLongEdge / longEdge, Math.sqrt(maxPixels / (width * height)));
}

export interface ScaledSize {
  width: number;
  height: number;
}

/** The image size a window of `width` x `height` is captured at, for `scale`. */
export function scaledSize(width: number, height: number, scale: number): ScaledSize {
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface WindowPoint {
  x: number;
  y: number;
}

/**
 * Converts a point in screenshot pixels to window logical points. Returns null
 * when the point falls outside the screenshot, so a misread coordinate is
 * refused instead of landing on whatever is next to the window.
 */
export function screenshotPointToWindow(
  x: number,
  y: number,
  image: { width: number; height: number; scale: number },
): WindowPoint | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  if (!(image.scale > 0)) return null;
  return { x: x / image.scale, y: y / image.scale };
}
