/**
 * T12: daemon crash-restore integration.
 *
 * Verifies the end-to-end guarantees that depend on StateWriter,
 * SessionManager, AsyncQueue, and the atomic-write helpers working
 * together. The daemon's emergency save path (SIGINT/SIGTERM/
 * uncaughtException/Windows session-end) requires:
 *
 *   1. `saveImmediate` is a synchronous write (no Promise returned).
 *   2. File is durable on disk the instant `saveImmediate` returns.
 *   3. A still-queued debounced write cannot clobber an immediate
 *      save that superseded it.
 *   4. `flushSync()` drains the queue via the sync fallback so that
 *      process-exit paths with a stopped event loop still persist
 *      the latest snapshot.
 *   5. A crash mid-write (simulated by fsp/fs write throws) must
 *      leave the previous file untouched and must not leak .tmp
 *      residue.
 *   6. A fresh instance can `load()` the last durable snapshot and
 *      recover the daemon's view of the world.
 *
 * Crash simulation strategy: we mock `node:fs` / `node:fs/promises`
 * at the exact function that represents the crash point (writeFile,
 * rename, renameSync) rather than forking a real subprocess and
 * sending SIGKILL. This is portable across Windows and deterministic
 * enough to run on CI in milliseconds.
 *
 * Related files:
 *   - D:\wmux\src\daemon\StateWriter.ts
 *   - D:\wmux\src\main\session\SessionManager.ts
 *   - D:\wmux\src\daemon\util\AsyncQueue.ts
 *   - D:\wmux\src\daemon\util\atomicWrite\core.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StateWriter } from '../StateWriter';
import { waitForCondition } from './_waitForFile';
import { atomicWriteJSON } from '../util/atomicWrite';
import type { DaemonState, DaemonSession } from '../types';

// SessionManager lives in main/ and pulls in `electron`. The mock
// factory is hoisted by vitest above the static import below so
// `app.getPath('userData')` is callable in a plain node test context.
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => path.join(os.tmpdir(), 'wmux-crash-restore-session')),
  },
}));

import { SessionManager } from '../../main/session/SessionManager';
import * as electron from 'electron';

// ── Fixtures ─────────────────────────────────────────────────────────

function makeSession(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    id: 'sess-1',
    state: 'detached',
    createdAt: new Date('2026-04-17T00:00:00.000Z').toISOString(),
    lastActivity: new Date('2026-04-17T00:00:00.000Z').toISOString(),
    pid: 4242,
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

// ── Shared setup ─────────────────────────────────────────────────────

let tmpDir: string;
let writer: StateWriter;
let statePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-crash-restore-'));
  writer = new StateWriter(tmpDir);
  statePath = path.join(tmpDir, 'sessions.json');
});

afterEach(() => {
  // Clear any lingering timers before we dispose — dispose() calls
  // saveImmediate() on pending state, which is fine, but we don't
  // want leftover fake timers to leak into the next test.
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
  try {
    writer.dispose();
  } catch {
    // best-effort — tests may have thrown the writer into a bad state
  }
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Scenario 1: saveImmediate synchronous contract ───────────────────

describe('crash-restore integration — saveImmediate synchronous contract', () => {
  it('returns boolean true on the sync path (no Promise) — emergency exit handlers rely on this', () => {
    // U2 (a2a-channels): saveImmediate now returns `boolean` instead
    // of `void` so the post path can surface PERSIST_FAILED. The
    // synchronous, non-throwing contract is preserved — what matters
    // here is that the return is NOT a Promise; the boolean type is
    // a refinement that callers ignore unless they need the failure
    // signal.
    const result: unknown = writer.saveImmediate(makeState([makeSession()]));

    // Core contract: saveImmediate must be synchronous and return a
    // boolean on success — never a Promise.
    expect(typeof result).toBe('boolean');
    expect(result).toBe(true);
    // Defensive: even if result became truthy, it must not be
    // thenable. The daemon's signal handlers cannot await.
    expect(typeof (result as { then?: unknown })?.then).not.toBe('function');
  });

  it('file is durable on disk the instant saveImmediate returns — no microtask wait', () => {
    expect(fs.existsSync(statePath)).toBe(false);

    writer.saveImmediate(makeState([makeSession({ id: 'immediate' })]));

    // No `await`, no setImmediate — checked in the very next sync
    // statement. This is the invariant that makes the daemon's
    // signal handlers safe.
    expect(fs.existsSync(statePath)).toBe(true);
    const loaded = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(loaded.sessions[0].id).toBe('immediate');
  });

  it('14 consecutive saveImmediate calls — file always valid, no .tmp residue', () => {
    // Mirrors the daemon's index.ts emergency path which calls
    // saveImmediate at 14 distinct exit sites. Each iteration must
    // leave the primary file parseable and the tmp slot clean.
    for (let i = 0; i < 14; i += 1) {
      writer.saveImmediate(
        makeState([makeSession({ id: `iter-${i}` })]),
      );

      // Primary exists and parses as valid DaemonState.
      expect(fs.existsSync(statePath)).toBe(true);
      const loaded = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      expect(loaded.version).toBe(1);
      expect(loaded.sessions[0].id).toBe(`iter-${i}`);

      // No .tmp residue after each successful write. We scan the
      // directory rather than hitting a single fixed path because
      // tmp files are named `<target>.tmp.<pid>.<counter>`.
      const leftoverTmp = fs
        .readdirSync(tmpDir)
        .filter((f) => f.includes('.tmp.'));
      expect(leftoverTmp).toEqual([]);
    }
  });

  it('queued saveDebounced is dropped when saveImmediate supersedes it (queue.clear path)', async () => {
    vi.useFakeTimers();

    // Stage a debounced save of v1.
    writer.saveDebounced(makeState([makeSession({ id: 'debounced-v1' })]));
    expect(fs.existsSync(statePath)).toBe(false);

    // Advance past the 30s debounce — this fires the setTimeout
    // callback synchronously, which calls queue.enqueue. No
    // microtasks have drained yet because we haven't yielded.
    vi.advanceTimersByTime(30_000);

    // Between the enqueue and the microtask draining, call
    // saveImmediate. Its first action is queue.clear(), which
    // resolves the pending entry as a no-op before maybeStart()
    // can pick it up.
    writer.saveImmediate(
      makeState([makeSession({ id: 'immediate-winner' })]),
    );

    // Yield to drain microtasks. The coalesced task must resolve
    // without touching the file again.
    vi.useRealTimers();
    await waitForCondition(
      () => fs.existsSync(statePath) && JSON.parse(fs.readFileSync(statePath, 'utf-8')).sessions[0].id === 'immediate-winner',
    );

    const loaded = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(loaded.sessions[0].id).toBe('immediate-winner');
  });
});

// ── Scenario 2: flushSync drain ──────────────────────────────────────

describe('crash-restore integration — flushSync drains pending state', () => {
  it('flushSync before the debounce timer fires writes via sync fallback', () => {
    vi.useFakeTimers();

    writer.saveDebounced(makeState([makeSession({ id: 'pending-sync' })]));
    // Timer still pending — nothing has been written yet.
    expect(fs.existsSync(statePath)).toBe(false);

    // Simulate process-exit before the 30s debounce expires.
    writer.flushSync();

    // flushSync must have routed the pending snapshot through the
    // sync atomicWrite path.
    expect(fs.existsSync(statePath)).toBe(true);
    const loaded = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(loaded.sessions[0].id).toBe('pending-sync');
  });

  it('flushSync leaves the writer idle — a fresh saveDebounced works afterward', async () => {
    vi.useFakeTimers();

    writer.saveDebounced(makeState([makeSession({ id: 'first' })]));
    writer.flushSync();
    expect(fs.existsSync(statePath)).toBe(true);

    // After flushSync the internal queue should be idle; a new
    // debounced save must schedule a fresh timer.
    writer.saveDebounced(makeState([makeSession({ id: 'second' })]));

    vi.advanceTimersByTime(30_000);
    vi.useRealTimers();
    await waitForCondition(
      () => fs.existsSync(statePath) && JSON.parse(fs.readFileSync(statePath, 'utf-8')).sessions[0].id === 'second',
    );

    const loaded = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(loaded.sessions[0].id).toBe('second');
  });

  it('process-exit pattern — debounced payload survives via flushSync sync fallback', () => {
    vi.useFakeTimers();

    const payload = makeState([
      makeSession({ id: 'process-exit-payload', state: 'attached' }),
    ]);
    writer.saveDebounced(payload);

    // Simulate reaching process 'exit' handler before the async
    // write could flush. flushSync is the only tool available —
    // the event loop will not run microtasks after exit.
    writer.flushSync();

    const loaded = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(loaded.sessions).toHaveLength(1);
    expect(loaded.sessions[0].id).toBe('process-exit-payload');
    expect(loaded.sessions[0].state).toBe('attached');
  });
});

// ── Scenario 3: atomic-write crash simulation ────────────────────────

describe('crash-restore integration — atomic-write crash simulation', () => {
  it('writeFileSync crash during saveImmediate preserves previous file + no tmp residue', () => {
    // Persist v1 normally.
    writer.saveImmediate(makeState([makeSession({ id: 'v1-durable' })]));
    const v1Contents = fs.readFileSync(statePath, 'utf-8');

    // Crash the next sync write.
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementationOnce(() => {
        throw new Error('EIO: simulated disk failure');
      });

    // StateWriter.saveImmediate swallows the atomicWriteJSONSync
    // error via console.error — the important invariants are that
    // the primary file is unchanged and there is no leaked tmp.
    writer.saveImmediate(makeState([makeSession({ id: 'v2-will-fail' })]));

    expect(writeSpy).toHaveBeenCalled();

    // Primary file still holds v1 — the crash happened before the
    // rename tmp→primary so primary was never touched.
    expect(fs.readFileSync(statePath, 'utf-8')).toBe(v1Contents);

    const leftoverTmp = fs
      .readdirSync(tmpDir)
      .filter((f) => f.includes('.tmp.'));
    expect(leftoverTmp).toEqual([]);
  });

  it('fsp.rename crash during atomicWriteJSON cleans tmp + propagates error', async () => {
    // Pre-populate a valid primary so the first rename
    // (primary → .bak) has a source to move. Then fail the second
    // rename (tmp → primary), which is the one that gets
    // rethrown from atomicWriteJSON.
    writer.saveImmediate(makeState([makeSession({ id: 'rename-v1' })]));

    const realRename = fsp.rename.bind(fsp);
    let renameCall = 0;
    const renameSpy = vi
      .spyOn(fsp, 'rename')
      .mockImplementation(async (from, to) => {
        renameCall += 1;
        // Let the primary→.bak rename succeed so the crash lands
        // squarely on the tmp→primary step — that's the branch
        // whose exception propagates out of atomicWriteJSON.
        if (renameCall === 1) {
          return realRename(from, to);
        }
        throw new Error('EIO: simulated rename failure');
      });

    const before = fs.readdirSync(tmpDir);

    // Call atomicWriteJSON directly — StateWriter's queue task
    // swallows errors via console.error, which would hide the
    // propagation contract we want to verify here.
    await expect(
      atomicWriteJSON(statePath, makeState([makeSession({ id: 'v2-rename-fail' })])),
    ).rejects.toThrow(/simulated rename failure/);

    expect(renameSpy).toHaveBeenCalled();

    // No .tmp residue — the outer catch in atomicWriteJSON must
    // have unlinked the staged tmp file.
    const after = fs.readdirSync(tmpDir);
    const leakedTmp = after
      .filter((f) => f.includes('.tmp.') && !before.includes(f));
    expect(leakedTmp).toEqual([]);
  });

  it('saveImmediate → fresh StateWriter instance loads the same payload (crash-restore)', () => {
    const payload = makeState([
      makeSession({ id: 'survivor-1', state: 'attached' }),
      makeSession({ id: 'survivor-2', state: 'detached' }),
    ]);
    writer.saveImmediate(payload);

    // Simulate a daemon crash and restart: drop the old instance,
    // create a new one against the same directory, and load.
    writer.dispose();
    const restarted = new StateWriter(tmpDir);
    const loaded = restarted.load();

    expect(loaded.version).toBe(1);
    expect(loaded.sessions).toHaveLength(2);
    expect(loaded.sessions.map((s) => s.id).sort()).toEqual([
      'survivor-1',
      'survivor-2',
    ]);
    // Reassign so afterEach's dispose() targets the live writer.
    writer = restarted;
  });

  it('flushSync → fresh StateWriter instance loads the debounced payload (crash-restore via sync fallback)', () => {
    vi.useFakeTimers();

    const payload = makeState([makeSession({ id: 'flushed-survivor' })]);
    writer.saveDebounced(payload);
    // Crash before debounce expires — flushSync is the last line
    // of defence and must still hand the payload to disk.
    writer.flushSync();

    writer.dispose();
    vi.useRealTimers();

    const restarted = new StateWriter(tmpDir);
    const loaded = restarted.load();

    expect(loaded.sessions).toHaveLength(1);
    expect(loaded.sessions[0].id).toBe('flushed-survivor');
    writer = restarted;
  });
});

// ── Scenario 4: SessionManager mirrors the same guarantees ───────────

describe('crash-restore integration — SessionManager mirrors StateWriter contract', () => {
  let sessionUserDataDir: string;
  let sessionPath: string;
  let manager: InstanceType<typeof SessionManager>;

  beforeEach(() => {
    sessionUserDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wmux-crash-restore-sm-'),
    );
    // Steer the SessionManager at our scratch directory for this
    // test without needing a fresh vi.mock per case.
    (electron.app.getPath as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      sessionUserDataDir,
    );

    manager = new SessionManager();
    sessionPath = path.join(sessionUserDataDir, 'session.json');
  });

  afterEach(() => {
    fs.rmSync(sessionUserDataDir, { recursive: true, force: true });
  });

  it('save() is synchronous and durable — same contract as StateWriter.saveImmediate', () => {
    const data = {
      workspaces: [],
      activeWorkspaceId: 'ws-1',
      sidebarVisible: true,
    };

    const result: unknown = manager.save(data);
    expect(result).toBeUndefined();
    expect(typeof (result as { then?: unknown })?.then).not.toBe('function');

    // File durable the instant save() returns.
    expect(fs.existsSync(sessionPath)).toBe(true);
    const loaded = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    expect(loaded.activeWorkspaceId).toBe('ws-1');
  });

  it('flushSync() writes the debounced payload via sync fallback on process exit', () => {
    vi.useFakeTimers();

    const data = {
      workspaces: [],
      activeWorkspaceId: 'ws-flush-sync',
      sidebarVisible: false,
    };
    manager.saveDebounced(data);

    // Nothing on disk until either the timer expires or flushSync
    // runs.
    expect(fs.existsSync(sessionPath)).toBe(false);

    manager.flushSync();

    expect(fs.existsSync(sessionPath)).toBe(true);
    const loaded = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    expect(loaded.activeWorkspaceId).toBe('ws-flush-sync');

    vi.useRealTimers();
  });
});
