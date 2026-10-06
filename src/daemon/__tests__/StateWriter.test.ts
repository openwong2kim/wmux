import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateWriter } from '../StateWriter';
import type { DaemonState, DaemonSession } from '../types';
import { waitForCondition } from './_waitForFile';

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

  it('load skips a resume binding missing its folder and keeps the session and the others', () => {
    const good = { agent: 'claude', sessionId: '0a1b2c3d-0000-4000-8000-000000000002', cwd: '/tmp', ts: 1 };
    const missingFolder = { agent: 'codex', sessionId: 'bad-id', ts: 1 } as unknown as DaemonSession['resumeBinding'];
    writer.saveImmediate(makeState([
      makeSession({ id: 'broken', resumeBinding: missingFolder }),
      makeSession({ id: 'intact', resumeBinding: good }),
    ]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const loaded = writer.load();
      expect(loaded.sessions.map((s) => s.id)).toEqual(['broken', 'intact']);
      expect(loaded.sessions[0].resumeBinding).toBeUndefined();
      expect(loaded.sessions[1].resumeBinding).toEqual(good);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('broken');
    } finally {
      warn.mockRestore();
    }
  });

  it('the main writer persists the skipped binding and reports it through its own log, once', () => {
    const missingFolder = { agent: 'codex', sessionId: 'bad-id', ts: 1 } as unknown as DaemonSession['resumeBinding'];
    writer.saveImmediate(makeState([makeSession({ id: 'broken', resumeBinding: missingFolder })]));
    const filePath = path.join(tmpDir, 'sessions.json');
    const warnings: string[] = [];
    const main = new StateWriter(tmpDir, undefined, undefined, true, (msg) => warnings.push(msg));
    try {
      expect(main.load().sessions[0].resumeBinding).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).sessions[0].resumeBinding).toBeUndefined();
      // The repaired file no longer carries it, so the next load is quiet.
      main.load();
      expect(warnings).toEqual(['[StateWriter] skipped an incomplete resume binding on session broken']);
    } finally {
      main.dispose();
    }
  });

  it('a writer without persistHealedOnLoad leaves the file as it found it', () => {
    const missingFolder = { agent: 'codex', sessionId: 'bad-id', ts: 1 } as unknown as DaemonSession['resumeBinding'];
    writer.saveImmediate(makeState([makeSession({ id: 'broken', resumeBinding: missingFolder })]));
    const filePath = path.join(tmpDir, 'sessions.json');
    const oneShot = new StateWriter(tmpDir, undefined, undefined, false, () => undefined);
    try {
      expect(oneShot.load().sessions[0].resumeBinding).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).sessions[0].resumeBinding).toEqual(missingFolder);
    } finally {
      oneShot.dispose();
    }
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
    // Wait for the real fsp.writeFile/rename to land (poll, not a fixed guess —
    // a fixed wait flakes under parallel-fork fs contention).
    await waitForCondition(() => fs.existsSync(filePath));

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
    const filePath = path.join(tmpDir, 'sessions.json');
    // Wait for the coalesced write to land with the latest value.
    await waitForCondition(
      () => fs.existsSync(filePath) && JSON.parse(fs.readFileSync(filePath, 'utf-8')).sessions[0].id === 'v3',
    );

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
      // #646: an expired tombstone is now kept while its pid still answers, so
      // this fixture needs a pid that can never be alive — otherwise the
      // default 12345 could be a real process on the test machine and this
      // assertion would pass or fail depending on who is running it.
      pid: 0,
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

  // #646: pruning ran BEFORE recovery's reconciliation pass, so a tombstone
  // written over a still-running shell — the exact 11-12-day orphans in the
  // report — was dropped before anything could reap its process.
  it('load KEEPS an expired DEAD session whose pid is still alive (#646)', () => {
    const now = Date.now();
    const orphan = makeSession({
      id: 'orphan-tombstone',
      state: 'dead',
      lastActivity: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
      deadTtlHours: 24,
      pid: process.pid, // guaranteed alive
    });

    writer.saveImmediate(makeState([orphan]));

    expect(writer.load().sessions.map((s) => s.id)).toContain('orphan-tombstone');
  });

  it('load drops a live-pid DEAD session once past the hard cap (#646)', () => {
    const now = Date.now();
    // 7x the record's own 24h TTL is the cap; 8 days is past it. Without the
    // cap a recycled pid could keep a tombstone on disk indefinitely.
    const ancient = makeSession({
      id: 'ancient-tombstone',
      state: 'dead',
      lastActivity: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
      deadTtlHours: 24,
      pid: process.pid,
    });

    writer.saveImmediate(makeState([ancient]));

    expect(writer.load().sessions.map((s) => s.id)).not.toContain('ancient-tombstone');
  });

  it('load still prunes an expired DEAD session with no usable pid (#646)', () => {
    const now = Date.now();
    const noPid = makeSession({
      id: 'no-pid-tombstone',
      state: 'dead',
      lastActivity: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
      deadTtlHours: 24,
      pid: undefined as unknown as number, // legacy record
    });

    writer.saveImmediate(makeState([noPid]));

    expect(writer.load().sessions.map((s) => s.id)).not.toContain('no-pid-tombstone');
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
    // Live attached sessions should never be touched by TTL — a client is
    // connected and the session is in active use.
    const attached = makeSession({ id: 'attached', state: 'attached' });

    writer.saveImmediate(makeState([stale, fresh, attached]));

    const loaded = writer.load();
    const ids = loaded.sessions.map((s) => s.id);

    expect(ids).not.toContain('stale-suspended');
    expect(ids).toContain('fresh-suspended');
    expect(ids).toContain('attached');
  });

  it('load prunes DETACHED sessions past the detached TTL (#557)', () => {
    // A crash/forced-kill leaves detached records on disk (the 30 s snapshot
    // runner writes listSessions() verbatim). Without a detached TTL these
    // accumulated forever and were re-spawned on every restart. Default TTL
    // is 8 h; a stale orphan (10 h idle) must be pruned before recovery runs.
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const stale = makeSession({
      id: 'stale-detached',
      state: 'detached',
      lastActivity: new Date(now - 10 * HOUR).toISOString(),
    });
    const fresh = makeSession({
      id: 'fresh-detached',
      state: 'detached',
      lastActivity: new Date(now - 1 * HOUR).toISOString(),
    });
    // Attached is never TTL-reaped regardless of age.
    const attached = makeSession({
      id: 'old-attached',
      state: 'attached',
      lastActivity: new Date(now - 30 * 24 * HOUR).toISOString(),
    });

    writer.saveImmediate(makeState([stale, fresh, attached]));

    const loaded = writer.load();
    const ids = loaded.sessions.map((s) => s.id);

    expect(ids).not.toContain('stale-detached');
    expect(ids).toContain('fresh-detached');
    expect(ids).toContain('old-attached');
  });

  it('load restamps sessions with a corrupt lastActivity instead of leaking them (#557)', () => {
    // A malformed lastActivity makes `now - getTime()` NaN, and every
    // `NaN < ttl` comparison is false — so without the restamp guard these
    // records would be KEPT forever (fail-open), defeating the reaper. The fix
    // restamps to now (not prune) so a possibly-live session survives one bad
    // timestamp yet the TTL clock restarts and can age out on a later load.
    const corruptDetached = makeSession({
      id: 'corrupt-detached',
      state: 'detached',
      lastActivity: 'not-a-date',
    });
    const corruptDead = makeSession({
      id: 'corrupt-dead',
      state: 'dead',
      lastActivity: 'not-a-date',
    });

    writer.saveImmediate(makeState([corruptDetached, corruptDead]));

    const before = Date.now();
    const loaded = writer.load();
    const after = Date.now();
    const ids = loaded.sessions.map((s) => s.id);

    // Both survive this load...
    expect(ids).toContain('corrupt-detached');
    expect(ids).toContain('corrupt-dead');

    // ...and their timestamps are now valid, recent ISO strings.
    for (const s of loaded.sessions) {
      const t = new Date(s.lastActivity).getTime();
      expect(Number.isNaN(t)).toBe(false);
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(after);
    }
  });

  it('heals a non-string lastActivity (null / number) instead of reaping it as ancient (#557)', () => {
    // `new Date(null).getTime()` and `new Date(0).getTime()` both coerce to a
    // VALID epoch 0, so a NaN-only guard would miss them and the record would
    // look ~56 years old and be silently reaped. isDaemonState() validates only
    // minimal fields, so disk corruption / legacy records can carry a non-string
    // lastActivity here. Both must heal (kept + restamped), like a bad string.
    const nullActivity = makeSession({
      id: 'null-activity',
      state: 'detached',
      lastActivity: null as unknown as string,
    });
    const numericActivity = makeSession({
      id: 'numeric-activity',
      state: 'dead',
      lastActivity: 0 as unknown as string,
    });

    writer.saveImmediate(makeState([nullActivity, numericActivity]));

    const before = Date.now();
    const loaded = writer.load();
    const after = Date.now();
    const ids = loaded.sessions.map((s) => s.id);

    expect(ids).toContain('null-activity');
    expect(ids).toContain('numeric-activity');
    for (const s of loaded.sessions) {
      const t = new Date(s.lastActivity).getTime();
      expect(Number.isNaN(t)).toBe(false);
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(after);
    }
  });

  it('persists the restamp to disk so it survives a restart and eventually ages out (#557)', () => {
    // The real leak the persist guard closes: an in-memory-only restamp would be
    // re-read as corrupt on the next boot and restamped again forever. The main
    // recovery writer (persistHealedOnLoad=true) must write the healed value to
    // disk, and the persisted restamp must then age out normally once the TTL
    // elapses against it — exercising the full corrupt→persist→age-out path.
    const HOUR = 60 * 60 * 1000;
    const filePath = path.join(tmpDir, 'sessions.json');
    const corrupt = makeSession({
      id: 'corrupt-detached',
      state: 'detached',
      lastActivity: 'not-a-date',
    });

    vi.useFakeTimers();
    try {
      const t0 = new Date('2026-07-23T00:00:00.000Z').getTime();
      vi.setSystemTime(t0);

      // Recovery writer: persistHealedOnLoad ON. Default 8h detached TTL.
      const recoveryWriter = new StateWriter(tmpDir, 7 * 24, 8, true);
      recoveryWriter.saveImmediate(makeState([corrupt]));

      // First load heals the corrupt timestamp AND writes it back to disk.
      const firstLoad = recoveryWriter.load();
      expect(firstLoad.sessions.map((s) => s.id)).toContain('corrupt-detached');

      // The healed value is on disk (not just in memory): re-reading the raw
      // file shows a valid ISO timestamp equal to t0, not 'not-a-date'.
      const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        sessions: Array<{ id: string; lastActivity: string }>;
      };
      const persisted = onDisk.sessions.find((s) => s.id === 'corrupt-detached');
      expect(persisted).toBeDefined();
      expect(new Date(persisted!.lastActivity).getTime()).toBe(t0);

      // Advance the clock past the detached TTL relative to the PERSISTED
      // restamp. A fresh writer over the same dir (a daemon restart) rereads the
      // persisted value and now ages it out — proving it can never leak forever.
      vi.setSystemTime(t0 + 10 * HOUR); // 10h > 8h TTL
      const restarted = new StateWriter(tmpDir, 7 * 24, 8, true);
      const afterRestart = restarted.load().sessions.map((s) => s.id);
      expect(afterRestart).not.toContain('corrupt-detached');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT persist a restamp when persistHealedOnLoad is off (one-shot lock path) (#557)', () => {
    // The acquireLock() one-shot writer only reads bootId and must never write
    // sessions.json (it would race the main instance). With the flag off, load()
    // still heals the timestamp in memory but leaves the on-disk record corrupt.
    const filePath = path.join(tmpDir, 'sessions.json');
    const corrupt = makeSession({
      id: 'corrupt-detached',
      state: 'detached',
      lastActivity: 'not-a-date',
    });

    // Default `writer` (constructed in beforeEach) has persistHealedOnLoad off.
    writer.saveImmediate(makeState([corrupt]));

    const loaded = writer.load();
    // In-memory copy is healed...
    expect(Number.isNaN(new Date(loaded.sessions[0].lastActivity).getTime())).toBe(false);

    // ...but the on-disk file was NOT rewritten by load(): still 'not-a-date'.
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      sessions: Array<{ id: string; lastActivity: string }>;
    };
    expect(onDisk.sessions[0].lastActivity).toBe('not-a-date');
  });

  it('honours a custom detachedTtlHours from the constructor (#557)', () => {
    // A writer configured with a 2 h detached TTL instead of the 8 h default.
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const customWriter = new StateWriter(tmpDir, 7 * 24, 2);
    const stale = makeSession({
      id: 'stale-3h',
      state: 'detached',
      lastActivity: new Date(now - 3 * HOUR).toISOString(), // 3h > 2h → pruned
    });
    const fresh = makeSession({
      id: 'fresh-1h',
      state: 'detached',
      lastActivity: new Date(now - 1 * HOUR).toISOString(), // 1h < 2h → survives
    });
    customWriter.saveImmediate(makeState([stale, fresh]));

    const ids = customWriter.load().sessions.map((s) => s.id);
    expect(ids).not.toContain('stale-3h');
    expect(ids).toContain('fresh-1h');
  });

  it('load keeps an exec/supervised detached session past the detached TTL (#557)', () => {
    // exec units (X8 reboot-survival) are intentionally long-lived unattached
    // sessions that may sit silent for >8 h. The detached TTL must not reap
    // them, or supervision breaks. A plain detached session of the same age IS
    // pruned — proving the exemption is exec-specific, not TTL-wide.
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const supervised = makeSession({
      id: 'supervised-detached',
      state: 'detached',
      lastActivity: new Date(now - 100 * HOUR).toISOString(),
      exec: { command: 'node server.js' },
    });
    // supervision is an independent optional field: a supervised plain shell
    // can carry supervision WITHOUT exec, and must be exempt too.
    const supervisionOnly = makeSession({
      id: 'supervision-only-detached',
      state: 'detached',
      lastActivity: new Date(now - 100 * HOUR).toISOString(),
      supervision: {
        restart: 'on-failure',
        limit: { burst: 5, healthyUptimeSec: 300 },
        status: 'armed',
      },
    });
    const plain = makeSession({
      id: 'plain-detached',
      state: 'detached',
      lastActivity: new Date(now - 100 * HOUR).toISOString(),
    });

    writer.saveImmediate(makeState([supervised, supervisionOnly, plain]));

    const ids = writer.load().sessions.map((s) => s.id);
    expect(ids).toContain('supervised-detached');
    expect(ids).toContain('supervision-only-detached');
    expect(ids).not.toContain('plain-detached');
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

  // ── U2 (a2a-channels): saveImmediate boolean return parity ────────
  // StateWriter.saveImmediate is changed for parity with
  // ChannelStateWriter.saveImmediate (U2). The synchronous,
  // non-throwing contract is preserved; the boolean is opt-in for
  // callers that need the failure signal.
  describe('saveImmediate return value (U2 boolean parity)', () => {
    it('returns true on a successful write', () => {
      const ret = writer.saveImmediate(makeState([makeSession()]));
      expect(typeof ret).toBe('boolean');
      expect(ret).toBe(true);
      // Synchronous, non-throwing contract preserved: no Promise.
      expect((ret as unknown as { then?: unknown })?.then).toBeUndefined();
    });

    it('returns false and logs the error when the target path is unwritable', () => {
      // Force a real write failure by making the *parent* of the
      // target file be a regular file. The writer constructs
      // `path.join(baseDir, 'sessions.json')` and the atomic write's
      // `fs.writeFileSync(tmp, ...)` fails because
      // `<file>/sessions.json.tmp` cannot be created when the parent
      // is a file, not a directory.
      const blocker = path.join(tmpDir, 'blocker');
      fs.writeFileSync(blocker, 'this is a regular file, not a directory');

      const failingWriter = new StateWriter(blocker);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const ret = failingWriter.saveImmediate(makeState([makeSession()]));

      expect(ret).toBe(false);
      expect(errSpy).toHaveBeenCalledWith(
        '[StateWriter] Failed to save state:',
        expect.any(Error),
      );
      errSpy.mockRestore();
      failingWriter.dispose();
    });

    it('a load after a successful saveImmediate round-trips the data', () => {
      const s = makeSession({ id: 's-roundtrip' });
      const ret = writer.saveImmediate(makeState([s]));
      expect(ret).toBe(true);

      const loaded = writer.load();
      expect(loaded.sessions).toHaveLength(1);
      expect(loaded.sessions[0].id).toBe('s-roundtrip');
    });

    it('call sites that ignore the return value continue to work (no throw, file is written)', () => {
      // Mirrors the existing call-site pattern: the 13+ call sites in
      // src/daemon/index.ts and snapshotRunner.ts that don't capture
      // the return value continue to work — TypeScript allows
      // discarding return values.
      const filePath = path.join(tmpDir, 'sessions.json');
      expect(fs.existsSync(filePath)).toBe(false);

      // Discard the return value explicitly.
      void writer.saveImmediate(makeState([makeSession()]));

      expect(fs.existsSync(filePath)).toBe(true);
    });
  });
});

// #1305 — a suspended entry carrying recoveryError (a WSL pane waiting for the
// user's Retry) outlives the 7-day suspended TTL, but not forever: without a
// bound, a pane whose surface disappeared kept sessions.json growing and cost a
// cold WSL probe on every boot. The clock is recoveryPendingSince, stamped when
// the entry became pending — NOT lastActivity, which is the shell's last output
// and is already old for an exec unit that is allowed to sit silent.
//
//   recoveryPendingSince         7d                        30d
//        |------------------------|--------------------------|----------->
//        |   pending:   kept      |  pending: kept           | pending: pruned
//        |   suspended: kept      |  suspended: pruned       |
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function makePending(pendingForMs: number, overrides: Partial<DaemonSession> = {}): DaemonSession {
  return makeSession({
    state: 'suspended',
    cmd: 'wsl.exe',
    // Deliberately ancient: the shell went quiet long before the pane ever
    // went pending, which is the case that must NOT be reaped early.
    lastActivity: new Date(Date.now() - 400 * DAY_MS).toISOString(),
    recoveryError: 'WSL distro unavailable',
    recoveryPendingSince: new Date(Date.now() - pendingForMs).toISOString(),
    bufferDumpPath: '/saved/pane.buf',
    ...overrides,
  });
}

it('keeps a failed WSL recovery past suspended TTL so retry cannot lose its snapshot', () => {
  // 10 days pending: well past the 7-day suspended TTL, well inside the 30-day
  // pending-recovery TTL.
  const pending = makePending(10 * DAY_MS);
  writer.saveImmediate(makeState([pending]));
  expect(writer.load().sessions).toMatchObject([{ id: pending.id, recoveryError: pending.recoveryError, bufferDumpPath: pending.bufferDumpPath }]);
});

it('keeps a failed WSL recovery that is still inside the 30-day pending TTL', () => {
  writer.saveImmediate(makeState([makePending(29 * DAY_MS)]));
  expect(writer.load().sessions).toHaveLength(1);
});

it('prunes a failed WSL recovery nobody has asked for in 30 days', () => {
  // The bug: this entry used to be exempt outright, so it lived forever and
  // every boot scheduled a background promote retry for it (#1305).
  writer.saveImmediate(makeState([makePending(31 * DAY_MS)]));
  expect(writer.load().sessions).toEqual([]);
});

it('does not age a pending pane out on its shell activity', () => {
  // The whole point of the separate clock: an exec/supervised WSL unit may sit
  // silent for months and still be wanted. It went pending yesterday, so it
  // keeps its full retention even though lastActivity is 400 days old.
  writer.saveImmediate(makeState([makePending(1 * DAY_MS)]));
  expect(writer.load().sessions).toHaveLength(1);
});

it('keeps a legacy pending record that has no retention clock yet', () => {
  // Written by a wmux that predates recoveryPendingSince. Pruning it on
  // lastActivity would delete the pane and its .buf on the first boot after the
  // upgrade; the boot re-seed stamps the clock instead.
  const legacy = makePending(0);
  delete legacy.recoveryPendingSince;
  writer.saveImmediate(makeState([legacy]));
  expect(writer.load().sessions).toHaveLength(1);
});

it('never expires a pending recovery sooner than a plain suspended tombstone', () => {
  // suspendedTtlHours raised to 60 days: the pending entry must not be the one
  // that dies first.
  const longWriter = new StateWriter(tmpDir, 60 * 24);
  try {
    longWriter.saveImmediate(makeState([makePending(40 * DAY_MS)]));
    expect(longWriter.load().sessions).toHaveLength(1);
  } finally {
    longWriter.dispose();
  }
});

it('heals a pending recovery with a corrupt lastActivity instead of pruning it', () => {
  // The heal must keep running BEFORE the prune: a single bad timestamp must
  // not silently discard a pane's conversation binding and buffer.
  const pending = makePending(0, { lastActivity: 'not-a-timestamp' as unknown as string });
  writer.saveImmediate(makeState([pending]));
  const loaded = writer.load().sessions;
  expect(loaded).toHaveLength(1);
  expect(Number.isNaN(Date.parse(loaded[0].lastActivity))).toBe(false);
});
