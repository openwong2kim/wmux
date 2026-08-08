import type { BrowserWindow } from 'electron';

/**
 * UI zoom (#822 prototype) — scale the whole renderer, then re-place the
 * native window controls so DESIGN.md's 36px chrome module still lines up.
 *
 * The premise under test: "trafficLightPosition and titleBarOverlay are in OS
 * coordinates and do not follow a renderer zoom, so zoom desyncs the custom
 * titlebar from the native controls." The first half is true. The second half
 * only holds if the positions are write-once — they are not. Both are runtime
 * setters, and the titleBarOverlay one is already wired for theme changes
 * (registerHandlers.ts), so the resync rides an existing path.
 *
 * Coordinate note (this is the whole trick): `setZoomFactor` scales CSS px,
 * so the renderer's 36px bar occupies `36 * z` window points. The native
 * controls do NOT scale — traffic lights stay ~14pt tall at any zoom. So the
 * y-offset that centers them is `(36 * z - LIGHTS_H) / 2`, not `11 * z`.
 * Scaling the offset instead of re-centering is what actually desyncs.
 */

/** Custom titlebar height in CSS px — DESIGN.md's chrome module. */
const CHROME_H = 36;
/** Rendered height of the macOS traffic-light cluster, in window points. */
const MAC_LIGHTS_H = 14;
/** Left inset of the traffic lights at zoom 1. */
const MAC_LIGHTS_X = 12;

export const UI_ZOOM_MIN = 0.8;
export const UI_ZOOM_MAX = 1.6;

/** Clamp to the supported range; non-finite input falls back to 1. */
export function clampUiZoom(factor: unknown): number {
  const n = typeof factor === 'number' ? factor : Number.NaN;
  if (!Number.isFinite(n)) return 1;
  return Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, n));
}

/**
 * Where the traffic lights must sit so they stay vertically centered in a
 * titlebar that the renderer draws `CHROME_H * zoom` points tall.
 *
 * Exported for the unit test: this is the one piece of arithmetic that decides
 * whether the premise holds, so it is verified without booting Electron.
 */
export function macTrafficLightPosition(zoom: number): { x: number; y: number } {
  const barH = CHROME_H * zoom;
  return {
    x: Math.round(MAC_LIGHTS_X * zoom),
    y: Math.max(0, Math.round((barH - MAC_LIGHTS_H) / 2)),
  };
}

/** Native titleBarOverlay height matching the scaled chrome row (Windows). */
export function winOverlayHeight(zoom: number): number {
  return Math.round(CHROME_H * zoom);
}

/**
 * Apply a zoom factor and re-place the native chrome to match.
 *
 * Every native call is guarded: these APIs exist only on the platform whose
 * window options requested them, and a cosmetic resync must never crash main
 * (same posture as the existing setTitleBarOverlay handler).
 */
export function applyUiZoom(
  win: BrowserWindow,
  factor: number,
  overlayColors?: { color: string; symbolColor: string },
): number {
  const zoom = clampUiZoom(factor);
  if (win.isDestroyed()) return zoom;

  win.webContents.setZoomFactor(zoom);

  if (process.platform === 'darwin') {
    try {
      win.setWindowButtonPosition(macTrafficLightPosition(zoom));
    } catch {
      // Window created without titleBarStyle:'hidden' — nothing to re-place.
    }
  }

  if (process.platform === 'win32' && overlayColors) {
    try {
      win.setTitleBarOverlay({ ...overlayColors, height: winOverlayHeight(zoom) });
    } catch {
      // Window created without titleBarOverlay (flag/rollback path).
    }
  }

  return zoom;
}
