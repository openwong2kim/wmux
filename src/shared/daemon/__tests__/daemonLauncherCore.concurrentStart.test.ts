import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

/**
 * POSIX concurrent-start races. Two starters (app ensureDaemon, respawn,
 * `wmux daemon start`) used to overlap: the second one's stale-file cleanup
 * deleted the first daemon's live daemon.lock/daemon.pid, its own daemon took
 * the lock and rebound the socket, and the first daemon kept its sessions with
 * nobody able to reach it. The readiness ping also accepted an answer from any
 * daemon and reported the spawned (exiting) pid as the live one.
 *
 * The fake daemon below does what the real one does at boot, in order: take
 * daemon.lock with O_EXCL (refuse a live owner), write daemon.pid, unlink and
 * rebind the socket, write the daemon-pipe hint, answer daemon.ping with pid.
 */
const FAKE_DAEMON = `
const fs = require('fs'), net = require('net'), path = require('path');
const dir = process.env.FAKE_WMUX_DIR, sock = process.env.FAKE_WMUX_SOCK;
const lock = path.join(dir, 'daemon.lock');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function take() {
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); return true; } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const owner = parseInt(fs.readFileSync(lock, 'utf8'), 10);
    if (owner > 0 && alive(owner)) return false;
    fs.unlinkSync(lock);
    return take();
  }
}
setTimeout(() => {
  if (!take()) process.exit(1);
  fs.writeFileSync(path.join(dir, 'daemon.pid'), String(process.pid));
  try { if (fs.lstatSync(sock).isSocket()) fs.unlinkSync(sock); } catch {}
  net.createServer((s) => {
    s.on('data', (d) => {
      const id = JSON.parse(String(d).split('\\n')[0]).id;
      s.write(JSON.stringify({ id, ok: true, result: { status: 'ok', pid: process.pid } }) + '\\n');
    });
  }).listen(sock, () => fs.writeFileSync(path.join(dir, 'daemon-pipe'), sock));
}, 150);
`;

import { ensureDaemon, liveDaemonFileOwner, type DaemonLauncherDeps } from '../daemonLauncherCore';
import { getDaemonAuthTokenPath, getDaemonSocketPath } from '../../constants';

const noop = (): void => undefined;
const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid as number;

describe.skipIf(process.platform === 'win32')('daemonLauncherCore — concurrent start (POSIX)', () => {
  let wmuxDir: string;
  let prevSuffix: string | undefined;
  let scriptPath: string;
  let sock: string;
  const launched: number[] = [];
  const servers: net.Server[] = [];

  beforeEach(() => {
    prevSuffix = process.env.WMUX_DATA_SUFFIX;
    // Short suffix: the socket path must fit sun_path (104 bytes on macOS).
    process.env.WMUX_DATA_SUFFIX = `-cs${Math.floor(Math.random() * 1e6)}`;
    wmuxDir = path.join(os.homedir(), `.wmux${process.env.WMUX_DATA_SUFFIX}`);
    fs.mkdirSync(wmuxDir, { recursive: true });
    sock = getDaemonSocketPath();
    scriptPath = path.join(wmuxDir, 'fake-daemon.js');
    fs.writeFileSync(scriptPath, FAKE_DAEMON);
    fs.writeFileSync(getDaemonAuthTokenPath(), 'test-token', { mode: 0o600 });
    process.env.FAKE_WMUX_DIR = wmuxDir;
    process.env.FAKE_WMUX_SOCK = sock;
  });

  afterEach(async () => {
    for (const pid of launched.splice(0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
    delete process.env.FAKE_WMUX_DIR;
    delete process.env.FAKE_WMUX_SOCK;
    if (prevSuffix === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = prevSuffix;
    fs.rmSync(wmuxDir, { recursive: true, force: true });
  });

  function deps(): DaemonLauncherDeps {
    return {
      resolveDaemonScriptCandidates: () => [scriptPath],
      resolveSpawnedByVersion: () => '9.9.9-test',
      askUserToRecoverFromStalePid: async () => false,
      isElectronHost: () => false,
      launchViaLaunchdOnDarwin: false,
      log: noop,
      warn: noop,
    };
  }

  const livePidFile = (): number => parseInt(fs.readFileSync(path.join(wmuxDir, 'daemon.pid'), 'utf8'), 10);

  it('two concurrent starters end with one daemon, and both report its pid', async () => {
    const [a, b] = await Promise.all([ensureDaemon(deps()), ensureDaemon(deps())]);
    for (const r of [a, b]) if (r.pid) launched.push(r.pid);
    expect(a.pid).toBe(b.pid);
    expect([a.spawned, b.spawned].sort()).toEqual([false, true]);
    expect(isAlive(a.pid as number)).toBe(true);
    expect(livePidFile()).toBe(a.pid);
    expect(fs.readFileSync(path.join(wmuxDir, 'daemon.lock'), 'utf8')).toBe(String(a.pid));
  }, 30_000);

  it('never deletes the lock files of a running daemon whose pid file was lost', async () => {
    const owner = spawn(process.execPath, [scriptPath], { detached: true, stdio: 'ignore', env: process.env });
    launched.push(owner.pid as number);
    await vi.waitFor(() => expect(fs.existsSync(path.join(wmuxDir, 'daemon-pipe'))).toBe(true), { timeout: 5_000 });
    fs.unlinkSync(path.join(wmuxDir, 'daemon.pid'));

    const info = await ensureDaemon(deps());
    if (info.pid && info.pid !== owner.pid) launched.push(info.pid);
    expect(info).toMatchObject({ pid: owner.pid, spawned: false });
    expect(fs.readFileSync(path.join(wmuxDir, 'daemon.lock'), 'utf8')).toBe(String(owner.pid));
    expect(fs.existsSync(path.join(wmuxDir, 'daemon-pipe'))).toBe(true);
    // Restored, so a later wedge of this daemon goes through the verified path.
    expect(livePidFile()).toBe(owner.pid);
  }, 30_000);

  it('still cleans truly stale files and starts a fresh daemon', async () => {
    const dead = deadPid();
    for (const name of ['daemon.lock', 'daemon.pid']) fs.writeFileSync(path.join(wmuxDir, name), String(dead));
    fs.writeFileSync(path.join(wmuxDir, 'daemon-booting'), String(dead));
    fs.writeFileSync(path.join(wmuxDir, 'daemon-pipe'), path.join(wmuxDir, 'gone.sock'));

    const info = await ensureDaemon(deps());
    if (info.pid) launched.push(info.pid);
    expect(info.spawned).toBe(true);
    expect(info.pid).not.toBe(dead);
    expect(livePidFile()).toBe(info.pid);
    expect(fs.existsSync(path.join(wmuxDir, 'daemon-booting'))).toBe(false);
  }, 30_000);

  it('reports the daemon that answered readiness, not a spawned pid that lost', async () => {
    // Another live daemon (pid 999) owns the socket; the spawned process never
    // answers and only points the pipe hint at that socket.
    const server = net.createServer((s) => {
      s.on('data', (d) => {
        const id = JSON.parse(String(d).split('\n')[0]).id;
        s.write(JSON.stringify({ id, ok: true, result: { status: 'ok', pid: 999 } }) + '\n');
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(sock, () => r()));
    fs.writeFileSync(
      scriptPath,
      `require('fs').writeFileSync(${JSON.stringify(path.join(wmuxDir, 'loser.pid'))}, String(process.pid));\n` +
        `require('fs').writeFileSync(${JSON.stringify(path.join(wmuxDir, 'daemon-pipe'))}, ${JSON.stringify(sock)});\n` +
        'setTimeout(() => {}, 30000);\n',
    );
    const info = await ensureDaemon(deps());
    try { launched.push(parseInt(fs.readFileSync(path.join(wmuxDir, 'loser.pid'), 'utf8'), 10)); } catch { /* not started */ }
    expect(info).toMatchObject({ pid: 999, spawned: false });
    expect(livePidFile()).toBe(999);
  }, 30_000);
});

describe.skipIf(process.platform === 'win32')('liveDaemonFileOwner', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldfo-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('names a live owner other than the judged pid or ourselves, never a dead one', () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      fs.writeFileSync(path.join(dir, 'daemon.lock'), String(child.pid));
      expect(liveDaemonFileOwner(dir, null)).toBe(child.pid);
      expect(liveDaemonFileOwner(dir, child.pid as number)).toBeNull();
      fs.writeFileSync(path.join(dir, 'daemon.lock'), String(process.pid));
      expect(liveDaemonFileOwner(dir, null)).toBeNull();
      fs.writeFileSync(path.join(dir, 'daemon.lock'), String(deadPid()));
      fs.writeFileSync(path.join(dir, 'daemon.pid'), 'garbage');
      expect(liveDaemonFileOwner(dir, null)).toBeNull();
    } finally {
      child.kill('SIGKILL');
    }
  });
});
