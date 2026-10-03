// Adapted from MonoCode (hardbeat920/monocode@6bd432ca,
// src/features/settings/model/appearance.ts), MIT License, Copyright (c) 2026 Nick
//
// Window glass follows the window, not just the platform: it is on only on
// macOS (where main gives the window a vibrancy material) and only while the
// active theme is dark — a translucent light sidebar washes out its text. The
// flag is a `data-glass` attribute on <html>; globals.css turns the chrome
// tint translucent under it while the workspace frame stays opaque.
import { isLight } from '../tailwindPalette';

export function shouldUseGlass(platform: string | undefined, bgBase: string, themeGlass = '1'): boolean {
  if (platform !== 'darwin') return false;
  // A theme can opt out of translucency (THEME_STYLES.glass → --theme-glass).
  if (themeGlass.trim() === '0') return false;
  const hex = bgBase.trim();
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return false;
  return !isLight(hex);
}

let lastSent: boolean | null = null;

function sync(root: HTMLElement): void {
  const style = getComputedStyle(root);
  const on = shouldUseGlass(
    window.electronAPI?.platform,
    style.getPropertyValue('--bg-base'),
    style.getPropertyValue('--theme-glass') || '1',
  );
  if (on) root.setAttribute('data-glass', '');
  else root.removeAttribute('data-glass');
  // The material follows the native appearance: pin it dark under a dark
  // theme, hand it back to the system otherwise.
  if (on !== lastSent) {
    lastSent = on;
    window.electronAPI?.window?.setGlassAppearance?.(on);
  }
}

/** Keep `data-glass` in step with the theme (data-theme or custom vars). */
export function installWindowGlass(root: HTMLElement = document.documentElement): () => void {
  sync(root);
  const observer = new MutationObserver(() => sync(root));
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style'] });
  return () => observer.disconnect();
}
