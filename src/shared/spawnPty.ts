/**
 * The one place a pane's PTY is spawned (#2398).
 *
 * node-pty 1.2.0-beta defers ConPTY's connect() until its conout worker is
 * ready, which changed two things every caller relied on:
 *  - `pty.pid` is 0 when `spawn` returns and only becomes the shell's pid once
 *    the output pipe connects (node-pty's `ready_datapipe`);
 *  - a CreateProcess failure (a bad cwd, error 267; a transient error 87) no
 *    longer throws from `spawn`: it arrives later as an `exit` while the pid is
 *    still 0.
 *
 * `spawnPty` restores the old contract: it resolves only once the pid is real
 * and rejects with node-pty 1.1.0's own message, `Cannot create process,
 * error code: N`, so `spawnWithConptyPolicy`'s classes and the daemon's
 * `error code: 87` retry keep matching. Nothing that records a pid (session
 * meta, pidCreatedAtFt, the pid map, agent tracking) can then see a 0.
 *
 * A pid that is already known (node-pty on macOS/Linux, the Rust core) is
 * returned with no listener and no timer.
 */
import * as pty from 'node-pty';
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';
import { spawnTerminalPty } from './terminalPty';
import { spawnWithConptyPolicy, type ConptyBackend } from './conptyWindows';

/** node-pty's own bound on the ConPTY connect (its CONNECTION_TIMEOUT). */
export const PTY_PID_TIMEOUT_MS = 5000;

type NodeSpawn = (command: string, args: string[], options: IPtyForkOptions & IWindowsPtyForkOptions) => IPty;

export interface SpawnPtyRequest {
  command: string;
  args: string[];
  /** Spawn options without the ConPTY backend choice, which the policy makes. */
  options: IPtyForkOptions & IWindowsPtyForkOptions;
  /** Start on the bundled conpty.dll (see shouldUseBundledConpty). */
  useBundledConpty: boolean;
  onNotice: (level: 'info' | 'warn', message: string) => void;
  onBackend?: (backend: ConptyBackend) => void;
  /** Tests only. */
  nodeSpawn?: NodeSpawn;
  /** Tests only. */
  pidTimeoutMs?: number;
}

function start(req: SpawnPtyRequest): IPty {
  const nodeSpawn = req.nodeSpawn ?? pty.spawn;
  return spawnWithConptyPolicy(
    (useBundled) => spawnTerminalPty(req.command, req.args, {
      ...req.options,
      useConpty: true,
      ...(useBundled ? { useConptyDll: true } : {}),
    }, nodeSpawn),
    req.useBundledConpty,
    req.onNotice,
    req.onBackend,
  );
}

function killQuietly(p: IPty): void {
  try { p.kill(); } catch { /* already gone */ }
}

/** Spawn a PTY and resolve once it reports the shell's pid. */
export function spawnPty(req: SpawnPtyRequest): Promise<IPty> {
  const p = start(req);
  if (p.pid > 0) return Promise.resolve(p);
  return awaitPtyPid(p, req.pidTimeoutMs ?? PTY_PID_TIMEOUT_MS);
}

/** The part of node-pty's internal output socket the wait listens on. */
interface ConnectEvents {
  once(event: 'ready_datapipe', listener: () => void): unknown;
  removeListener(event: 'ready_datapipe', listener: () => void): unknown;
}

/**
 * Wait for a deferred-connect ConPTY to report its pid.
 *
 * Resolves from inside node-pty's `ready_datapipe` handler (ours is registered
 * after its own, so the pid is already set). The caller's continuation is then
 * microtasks only and attaches its `onData` before the first read, which
 * node-pty emits with no buffer; a timer-based poll could resolve after a
 * chunk was already dropped, so there is none.
 */
export function awaitPtyPid(p: IPty, timeoutMs: number): Promise<IPty> {
  const socket = (p as unknown as { _socket?: Partial<ConnectEvents> })._socket;
  if (typeof socket?.once !== 'function' || typeof socket.removeListener !== 'function') {
    killQuietly(p);
    return Promise.reject(new Error('Cannot create process, the PTY reported no pid and exposes no connect event'));
  }
  const events = socket as ConnectEvents;
  return new Promise<IPty>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      exitListener.dispose();
      events.removeListener('ready_datapipe', onReady);
      if (error) reject(error); else resolve(p);
    };
    const onReady = (): void => {
      if (p.pid > 0) { finish(); return; }
      killQuietly(p);
      finish(new Error('Cannot create process, the PTY connected without a pid'));
    };
    // A real exit is only wired up after `ready_datapipe` sets the pid, so an
    // exit seen here is node-pty reporting a failed connect (CreateProcess
    // error or its own connect timeout). It has already closed everything.
    const exitListener = p.onExit(({ exitCode }) => {
      finish(new Error(`Cannot create process, error code: ${exitCode}`));
    });
    const timer = setTimeout(() => {
      killQuietly(p);
      finish(new Error(`Cannot create process, no pid within ${timeoutMs} ms`));
    }, timeoutMs);
    events.once('ready_datapipe', onReady);
  });
}

/**
 * The synchronous spawn, for callers that cannot wait (only the sync
 * `createSession`/`create` APIs that test doubles drive). It refuses a PTY
 * without a pid instead of registering one: on Windows with node-pty
 * 1.2.0-beta that is every real spawn, so production must use `spawnPty`.
 */
export function spawnPtySync(req: SpawnPtyRequest): IPty {
  const p = start(req);
  if (p.pid > 0) return p;
  killQuietly(p);
  throw new Error('Cannot create process, the PTY has no pid yet (use the async create path)');
}
