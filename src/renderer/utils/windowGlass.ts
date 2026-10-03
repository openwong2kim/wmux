// Adapted from MonoCode (hardbeat920/monocode@6bd432ca,
// src/features/settings/model/appearance.ts), MIT License, Copyright (c) 2026 Nick
//
// Window glass follows the window, not just the platform: it is on only on
// macOS (where main gives the window a vibrancy material), only while the
// active theme is dark — a translucent light sidebar washes out its text — and
// only while macOS itself is dark. The material follows the system appearance,
// and Electron can only change that app-wide (nativeTheme), which would also
// flip every browser surface's prefers-color-scheme and the native menus; so a
// dark theme on a light Mac keeps an opaque frame instead. The flag is a
// `data-glass` attribute on <html>; globals.css turns the frame translucent
// under it while the sheet stays opaque.
import { isLight } from '../tailwindPalette';

export function shouldUseGlass(platform: string | undefined, bgBase: string, themeGlass = '1', systemDark = true): boolean {
  if (platform !== 'darwin' || !systemDark) return false;
  // A theme can opt out of translucency (THEME_STYLES.glass → --theme-glass).
  if (themeGlass.trim() === '0') return false;
  const hex = bgBase.trim();
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return false;
  return !isLight(hex);
}

function sync(root: HTMLElement, systemDark: boolean): void {
  const style = getComputedStyle(root);
  const on = shouldUseGlass(
    window.electronAPI?.platform,
    style.getPropertyValue('--bg-base'),
    style.getPropertyValue('--theme-glass') || '1',
    systemDark,
  );
  if (on) root.setAttribute('data-glass', '');
  else root.removeAttribute('data-glass');
}

/** Keep `data-glass` in step with the theme (data-theme or custom vars) and the system appearance. */
export function installWindowGlass(root: HTMLElement = document.documentElement): () => void {
  const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
  const run = () => sync(root, scheme ? scheme.matches : true);
  run();
  const observer = new MutationObserver(run);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style'] });
  scheme?.addEventListener?.('change', run);
  return () => {
    observer.disconnect();
    scheme?.removeEventListener?.('change', run);
  };
}
