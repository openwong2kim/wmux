// Unit tests for the heartbeat config store: default-ON at 3min (missing/corrupt/
// wrong-shape file), interval floor clamp on load, and merge-preserving saves.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_HEARTBEAT,
  MIN_HEARTBEAT_INTERVAL_MS,
  loadDeckHeartbeat,
  saveDeckHeartbeat,
  getDeckHeartbeatPath,
} from '../deckHeartbeatStore';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-deck-heartbeat-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deckHeartbeatStore', () => {
  it('missing file resolves to the default (enabled, 3-minute cadence)', () => {
    expect(DEFAULT_HEARTBEAT).toEqual({ enabled: true, intervalMs: 180_000 });
    expect(loadDeckHeartbeat(dir)).toEqual({ enabled: true, intervalMs: 180_000 });
  });

  it('round-trips enabled + interval through the file', async () => {
    const saved = await saveDeckHeartbeat({ enabled: false, intervalMs: 300_000 }, dir);
    expect(saved).toEqual({ enabled: false, intervalMs: 300_000 });
    expect(loadDeckHeartbeat(dir)).toEqual({ enabled: false, intervalMs: 300_000 });
  });

  it('a partial save preserves the other field', async () => {
    await saveDeckHeartbeat({ intervalMs: 240_000 }, dir);
    expect(loadDeckHeartbeat(dir)).toEqual({ enabled: true, intervalMs: 240_000 });
    await saveDeckHeartbeat({ enabled: false }, dir);
    expect(loadDeckHeartbeat(dir)).toEqual({ enabled: false, intervalMs: 240_000 });
  });

  it('clamps a below-floor interval up to the minimum on load AND on save', async () => {
    fs.writeFileSync(getDeckHeartbeatPath(dir), JSON.stringify({ enabled: true, intervalMs: 5_000 }), 'utf8');
    expect(loadDeckHeartbeat(dir).intervalMs).toBe(MIN_HEARTBEAT_INTERVAL_MS);
    const saved = await saveDeckHeartbeat({ intervalMs: 1_000 }, dir);
    expect(saved.intervalMs).toBe(MIN_HEARTBEAT_INTERVAL_MS);
  });

  it('corrupt / wrong-shape file resolves to the default (never throws)', () => {
    fs.writeFileSync(getDeckHeartbeatPath(dir), 'CORRUPT{', 'utf8');
    expect(loadDeckHeartbeat(dir)).toEqual(DEFAULT_HEARTBEAT);
    fs.writeFileSync(getDeckHeartbeatPath(dir), JSON.stringify([true]), 'utf8');
    expect(loadDeckHeartbeat(dir)).toEqual(DEFAULT_HEARTBEAT);
    // Non-boolean enabled / non-finite interval fall back per field.
    fs.writeFileSync(getDeckHeartbeatPath(dir), JSON.stringify({ enabled: 'yes', intervalMs: 'soon' }), 'utf8');
    expect(loadDeckHeartbeat(dir)).toEqual(DEFAULT_HEARTBEAT);
  });
});
