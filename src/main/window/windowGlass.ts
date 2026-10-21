import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { parseWindowsBuildNumber } from '../../shared/platform';
import { WINDOW_START_COLORS, type StartPolarity } from '../../shared/windowStartPaint';
import {
  WINDOW_GLASS_LEVELS,
  isWindowGlassSupported,
  resolveWindowGlass,
  type WindowGlassLevel,
} from '../../shared/windowGlass';
import { winOverlayHeight } from './uiZoom';

/**
 * Windows window glass (DESIGN.md "Window glass"). On Windows 11 22H2+ the
 * window gets the acrylic backdrop behind a transparent background, the same
 * role the vibrancy material plays on macOS; the renderer then tints only the
 * frame and the sidebar over it (`data-glass`, globals.css) and the panes stay
 * opaque. Older Windows builds and glass Off keep the opaque window.
 *
 * Three native settings move together, or the window shows a seam:
 *   - the background material (`acrylic` or `none`);
 *   - the window background colour (transparent, or the opaque frame colour);
 *   - the titleBarOverlay colour: a solid strip would sit as a band across
 *     the glass behind the caption buttons, so it is transparent while glass
 *     is on. The renderer keeps sending the solid frame colour it paints, and
 *     main swaps in the transparent one here, so neither overlay sender
 *     (theme sync, UI-zoom sync) can repaint the band.
 *
 * Soft and Clear differ only in how much the page paints over the material,
 * so for main both mean acrylic.
 */

/** The opaque window's background and overlay colour: the default (Tint) theme's frame. */
export const WIN_OPAQUE_BACKGROUND = WINDOW_START_COLORS.dark.background;
/** The overlay's caption-button colour before the renderer sends the theme's. */
export const WIN_OVERLAY_SYMBOL = WINDOW_START_COLORS.dark.symbol;
export const TRANSPARENT = '#00000000';

/** Whether this Windows machine can show glass, from `os.release()`. False off Windows. */
export function windowsGlassSupported(platform: string, release: string): boolean {
  return platform === 'win32' && isWindowGlassSupported(platform, parseWindowsBuildNumber(release));
}

/**
 * Whether a new window starts with glass: supported, the persisted level is
 * not Off, and the window was not last shown opaque for its theme. The
 * renderer turns glass off on Windows for a theme whose text cannot stay
 * legible over it and saves that as `windowGlassEffective`; starting such a
 * launch with acrylic would show it until the renderer loads and then flip to
 * opaque. A session without the field (saved before it existed) follows the
 * level.
 */
export function initialWindowsGlass(supported: boolean, persistedLevel: unknown, persistedEffective?: unknown): boolean {
  return supported && resolveWindowGlass(persistedLevel) !== 'off' && persistedEffective !== 'off';
}

/**
 * The app appearance to set before a glass window is built. Acrylic takes its
 * tone from the app's appearance, which the renderer only sets once it has
 * loaded; until then a dark theme on a light Windows showed light acrylic for
 * the first frames. So main applies the polarity the renderer last saved
 * (`windowAppearance` in session.json). With no session at all (a first run,
 * `undefined`) that is dark, the default theme's. A session saved before the
 * polarity was, or an unknown value, gets null, as does a window that starts
 * opaque: the system appearance stays until the renderer sets it.
 */
export function initialWindowsAppearance(glass: boolean, persisted: unknown): 'dark' | 'light' | null {
  if (!glass) return null;
  if (persisted === 'dark' || persisted === 'light') return persisted;
  return persisted === undefined ? 'dark' : null;
}

/**
 * The win32 window options. With glass off the window is opaque: a solid
 * overlay strip and a solid background in the frame colour of the saved
 * polarity's default theme (shared/windowStartPaint.ts), so a light theme does
 * not start dark. It is also built hidden: Windows draws a window shown before
 * Chromium's first frame in the system's blank colour (#F3F3F3 on a light
 * system), which `backgroundColor` cannot cover, so createWindow shows it once
 * it has painted (#2512). With glass on the acrylic material covers those
 * frames, and the window is shown at once as before.
 */
export function winWindowOptions(glass: boolean, polarity: StartPolarity = 'dark'): Partial<BrowserWindowConstructorOptions> {
  // Height 40 = uiZoom's CHROME_H at zoom 1 (the scaled resync uses it).
  if (!glass) {
    const { background, symbol } = WINDOW_START_COLORS[polarity];
    return { titleBarStyle: 'hidden', titleBarOverlay: { color: background, symbolColor: symbol, height: 40 }, backgroundColor: background, show: false };
  }
  const titleBarOverlay = { color: TRANSPARENT, symbolColor: WIN_OVERLAY_SYMBOL, height: 40 };
  return { titleBarStyle: 'hidden', titleBarOverlay, backgroundColor: TRANSPARENT, backgroundMaterial: 'acrylic' };
}

// Glass state per window, so the overlay senders know which colour to use.
const glassOn = new WeakMap<BrowserWindow, boolean>();

/** Record the glass state a window was built with (createWindow). */
export function markWindowGlass(win: BrowserWindow, on: boolean): void {
  glassOn.set(win, on);
}

export function isWindowGlassOn(win: BrowserWindow): boolean {
  return glassOn.get(win) === true;
}

/** The overlay colour to apply: transparent while the window shows glass, else the renderer's solid one. */
export function overlayColorFor(win: BrowserWindow, solid: string): string {
  return isWindowGlassOn(win) ? TRANSPARENT : solid;
}

type GlassWindow = Pick<
  BrowserWindow,
  'setBackgroundMaterial' | 'setBackgroundColor' | 'setTitleBarOverlay' | 'webContents'
>;

/**
 * Switch a live window's glass for a new level: material, background colour
 * and overlay colour together. With glass off the background and the overlay
 * take `colors`, the renderer's solid pair (the frame colour it paints with
 * glass off), which the theme sync keeps current (applyTitleBarColors);
 * without it the construction pair. Returns false when the window already had
 * this state and nothing was called.
 */
export function applyWindowsGlass(
  win: BrowserWindow,
  level: WindowGlassLevel,
  colors?: { color: string; symbolColor: string },
): boolean {
  const on = level !== 'off';
  if (isWindowGlassOn(win) === on) return false;
  const w: GlassWindow = win;
  w.setBackgroundMaterial(on ? 'acrylic' : 'none');
  const solid = colors?.color ?? WIN_OPAQUE_BACKGROUND;
  w.setBackgroundColor(on ? TRANSPARENT : solid);
  w.setTitleBarOverlay({
    color: on ? TRANSPARENT : solid,
    symbolColor: colors?.symbolColor ?? WIN_OVERLAY_SYMBOL,
    height: winOverlayHeight(w.webContents.getZoomFactor()),
  });
  glassOn.set(win, on);
  return true;
}

/**
 * The theme sync's native calls (WINDOW_SET_TITLEBAR_OVERLAY): the overlay
 * strip in the frame colour the renderer paints, transparent while the window
 * shows glass. An opaque window's background takes that colour too. It shows
 * wherever the page has not painted (a window being enlarged, a renderer
 * restarting after a crash), so left at its start colour it would show the
 * polarity the window was built in after the theme changed (#2512).
 */
export function applyTitleBarColors(win: BrowserWindow, colors: { color: string; symbolColor: string }): void {
  const w: GlassWindow = win;
  const glass = isWindowGlassOn(win);
  if (!glass) w.setBackgroundColor(colors.color);
  w.setTitleBarOverlay({
    color: glass ? TRANSPARENT : colors.color,
    symbolColor: colors.symbolColor,
    height: winOverlayHeight(w.webContents.getZoomFactor()),
  });
}

/**
 * Whether main follows the renderer's appearance request: macOS always (the
 * vibrancy material), Windows only where it can show glass (the acrylic tint
 * follows the app's appearance). Elsewhere overriding the appearance would
 * change native menus and the in-app browser for nothing.
 */
export function appearanceFollowsTheme(platform: string, windowsGlass: boolean): boolean {
  return platform === 'darwin' || (platform === 'win32' && windowsGlass);
}

/**
 * The WINDOW_SET_APPEARANCE handler: set the app's appearance from the
 * renderer's request where it follows the theme. Trust boundary: only
 * 'dark', 'light' or 'system' reach `themeSource`. Returns whether it changed.
 */
export function applyAppearance(
  theme: { themeSource: 'system' | 'light' | 'dark' },
  appearance: unknown,
  platform: string,
  windowsGlass: boolean,
): boolean {
  if (!appearanceFollowsTheme(platform, windowsGlass)) return false;
  if (appearance !== 'dark' && appearance !== 'light' && appearance !== 'system') return false;
  if (theme.themeSource === appearance) return false;
  theme.themeSource = appearance;
  return true;
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * The WINDOW_SET_GLASS payload, validated: a known level, and the overlay
 * pair only when both are #RGB/#RRGGBB (a malformed colour must never reach
 * the native setters, which throw). Null for anything else.
 */
export function parseGlassRequest(
  opts: unknown,
): { level: WindowGlassLevel; colors?: { color: string; symbolColor: string } } | null {
  if (!opts || typeof opts !== 'object') return null;
  const { level, color, symbolColor } = opts as { level?: unknown; color?: unknown; symbolColor?: unknown };
  if (!WINDOW_GLASS_LEVELS.includes(level as WindowGlassLevel)) return null;
  const colors =
    typeof color === 'string' && HEX_COLOR.test(color) &&
    typeof symbolColor === 'string' && HEX_COLOR.test(symbolColor)
      ? { color, symbolColor }
      : undefined;
  return { level: level as WindowGlassLevel, ...(colors ? { colors } : {}) };
}
