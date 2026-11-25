import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

vi.mock('electron', () => ({ nativeImage: { createFromBitmap: vi.fn() } }));

import {
  overlayBadgeText,
  overlayDescription,
  renderBadgeBitmap,
  TaskbarStatus,
  PROGRESS_DEBOUNCE_MS,
  type TaskbarSink,
} from '../taskbarStatus';

describe('overlayBadgeText', () => {
  it('clears at 0 and below, numbers 1–9, caps at "9+"', () => {
    expect(overlayBadgeText(0)).toBeNull();
    expect(overlayBadgeText(-3)).toBeNull();
    expect(overlayBadgeText(Number.NaN)).toBeNull();
    expect(overlayBadgeText(1)).toBe('1');
    expect(overlayBadgeText(9)).toBe('9');
    expect(overlayBadgeText(10)).toBe('9+');
    expect(overlayBadgeText(1234)).toBe('9+');
  });

  it('gives the overlay a readable description with the real count', () => {
    expect(overlayDescription(1)).toBe('wmux: 1 unread notification');
    expect(overlayDescription(12)).toBe('wmux: 12 unread notifications');
  });
});

describe('renderBadgeBitmap', () => {
  it('draws an opaque centre, transparent corners, and white glyph pixels on grey', () => {
    for (const size of [16, 32]) {
      const buf = renderBadgeBitmap('9+', size);
      expect(buf.length).toBe(size * size * 4);
      expect(buf[3]).toBe(0); // top-left corner is outside the circle
      const alphaAt = (x: number, y: number) => buf[(y * size + x) * 4 + 3];
      expect(alphaAt(size / 2, size / 2)).toBe(255);
      // Some pixels are the white glyph, some the grey fill.
      let ink = 0;
      let fill = 0;
      for (let i = 0; i < buf.length; i += 4) {
        if (buf[i + 3] !== 255) continue;
        if (buf[i + 2] === 0xff) ink++;
        else fill++;
      }
      expect(ink).toBeGreaterThan(0);
      expect(fill).toBeGreaterThan(ink);
    }
  });
});

function harness() {
  const overlay = vi.fn<(text: string | null, description: string) => void>();
  const progress = vi.fn<(running: boolean) => void>();
  const sink: TaskbarSink = { setOverlay: overlay, setProgress: progress };
  vi.useFakeTimers();
  const status = new TaskbarStatus({
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  status.bind(sink);
  return { status, overlay, progress };
}

describe('TaskbarStatus', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('applies nothing until the renderer has sent the setting once', () => {
    const { status, overlay, progress } = harness();
    status.setCount(3);
    expect(overlay).not.toHaveBeenCalled();
    status.setState({ enabled: true, running: true });
    expect(overlay).toHaveBeenLastCalledWith('3', 'wmux: 3 unread notifications');
    expect(progress).toHaveBeenLastCalledWith(true);
  });

  it('never shows anything when the first setting is off', () => {
    const { status, overlay, progress } = harness();
    status.setCount(3);
    status.setState({ enabled: false, running: true });
    status.setCount(4);
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS * 2);
    expect(overlay.mock.calls.every(([text]) => text === null)).toBe(true);
    expect(progress.mock.calls.every(([running]) => running === false)).toBe(true);
  });

  it('follows the count, clears at 0, and refreshes the description under an unchanged label', () => {
    const { status, overlay } = harness();
    status.setState({ enabled: true, running: false });
    overlay.mockClear();
    status.setCount(12);
    status.setCount(15); // still "9+", new description
    status.setCount(15); // nothing new
    status.setCount(0);
    expect(overlay.mock.calls).toEqual([
      ['9+', 'wmux: 12 unread notifications'],
      ['9+', 'wmux: 15 unread notifications'],
      [null, ''],
    ]);
  });

  it('a late close of the old window does not unbind the window adopted after it', () => {
    const { status } = harness();
    const oldSink: TaskbarSink = { setOverlay: vi.fn(), setProgress: vi.fn() };
    const newSink: TaskbarSink = { setOverlay: vi.fn(), setProgress: vi.fn() };
    status.setState({ enabled: true, running: false });
    status.bind(oldSink);
    status.bind(newSink); // recovery window adopted
    status.unbind(oldSink); // old window's 'closed' fires afterwards
    status.setCount(4);
    expect(newSink.setOverlay).toHaveBeenLastCalledWith('4', 'wmux: 4 unread notifications');
    expect(oldSink.setOverlay).not.toHaveBeenCalledWith('4', expect.anything());
    status.unbind(newSink);
    status.setCount(5);
    expect(newSink.setOverlay).not.toHaveBeenCalledWith('5', expect.anything());
  });

  it('every bound window carries the overlay and progress, so a grouped taskbar button still shows them', () => {
    const { status, overlay, progress } = harness();
    const second: TaskbarSink = { setOverlay: vi.fn(), setProgress: vi.fn() };
    status.bind(second);
    status.setCount(2);
    status.setState({ enabled: true, running: false });
    status.setState({ enabled: true, running: true });
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS);
    for (const [setOverlay, setProgress] of [[overlay, progress], [second.setOverlay, second.setProgress]]) {
      expect(setOverlay).toHaveBeenLastCalledWith('2', 'wmux: 2 unread notifications');
      expect(setProgress).toHaveBeenLastCalledWith(true);
    }
    status.setState({ enabled: false, running: true });
    expect(progress).toHaveBeenLastCalledWith(false);
    expect(second.setProgress).toHaveBeenLastCalledWith(false);
  });

  it('debounces the progress state so a quick flip does not flicker', () => {
    const { status, progress } = harness();
    status.setState({ enabled: true, running: false });
    progress.mockClear();
    status.setState({ enabled: true, running: true });
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS - 100);
    status.setState({ enabled: true, running: false });
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS * 2);
    expect(progress).not.toHaveBeenCalled();

    status.setState({ enabled: true, running: true });
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS - 1);
    expect(progress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(progress).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('turning the setting off clears both at once and cancels a pending change', () => {
    const { status, overlay, progress } = harness();
    status.setCount(2);
    status.setState({ enabled: true, running: false });
    status.setState({ enabled: true, running: true }); // pending
    overlay.mockClear();
    progress.mockClear();
    status.setState({ enabled: false, running: true });
    expect(overlay).toHaveBeenCalledExactlyOnceWith(null, '');
    expect(progress).toHaveBeenCalledExactlyOnceWith(false);
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS * 2);
    status.setCount(5);
    expect(overlay).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledTimes(1);
  });

  it('re-applies the current state when the window is bound again', () => {
    const { status, overlay, progress } = harness();
    status.setCount(1);
    status.setState({ enabled: true, running: true });
    overlay.mockClear();
    progress.mockClear();
    const sink2: TaskbarSink = { setOverlay: vi.fn(), setProgress: vi.fn() };
    status.bind(sink2);
    expect(sink2.setOverlay).toHaveBeenCalledWith('1', 'wmux: 1 unread notification');
    expect(sink2.setProgress).toHaveBeenCalledWith(true);
  });

  it('is silent with no window bound', () => {
    const status = new TaskbarStatus({ set: () => 0, clear: () => undefined });
    expect(() => {
      status.setCount(3);
      status.setState({ enabled: true, running: true });
      status.setState({ enabled: false, running: false });
    }).not.toThrow();
  });
});

describe('win32 gate (source text)', () => {
  const src = readFileSync(path.join(__dirname, '..', 'taskbarStatus.ts'), 'utf8');

  it('returns before touching a window off Windows in every exported entry point', () => {
    for (const name of ['bindTaskbarWindow', 'updateTaskbarNeedsYou', 'updateTaskbarState']) {
      const body = src.slice(src.indexOf(`export function ${name}(`));
      const firstLine = body.split('\n')[1];
      expect(firstLine.trim(), name).toBe("if (process.platform !== 'win32') return;");
    }
  });

  it('every adopted main window is bound, not only the first', () => {
    const index = readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    const fn = index.slice(index.indexOf('function adoptMainWindow('));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('bindTaskbarWindow(win);');
    expect(index.match(/bindTaskbarWindow\(/g)).toHaveLength(1);
  });

  it('the overlay count is fed from the dock-badge path', () => {
    const tray = readFileSync(path.join(__dirname, '..', 'tray.ts'), 'utf8');
    const fn = tray.slice(tray.indexOf('export function updateUnreadBadge('));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('updateTaskbarNeedsYou(count);');
  });
});
