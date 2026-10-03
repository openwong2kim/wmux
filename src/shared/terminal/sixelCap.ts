/**
 * Enforce an image addon's pixelLimit on the FINISHED sixel image.
 *
 * @xterm/addon-image's decoder bounds the memory it keeps while decoding, not
 * the canvas the addon builds from it in the sixel handler's unhook (width x
 * height x 4 bytes). So the size is checked first, before unhook reads the
 * pixels or creates the canvas, and an image over the limit is dropped the way
 * the addon drops a payload over sixelSizeLimit.
 *
 * Shared by the desktop renderer (src/renderer/terminal/inlineImages.ts) and
 * the browser terminal (src/daemon/web/frontend/inlineImages.js, through the
 * `wmuxTerminalShared` bundle).
 *
 * Reaches into the addon's private handler map (0.9.x). Returns false when
 * that shape is missing; the caller then loads the addon without sixel rather
 * than without the cap. A decoder without a readable size drops the image.
 */

/** The part of the addon's sixel decoder the cap reads. */
interface SixelDecoder {
  readonly width: number;
  readonly height: number;
  release(): void;
}

interface SixelHandler {
  _dec?: SixelDecoder;
  _aborted?: boolean;
  unhook(success: boolean): boolean | Promise<boolean>;
}

/** The part of an `ImageAddon` the cap reads. */
export interface SixelCapAddon {
  _handlers?: { get(key: string): unknown };
}

export function capSixelImageSize(addon: SixelCapAddon, pixelLimit: number): boolean {
  const handlers = addon._handlers;
  const handler = handlers && typeof handlers.get === 'function'
    ? handlers.get('sixel') as SixelHandler | undefined
    : undefined;
  if (!handler || typeof handler.unhook !== 'function') return false;
  const unhook = handler.unhook;
  handler.unhook = (success: boolean) => {
    if (success && !handler._aborted) {
      const dec = handler._dec;
      const width = dec?.width;
      const height = dec?.height;
      // A decoder whose size cannot be read is dropped too: the cap must not
      // depend on the addon keeping this shape.
      if (!dec || !Number.isFinite(width) || !Number.isFinite(height) || (width as number) * (height as number) > pixelLimit) {
        handler._aborted = true;
        try { dec?.release(); } catch { /* nothing held */ }
        return true;
      }
    }
    return unhook.call(handler, success);
  };
  return true;
}
