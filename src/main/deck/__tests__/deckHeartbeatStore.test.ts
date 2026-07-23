// Unit tests for the heartbeat config store: default-ON at 3min (missing/corrupt/
// wrong-shape file), interval floor clamp on load, and merge-preserving saves.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_HEARTBEAT,
  MIN_HEARTBEAT_INTERVAL_MS,
  MIN_DECISION_TTL_MS,
  DEFAULT_DECISION_TTL_MS,
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
  it('missing file resolves to the default (enabled, 3-minute cadence, 30-minute TTL)', () => {
    expect(DEFAULT_HEARTBEAT).toEqual({
      enabled: true,
      intervalMs: 180_000,
      decisionTtlMs: DEFAULT_DECISION_TTL_MS,
    });
    expect(loadDeckHeartbeat(dir)).toEqual({
      enabled: true,
      intervalMs: 180_000,
      decisionTtlMs: DEFAULT_DECISION_TTL_MS,
    });
  });

  it('round-trips enabled + interval + decisionTtlMs through the file', async () => {
    const saved = await saveDeckHeartbeat(
      { enabled: false, intervalMs: 300_000, decisionTtlMs: 20 * 60_000 },
      dir,
    );
    expect(saved).toEqual({ enabled: false, intervalMs: 300_000, decisionTtlMs: 20 * 60_000 });
    expect(loadDeckHeartbeat(dir)).toEqual({
      enabled: false,
      intervalMs: 300_000,
      decisionTtlMs: 20 * 60_000,
    });
  });

  it('a partial save preserves the other fields', async () => {
    await saveDeckHeartbeat({ intervalMs: 240_000 }, dir);
    expect(loadDeckHeartbeat(dir)).toEqual({
      enabled: true,
      intervalMs: 240_000,
      decisionTtlMs: DEFAULT_DECISION_TTL_MS,
    });
    await saveDeckHeartbeat({ enabled: false }, dir);
    expect(loadDeckHeartbeat(dir)).toEqual({
      enabled: false,
      intervalMs: 240_000,
      decisionTtlMs: DEFAULT_DECISION_TTL_MS,
    });
    await saveDeckHeartbeat({ decisionTtlMs: 45 * 60_000 }, dir);
    expect(loadDeckHeartbeat(dir)).toEqual({
      enabled: false,
      intervalMs: 240_000,
      decisionTtlMs: 45 * 60_000,
    });
  });

  it('clamps a below-floor interval up to the minimum on load AND on save', async () => {
    fs.writeFileSync(getDeckHeartbeatPath(dir), JSON.stringify({ enabled: true, intervalMs: 5_000 }), 'utf8');
    expect(loadDeckHeartbeat(dir).intervalMs).toBe(MIN_HEARTBEAT_INTERVAL_MS);
    const saved = await saveDeckHeartbeat({ intervalMs: 1_000 }, dir);
    expect(saved.intervalMs).toBe(MIN_HEARTBEAT_INTERVAL_MS);
  });

  it('clamps a below-floor decisionTtlMs up to the minimum on load AND on save', async () => {
    fs.writeFileSync(
      getDeckHeartbeatPath(dir),
      JSON.stringify({ enabled: true, intervalMs: 180_000, decisionTtlMs: 1_000 }),
      'utf8',
    );
    expect(loadDeckHeartbeat(dir).decisionTtlMs).toBe(MIN_DECISION_TTL_MS);
    const saved = await saveDeckHeartbeat({ decisionTtlMs: 10 }, dir);
    expect(saved.decisionTtlMs).toBe(MIN_DECISION_TTL_MS);
  });

  it('a non-finite / missing decisionTtlMs falls back to the default', () => {
    fs.writeFileSync(
      getDeckHeartbeatPath(dir),
      JSON.stringify({ enabled: true, intervalMs: 180_000, decisionTtlMs: 'later' }),
      'utf8',
    );
    expect(loadDeckHeartbeat(dir).decisionTtlMs).toBe(DEFAULT_DECISION_TTL_MS);
  });

  it('corrupt / wrong-shape file resolves to the default (never throws)', () => {
    fs.writeFileSync(getDeckHeartbeatPath(dir), 'CORRUPT{', 'utf8');
    expect(loadDeckHeartbeat(dir)).toEqual(DEFAULT_HEARTBEAT);
    fs.writeFileSync(getDeckHeartbeatPath(dir), JSON.stringify([true]), 'utf8');
    expect(loadDeckHeartbeat(dir)).toEqual(DEFAULT_HEARTBEAT);
    // Non-boolean enabled / non-finite interval / non-finite ttl fall back per field.
    fs.writeFileSync(getDeckHeartbeatPath(dir), JSON.stringify({ enabled: 'yes', intervalMs: 'soon', decisionTtlMs: 'never' }), 'utf8');
    expect(loadDeckHeartbeat(dir)).toEqual(DEFAULT_HEARTBEAT);
  });
});
