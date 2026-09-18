// ─── Main window placement persistence (#1362) ───────────────────────────────
//
// wmux restores workspaces, panes, scrollback and agent conversations across a
// reboot; the window frame was the one piece that did not come back — every
// launch (including the relaunch after each auto-update) reopened at the fixed
// 1280x800 default in an OS-chosen position.
//
// One JSON file in the wmux data dir (`window-state.json`), written with the
// daemon's atomic-write primitives and honoring WMUX_DATA_SUFFIX isolation —
// the same pattern as deck-schedules.json. A separate file (not session.json)
// so dragging the window does not rewrite the session document.
//
// Everything in this module is pure/Electron-free except the two file helpers,
// so the restore decision is unit-testable without booting Electron: the
// Electron wiring in createWindow.ts only feeds it `screen.getAllDisplays()`
// rectangles and applies the result.

import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import {
  atomicReadJSONSync,
  atomicWriteJSON,
  atomicWriteJSONSync,
} from '../../daemon/util/atomicWrite';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  /** Always the NORMAL (un-maximized) rectangle — getNormalBounds(), not
   *  getBounds(): saving the maximized rect loses the restored size. */
  bounds: Rect;
  maximized: boolean;
  /** macOS native fullscreen. Restored only where it was recorded. */
  fullScreen: boolean;
}

/** Constructor defaults — the literals createWindow used before #1362. */
export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 800 } as const;
export const MIN_WINDOW_SIZE = { width: 800, height: 600 } as const;

export function getWindowStatePath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'window-state.json');
}

function finiteInt(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(v);
}

/** Parse an untrusted record (the file is hand-editable) into a WindowState,
 *  or null if it is not usable. */
export function sanitizeWindowState(raw: unknown): WindowState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const b = o.bounds;
  if (!b || typeof b !== 'object') return null;
  const r = b as Record<string, unknown>;
  const x = finiteInt(r.x);
  const y = finiteInt(r.y);
  const width = finiteInt(r.width);
  const height = finiteInt(r.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  return {
    bounds: { x, y, width, height },
    maximized: o.maximized === true,
    fullScreen: o.fullScreen === true,
  };
}

/** Overlap area of two rectangles (0 when they do not intersect). */
function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

/** A restored rectangle must land on a display that still exists, with enough
 *  of it visible to grab — a window restored off-screen is worse than a small
 *  one (monitor unplugged, laptop undocked, resolution changed). */
const MIN_VISIBLE_FRACTION = 0.2;
const MIN_VISIBLE_WIDTH = 120;
const MIN_VISIBLE_HEIGHT = 60;

export function isBoundsVisible(bounds: Rect, workAreas: Rect[]): boolean {
  const area = bounds.width * bounds.height;
  if (area <= 0) return false;
  for (const wa of workAreas) {
    const overlap = intersectionArea(bounds, wa);
    if (overlap <= 0) continue;
    const w = Math.min(bounds.x + bounds.width, wa.x + wa.width) - Math.max(bounds.x, wa.x);
    const h = Math.min(bounds.y + bounds.height, wa.y + wa.height) - Math.max(bounds.y, wa.y);
    if (w < MIN_VISIBLE_WIDTH || h < MIN_VISIBLE_HEIGHT) continue;
    // Fraction of whichever is smaller: a window LARGER than the display it
    // lands on (saved on a 4K monitor, reopened on a laptop) covers the whole
    // work area while being a small fraction of itself — that is fully
    // visible, not off-screen, and clamping fixes the size.
    const reference = Math.min(area, wa.width * wa.height);
    if (reference > 0 && overlap / reference >= MIN_VISIBLE_FRACTION) return true;
  }
  return false;
}

/** Work area the rectangle overlaps most, or null when it overlaps none. */
function bestWorkArea(bounds: Rect, workAreas: Rect[]): Rect | null {
  let best: Rect | null = null;
  let bestOverlap = 0;
  for (const wa of workAreas) {
    const overlap = intersectionArea(bounds, wa);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = wa;
    }
  }
  return best;
}

/** Clamp to minWidth/minHeight and to the work area it lands on, then pull a
 *  rectangle hanging off an edge back inside that work area. */
export function clampToWorkArea(bounds: Rect, workArea: Rect): Rect {
  // The minimum wins over the work area: BrowserWindow enforces
  // minWidth/minHeight anyway, so clamping below them would only produce a
  // position computed for a size the window will never have.
  const width = Math.max(Math.min(bounds.width, workArea.width), MIN_WINDOW_SIZE.width);
  const height = Math.max(Math.min(bounds.height, workArea.height), MIN_WINDOW_SIZE.height);
  const x = Math.max(
    Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    workArea.x,
  );
  const y = Math.max(
    Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
    workArea.y,
  );
  return { x, y, width, height };
}

export interface RestorePlan {
  /** Absent → let Electron place the window at the default size. */
  bounds?: Rect;
  maximized: boolean;
  fullScreen: boolean;
}

/**
 * Decide what to restore. Pure: `workAreas` are the current displays'
 * `workArea` rectangles from `screen.getAllDisplays()`.
 *
 * Falls back to the defaults (no bounds, no maximize, no fullscreen) whenever
 * the saved state is missing, unusable, or no longer intersects any display.
 */
export function planRestore(saved: unknown, workAreas: Rect[]): RestorePlan {
  const state = sanitizeWindowState(saved);
  if (!state || workAreas.length === 0) return { maximized: false, fullScreen: false };
  if (!isBoundsVisible(state.bounds, workAreas)) return { maximized: false, fullScreen: false };
  const wa = bestWorkArea(state.bounds, workAreas);
  if (!wa) return { maximized: false, fullScreen: false };
  return {
    bounds: clampToWorkArea(state.bounds, wa),
    maximized: state.maximized,
    fullScreen: state.fullScreen,
  };
}

/** Load the persisted state; a missing/corrupt file restores nothing. */
export function loadWindowState(dir?: string): WindowState | null {
  let raw: unknown;
  try {
    raw = atomicReadJSONSync<unknown>(getWindowStatePath(dir));
  } catch {
    return null;
  }
  return sanitizeWindowState(raw);
}

export async function saveWindowState(state: WindowState, dir?: string): Promise<void> {
  await atomicWriteJSON(getWindowStatePath(dir), state);
}

/** Sync variant for the `close` handler: the process may exit before an async
 *  write settles, and the last placement before quit is the one that matters. */
export function saveWindowStateSync(state: WindowState, dir?: string): void {
  atomicWriteJSONSync(getWindowStatePath(dir), state);
}
