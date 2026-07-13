// Unit tests for the global auto-wake switch store: default-ON resolution
// (missing/corrupt/wrong-shape file), round-trip persistence, and non-boolean
// coercion on write.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_AUTO_WAKE_ENABLED,
  loadAutoWakeEnabled,
  setAutoWakeEnabled,
  getDeckAutoWakePath,
} from '../deckAutoWakeStore';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-deck-autowake-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deckAutoWakeStore', () => {
  it('missing file resolves to the default (enabled — the shipped behavior)', () => {
    expect(DEFAULT_AUTO_WAKE_ENABLED).toBe(true);
    expect(loadAutoWakeEnabled(dir)).toBe(true);
  });

  it('round-trips OFF and back ON through the file', async () => {
    expect(await setAutoWakeEnabled(false, dir)).toBe(false);
    expect(loadAutoWakeEnabled(dir)).toBe(false);
    expect(await setAutoWakeEnabled(true, dir)).toBe(true);
    expect(loadAutoWakeEnabled(dir)).toBe(true);
  });

  it('corrupt / wrong-shape file resolves to enabled (never throws)', () => {
    fs.writeFileSync(getDeckAutoWakePath(dir), 'CORRUPT{', 'utf8');
    expect(loadAutoWakeEnabled(dir)).toBe(true);
    fs.writeFileSync(getDeckAutoWakePath(dir), JSON.stringify([false]), 'utf8');
    expect(loadAutoWakeEnabled(dir)).toBe(true);
    fs.writeFileSync(getDeckAutoWakePath(dir), JSON.stringify({ enabled: 'no' }), 'utf8');
    expect(loadAutoWakeEnabled(dir)).toBe(true);
  });

  it('coerces a non-boolean write to false (only EXACTLY true enables)', async () => {
    expect(await setAutoWakeEnabled('yes' as unknown as boolean, dir)).toBe(false);
    expect(loadAutoWakeEnabled(dir)).toBe(false);
  });
});
