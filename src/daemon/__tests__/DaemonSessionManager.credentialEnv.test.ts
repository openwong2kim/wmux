// #3049 — a restored user shell's credentials, passed by main when it starts
// the shell's placeholder, reach the spawned process only: never the
// session's meta.env, so never sessions.json (buildState serialises
// listSessions), a session read, or a later replay. The placeholder's
// in-memory start hold is never on a record either.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
vi.mock('node-pty', () => {
  const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
    const p = new MockPty(cmd, args, opts as { cols: number; rows: number; env?: Record<string, string> });
    spawned.push(p);
    return p;
  };
  return { default: { spawn }, spawn };
});

import { DaemonSessionManager } from '../DaemonSessionManager';
import { StateWriter } from '../StateWriter';
import type { DaemonSession } from '../types';

// Placeholder values only; no real secret is ever used in a test.
const VALUE = 'placeholder-3049';

function record(id: string, extra: Partial<DaemonSession> = {}): DaemonSession {
  return {
    id,
    state: 'suspended',
    createdAt: '2026-11-04T00:00:00.000Z',
    lastActivity: '2026-11-04T00:00:00.000Z',
    pid: 1234,
    cmd: '/bin/bash',
    cwd: os.tmpdir(),
    env: { PATH: '/usr/bin', HOME: os.homedir() },
    cols: 80,
    rows: 24,
    deadTtlHours: 24,
    ...extra,
  };
}

const replayOf = (s: DaemonSession) => ({ id: s.id, cmd: s.cmd, cwd: s.cwd, env: s.env, cols: s.cols, rows: s.rows });

describe('DaemonSessionManager credentialEnv (#3049)', () => {
  let manager: DaemonSessionManager;
  let dir: string;
  beforeEach(() => {
    spawned.length = 0;
    manager = new DaemonSessionManager();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cred3049-'));
  });
  afterEach(() => {
    manager.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('puts the credentials in the spawn env only: not on the meta, the listing or the saved state', async () => {
    const held = record('shell-1');
    manager.holdForStart(held);
    await manager.createSessionAsync({ ...replayOf(held), credentialEnv: { GH_TOKEN: VALUE } });

    expect(spawned.at(-1)?.opts.env?.GH_TOKEN).toBe(VALUE);
    expect(manager.getSession('shell-1')?.meta.env.GH_TOKEN).toBeUndefined();
    expect(JSON.stringify(manager.listSessions())).not.toContain(VALUE);
    const writer = new StateWriter(dir);
    try {
      expect(writer.saveImmediate({ version: 1, sessions: manager.listSessions(), bootId: 'boot' })).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')).not.toContain(VALUE);
    } finally {
      writer.dispose();
    }
  });

  it('a replay of the persisted meta spawns without the credentials', async () => {
    await manager.createSessionAsync({ ...replayOf(record('shell-2')), credentialEnv: { GH_TOKEN: VALUE } });
    const meta = manager.listSessions().find((s) => s.id === 'shell-2')!;
    manager.destroySession('shell-2');
    await manager.createSessionAsync(replayOf(meta));
    expect(spawned.at(-1)?.opts.env?.GH_TOKEN).toBeUndefined();
  });

  it('never overrides a key the env carries, and names nothing in WSLENV', async () => {
    await manager.createSessionAsync({
      ...replayOf(record('shell-3', { env: { PATH: '/usr/bin', GH_TOKEN: 'kept-placeholder', WSLENV: 'USERPROFILE/p' } })),
      credentialEnv: { GH_TOKEN: VALUE, NPM_TOKEN: VALUE },
    });
    const env = spawned.at(-1)!.opts.env!;
    expect(env.GH_TOKEN).toBe('kept-placeholder');
    expect(env.NPM_TOKEN).toBe(VALUE);
    expect(env.WSLENV).toBe('USERPROFILE/p');
  });

  it('drops what is not a passable credential: the relay secret, WMUX_*, internal and plain keys', async () => {
    await manager.createSessionAsync({
      ...replayOf(record('shell-4')),
      credentialEnv: { GH_TOKEN: VALUE, WMUX_PUSH_RELAY_SECRET: 'relay-placeholder', PATH: '/evil', NODE_OPTIONS: '--x' },
    });
    const env = spawned.at(-1)!.opts.env!;
    expect(env.GH_TOKEN).toBe(VALUE);
    expect(env.WMUX_PUSH_RELAY_SECRET).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('refuses credentials for an exec unit or a supervised session, and spawns nothing', async () => {
    const before = spawned.length;
    await expect(manager.createSessionAsync({ ...replayOf(record('agent-1')), exec: { command: 'claude' }, credentialEnv: { GH_TOKEN: VALUE } }))
      .rejects.toThrow(/credentialEnv/);
    await expect(manager.createSessionAsync({
      ...replayOf(record('agent-2')),
      supervision: { restart: 'on-failure', limit: { maxRestarts: 3, windowMs: 60_000 }, status: 'armed' },
      credentialEnv: { GH_TOKEN: VALUE },
    })).rejects.toThrow(/credentialEnv/);
    await expect(manager.createSessionAsync({ ...replayOf(record('shell-5')), credentialEnv: ['x'] as unknown as Record<string, string> }))
      .rejects.toThrow(/credentialEnv/);
    expect(spawned.length).toBe(before);
  });

  it('a held placeholder is listed once, as suspended, and once more only as the live session after its start', async () => {
    const held = record('shell-6');
    manager.holdForStart(held);
    expect(manager.isStartPending('shell-6')).toBe(true);
    expect(manager.startPendingIds()).toEqual(['shell-6']);
    expect(manager.listSessions().filter((s) => s.id === 'shell-6').map((s) => s.state)).toEqual(['suspended']);
    // The hold is never on the record, so never persisted.
    expect(JSON.stringify(manager.listSessions())).not.toContain('startPending');

    await manager.createSessionAsync({ ...replayOf(held), credentialEnv: { GH_TOKEN: VALUE } });
    expect(manager.listSessions().filter((s) => s.id === 'shell-6').map((s) => s.state)).toEqual(['detached']);
    expect(manager.isStartPending('shell-6')).toBe(false);
  });

  it('a failed start drops the placeholder silently; a close drops it as destroyed', () => {
    const destroyed: string[] = [];
    manager.on('session:destroyed', (p: { id: string }) => destroyed.push(p.id));
    manager.holdForStart(record('shell-7'));
    manager.holdForStart(record('shell-8'));

    expect(manager.dropPendingRecovery('shell-7')?.id).toBe('shell-7');
    expect(manager.isStartPending('shell-7')).toBe(false);
    expect(manager.getPendingRecovery('shell-7')).toBeUndefined();
    expect(destroyed).toEqual([]);

    manager.destroySession('shell-8');
    expect(manager.isStartPending('shell-8')).toBe(false);
    expect(destroyed).toEqual(['shell-8']);
  });
});
