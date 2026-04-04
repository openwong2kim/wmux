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

  it('saveDebounced does not write immediately', () => {
    vi.useFakeTimers();
    try {
      const state = makeState([makeSession()]);
      writer.saveDebounced(state);

      const filePath = path.join(tmpDir, 'sessions.json');
      expect(fs.existsSync(filePath)).toBe(false);

      // Advance past debounce interval (30s)
      vi.advanceTimersByTime(30_000);

      expect(fs.existsSync(filePath)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('saveDebounced coalesces multiple calls within debounce window', () => {
    vi.useFakeTimers();
    try {
      writer.saveDebounced(makeState([makeSession({ id: 'v1' })]));

      vi.advanceTimersByTime(10_000);
      writer.saveDebounced(makeState([makeSession({ id: 'v2' })]));

      vi.advanceTimersByTime(10_000);
      writer.saveDebounced(makeState([makeSession({ id: 'v3' })]));

      // Timer from first call fires at 30s
      vi.advanceTimersByTime(10_000);

      const filePath = path.join(tmpDir, 'sessions.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      // Should have the latest pending state
      expect(loaded.sessions[0].id).toBe('v3');
    } finally {
      vi.useRealTimers();
    }
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
});
