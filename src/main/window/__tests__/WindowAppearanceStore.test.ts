import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowAppearanceStore } from '../WindowAppearanceStore';
import {
  DEFAULT_WINDOW_APPEARANCE,
  normalizeWindowAppearance,
  windowNeedsTransparentCreation,
} from '../../../shared/windowAppearance';

// #1133 — main-owned prefs. Same contract shape as BrowserBackendStore: sync
// read at construction, atomic write, per-field degradation on corruption.

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'wmux-window-appearance-'));
}

describe('normalizeWindowAppearance', () => {
  it('defaults for garbage of every shape', () => {
    expect(normalizeWindowAppearance(undefined)).toEqual(DEFAULT_WINDOW_APPEARANCE);
    expect(normalizeWindowAppearance(null)).toEqual(DEFAULT_WINDOW_APPEARANCE);
    expect(normalizeWindowAppearance('mica')).toEqual(DEFAULT_WINDOW_APPEARANCE);
    expect(normalizeWindowAppearance({ opacity: 'lots', material: 4 })).toEqual(DEFAULT_WINDOW_APPEARANCE);
  });

  it('degrades per field — a corrupt opacity keeps the material', () => {
    expect(normalizeWindowAppearance({ opacity: NaN, material: 'acrylic' }))
      .toEqual({ opacity: 100, material: 'acrylic' });
    expect(normalizeWindowAppearance({ opacity: 70, material: 'frosted-glass' }))
      .toEqual({ opacity: 70, material: 'none' });
  });

  it('clamps and rounds opacity into 0..100', () => {
    expect(normalizeWindowAppearance({ opacity: 140 }).opacity).toBe(100);
    expect(normalizeWindowAppearance({ opacity: -3 }).opacity).toBe(0);
    expect(normalizeWindowAppearance({ opacity: 66.6 }).opacity).toBe(67);
  });
});

describe('windowNeedsTransparentCreation', () => {
  it('is false exactly for today’s opaque behaviour', () => {
    expect(windowNeedsTransparentCreation({ opacity: 100, material: 'none' })).toBe(false);
  });

  it('is true for a reduced opacity or any material', () => {
    expect(windowNeedsTransparentCreation({ opacity: 99, material: 'none' })).toBe(true);
    expect(windowNeedsTransparentCreation({ opacity: 100, material: 'mica' })).toBe(true);
    expect(windowNeedsTransparentCreation({ opacity: 80, material: 'acrylic' })).toBe(true);
  });
});

describe('WindowAppearanceStore', () => {
  // set() debounces the disk write (150ms default) — tests construct with 0
  // so every set() flushes synchronously, which is what the round-trip
  // assertions read.
  function storeNow(dir: string): WindowAppearanceStore {
    return new WindowAppearanceStore(dir, 0);
  }

  it('falls back to defaults for a missing or corrupt file', () => {
    const dir = tmpDir();
    try {
      expect(new WindowAppearanceStore(dir, 0).get()).toEqual(DEFAULT_WINDOW_APPEARANCE);
      writeFileSync(join(dir, 'window-appearance.json'), '{not json', 'utf8');
      expect(new WindowAppearanceStore(dir, 0).get()).toEqual(DEFAULT_WINDOW_APPEARANCE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips a written prefs object', () => {
    const dir = tmpDir();
    try {
      const store = storeNow(dir);
      store.set({ opacity: 75, material: 'mica' });
      expect(new WindowAppearanceStore(dir, 0).get()).toEqual({ opacity: 75, material: 'mica' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes on write — an out-of-range value never reaches disk', () => {
    const dir = tmpDir();
    try {
      const store = storeNow(dir);
      store.set({ opacity: 250, material: 'mica' } as never);
      expect(new WindowAppearanceStore(dir, 0).get()).toEqual({ opacity: 100, material: 'mica' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
