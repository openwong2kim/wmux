// The Claude file send setting (shared/claudeFileSend.ts) reaches every daemon
// spawn through the process env only: on adds the variable, off adds nothing,
// and the session meta (sessions.json, recovery replays) never carries it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import os from 'node:os';

class MockPty extends EventEmitter {
  pid = 4243;
  constructor(readonly cmd: string, readonly args: string[], readonly opts: { env?: Record<string, string> }) {
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
    const p = new MockPty(cmd, args, opts as { env?: Record<string, string> });
    spawned.push(p);
    return p;
  };
  return { default: { spawn }, spawn };
});

import { DaemonSessionManager } from '../DaemonSessionManager';
import { CLAUDE_FILE_SEND_ENV } from '../../shared/claudeFileSend';

describe('DaemonSessionManager Claude file send', () => {
  let manager: DaemonSessionManager;
  let on = false;
  beforeEach(() => {
    spawned.length = 0;
    on = false;
    manager = new DaemonSessionManager();
    manager.setClaudeFileSend(() => on);
  });
  afterEach(() => manager.disposeAll());

  it('adds the variable to the spawn env only while the setting is on', () => {
    manager.createSession({ id: 'off-1', cmd: '/bin/bash', cwd: os.tmpdir(), env: { PATH: '/usr/bin' } });
    expect(spawned.at(-1)?.opts.env?.[CLAUDE_FILE_SEND_ENV]).toBeUndefined();

    on = true;
    const session = manager.createSession({ id: 'on-1', cmd: '/bin/bash', cwd: os.tmpdir(), env: { PATH: '/usr/bin' } });
    expect(spawned.at(-1)?.opts.env?.[CLAUDE_FILE_SEND_ENV]).toBe('1');
    expect(session.env?.[CLAUDE_FILE_SEND_ENV]).toBeUndefined();
  });

  it('a recovery replay follows the setting as it is now', () => {
    on = true;
    manager.createSession({ id: 'pane-1', cmd: '/bin/bash', cwd: os.tmpdir(), env: { PATH: '/usr/bin' } });
    const meta = manager.listSessions().find((s) => s.id === 'pane-1');
    manager.destroySession('pane-1');
    on = false;
    manager.createSession({ id: 'pane-1', cmd: meta!.cmd, cwd: meta!.cwd, env: meta!.env });
    expect(spawned.at(-1)?.opts.env?.[CLAUDE_FILE_SEND_ENV]).toBeUndefined();
  });
});
