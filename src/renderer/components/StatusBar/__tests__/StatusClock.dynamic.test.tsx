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
  MEMORY_CHIP_MIN_BYTES,
  StatusClockTime,
  formatMemoryChip,
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
    expect(shouldShowMemoryChip(baseline * MEMORY_CHIP_GROWTH_FACTOR, baseline)).toBe(false);
    expect(shouldShowMemoryChip(baseline * MEMORY_CHIP_GROWTH_FACTOR + 1, baseline)).toBe(true);
  });

  it('never fires on a missing or nonsense reading', () => {
    expect(shouldShowMemoryChip(0, 100 * MB)).toBe(false);
    expect(shouldShowMemoryChip(-1, 100 * MB)).toBe(false);
    expect(shouldShowMemoryChip(Number.NaN, 100 * MB)).toBe(false);
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
