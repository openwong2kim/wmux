// Page zoom for browser panes. Cmd/Ctrl + = / - / 0 zoom the page while a
// browser pane is active, as in Chrome, and the terminal font everywhere else.
// The renderer routes the shortcut when the pane's chrome has focus; main
// catches the same keys inside the page, which never reach the renderer.

/** Chrome's zoom steps, so a page zooms in the steps users already know. */
export const PAGE_ZOOM_FACTORS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;

export type PageZoomStep = 'in' | 'out' | 'reset';

/** CustomEvent name BrowserPanel listens on to zoom its page. */
export const BROWSER_ZOOM_EVENT = 'wmux:browser-zoom';

export interface BrowserZoomDetail {
  surfaceId: string;
  step: PageZoomStep;
}

/** The next step from `current`; a factor between steps moves to the nearest one in that direction. */
export function stepPageZoom(current: number, step: PageZoomStep): number {
  if (step === 'reset' || !Number.isFinite(current)) return 1;
  const eps = 0.001;
  if (step === 'in') return PAGE_ZOOM_FACTORS.find((f) => f > current + eps) ?? PAGE_ZOOM_FACTORS[PAGE_ZOOM_FACTORS.length - 1];
  return [...PAGE_ZOOM_FACTORS].reverse().find((f) => f < current - eps) ?? PAGE_ZOOM_FACTORS[0];
}

/** The subset of Electron's `Input` the key match reads. */
export interface ZoomKeyInput {
  type: string;
  key: string;
  code?: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
}

/**
 * The zoom step a key press inside a page asks for, or null. Mirrors the
 * zoomIn / zoomOut / zoomReset defaults in keymap.ts (Cmd on macOS, Ctrl
 * elsewhere, shifted and numpad spellings included).
 */
export function pageZoomKey(input: ZoomKeyInput, platform: NodeJS.Platform): PageZoomStep | null {
  if (input.type !== 'keyDown' || input.alt) return null;
  const mod = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  if (!mod) return null;
  if (input.key === '=' || input.key === '+' || input.code === 'NumpadAdd') return 'in';
  if (input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract') return 'out';
  // By key, not code: with NumLock off the Numpad0 key is Insert (Ctrl+Insert copies).
  if (input.key === '0') return 'reset';
  return null;
}
