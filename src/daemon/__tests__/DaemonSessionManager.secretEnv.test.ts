// A bot worker's secrets reach the spawned process only: never the session's
// meta.env, so never sessions.json (buildState serialises listSessions), a
// session read, or a recovery / supervised-restart replay.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import os from 'node:os';

class MockPty extends EventEmitter {
  pid = 4242;
  constructor(readonly cmd: string, readonly args: string[], readonly opts: { cols: number; rows: number; env?: Record<string, string> }) {
    super();
  }
  onData() { return { dispose: () => undefined }; }
  onExit() { return { dispose: () => undefined }; }
  write(): void { /* noop */ }
  resize(): void { /* noop */ }
  kill(): void { /* noop */ }
}

const spawned: MockPty[] = [];
vi.mock('../../shared/terminalPty', async (importOriginal) => (await import('../../test-utils/ptyTransportStub')).routeSpawnToNodePtyMock(importOriginal));
vi.mock('node-pty', () => {
  const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
    const p = new MockPty(cmd, args, opts as { cols: number; rows: number; env?: Record<string, string> });
    spawned.push(p);
    return p;
  };
  return { default: { spawn }, spawn };
});

import { DaemonSessionManager } from '../DaemonSessionManager';

const VALUE = 'npm_9f8e7d6c5b4a3f2e1d0c';

describe('DaemonSessionManager secretEnv', () => {
  let manager: DaemonSessionManager;
  beforeEach(() => {
    spawned.length = 0;
    manager = new DaemonSessionManager();
  });
  afterEach(() => manager.disposeAll());

  it('puts the secrets in the spawn env only, never on the session meta', () => {
    const session = manager.createSession({
      id: 'worker-1',
      cmd: '/bin/bash',
      cwd: os.tmpdir(),
      env: { PATH: '/usr/bin', HOME: os.homedir() },
      secretEnv: { NPM_TOKEN: VALUE },
    });
    expect(spawned.at(-1)?.opts.env?.NPM_TOKEN).toBe(VALUE);
    expect(session.env?.NPM_TOKEN).toBeUndefined();
    // What buildState persists (sessions.json) and every session read serve.
    expect(JSON.stringify(manager.listSessions())).not.toContain(VALUE);
    expect(JSON.stringify(manager.getSession('worker-1')?.meta)).not.toContain(VALUE);
  });

  it('takes a connection gateway bearer (main/connectors/workerGateway.ts) like a secret: spawn env only, never listed or replayed', () => {
    const BEARER = 'lease_bearer_Abc123_xyz789_0000000000000000';
    manager.createSession({ id: 'worker-g', cmd: '/bin/bash', cwd: os.tmpdir(), env: { PATH: '/usr/bin' }, secretEnv: { CONNECTOR_1A2B3C4D_TOKEN: BEARER } });
    expect(spawned.at(-1)?.opts.env?.CONNECTOR_1A2B3C4D_TOKEN).toBe(BEARER);
    expect(JSON.stringify(manager.listSessions())).not.toContain(BEARER);
    const meta = manager.listSessions().find((s) => s.id === 'worker-g');
    manager.destroySession('worker-g');
    manager.createSession({ id: 'worker-g', cmd: meta!.cmd, cwd: meta!.cwd, env: meta!.env });
    expect(spawned.at(-1)?.opts.env?.CONNECTOR_1A2B3C4D_TOKEN).toBeUndefined();
  });

  it('a replay of the persisted meta spawns without the secrets', () => {
    manager.createSession({ id: 'worker-2', cmd: '/bin/bash', cwd: os.tmpdir(), env: { PATH: '/usr/bin' }, secretEnv: { NPM_TOKEN: VALUE } });
    const meta = manager.listSessions().find((s) => s.id === 'worker-2');
    manager.destroySession('worker-2');
    manager.createSession({ id: 'worker-2', cmd: meta!.cmd, cwd: meta!.cwd, env: meta!.env });
    expect(spawned.at(-1)?.opts.env?.NPM_TOKEN).toBeUndefined();
  });

  it('refuses a malformed secret env (fails the create, spawns nothing)', () => {
    const bad: unknown[] = [
      {},
      { lowercase_token: VALUE },
      { WMUX_AUTH_TOKEN: VALUE },
      { PATH: '/tmp/evil' },
      { NPM_TOKEN: 'short' },
      { NPM_TOKEN: 42 },
      [VALUE],
    ];
    for (const secretEnv of bad) {
      const before = spawned.length;
      expect(() => manager.createSession({
        id: `bad-${spawned.length}-${Math.random().toString(16).slice(2, 8)}`,
        cmd: '/bin/bash',
        cwd: os.tmpdir(),
        secretEnv: secretEnv as Record<string, string>,
      })).toThrow(/secretEnv/);
      expect(spawned.length).toBe(before);
    }
  });
});
