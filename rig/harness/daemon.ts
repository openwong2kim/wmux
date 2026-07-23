// Verification rig — headless daemon harness (design §4 / G1)
//
// Spawns `dist/daemon-bundle/index.js` with isolated env (RigContext), confirms ready via
// `daemon.ping` polling. Exposes the full daemon pipe surface (channels·A2A·principal) without the app,
// so the SIM lane is viable with this harness alone (G1).
//
// Missing bundle: explicit error, no auto-build (design §9 recon 3, footgun: multi-minute build inside
// a test is a trap). node-pty is external in the bundle, so spawn with repo root as cwd where
// node_modules resolves (recon 4).
//
// Shutdown rules (review reflected):
//   - Tree kill: posix uses `detached: true` spawn (child is process group leader) then
//     `process.kill(-pid, 'SIGKILL')` group kill; win32 uses `taskkill /pid {pid} /T /F`.
//     Also reaps grandchildren spawned by daemon (PTY etc. — later RigSession).
//   - kill() bounded-waits for exit event (5s) — avoids racing afterAll temp home deletion with dying process file access.
//   - Orphan backstop: module-level live registry + `process.on('exit')` sync kill.
//     Covers paths where vitest misses afterAll (external kill·CI cancel·hook timeout).
//     If SIGKILL kills the runner instantly, backstop cannot run — remainder is best-effort collected by
//     daemon idle self-shutdown (idleShutdownMinutes) (best-effort limit stated).
//
// Respawn is API-only for S7 (SIGKILL→replay convergence) — respawning with same suffix restores state from disk (inside temp home). v1 S1 does not consume it.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import type { RigContext } from './isolation';

/** Daemon bundle path relative to repo root (package.json build:daemon output). */
const DAEMON_BUNDLE_REL = path.join('dist', 'daemon-bundle', 'index.js');

/** Finds repo root. This file is `{root}/rig/harness/daemon.ts`, so two levels up. */
function repoRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

/**
 * Synchronously SIGKILLs a process tree. posix: detached spawn so child pid == group id →
 * group kill (-pid); on group-kill failure (already reaped etc.) falls back to direct kill. win32: taskkill /T /F.
 * Must be safe in `process.on('exit')` handlers — fully synchronous path.
 */
function killTreeSync(proc: ChildProcess): void {
  const pid = proc.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // Already dead (ESRCH etc.) — harmless.
  }
}

/**
 * Orphan backstop registry (review reflected). Register on spawn, unregister on exit. On runner paths that
 * miss afterAll, `process.on('exit')` synchronously tree-kills remaining daemons.
 */
const liveDaemons = new Set<ChildProcess>();
let exitBackstopInstalled = false;
function installExitBackstop(): void {
  if (exitBackstopInstalled) return;
  exitBackstopInstalled = true;
  process.on('exit', () => {
    for (const proc of liveDaemons) killTreeSync(proc);
    liveDaemons.clear();
  });
}

export interface RigDaemonOptions {
  /** Total ready-polling budget (ms). Default 45s (review reflected — CI slow-runner margin). */
  readonly readyTimeoutMs?: number;
  /** Ready-polling interval (ms). Default 300ms. */
  readonly pollIntervalMs?: number;
}

/** Upper bound (ms) to wait for exit event after kill(). SIGKILL usually finishes in ms anyway. */
const EXIT_WAIT_MS = 5000;

/**
 * Owns one isolated headless wmux daemon process. Provides spawn·ready wait·tree kill (SIGKILL)·
 * respawn·log collection·teardown. Pipe RPC is PipeClient's separate concern (separation of concerns).
 */
export class RigDaemon {
  private readonly ctx: RigContext;
  private readonly bundlePath: string;
  private readonly readyTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private proc: ChildProcess | null = null;
  /** Promise settled on current process exit event (for kill's bounded wait). */
  private procExit: Promise<void> | null = null;
  /** stdout+stderr collection buffer (printed on failure for diagnosis). */
  private readonly logChunks: string[] = [];

  constructor(ctx: RigContext, opts: RigDaemonOptions = {}) {
    this.ctx = ctx;
    this.bundlePath = path.join(repoRoot(), DAEMON_BUNDLE_REL);
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 45000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 300;
  }

  /** Full collected daemon log (test prints on failure). */
  get log(): string {
    return this.logChunks.join('');
  }

  /** pid of currently spawned process (undefined if none). */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /**
   * Spawns daemon bundle and polls until `daemon.ping` returns ok. Missing bundle: explicit error instead of
   * auto-build (run `npm run build:daemon` first). Early exit breaks ready polling via exit listener so failure is immediate.
   */
  async start(): Promise<void> {
    if (this.proc) throw new Error('[rig/daemon] already started');
    if (!fs.existsSync(this.bundlePath)) {
      throw new Error(
        `[rig/daemon] daemon bundle not found at ${this.bundlePath} — ` +
          'run `npm run build:daemon` first (rig does NOT auto-build; a multi-minute ' +
          'build inside a test is a footgun — design §9 recon 3).',
      );
    }
    await this.spawnAndWait();
  }

  /**
   * SIGKILLs process tree (also for S7 chaos injection) and **bounded-waits for exit event**
   * (5s) — so teardown temp home deletion does not race dying process file access.
   * Forces immediate termination regardless of commit barrier (SIGKILL semantics preserved — wait is reaping confirmation, not grace).
   */
  async kill(): Promise<void> {
    const proc = this.proc;
    const exitP = this.procExit;
    if (!proc) return;
    this.proc = null;
    this.procExit = null;
    killTreeSync(proc);
    if (exitP) {
      await Promise.race([exitP, sleep(EXIT_WAIT_MS)]);
    }
  }

  /**
   * After SIGKILL, respawns daemon with same suffix and waits for ready (S7 replay convergence API).
   * Disk state (event log·config inside temp home) is restored as-is. Kills live process first (including exit reap).
   */
  async respawn(): Promise<void> {
    await this.kill();
    await this.spawnAndWait();
  }

  /**
   * Teardown: process tree kill + exit reap. Temp home deletion is caller's (test) job via
   * removeRigHome — order: `await teardown()` → removeRigHome (§2).
   */
  async teardown(): Promise<void> {
    await this.kill();
  }

  /** Shared spawn + ready polling path (start/respawn). */
  private async spawnAndWait(): Promise<void> {
    installExitBackstop();
    const proc = spawn(process.execPath, [this.bundlePath], {
      cwd: repoRoot(), // repo root with node_modules for node-pty native resolution (recon 4)
      env: this.ctx.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // posix: child as process group leader — prerequisite for killTreeSync group kill (-pid).
      // win32: taskkill /T walks tree, so unnecessary (only leaves console separation side effects — unused).
      detached: process.platform !== 'win32',
    });
    this.proc = proc;
    liveDaemons.add(proc);

    const collect = (d: Buffer): void => {
      this.logChunks.push(d.toString());
    };
    proc.stdout?.on('data', collect);
    proc.stderr?.on('data', collect);

    // Early-exit flag — prevents ready polling from waiting forever. exit Promise shared with kill() bounded wait.
    let exited = false;
    let exitInfo = '';
    this.procExit = new Promise<void>((resolve) => {
      proc.once('exit', (code, signal) => {
        exited = true;
        exitInfo = `code=${code} signal=${signal}`;
        liveDaemons.delete(proc);
        // Clear reference only when this handler's process is the one we track (respawn race prevention).
        if (this.proc === proc) this.proc = null;
        resolve();
      });
    });

    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(
          `[rig/daemon] daemon exited before becoming ready (${exitInfo}).\n` +
            `--- daemon log ---\n${this.log}`,
        );
      }
      if (await this.pingOnce()) return;
      await sleep(this.pollIntervalMs);
    }
    // Timeout — attach log for diagnosis before throwing.
    await this.kill();
    throw new Error(
      `[rig/daemon] daemon did not become ready within ${this.readyTimeoutMs}ms.\n` +
        `--- daemon log ---\n${this.log}`,
    );
  }

  /**
   * One `daemon.ping` attempt. Lightweight socket round-trip for ready check only, inlined here instead of PipeClient
   * (identity binding) — ping is identity-agnostic and token file may not exist yet before ready, so failures
   * must be quietly absorbed as false.
   */
  private pingOnce(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let token = '';
      try {
        token = fs.readFileSync(this.ctx.daemonTokenPath, 'utf8').trim();
      } catch {
        // Token file not yet present — daemon still booting. Retry.
        resolve(false);
        return;
      }
      const id = `ping-${Date.now()}-${Math.random()}`;
      const sock = net.createConnection(this.ctx.daemonPipePath);
      let buf = '';
      let done = false;
      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          sock.destroy();
        } catch {
          /* noop */
        }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 2000);
      sock.setEncoding('utf8');
      sock.once('connect', () => sock.write(JSON.stringify({ id, method: 'daemon.ping', params: {}, token }) + '\n'));
      sock.once('error', () => finish(false));
      sock.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: { id?: string; ok?: boolean };
          try {
            msg = JSON.parse(line) as { id?: string; ok?: boolean };
          } catch {
            continue;
          }
          if (msg.id !== id) continue;
          finish(msg.ok === true);
          return;
        }
      });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
