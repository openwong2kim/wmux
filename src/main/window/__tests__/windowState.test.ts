// #1362 — restore decision for the main window's saved placement. Pure logic,
// no Electron: the display work areas are passed in.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planRestore,
  sanitizeWindowState,
  clampToWorkArea,
  loadWindowState,
  saveWindowState,
  getWindowStatePath,
  MIN_WINDOW_SIZE,
  type Rect,
  type WindowState,
} from '../windowState';

const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const SECOND: Rect = { x: 1920, y: 0, width: 1920, height: 1040 };

const state = (over: Partial<WindowState> = {}): WindowState => ({
  bounds: { x: 17, y: 38, width: 1781, height: 942 },
  maximized: false,
  fullScreen: false,
  ...over,
});

describe('planRestore', () => {
  it('restores a rectangle that still fits a live display', () => {
    const plan = planRestore(state({ maximized: true }), [PRIMARY]);
    expect(plan.bounds).toEqual({ x: 17, y: 38, width: 1781, height: 942 });
    expect(plan.maximized).toBe(true);
  });

  it('falls back to defaults when the saved rectangle is off every display', () => {
    // Saved on a second monitor that has since been unplugged.
    const plan = planRestore(state({ bounds: { ...SECOND, x: 2400, y: 100, width: 1200, height: 800 } }), [
      PRIMARY,
    ]);
    expect(plan.bounds).toBeUndefined();
    expect(plan.maximized).toBe(false);
    expect(plan.fullScreen).toBe(false);
  });

  it('falls back when only a sliver of the window overlaps a display', () => {
    const plan = planRestore(state({ bounds: { x: 1880, y: 500, width: 1200, height: 800 } }), [PRIMARY]);
    expect(plan.bounds).toBeUndefined();
  });

  it('ignores missing or malformed saved state', () => {
    expect(planRestore(null, [PRIMARY]).bounds).toBeUndefined();
    expect(planRestore({ bounds: { x: 0, y: 0, width: 'wide', height: 800 } }, [PRIMARY]).bounds).toBeUndefined();
    expect(sanitizeWindowState({ bounds: { x: 0, y: 0, width: 0, height: 800 } })).toBeNull();
  });

  it('clamps an oversized rectangle back inside the display and honours the minimums', () => {
    const plan = planRestore(state({ bounds: { x: -200, y: -100, width: 4000, height: 3000 } }), [PRIMARY]);
    expect(plan.bounds).toEqual({ x: 0, y: 0, width: PRIMARY.width, height: PRIMARY.height });
    expect(clampToWorkArea({ x: 0, y: 0, width: 100, height: 100 }, PRIMARY)).toEqual({
      x: 0,
      y: 0,
      width: MIN_WINDOW_SIZE.width,
      height: MIN_WINDOW_SIZE.height,
    });
  });

  it('never clamps below the window minimums, even on a tiny work area', () => {
    const tiny: Rect = { x: 0, y: 0, width: 640, height: 480 };
    expect(clampToWorkArea({ x: 10, y: 10, width: 1200, height: 900 }, tiny)).toEqual({
      x: 0,
      y: 0,
      width: MIN_WINDOW_SIZE.width,
      height: MIN_WINDOW_SIZE.height,
    });
  });

  it('picks the display the window mostly sits on', () => {
    const plan = planRestore(state({ bounds: { x: 2000, y: 40, width: 1200, height: 800 } }), [
      PRIMARY,
      SECOND,
    ]);
    expect(plan.bounds).toEqual({ x: 2000, y: 40, width: 1200, height: 800 });
  });
});

describe('windowState file', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-window-state-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips through the data-dir file', async () => {
    expect(loadWindowState(dir)).toBeNull();
    await saveWindowState(state({ fullScreen: true }), dir);
    expect(loadWindowState(dir)).toEqual(state({ fullScreen: true }));
  });

  it('treats a corrupt file as no saved state', () => {
    fs.writeFileSync(getWindowStatePath(dir), '{not json');
    expect(loadWindowState(dir)).toBeNull();
  });
});
