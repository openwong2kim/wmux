import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';

/**
 * Issue #21 AC 5 — the daemon must position a replayed pane from the
 * `SessionLocation` it was handed, through the ONE spawn-cwd computation
 * (`preparePtyLocation`), instead of re-deriving a second one from `cmd` +
 * `cwd`. The persisted location is the authority: it is what the create path
 * classified with the shell that actually ran, and what recovery replays.
 */

const { spawns, spawn } = vi.hoisted(() => {
  const calls: { cmd: string; args: string[]; cwd: string | undefined }[] = [];
  const disposable = { dispose: () => { /* noop */ } };
  return {
    spawns: calls,
    spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args: [...args], cwd: opts.cwd as string | undefined });
      return {
        pid: 4242,
        onData: () => disposable,
        onExit: () => disposable,
        write: () => { /* noop */ },
        resize: () => { /* noop */ },
        kill: () => { /* noop */ },
        on: () => { /* noop */ },
      };
    },
  };
});

vi.mock('node-pty', () => ({ default: { spawn }, spawn }));

import { DaemonSessionManager } from '../DaemonSessionManager';

let manager: InstanceType<typeof DaemonSessionManager>;

beforeEach(() => {
  spawns.length = 0;
  manager = new DaemonSessionManager();
});

afterEach(() => {
  manager.disposeAll();
});

describe('daemon replay positions a pane from its SessionLocation', () => {
  it('recovers a persisted Git Bash session at /c/dev/x into C:\\dev\\x', () => {
    manager.createSession({
      id: 'replay-msys',
      cmd: 'C:\\Program Files\\Git\\bin\\bash.exe',
      cwd: '/c/dev/x',
      location: {
        domain: 'msys',
        cwd: '/c/dev/x',
        shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
      },
    });
    expect(spawns.at(-1)?.cwd).toBe('C:\\dev\\x');
    // The MSYS cwd stays the pane's identity — only the spawn cwd is converted.
    expect(manager.getSession('replay-msys')?.meta.cwd).toBe('/c/dev/x');
  });

  it('uses the supplied location, not a re-derivation from cmd', () => {
    // A Git Bash pane persisted with a bare `cmd` (`wmux new --shell bash`):
    // re-classifying from `cmd` calls `/c/dev/x` a host path and hands node-pty
    // a cwd Windows cannot open, so the pane fails to start. The location
    // records the shell that actually ran, and is the authority.
    manager.createSession({
      id: 'replay-msys-bare-cmd',
      cmd: 'bash',
      cwd: '/c/dev/x',
      location: {
        domain: 'msys',
        cwd: '/c/dev/x',
        shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
      },
    });
    expect(spawns.at(-1)?.cwd).toBe('C:\\dev\\x');
  });

  it('positions a WSL pane with --cd and a host spawn cwd', () => {
    manager.createSession({
      id: 'replay-wsl',
      cmd: 'C:\\Windows\\System32\\wsl.exe',
      cwd: '/home/me/repo',
      location: {
        domain: 'wsl',
        cwd: '/home/me/repo',
        shell: 'C:\\Windows\\System32\\wsl.exe',
        distro: 'Ubuntu',
      },
    });
    const last = spawns.at(-1)!;
    expect(last.cwd).toBe(os.homedir());
    expect(last.args.slice(0, 2)).toEqual(['--cd', '/home/me/repo']);
  });

  it('never lets the session cwd and its location disagree', () => {
    // `cwd` is canonicalized on the way in (tilde expansion, defaulting); a
    // location carrying a stale twin of it would position the pane from one
    // value and report the other. The session cwd is the single owner.
    manager.createSession({
      id: 'replay-divergent',
      cmd: 'cmd.exe',
      cwd: os.homedir(),
      location: { domain: 'host', cwd: '/stale/elsewhere', shell: 'cmd.exe' },
    });
    expect(manager.getSession('replay-divergent')?.meta.location?.cwd).toBe(os.homedir());
    expect(spawns.at(-1)?.cwd).toBe(os.homedir());
  });

  it('leaves a plain host session at its own cwd', () => {
    manager.createSession({
      id: 'replay-host',
      cmd: 'cmd.exe',
      cwd: os.homedir(),
      location: { domain: 'host', cwd: os.homedir(), shell: 'cmd.exe' },
    });
    expect(spawns.at(-1)?.cwd).toBe(os.homedir());
    expect(spawns.at(-1)?.args).not.toContain('--cd');
  });
});
