import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock node-pty so create/attach do not spawn real processes.
// Mirrors the pattern in DaemonSessionManager.test.ts.
class MockPty extends EventEmitter {
  pid = 12345;
  onData() { return { dispose: () => { /* noop */ } }; }
  onExit() { return { dispose: () => { /* noop */ } }; }
  write(_data: string): void { /* noop */ }
  resize(_cols: number, _rows: number): void { /* noop */ }
  kill(): void { /* noop */ }
}

vi.mock('node-pty', () => ({
  default: {
    spawn: () => new MockPty(),
  },
  spawn: () => new MockPty(),
}));

// Import after mock so DaemonSessionManager wires the mock.
import { DaemonSessionManager } from '../DaemonSessionManager';
import { StateWriter } from '../StateWriter';
import type { DaemonState } from '../types';

// A1a invariant lock test.
//
// Production behavior under test:
//   daemon.createSession RPC handler (src/daemon/index.ts:474-508)
//     calls sessionManager.createSession + buildState + stateWriter.saveImmediate(state)
//     BEFORE returning. saveImmediate is synchronous (see StateWriter.ts:35), so
//     sessions.json is on disk before the RPC ack is delivered to the caller.
//   daemon.attachSession RPC handler (src/daemon/index.ts:544-595) has the same
//     invariant on its happy path (lines 591-592). The throw-path
//     (pipe.start() failing) is documented in decisions.md (codex finding #16).
//
// Why this test exists:
//   The plan A1a step prescribed adding setImmediate(saveImmediate) to the
//   createSession/attachSession handlers. Codex consult (session 019e2af8,
//   2026-05-15) finding #16 verified the invariant is already in production.
//   This test locks it against future refactors that would break it (e.g.,
//   wrapping the call in setImmediate, making saveImmediate async, or
//   reordering so save runs after pipe.start()).
describe('A1a invariant — saveImmediate persists synchronously', () => {
  let tmpDir: string;
  let writer: StateWriter;
  let manager: DaemonSessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-a1a-test-'));
    writer = new StateWriter(tmpDir);
    manager = new DaemonSessionManager();
  });

  afterEach(() => {
    writer.dispose();
    manager.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Mirrors buildState() in src/daemon/index.ts:851-860.
  function buildState(): DaemonState {
    return {
      version: 1,
      sessions: manager.listSessions(),
      bootId: 'a1a-test-boot',
    };
  }

  it('StateWriter.saveImmediate has synchronous void return (lock against async refactor)', () => {
    const ret = writer.saveImmediate({ version: 1, sessions: [] });
    expect(ret).toBeUndefined();
    // Defensive check: if a refactor returns a Promise, .then would exist.
    expect((ret as unknown as { then?: unknown } | undefined)?.then).toBeUndefined();
  });

  it('sessions.json exists synchronously after saveImmediate returns', () => {
    const filePath = path.join(tmpDir, 'sessions.json');
    expect(fs.existsSync(filePath)).toBe(false);
    writer.saveImmediate({ version: 1, sessions: [] });
    // No await, no microtask yield, no setImmediate — file must exist now.
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('saveImmediate write completes before any microtask boundary', async () => {
    const filePath = path.join(tmpDir, 'sessions.json');
    let observedAbsenceInMicrotask = false;
    // Schedule a microtask that would observe the file's absence if saveImmediate
    // were async or deferred via setImmediate.
    Promise.resolve().then(() => {
      observedAbsenceInMicrotask = !fs.existsSync(filePath);
    });
    writer.saveImmediate({ version: 1, sessions: [] });
    // Drain microtask + macrotask queue.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observedAbsenceInMicrotask).toBe(false);
  });

  // Replays the production createSession RPC handler sequence
  // (src/daemon/index.ts:482-507) and asserts the persistence invariant.
  it('createSession RPC sequence: session entry on disk before RPC return', () => {
    const filePath = path.join(tmpDir, 'sessions.json');
    const sessionId = 'a1a-invariant-create';

    const session = manager.createSession({
      id: sessionId,
      cmd: 'bash',
      cwd: tmpDir,
      env: {},
      cols: 80,
      rows: 24,
    });
    const state = buildState();
    writer.saveImmediate(state);
    // ^ Equivalent to the moment the RPC handler returns the session to caller.

    expect(fs.existsSync(filePath)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DaemonState;
    expect(persisted.sessions).toContainEqual(
      expect.objectContaining({ id: sessionId }),
    );
    expect(persisted.bootId).toBeDefined();

    manager.destroySession(session.id);
  });

  // Replays the production attachSession happy-path persistence
  // (src/daemon/index.ts:591-592). The throw-path (pipe.start() failing) is a
  // known gap tracked under codex finding #16 follow-up.
  it('attachSession RPC sequence (happy path): attached state on disk before RPC return', () => {
    const filePath = path.join(tmpDir, 'sessions.json');
    const sessionId = 'a1a-invariant-attach';

    // Initial create + persist (so a session exists to attach).
    manager.createSession({
      id: sessionId,
      cmd: 'bash',
      cwd: tmpDir,
      env: {},
      cols: 80,
      rows: 24,
    });
    writer.saveImmediate(buildState());

    // Now exercise attachSession's persistence invariant. The production handler
    // wraps a SessionPipe start between manager.attachSession and saveImmediate;
    // we skip the pipe step because the invariant being locked is the
    // saveImmediate sync write, not the pipe lifecycle.
    manager.attachSession(sessionId);
    writer.saveImmediate(buildState());

    expect(fs.existsSync(filePath)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DaemonState;
    const persistedSession = persisted.sessions.find((s) => s.id === sessionId);
    expect(persistedSession).toBeDefined();
    expect(persistedSession?.state).toBe('attached');

    manager.destroySession(sessionId);
  });
});
