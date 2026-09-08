/**
 * #1133 — window transparency preferences.
 *
 * Two independent knobs, one composited effect:
 *   - `opacity`  — how much of the theme's `--bg-base` is painted over the
 *                  desktop (100 = fully opaque, today's behaviour). Applies to
 *                  any platform whose window was created `transparent: true`.
 *   - `material` — Windows 11 only: the system-composited backdrop (mica /
 *                  acrylic) behind that tint, at near-zero GPU cost.
 *
 * Main is the authority (the window must be created `transparent: true` BEFORE
 * the renderer boots — the flag cannot be toggled on a live window), so the
 * durable copy lives in main's `window-appearance.json`, not session.json.
 * The renderer keeps only a mirror for the Settings UI.
 *
 * Platform note: everything here must stay parameter-free at module scope —
 * this module is imported by both main and the sandboxed renderer.
 */

/** Electron `setBackgroundMaterial` vocabulary, restricted to what we expose. */
export type WindowMaterial = 'none' | 'mica' | 'acrylic';

export interface WindowAppearancePrefs {
  /** 0–100: percent of `--bg-base` painted. Below 100 needs a translucent window. */
  opacity: number;
  material: WindowMaterial;
}

export const DEFAULT_WINDOW_APPEARANCE: WindowAppearancePrefs = {
  opacity: 100,
  material: 'none',
};

/** The lowest opacity the Settings slider offers — below this the window is
 *  unreadable on any real background; the normalizer still accepts lower
 *  values from a hand-edited file rather than silently rewriting them. */
export const WINDOW_OPACITY_SLIDER_MIN = 30;

export function isWindowMaterial(value: unknown): value is WindowMaterial {
  return value === 'none' || value === 'mica' || value === 'acrylic';
}

/**
 * Coerce anything (disk JSON, IPC args) into a valid prefs object. Unknown
 * fields fall back to the defaults one field at a time — a corrupt opacity
 * must not also lose the material, and vice versa.
 */
export function normalizeWindowAppearance(raw: unknown): WindowAppearancePrefs {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    opacity?: unknown;
    material?: unknown;
  };
  const opacity = typeof obj.opacity === 'number' && Number.isFinite(obj.opacity)
    ? Math.min(100, Math.max(0, Math.round(obj.opacity)))
    : DEFAULT_WINDOW_APPEARANCE.opacity;
  const material = isWindowMaterial(obj.material) ? obj.material : DEFAULT_WINDOW_APPEARANCE.material;
  return { opacity, material };
}

/**
 * Whether the window must be CREATED `transparent: true`. That flag is
 * creation-only in Chromium, so this is the restart-gated predicate: a prefs
 * change that flips this return value applies on the next window, not now.
 * (Material 'none' with opacity 100 is exactly today's opaque behaviour.)
 */
export function windowNeedsTransparentCreation(prefs: WindowAppearancePrefs): boolean {
  return prefs.opacity < 100 || prefs.material !== 'none';
}
