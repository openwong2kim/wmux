// Adapted from MonoCode (hardbeat920/monocode@6bd432ca,
// src/features/settings/model/appearance.ts), MIT License, Copyright (c) 2026 Nick
//
// Window glass follows the window, not just the platform: it is on only on
// macOS (where main gives the window a vibrancy material), only while the
// theme opts in and the user has not turned it off, and only while the app's
// appearance matches the theme. The material follows the app's appearance, so
// the renderer asks main to set that appearance from the theme (dark theme,
// dark material; light theme, light material) and turns glass on once the
// two agree. The flag is a `data-glass` attribute on <html>; globals.css turns
// the frame and the sidebar translucent under it while the panes stay opaque.
import { isLight } from '../tailwindPalette';

export type WindowGlassLevel = 'off' | 'soft' | 'clear';
export const WINDOW_GLASS_LEVELS: readonly WindowGlassLevel[] = ['off', 'soft', 'clear'];
export const DEFAULT_WINDOW_GLASS: WindowGlassLevel = 'soft';

/** Persisted values are whitelisted on load; anything else is the default. */
export function resolveWindowGlass(value: unknown): WindowGlassLevel {
  return WINDOW_GLASS_LEVELS.includes(value as WindowGlassLevel) ? value as WindowGlassLevel : DEFAULT_WINDOW_GLASS;
}

/** The theme's polarity from its base colour, or null while it cannot be read. */
export function themeAppearance(bgBase: string): 'dark' | 'light' | null {
  const hex = bgBase.trim();
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return isLight(hex) ? 'light' : 'dark';
}

export function shouldUseGlass(
  platform: string | undefined,
  bgBase: string,
  themeGlass = '1',
  systemDark = true,
  level: WindowGlassLevel = DEFAULT_WINDOW_GLASS,
): boolean {
  if (platform !== 'darwin' || level === 'off') return false;
  // A theme can opt out of translucency (THEME_STYLES.glass → --theme-glass).
  if (themeGlass.trim() === '0') return false;
  const appearance = themeAppearance(bgBase);
  if (!appearance) return false;
  // Until the material matches the theme, a light material would wash out a
  // dark frame (and the reverse), so the frame stays opaque.
  return (appearance === 'dark') === systemDark;
}

function sync(root: HTMLElement, systemDark: boolean, lastAppearance: { value: string | null }): void {
  const style = getComputedStyle(root);
  const platform = window.electronAPI?.platform;
  const bgBase = style.getPropertyValue('--bg-base');
  const appearance = themeAppearance(bgBase);
  const level = resolveWindowGlass(root.getAttribute('data-glass-level'));
  // With glass off the app goes back to the system appearance: overriding it
  // is app-wide (native menus, the in-app browser's prefers-color-scheme),
  // so it is only worth it while the material shows.
  const wanted = level === 'off' ? 'system' : appearance;
  if (platform === 'darwin' && wanted && wanted !== lastAppearance.value) {
    lastAppearance.value = wanted;
    window.electronAPI?.window?.setAppearance?.(wanted);
  }
  const on = shouldUseGlass(platform, bgBase, style.getPropertyValue('--theme-glass') || '1', systemDark, level);
  // The value is the material's appearance, so CSS can tune a light material.
  if (on && appearance) root.setAttribute('data-glass', appearance);
  else root.removeAttribute('data-glass');
}

/** Keep `data-glass` and the app's appearance in step with the theme, the glass level and the appearance. */
export function installWindowGlass(root: HTMLElement = document.documentElement): () => void {
  const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
  const lastAppearance = { value: null as string | null };
  const run = () => sync(root, scheme ? scheme.matches : true, lastAppearance);
  run();
  const observer = new MutationObserver(run);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style', 'data-glass-level'] });
  scheme?.addEventListener?.('change', run);
  return () => {
    observer.disconnect();
    scheme?.removeEventListener?.('change', run);
  };
}
