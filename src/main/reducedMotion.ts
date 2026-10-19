// ─── Windows' reduced-motion setting, which the renderer misses ─────────────
//
// With Windows' "Animation effects" off (SPI_SETCLIENTAREAANIMATION), wmux's
// renderer still reports `prefers-reduced-motion: no-preference`, so every
// reduced-motion rule in the app is inert there (Edge, on the same machine,
// reports `reduce`). Main reads the setting through Electron and the renderer
// mirrors it as `data-reduced-motion` on its root (renderer/utils/
// reducedMotion.ts), which the CSS honours next to the media query.
// macOS and Linux are left to the media query, which works there.
import type { AnimationSettings } from 'electron';

/** Whether the system asks for reduced motion, on Windows; false elsewhere
 *  and when the setting cannot be read. Pure but for `read`. */
export function systemPrefersReducedMotion(
  platform: NodeJS.Platform,
  read: () => Pick<AnimationSettings, 'shouldRenderRichAnimation'>,
): boolean {
  if (platform !== 'win32') return false;
  try {
    const settings = read();
    // shouldRenderRichAnimation reads SPI_GETCLIENTAREAANIMATION on every
    // call; prefersReducedMotion is derived from it once and may be stale
    // (true after the setting was turned back on), so the live one decides.
    return settings.shouldRenderRichAnimation === false;
  } catch {
    return false;
  }
}
