// @vitest-environment jsdom
//
// Titlebar vitals: the memory chip and the wall-clock used to sit there
// permanently ("553MB 09:22"). DESIGN.md's fleet-vitals rule is that a chip
// renders only when it means something — these two are now held to it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  MEMORY_CHIP_GROWTH_FACTOR,
  MEMORY_CHIP_HYSTERESIS,
  MEMORY_CHIP_MIN_BYTES,
  MEMORY_POLL_HIDDEN_MS,
  MEMORY_POLL_SHOWN_MS,
  StatusClockTime,
  formatMemoryChip,
  memoryChipLevel,
  shouldShowMemoryChip,
} from '../StatusClock';
import { useStore } from '../../../stores';

describe('shouldShowMemoryChip', () => {
  const MB = 1024 * 1024;

  it('stays hidden for an ordinary footprint', () => {
    expect(shouldShowMemoryChip(553 * MB, 500 * MB)).toBe(false);
  });

  it('appears above the absolute floor even with no baseline yet', () => {
    expect(shouldShowMemoryChip(MEMORY_CHIP_MIN_BYTES, null)).toBe(true);
    expect(shouldShowMemoryChip(MEMORY_CHIP_MIN_BYTES - 1, null)).toBe(false);
  });

  it('appears when the footprint outgrew what the window started with', () => {
    const baseline = 400 * MB;
    expect(memoryChipLevel(baseline)).toBe(baseline * MEMORY_CHIP_GROWTH_FACTOR);
    expect(shouldShowMemoryChip(baseline * MEMORY_CHIP_GROWTH_FACTOR - 1, baseline)).toBe(false);
    expect(shouldShowMemoryChip(baseline * MEMORY_CHIP_GROWTH_FACTOR, baseline)).toBe(true);
  });

  it('never lets the growth rule raise the bar above the absolute floor', () => {
    // A window that started at 2 GB: growth would put the level at 3 GB, but
    // 2 GB is already worth saying out loud.
    expect(memoryChipLevel(2 * 1024 * MB)).toBe(MEMORY_CHIP_MIN_BYTES);
  });

  // A footprint parked ON the threshold used to blink the chip in and out on
  // every poll — worse than either state.
  it('does not flap: once shown it holds down to the hysteresis band', () => {
    const baseline = 400 * MB;
    const level = memoryChipLevel(baseline);
    const justUnder = level - 1;
    // Hidden and just under: still hidden. Shown and just under: still shown.
    expect(shouldShowMemoryChip(justUnder, baseline, false)).toBe(false);
    expect(shouldShowMemoryChip(justUnder, baseline, true)).toBe(true);
    // It does let go once the footprint really came down.
    expect(shouldShowMemoryChip(level * MEMORY_CHIP_HYSTERESIS, baseline, true)).toBe(true);
    expect(shouldShowMemoryChip(level * MEMORY_CHIP_HYSTERESIS - 1, baseline, true)).toBe(false);
  });

  it('never fires on a missing or nonsense reading, shown or not', () => {
    expect(shouldShowMemoryChip(0, 100 * MB)).toBe(false);
    expect(shouldShowMemoryChip(-1, 100 * MB)).toBe(false);
    expect(shouldShowMemoryChip(Number.NaN, 100 * MB)).toBe(false);
    expect(shouldShowMemoryChip(Number.NaN, 100 * MB, true)).toBe(false);
  });
});

describe('formatMemoryChip', () => {
  it('keeps the chip text the strip already had', () => {
    expect(formatMemoryChip(553 * 1024 * 1024)).toBe('553MB');
  });
});

let container: HTMLDivElement;
let root: Root;

function stubMemory(bytes: number): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    system: { getMemoryUsage: vi.fn(async () => bytes) },
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({ titlebarClockVisible: false });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(StatusClockTime));
  });
  // Let the memory promise settle.
  await act(async () => { await Promise.resolve(); });
}

describe('StatusClockTime', () => {
  it('renders neither gauge on a quiet, default session', async () => {
    stubMemory(553 * 1024 * 1024);
    await mount();
    expect(container.querySelector('[data-statusbar-memory]')).toBeNull();
    expect(container.querySelector('[data-statusbar-clock]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('shows the memory chip once the footprint is worth interrupting for', async () => {
    stubMemory(2 * 1024 * 1024 * 1024);
    await mount();
    expect(container.querySelector('[data-statusbar-memory]')?.textContent).toBe('2048MB');
  });

  it('shows the clock only when the setting asks for it', async () => {
    stubMemory(553 * 1024 * 1024);
    useStore.setState({ titlebarClockVisible: true });
    await mount();
    const clock = container.querySelector('[data-statusbar-clock]');
    expect(clock).not.toBeNull();
    expect(clock?.textContent).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('StatusClockTime memory poll cadence', () => {
  it('asks main rarely while nothing is rendering the number', () => {
    // The chip is the only reader; a 5 s IPC for a number nobody sees is pure
    // cost. Live cadence is reserved for a footprint on screen.
    expect(MEMORY_POLL_HIDDEN_MS).toBeGreaterThan(MEMORY_POLL_SHOWN_MS);
  });

  it('holds the chip through a dip inside the hysteresis band', async () => {
    const GB = 1024 * 1024 * 1024;
    let reading = 2 * GB;
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      system: { getMemoryUsage: vi.fn(async () => reading) },
    };
    await mount();
    expect(container.querySelector('[data-statusbar-memory]')).not.toBeNull();

    // Down a little — still above 90% of the 1.5 GB level, so it holds.
    reading = 1.4 * GB;
    await act(async () => {
      root.render(createElement(StatusClockTime));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-statusbar-memory]')).not.toBeNull();
  });
});
