// Adapted from MonoCode (hardbeat920/monocode@6bd432ca,
// src/features/settings/model/appearance.ts), MIT License, Copyright (c) 2026 Nick
//
// Window glass follows the window, not just the platform: it is on only where
// main gives the window a material (the vibrancy material on macOS, acrylic on
// Windows 11 22H2+; isWindowGlassSupported), only while the theme opts in and
// the user has not turned it off, and only while the app's appearance matches
// the theme. The material follows the app's appearance, so the renderer asks
// main to set that appearance from the theme (dark theme, dark material; light
// theme, light material) and turns glass on once the two agree. The flag is a
// `data-glass` attribute on <html>; globals.css turns the frame and the
// sidebar translucent under it while the panes stay opaque. On Windows the
// renderer also sends the level, so main switches the material at runtime,
// and sets the coverage itself: it is derived from the theme's tokens so the
// text stays legible over any backdrop (glassCoverage.ts), and a look that
// cannot be legible is opaque there, as if glass were Off.
import { isLight } from '../tailwindPalette';
import { windowsGlassMuted } from '../themes';
import {
  DEFAULT_WINDOW_GLASS,
  isWindowGlassSupported,
  resolveWindowGlass,
  type WindowGlassLevel,
} from '../../shared/windowGlass';
import { cssColorToHex, overlayColors } from './titlebarOverlay';
import { windowsGlassCoverage, type GlassCoverage, type GlassTokens } from './glassCoverage';

export {
  DEFAULT_WINDOW_GLASS,
  WINDOW_GLASS_LEVELS,
  resolveWindowGlass,
  type WindowGlassLevel,
} from '../../shared/windowGlass';

/** Whether this window can show glass: the preload's platform and Windows build. */
export function windowGlassSupported(): boolean {
  const api = typeof window === 'undefined' ? undefined : window.electronAPI;
  return isWindowGlassSupported(api?.platform, api?.windowsBuildNumber);
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
  windowsBuild: number | null = null,
): boolean {
  if (!isWindowGlassSupported(platform, windowsBuild) || level === 'off') return false;
  // A theme can opt out of translucency (THEME_STYLES.glass → --theme-glass).
  if (themeGlass.trim() === '0') return false;
  const appearance = themeAppearance(bgBase);
  if (!appearance) return false;
  // Until the material matches the theme, a light material would wash out a
  // dark frame (and the reverse), so the frame stays opaque.
  return (appearance === 'dark') === systemDark;
}

interface SyncState {
  /** The appearance last sent to main. */
  appearance: string | null;
  /** The glass level last sent to main (Windows). */
  level: WindowGlassLevel | null;
  /** The last Windows coverage worked out, by its inputs: the search is not free. */
  coverage: { key: string; value: GlassCoverage | null } | null;
}

/**
 * A colour token as `#rrggbb`, or null. `--frame-bg` defaults to
 * `var(--app-bg)`, a color-mix() that a custom property keeps unresolved, so
 * anything that is not already a plain colour is resolved through a hidden
 * probe's computed colour.
 */
function readColor(root: HTMLElement, style: CSSStyleDeclaration, name: string): string | null {
  const raw = style.getPropertyValue(name).trim();
  if (!raw) return null;
  const plain = cssColorToHex(raw);
  if (plain) return plain;
  const probe = root.ownerDocument.createElement('span');
  probe.style.display = 'none';
  probe.style.color = `var(${name})`;
  root.appendChild(probe);
  const resolved = cssColorToHex(getComputedStyle(probe).color);
  probe.remove();
  return resolved;
}

function readGlassTokens(root: HTMLElement, style: CSSStyleDeclaration): GlassTokens | null {
  const frameBg = readColor(root, style, '--frame-bg');
  const mantle = readColor(root, style, '--bg-mantle');
  const textMain = readColor(root, style, '--text-main');
  const textSub = readColor(root, style, '--text-sub');
  // The look's glass-only muted text (WINDOWS_GLASS_MUTED), which globals.css
  // paints only once Windows glass shows: the gate must judge the text glass
  // will draw, not the opaque value it replaces.
  const textMuted = windowsGlassMuted(root.getAttribute('data-theme')) ?? readColor(root, style, '--text-muted');
  return frameBg && mantle && textMain && textSub && textMuted
    ? { frameBg, mantle, textMain, textSub, textMuted }
    : null;
}

/** Set or clear an inline custom property only when it changes: the observer watches `style`, so a no-op write would sync again. */
function setInlineVar(root: HTMLElement, name: string, value: string | null): void {
  if (root.style.getPropertyValue(name) === (value ?? '')) return;
  if (value === null) root.style.removeProperty(name);
  else root.style.setProperty(name, value);
}

/**
 * The Windows coverage for the current look and level, or null when the look
 * cannot stay legible over glass (or its tokens cannot be read: legibility
 * wins, so that is opaque too).
 */
function windowsCoverage(
  root: HTMLElement,
  style: CSSStyleDeclaration,
  appearance: 'dark' | 'light',
  level: 'soft' | 'clear',
  last: SyncState,
): GlassCoverage | null {
  const tokens = readGlassTokens(root, style);
  if (!tokens) return null;
  const key = [appearance, level, tokens.frameBg, tokens.mantle, tokens.textMain, tokens.textSub, tokens.textMuted].join(' ');
  if (last.coverage?.key !== key) last.coverage = { key, value: windowsGlassCoverage(tokens, appearance, level) };
  return last.coverage.value;
}

function sync(
  root: HTMLElement,
  systemDark: boolean,
  last: SyncState,
  onAppearance?: (appearance: 'dark' | 'light') => void,
  onGlassLevel?: (level: WindowGlassLevel) => void,
): void {
  const style = getComputedStyle(root);
  const platform = window.electronAPI?.platform;
  const windowsBuild = window.electronAPI?.windowsBuildNumber ?? null;
  const supported = isWindowGlassSupported(platform, windowsBuild);
  const bgBase = style.getPropertyValue('--bg-base');
  const appearance = themeAppearance(bgBase);
  if (appearance) onAppearance?.(appearance);
  const themeGlass = style.getPropertyValue('--theme-glass') || '1';
  const chosen = resolveWindowGlass(root.getAttribute('data-glass-level'));
  // On Windows the look decides too: one that cannot show glass (opted out,
  // unreadable, or not legible over any backdrop) is treated as Off, so main
  // drops the acrylic and the transparent caption strip under an opaque page.
  const win32 = platform === 'win32' && supported;
  const coverage = win32 && chosen !== 'off' && appearance && themeGlass.trim() !== '0'
    ? windowsCoverage(root, style, appearance, chosen, last)
    : null;
  const level: WindowGlassLevel = win32 && !coverage ? 'off' : chosen;
  // With glass off the app goes back to the system appearance: overriding it
  // is app-wide (native menus, the in-app browser's prefers-color-scheme),
  // so it is only worth it while the material shows.
  const wanted = level === 'off' ? 'system' : appearance;
  if (supported && wanted && wanted !== last.appearance) {
    last.appearance = wanted;
    window.electronAPI?.window?.setAppearance?.(wanted);
  }
  const on = shouldUseGlass(platform, bgBase, themeGlass, systemDark, level, windowsBuild);
  // Windows coverage is inline on <html>; elsewhere the globals.css rules apply.
  setInlineVar(root, '--glass-frame', on && coverage ? `${coverage.frame}%` : null);
  setInlineVar(root, '--glass-sheet', on && coverage ? `${coverage.sheet}%` : null);
  // The value is the material's appearance, so CSS can tune a light material.
  if (on && appearance) root.setAttribute('data-glass', appearance);
  else root.removeAttribute('data-glass');
  // Windows switches the material at runtime (macOS keeps its vibrancy and
  // lets the page decide). Sent after `data-glass` moved, so the overlay pair
  // is the frame's paint for this level: the solid colour main restores when
  // glass goes off.
  if (win32 && level !== last.level) {
    last.level = level;
    window.electronAPI?.window?.setGlass?.({ level, ...(overlayColors() ?? {}) });
    onGlassLevel?.(level);
  }
}

/**
 * Keep `data-glass` and the app's appearance in step with the theme, the glass
 * level and the appearance. `onAppearance` hears the theme's polarity on every
 * sync, and `onGlassLevel` each level sent to main on Windows ('off' while the
 * theme blocks glass), both for the session save.
 */
export function installWindowGlass(
  root: HTMLElement = document.documentElement,
  onAppearance?: (appearance: 'dark' | 'light') => void,
  onGlassLevel?: (level: WindowGlassLevel) => void,
): () => void {
  const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
  const last: SyncState = { appearance: null, level: null, coverage: null };
  const run = () => sync(root, scheme ? scheme.matches : true, last, onAppearance, onGlassLevel);
  run();
  const observer = new MutationObserver(run);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style', 'data-glass-level'] });
  scheme?.addEventListener?.('change', run);
  return () => {
    observer.disconnect();
    scheme?.removeEventListener?.('change', run);
  };
}
