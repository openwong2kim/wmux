import { describe, expect, it, vi } from 'vitest';
import { createFirstResizeGate, primaryFontLoaded, FIRST_RESIZE_GATE_POLL_MS, type FirstResizeGateDeps } from '../firstResizeGate';

/** A pane whose font, renderer and fitted size the test moves frame by frame. */
function rig(initial: { shown?: boolean; font?: boolean; webglPending?: boolean; size?: string | null } = {}) {
  const state = { shown: true, font: false, webglPending: true, size: '122x40' as string | null, ...initial };
  const frames: Array<() => void> = [];
  const deps: FirstResizeGateDeps = {
    shown: () => state.shown,
    fontReady: () => state.font,
    rendererPending: () => state.webglPending,
    proposal: () => state.size,
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: () => { frames.length = 0; },
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (handle) => clearTimeout(handle),
  };
  const frame = () => { const run = frames.splice(0); for (const cb of run) cb(); };
  return { state, deps, frame, frames };
}

describe('createFirstResizeGate', () => {
  it('stays closed while the webfont loads and WebGL is due, then opens on the size that holds', async () => {
    vi.useFakeTimers();
    try {
      const { state, deps, frame } = rig();
      const gate = createFirstResizeGate(deps, 500);
      frame(); frame();
      expect(gate.isOpen).toBe(false); // fallback font: 122x40
      state.font = true; state.size = '115x44';
      frame(); frame();
      expect(gate.isOpen).toBe(false); // DOM cell, WebGL still due
      state.webglPending = false; state.size = '118x44';
      frame();
      expect(gate.isOpen).toBe(false); // first frame at 118x44
      frame();
      expect(gate.isOpen).toBe(true);
      await expect(gate.opened).resolves.toBe('settled');
    } finally { vi.useRealTimers(); }
  });

  it('opens at the bound when the font never loads, so a reattach cannot stall', async () => {
    vi.useFakeTimers();
    try {
      const { deps, frame } = rig();
      const gate = createFirstResizeGate(deps, 500);
      frame();
      vi.advanceTimersByTime(499);
      expect(gate.isOpen).toBe(false);
      vi.advanceTimersByTime(1);
      expect(gate.isOpen).toBe(true);
      await expect(gate.opened).resolves.toBe('bound');
    } finally { vi.useRealTimers(); }
  });

  it('waits on to the renderer bound when the font is in but the WebGL build is still queued', async () => {
    vi.useFakeTimers();
    try {
      const { state, deps, frame } = rig({ font: true });
      const gate = createFirstResizeGate(deps, 500, 1000);
      frame();
      vi.advanceTimersByTime(500);
      expect(gate.isOpen).toBe(false);
      vi.advanceTimersByTime(499);
      expect(gate.isOpen).toBe(false);
      vi.advanceTimersByTime(1);
      expect(gate.isOpen).toBe(true);
      await expect(gate.opened).resolves.toBe('bound');
      expect(state.webglPending).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('keeps the font bound when the font is not in, whatever the renderer', async () => {
    vi.useFakeTimers();
    try {
      const { deps, frame } = rig();
      const gate = createFirstResizeGate(deps, 500, 1000);
      frame();
      vi.advanceTimersByTime(500);
      expect(gate.isOpen).toBe(true);
      await expect(gate.opened).resolves.toBe('bound');
    } finally { vi.useRealTimers(); }
  });

  it('settles on timer polls when no frame comes (a window behind another one)', async () => {
    vi.useFakeTimers();
    try {
      const { state, deps } = rig({ font: true, webglPending: false, size: '118x44' });
      const gate = createFirstResizeGate(deps, 500);
      expect(gate.isOpen).toBe(false);
      vi.advanceTimersByTime(FIRST_RESIZE_GATE_POLL_MS);
      expect(gate.isOpen).toBe(true);
      await expect(gate.opened).resolves.toBe('settled');
      expect(state.size).toBe('118x44');
    } finally { vi.useRealTimers(); }
  });

  it('opens at once for a pane mounted hidden', async () => {
    const { deps, frames } = rig({ shown: false });
    const gate = createFirstResizeGate(deps, 500);
    expect(gate.isOpen).toBe(true);
    expect(frames).toHaveLength(0);
    await expect(gate.opened).resolves.toBe('immediate');
  });

  it('opens at once for a pane that cannot measure itself at mount', async () => {
    const { deps, frames } = rig({ size: null });
    const gate = createFirstResizeGate(deps, 500);
    expect(gate.isOpen).toBe(true);
    expect(frames).toHaveLength(0);
    await expect(gate.opened).resolves.toBe('immediate');
  });

  it('does not open on a frame that cannot be measured', () => {
    vi.useFakeTimers();
    try {
      const { state, deps, frame } = rig({ font: true, webglPending: false });
      const gate = createFirstResizeGate(deps, 500);
      state.size = null;
      frame(); frame(); frame();
      expect(gate.isOpen).toBe(false);
      state.size = '118x44';
      frame(); frame();
      expect(gate.isOpen).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('dispose opens it as disposed and stops the frames and the timer', async () => {
    vi.useFakeTimers();
    try {
      const { deps, frames } = rig();
      const gate = createFirstResizeGate(deps, 500);
      gate.dispose();
      expect(gate.isOpen).toBe(true);
      expect(frames).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      await expect(gate.opened).resolves.toBe('disposed');
    } finally { vi.useRealTimers(); }
  });
});

describe('primaryFontLoaded', () => {
  it('checks only the first family of the chain, at the terminal size', () => {
    const check = vi.fn(() => false);
    expect(primaryFontLoaded({ check }, "'Cascadia Code', 'JetBrains Mono Hangul', monospace", 13)).toBe(false);
    expect(check).toHaveBeenCalledWith("13px 'Cascadia Code'");
  });

  it('reads an empty or unparsable family as loaded', () => {
    expect(primaryFontLoaded({ check: () => false }, '', 13)).toBe(true);
    expect(primaryFontLoaded({ check: () => { throw new SyntaxError('bad'); } }, 'x', 13)).toBe(true);
  });
});
