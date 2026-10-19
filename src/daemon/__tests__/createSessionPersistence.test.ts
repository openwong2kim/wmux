import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock node-pty so create/attach do not spawn real processes.
// Mirrors the pattern in DaemonSessionManager.os.test.ts.
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

// #2398: a fixed native creation time, so the stamp is the same on every OS.
const PID_CREATED_AT_FT = 134296036801234567n;
vi.mock('../phantomExit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../phantomExit')>()),
  getProcessCreatedAtFt: () => PID_CREATED_AT_FT,
  getProcessStartTime: async () => null,
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

  it('StateWriter.saveImmediate has synchronous boolean return (lock against async refactor)', () => {
    // U2 (a2a-channels): saveImmediate now returns `boolean` instead
    // of `void` so the post path can surface PERSIST_FAILED. The
    // synchronous, non-throwing contract is preserved — emergency
    // exit handlers still rely on it. The original guard (no Promise
    // return) is what matters here; the boolean type is a refinement.
    const ret = writer.saveImmediate({ version: 1, sessions: [] });
    expect(typeof ret).toBe('boolean');
    expect(ret).toBe(true);
    // Defensive check: even if the return type changed again, it must
    // not become a Promise. The daemon's signal handlers cannot await.
    expect((ret as unknown as { then?: unknown })?.then).toBeUndefined();
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

  // #2398: the FILETIME is stamped synchronously at create, so the first save
  // already holds it, and it survives JSON as an exact decimal string.
  it('createSession stamps pidCreatedAtFt, and it round-trips through sessions.json as a string', () => {
    const session = manager.createSession({
      id: 'ft-stamp', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24,
    });
    expect(session.pidCreatedAtFt).toBe(PID_CREATED_AT_FT.toString());
    expect(session.pidStartTime).toBeUndefined();

    writer.saveImmediate(buildState());
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'sessions.json'), 'utf-8')) as DaemonState;
    expect(raw.sessions.find((s) => s.id === 'ft-stamp')?.pidCreatedAtFt).toBe('134296036801234567');
    const loaded = new StateWriter(tmpDir).load();
    const reloaded = loaded.sessions.find((s) => s.id === 'ft-stamp');
    expect(reloaded?.pidCreatedAtFt).toBe('134296036801234567');
    expect(BigInt(reloaded?.pidCreatedAtFt ?? -1)).toBe(PID_CREATED_AT_FT);
    expect(reloaded?.pidStartTime).toBeUndefined();

    manager.destroySession(session.id);
  });

  it('a web-created pane persists the remote-durable marker and is still destroyed on close', () => {
    const filePath = path.join(tmpDir, 'sessions.json');
    const session = manager.createSession({
      id: 'web-durable', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24, remoteDurable: true,
    });
    writer.saveImmediate(buildState());
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DaemonState;
    expect(persisted.sessions).toContainEqual(expect.objectContaining({ id: 'web-durable', remoteDurable: true }));

    // DELETE /api/sessions/:id (RemoteHostClient.closeSession) ends in destroySession:
    // the marker only lengthens the idle reap, it never keeps a closed pane.
    manager.destroySession(session.id);
    writer.saveImmediate(buildState());
    const after = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DaemonState;
    expect(after.sessions.map((s) => s.id)).not.toContain('web-durable');
  });

  // Source-level guard — addresses codex review P3 (2026-05-15 session
  // 019e2af8). The behavioral tests above replay the production sequence but
  // do not invoke the actual RPC handler. A handler-level refactor that
  // removed `stateWriter.saveImmediate(state)` would not fail those tests.
  //
  // This static check reads the daemon entrypoint source and confirms the
  // saveImmediate call is still present in both handler bodies. We slice the
  // source by handler-marker comments (// daemon.<method>) rather than using
  // a regex over braces, because handler bodies contain nested arrow callbacks
  // (e.g., processMonitor.watch) that would confuse a brace-based match.
  it('source-level guard: createSession + attachSession handlers retain saveImmediate', () => {
    const daemonIndexPath = path.join(__dirname, '..', 'index.ts');
    const src = fs.readFileSync(daemonIndexPath, 'utf-8');
    const lines = src.split('\n');

    function extractHandlerBody(method: string): string {
      const startMarker = `// daemon.${method}`;
      const startIdx = lines.findIndex((l) => l.trim() === startMarker);
      if (startIdx < 0) throw new Error(`Start marker not found: ${startMarker}`);
      // Body runs until the next `// daemon.<word>` comment line, exclusive.
      const nextHandlerIdx = lines.findIndex(
        (l, i) => i > startIdx && /^\s*\/\/ daemon\.\w+\s*$/.test(l),
      );
      const endIdx = nextHandlerIdx > 0 ? nextHandlerIdx : lines.length;
      return lines.slice(startIdx, endIdx).join('\n');
    }

    const createBody = extractHandlerBody('createSession');
    const attachBody = extractHandlerBody('attachSession');

    // saveImmediate(state) must appear in each handler. If a refactor removes
    // it (e.g., debounces it via setImmediate), this guard fails.
    expect(createBody).toMatch(/stateWriter\.saveImmediate\(\s*state\s*\)/);
    expect(attachBody).toMatch(/stateWriter\.saveImmediate\(\s*state\s*\)/);

    // Negative guard — saveImmediate is NOT wrapped in setImmediate or
    // queueMicrotask in either handler.
    expect(createBody).not.toMatch(/setImmediate\([^)]*saveImmediate/);
    expect(createBody).not.toMatch(/queueMicrotask\([^)]*saveImmediate/);
    expect(attachBody).not.toMatch(/setImmediate\([^)]*saveImmediate/);
    expect(attachBody).not.toMatch(/queueMicrotask\([^)]*saveImmediate/);
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
