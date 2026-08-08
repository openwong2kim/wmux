import { describe, it, expect, vi } from 'vitest';
import {
  clampUiZoom,
  macTrafficLightPosition,
  winOverlayHeight,
  applyUiZoom,
  UI_ZOOM_MIN,
  UI_ZOOM_MAX,
} from '../uiZoom';

/**
 * #822 — the arithmetic that decides whether UI zoom can keep the native
 * window controls aligned with DESIGN.md's 36px chrome module.
 *
 * The plan's rejected-alternative claim was that the native controls "do not
 * follow a renderer zoom", so zoom desyncs the titlebar. These cases pin the
 * correction: the controls are re-placeable, and the offset must be
 * RE-CENTERED against the scaled bar, not itself scaled. Scaling the y-offset
 * (11 → 15.4 at 1.4) is what produces the desync the plan feared.
 */

describe('clampUiZoom', () => {
  it('clamps below the minimum and above the maximum', () => {
    expect(clampUiZoom(0.1)).toBe(UI_ZOOM_MIN);
    expect(clampUiZoom(9)).toBe(UI_ZOOM_MAX);
  });

  it('passes valid values through and falls back to 1 on garbage', () => {
    expect(clampUiZoom(1.4)).toBe(1.4);
    expect(clampUiZoom(Number.NaN)).toBe(1);
    expect(clampUiZoom('1.4')).toBe(1);
    expect(clampUiZoom(undefined)).toBe(1);
  });
});

describe('macTrafficLightPosition', () => {
  it('reproduces the shipped position at zoom 1', () => {
    // createWindow.ts uses { x: 12, y: 11 } — (36 - 14) / 2 = 11.
    expect(macTrafficLightPosition(1)).toEqual({ x: 12, y: 11 });
  });

  it('re-centers rather than scaling the y-offset', () => {
    // At 1.4 the renderer's bar is 50.4pt tall; the 14pt lights center at 18.2.
    // The naive "scale the offset" answer would be 11 * 1.4 = 15.4 — 3pt high,
    // which is exactly the desync the plan cited as the blocker.
    const { y } = macTrafficLightPosition(1.4);
    expect(y).toBe(18);
    expect(y).not.toBe(Math.round(11 * 1.4));
  });

  it('never returns a negative offset when the bar is smaller than the lights', () => {
    expect(macTrafficLightPosition(0.2).y).toBe(0);
  });
});

describe('winOverlayHeight', () => {
  it('tracks the scaled chrome row', () => {
    expect(winOverlayHeight(1)).toBe(36);
    expect(winOverlayHeight(1.4)).toBe(50);
  });
});

describe('applyUiZoom', () => {
  // Minimal BrowserWindow stub — applyUiZoom touches only these three calls
  // plus isDestroyed(). The IPC handler (registerHandlers) forwards the
  // renderer's {factor, color, symbolColor} payload here; this guards the
  // contract that zoom is always applied (clamped) while the chrome resync
  // rides the platform guards inside applyUiZoom.
  function makeWin() {
    return {
      isDestroyed: () => false,
      webContents: { setZoomFactor: vi.fn() },
      setWindowButtonPosition: vi.fn(),
      setTitleBarOverlay: vi.fn(),
    };
  }

  it('applies the clamped factor to setZoomFactor and returns it', () => {
    const win = makeWin();
    const applied = applyUiZoom(win as never, 9, undefined);
    expect(applied).toBe(UI_ZOOM_MAX);
    expect(win.webContents.setZoomFactor).toHaveBeenCalledWith(UI_ZOOM_MAX);
  });

  it('no-ops on a destroyed window without throwing', () => {
    const win = makeWin();
    win.isDestroyed = () => true;
    const applied = applyUiZoom(win as never, 1.4, undefined);
    expect(applied).toBe(1.4);
    expect(win.webContents.setZoomFactor).not.toHaveBeenCalled();
  });
});
