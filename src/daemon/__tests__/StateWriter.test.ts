import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateWriter } from '../StateWriter';
import type { DaemonState, DaemonSession } from '../types';

let tmpDir: string;
let writer: StateWriter;

function makeSession(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    id: 'sess-1',
    state: 'detached',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    pid: 12345,
    cmd: 'bash',
    cwd: '/tmp',
    env: {},
    cols: 120,
    rows: 30,
    deadTtlHours: 24,
    ...overrides,
  };
}

function makeState(sessions: DaemonSession[] = []): DaemonState {
  return { version: 1, sessions };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-statewriter-test-'));
  writer = new StateWriter(tmpDir);
});

afterEach(() => {
  writer.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('StateWriter', () => {
  it('saveImmediate creates sessions.json', () => {
    const state = makeState([makeSession()]);
    writer.saveImmediate(state);

    const filePath = path.join(tmpDir, 'sessions.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(loaded.version).toBe(1);
    expect(loaded.sessions).toHaveLength(1);
    expect(loaded.sessions[0].id).toBe('sess-1');
  });

  it('load restores saved data', () => {
    const state = makeState([makeSession({ id: 'abc' })]);
    writer.saveImmediate(state);

    const loaded = writer.load();
    expect(loaded.version).toBe(1);
    expect(loaded.sessions).toHaveLength(1);
    expect(loaded.sessions[0].id).toBe('abc');
  });

  it('load falls back to .bak when primary is corrupt', () => {
    // Save valid state first (creates .bak on second save)
    const state = makeState([makeSession({ id: 'good' })]);
    writer.saveImmediate(state);

    // Second save — the first becomes .bak
    const state2 = makeState([makeSession({ id: 'good2' })]);
    writer.saveImmediate(state2);

    // Corrupt the primary file
    const filePath = path.join(tmpDir, 'sessions.json');
    fs.writeFileSync(filePath, '{{not valid json', 'utf-8');

    const loaded = writer.load();
    // Should recover from .bak which has the first save's state
    expect(loaded.sessions).toHaveLength(1);
    expect(loaded.sessions[0].id).toBe('good');
  });

  it('saveDebounced does not write immediately', async () => {
    vi.useFakeTimers();
    const state = makeState([makeSession()]);
    writer.saveDebounced(state);

    const filePath = path.join(tmpDir, 'sessions.json');
    expect(fs.existsSync(filePath)).toBe(false);

    // Advance past debounce interval (30s). T2: the timer enqueues
    // an async write on the coalescing queue; fake timers only
    // advance setTimeout, so we switch to real timers and wait for
    // the real async file I/O to complete.
    vi.advanceTimersByTime(30_000);
    vi.useRealTimers();
    // Give the event loop a few ticks for fsp.writeFile/rename to run.
    await new Promise((r) => setTimeout(r, 50));

    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('saveDebounced coalesces multiple calls within debounce window', async () => {
    vi.useFakeTimers();
    writer.saveDebounced(makeState([makeSession({ id: 'v1' })]));

    vi.advanceTimersByTime(10_000);
    writer.saveDebounced(makeState([makeSession({ id: 'v2' })]));

    vi.advanceTimersByTime(10_000);
    writer.saveDebounced(makeState([makeSession({ id: 'v3' })]));

    // Timer from first call fires at 30s.
    vi.advanceTimersByTime(10_000);
    vi.useRealTimers();
    // Let the async write settle on the real event loop.
    await new Promise((r) => setTimeout(r, 50));

    const filePath = path.join(tmpDir, 'sessions.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // Should have the latest pending state
    expect(loaded.sessions[0].id).toBe('v3');
  });

  it('flush writes pending state immediately', () => {
    vi.useFakeTimers();
    try {
      const state = makeState([makeSession({ id: 'flushed' })]);
      writer.saveDebounced(state);

      const filePath = path.join(tmpDir, 'sessions.json');
      expect(fs.existsSync(filePath)).toBe(false);

      writer.flush();
      expect(fs.existsSync(filePath)).toBe(true);

      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(loaded.sessions[0].id).toBe('flushed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose clears timers and flushes pending', () => {
    vi.useFakeTimers();
    try {
      const state = makeState([makeSession({ id: 'disposed' })]);
      writer.saveDebounced(state);

      writer.dispose();

      const filePath = path.join(tmpDir, 'sessions.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(loaded.sessions[0].id).toBe('disposed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('load prunes DEAD sessions past their TTL', () => {
    const now = Date.now();
    // Dead session from 25 hours ago with 24h TTL — should be pruned
    const expired = makeSession({
      id: 'expired',
      state: 'dead',
      lastActivity: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
      deadTtlHours: 24,
    });
    // Dead session from 1 hour ago with 24h TTL — should survive
    const recent = makeSession({
      id: 'recent-dead',
      state: 'dead',
      lastActivity: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
      deadTtlHours: 24,
    });
    // Alive session — always survives
    const alive = makeSession({ id: 'alive', state: 'attached' });

    writer.saveImmediate(makeState([expired, recent, alive]));

    const loaded = writer.load();
    const ids = loaded.sessions.map((s) => s.id);

    expect(ids).not.toContain('expired');
    expect(ids).toContain('recent-dead');
    expect(ids).toContain('alive');
  });

  it('load prunes SUSPENDED sessions past 7-day TTL (v2.8.1 hotfix)', () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    // Pre-v2.8.1, suspended sessions accumulated forever and eventually
    // exhausted MAX_SESSIONS=50, locking the daemon into a brick state.
    // 7-day TTL is the bound that prevents that.
    const stale = makeSession({
      id: 'stale-suspended',
      state: 'suspended',
      lastActivity: new Date(now - 8 * 24 * HOUR).toISOString(),
    });
    const fresh = makeSession({
      id: 'fresh-suspended',
      state: 'suspended',
      lastActivity: new Date(now - 6 * 24 * HOUR).toISOString(),
    });
    // Live sessions and detached ones should never be touched by TTL.
    const detached = makeSession({ id: 'detached', state: 'detached' });
    const attached = makeSession({ id: 'attached', state: 'attached' });

    writer.saveImmediate(makeState([stale, fresh, detached, attached]));

    const loaded = writer.load();
    const ids = loaded.sessions.map((s) => s.id);

    expect(ids).not.toContain('stale-suspended');
    expect(ids).toContain('fresh-suspended');
    expect(ids).toContain('detached');
    expect(ids).toContain('attached');
  });

  it('load uses suspended TTL even when deadTtlHours is short', () => {
    // Regression guard: the suspended TTL must not be confused with
    // the per-session deadTtlHours field, which only governs DEAD pruning.
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const session = makeSession({
      id: 'suspended-with-tight-dead-ttl',
      state: 'suspended',
      lastActivity: new Date(now - 25 * HOUR).toISOString(),
      deadTtlHours: 1,
    });
    writer.saveImmediate(makeState([session]));

    const loaded = writer.load();
    expect(loaded.sessions).toHaveLength(1);
    expect(loaded.sessions[0].id).toBe('suspended-with-tight-dead-ttl');
  });

  it('honours a custom suspendedTtlHours from the constructor (substrate 3.0)', () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    // A writer configured with a 48h suspended TTL instead of the 7d default.
    const customWriter = new StateWriter(tmpDir, 48);
    const stale = makeSession({
      id: 'stale-3d',
      state: 'suspended',
      lastActivity: new Date(now - 3 * 24 * HOUR).toISOString(), // 72h > 48h → pruned
    });
    const fresh = makeSession({
      id: 'fresh-1d',
      state: 'suspended',
      lastActivity: new Date(now - 24 * HOUR).toISOString(), // 24h < 48h → survives
    });
    customWriter.saveImmediate(makeState([stale, fresh]));

    const ids = customWriter.load().sessions.map((s) => s.id);
    expect(ids).not.toContain('stale-3d');
    expect(ids).toContain('fresh-1d');
  });

  it('default constructor keeps the 7-day suspended TTL (no config passed)', () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    // 3 days old: would be pruned under a 48h TTL, but kept under the 7d
    // default — proves the default still applies when config is omitted.
    const s = makeSession({
      id: 'three-day-suspended',
      state: 'suspended',
      lastActivity: new Date(now - 3 * 24 * HOUR).toISOString(),
    });
    writer.saveImmediate(makeState([s]));
    expect(writer.load().sessions.map((x) => x.id)).toContain('three-day-suspended');
  });

  it('rejects prototype pollution keys in JSON', () => {
    const filePath = path.join(tmpDir, 'sessions.json');
    const poisoned = JSON.stringify({
      version: 1,
      sessions: [],
      '__proto__': { admin: true },
      'constructor': { prototype: { isAdmin: true } },
    });
    fs.writeFileSync(filePath, poisoned, 'utf-8');

    const loaded = writer.load();
    // Should load without pollution
    expect(loaded.version).toBe(1);
    expect(loaded.sessions).toHaveLength(0);

    // Verify no pollution on Object prototype
    const plain: Record<string, unknown> = {};
    expect(plain['admin']).toBeUndefined();
    expect(plain['isAdmin']).toBeUndefined();
  });

  it('load returns empty state when no files exist', () => {
    const loaded = writer.load();
    expect(loaded.version).toBe(1);
    expect(loaded.sessions).toHaveLength(0);
  });

  it('atomic write creates .bak file', () => {
    writer.saveImmediate(makeState([makeSession({ id: 'first' })]));
    writer.saveImmediate(makeState([makeSession({ id: 'second' })]));

    const bakPath = path.join(tmpDir, 'sessions.json.bak');
    expect(fs.existsSync(bakPath)).toBe(true);

    const bakData = JSON.parse(fs.readFileSync(bakPath, 'utf-8'));
    expect(bakData.sessions[0].id).toBe('first');
  });

  it('no .tmp residue after successful save', () => {
    writer.saveImmediate(makeState([makeSession()]));
    const tmpPath = path.join(tmpDir, 'sessions.json.tmp');
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it('getBufferDumpPath returns path under buffers/', () => {
    const dumpPath = writer.getBufferDumpPath('sess-abc');
    expect(dumpPath).toBe(path.join(tmpDir, 'buffers', 'sess-abc.buf'));
  });

  it('ensureBufferDir creates the buffers directory', () => {
    const bufDir = path.join(tmpDir, 'buffers');
    expect(fs.existsSync(bufDir)).toBe(false);
    writer.ensureBufferDir();
    expect(fs.existsSync(bufDir)).toBe(true);
    // idempotent
    writer.ensureBufferDir();
    expect(fs.existsSync(bufDir)).toBe(true);
  });

  it('cleanOrphanedBuffers removes unreferenced .buf files', () => {
    writer.ensureBufferDir();
    const bufDir = path.join(tmpDir, 'buffers');

    // Create some buffer files
    fs.writeFileSync(path.join(bufDir, 'keep.buf'), 'data');
    fs.writeFileSync(path.join(bufDir, 'orphan.buf'), 'data');
    fs.writeFileSync(path.join(bufDir, 'other.txt'), 'data'); // non-.buf ignored

    writer.cleanOrphanedBuffers(new Set(['keep']));

    expect(fs.existsSync(path.join(bufDir, 'keep.buf'))).toBe(true);
    expect(fs.existsSync(path.join(bufDir, 'orphan.buf'))).toBe(false);
    expect(fs.existsSync(path.join(bufDir, 'other.txt'))).toBe(true);
  });

  // Rotation wiring (Critical #1): repeat saves accumulate the .bak.N
  // chain instead of collapsing to a single legacy `.bak` slot.
  it('rotation chain: three saves populate .bak and .bak.1', () => {
    writer.saveImmediate(makeState([makeSession({ id: 'g1' })]));
    writer.saveImmediate(makeState([makeSession({ id: 'g2' })]));
    writer.saveImmediate(makeState([makeSession({ id: 'g3' })]));

    const primary = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'sessions.json'), 'utf-8'),
    );
    const bak = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'sessions.json.bak'), 'utf-8'),
    );
    const bak1Path = path.join(tmpDir, 'sessions.json.bak.1');
    expect(fs.existsSync(bak1Path)).toBe(true);
    const bak1 = JSON.parse(fs.readFileSync(bak1Path, 'utf-8'));

    expect(primary.sessions[0].id).toBe('g3');
    expect(bak.sessions[0].id).toBe('g2');
    expect(bak1.sessions[0].id).toBe('g1');
  });

  it('rotation chain: five saves fill through .bak.3', () => {
    for (let i = 1; i <= 5; i++) {
      writer.saveImmediate(makeState([makeSession({ id: `g${i}` })]));
    }
    const readId = (suffix: '' | '.bak' | '.bak.1' | '.bak.2' | '.bak.3'): string => {
      const raw = fs.readFileSync(
        path.join(tmpDir, `sessions.json${suffix}`),
        'utf-8',
      );
      return JSON.parse(raw).sessions[0].id;
    };
    expect(readId('')).toBe('g5');
    expect(readId('.bak')).toBe('g4');
    expect(readId('.bak.1')).toBe('g3');
    expect(readId('.bak.2')).toBe('g2');
    expect(readId('.bak.3')).toBe('g1');
  });

  // flushSync order (Critical #4): queue drain first, then inline write.
  it('flushSync: with no queued task, writes pending state inline', () => {
    vi.useFakeTimers();
    try {
      writer.saveDebounced(makeState([makeSession({ id: 'fsync-pending' })]));
      // Debounce timer has NOT fired yet — nothing is in the queue.
      writer.flushSync();

      const filePath = path.join(tmpDir, 'sessions.json');
      expect(fs.existsSync(filePath)).toBe(true);
      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(loaded.sessions[0].id).toBe('fsync-pending');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushSync: drives queue.flushSync before any inline fallback', () => {
    vi.useFakeTimers();
    try {
      // Stage pending state, let the timer fire to enqueue the async
      // task. The queue has not yet run the async task (we never
      // switch to real timers) — a flushSync call in this state MUST
      // drive the queue's sync fallback rather than race the in-flight
      // task against the inline write.
      writer.saveDebounced(makeState([makeSession({ id: 'fsync-queue' })]));
      vi.advanceTimersByTime(30_000);
      // At this point: debounce timer has fired → queue has a pending
      // task, pendingState is still 'fsync-queue'.
      writer.flushSync();

      const filePath = path.join(tmpDir, 'sessions.json');
      expect(fs.existsSync(filePath)).toBe(true);
      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(loaded.sessions[0].id).toBe('fsync-queue');
    } finally {
      vi.useRealTimers();
    }
  });
});
