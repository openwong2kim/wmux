/**
 * T2 — per-task environment for a fan-out: a unique port and an optional
 * worktree setup hook. Both are declared in the repo's `wmux.json`
 * (`fanout.portRange` / `fanout.setup`) and both are read through the SAME
 * trust gate the supervised panes use.
 *
 * Port assignment: N tasks each get one free port out of the declared window,
 * exported to the task pane as `WMUX_TASK_PORT`. Without it, eight tasks that
 * all run `npm run dev` fight over one port and seven of them fail. The probe
 * mirrors browser-session/PortAllocator's bind test (that class allocates ONE
 * port for the CDP endpoint and holds it as instance state, so it can't hand
 * out N at once — the technique is reused, the module is left alone).
 *
 * Setup hook: a shell command run in the fresh worktree BEFORE the agent
 * starts, so `.env` copies and `npm ci` happen once per worktree instead of
 * being typed into every agent's first turn. It is trust-gated: a wmux.json
 * that is merely present ('untrusted'), edited since approval ('stale') or
 * refused ('denied') runs nothing at all.
 */

import * as net from 'node:net';
import { spawn } from 'node:child_process';
import type { ProjectConfigState } from '../../shared/wmuxProjectConfig';
import { getExecEnv } from '../../shared/execEnv';

/** Env var carrying a fan-out task's assigned port into its pane. */
export const FANOUT_TASK_PORT_ENV = 'WMUX_TASK_PORT';

/** Setup hooks are allowed to install dependencies, so the budget is minutes. */
export const FANOUT_SETUP_TIMEOUT_MS = 300_000;

/**
 * Tail of the hook's output kept for a failure report. This is a REPORT cap,
 * not an execution cap: the child streams as much as it likes and we simply
 * forget the older bytes. (The previous implementation passed this size as
 * `exec`'s `maxBuffer`, which KILLS the child on overflow — a chatty but
 * perfectly healthy `npm ci` would have failed the task.)
 */
const FANOUT_SETUP_REPORT_TAIL_BYTES = 64 * 1024;

/** Slice of the tail actually pasted into the error string. */
const FANOUT_SETUP_ERROR_DETAIL_CHARS = 2000;

// ── Cross-fan-out port reservations ──────────────────────────────────────────
// Ports are handed out BEFORE any dev server binds them, so a bind probe cannot
// see a port that a task spawned seconds ago was given. Within one fan-out the
// ascending scan covers that; ACROSS concurrent fan-outs (two idempotency keys,
// same repo, same window) it does not — both would probe the same free port and
// both would get it. This module-level ledger remembers what was handed out
// recently so the second fan-out skips it.
//
// Process-local by design: fan-out spawning lives in this one main process
// (see FanOutService's header — the spawn path is renderer-bridged from here).

/** How long a handed-out port stays claimed if nobody releases it. Long enough
 *  for the task's agent to boot and its dev server to actually bind. */
export const FANOUT_PORT_RESERVATION_TTL_MS = 10 * 60 * 1000;

/** port → expiry timestamp (ms). */
const portReservations = new Map<number, number>();

/** Drop expired entries so the ledger can't grow without bound. */
function pruneReservations(now: number): void {
  for (const [port, expiry] of portReservations) {
    if (expiry <= now) portReservations.delete(port);
  }
}

/** Is `port` still claimed by a recent fan-out? */
export function isFanoutPortReserved(port: number, now: number = Date.now()): boolean {
  const expiry = portReservations.get(port);
  if (expiry === undefined) return false;
  if (expiry <= now) {
    portReservations.delete(port);
    return false;
  }
  return true;
}

/** Claim `port` for TTL. Called for every port handed to a task. */
export function reserveFanoutPort(port: number, now: number = Date.now()): void {
  pruneReservations(now);
  portReservations.set(port, now + FANOUT_PORT_RESERVATION_TTL_MS);
}

/**
 * Release ports back to the window — the task that held them is gone (spawn
 * failed, setup hook failed, task closed). Not required for correctness (the
 * TTL expires anyway), it just stops a failed fan-out from parking its window.
 */
export function releaseFanoutPorts(ports: readonly (number | undefined)[]): void {
  for (const port of ports) {
    if (port !== undefined) portReservations.delete(port);
  }
}

/** Test seam — the ledger is module state shared by every fan-out. */
export function clearFanoutPortReservationsForTest(): void {
  portReservations.clear();
}

/**
 * Probe: is `port` free? Binds on BOTH loopback families — a dev server that
 * listens on `::1` (or on `0.0.0.0`/`::`) makes the port unusable even when the
 * IPv4 probe succeeds, so either family being taken means busy.
 *
 * A host with IPv6 disabled fails the `::1` bind with EAFNOSUPPORT /
 * EADDRNOTAVAIL / EINVAL — that is "no such stack", not "port taken", and must
 * not mark every port in the window busy.
 */
export async function isPortFree(port: number): Promise<boolean> {
  const v4 = await probeBind(port, '127.0.0.1');
  if (v4 === 'busy') return false;
  const v6 = await probeBind(port, '::1');
  return v6 !== 'busy';
}

type BindProbe = 'free' | 'busy' | 'unsupported';

/** Error codes that mean "this address family isn't available here". */
const ADDRESS_FAMILY_UNAVAILABLE = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL', 'EPROTONOSUPPORT']);

function probeBind(port: number, host: string): Promise<BindProbe> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      resolve(ADDRESS_FAMILY_UNAVAILABLE.has(err.code ?? '') ? 'unsupported' : 'busy');
    });
    server.listen(port, host, () => {
      server.close(() => resolve('free'));
    });
  });
}

export interface AssignFanoutPortsOptions {
  /** Bind probe; injectable for tests. Defaults to the real dual-stack probe. */
  probe?: (port: number) => Promise<boolean>;
  /** Clock; injectable for tests of the reservation TTL. */
  now?: () => number;
}

/**
 * Assign up to `count` DISTINCT free ports from `range`, in ascending order.
 *
 * The result is index-aligned with the task list: entry k is task k's port, or
 * undefined when the window ran out of free ports. Running out is not an error
 * — the task still spawns, it just gets no `WMUX_TASK_PORT` and behaves the way
 * it did before the range was declared.
 *
 * Every port handed out is also RESERVED (see the ledger above) so a fan-out
 * started while this one's dev servers are still booting doesn't hand out the
 * same numbers. The probe result itself is advisory: nothing holds the port
 * between the check and the dev server's own bind, exactly like PortAllocator.
 */
export async function assignFanoutPorts(
  range: { min: number; max: number },
  count: number,
  options: AssignFanoutPortsOptions = {},
): Promise<(number | undefined)[]> {
  const probe = options.probe ?? isPortFree;
  const clock = options.now ?? Date.now;
  const assigned: (number | undefined)[] = [];
  let next = range.min;
  for (let i = 0; i < count; i++) {
    let found: number | undefined;
    while (next <= range.max) {
      const candidate = next;
      next++;
      if (isFanoutPortReserved(candidate, clock())) continue;
      if (await probe(candidate)) {
        found = candidate;
        reserveFanoutPort(candidate, clock());
        break;
      }
    }
    assigned.push(found);
  }
  return assigned;
}

/**
 * Why no setup hook will run for this fan-out (reported, never silent).
 *   - 'none-declared' — the repo declares no hook
 *   - 'malformed'     — a hook IS declared but the value was rejected by the
 *                       schema, so it never became a runnable command
 *   - untrusted / stale / denied — declared and well-formed, but the bytes are
 *                       not currently approved
 */
export type FanoutSetupSkipReason = 'none-declared' | 'malformed' | 'untrusted' | 'stale' | 'denied';

export type FanoutSetupResolution =
  | { run: true; command: string }
  | { run: false; reason: FanoutSetupSkipReason };

/**
 * Trust gate for the setup hook. A command runs ONLY when the project's live
 * wmux.json bytes are currently 'trusted' — the same verdict ProjectConfigStore
 * computes for supervised panes, so an attacker-authored hook arriving via a PR
 * is inert until the user reviews and approves those exact bytes.
 */
export function resolveFanoutSetup(state: ProjectConfigState | null | undefined): FanoutSetupResolution {
  const fanout = state?.config?.fanout;
  const setup = fanout?.setup;
  if (!state?.found || setup === undefined) {
    // A declared-but-rejected `setup` must not read as "nothing was asked for"
    // — the author wrote a hook and it is not going to run.
    if (fanout?.invalidFields?.includes('setup')) return { run: false, reason: 'malformed' };
    return { run: false, reason: 'none-declared' };
  }
  if (state.trust === 'denied') return { run: false, reason: 'denied' };
  if (state.trust === 'stale') return { run: false, reason: 'stale' };
  if (state.trust !== 'trusted') return { run: false, reason: 'untrusted' };
  return { run: true, command: setup };
}

export type FanoutSetupRunResult = { ok: true } | { ok: false; error: string };

/**
 * Run a resolved setup command inside `cwd` (the fresh worktree). The command
 * is a shell line by contract (`cp … && npm ci`), so it goes through the
 * platform shell — the trust gate, not quoting, is what makes that safe.
 * Failure is reported to the caller; it does NOT throw.
 *
 * The child is spawned as its own PROCESS GROUP (`detached`). Killing the shell
 * alone on timeout would leave its grandchildren (the actual `npm`) running,
 * still writing into a worktree we have just declared failed and preserved for
 * inspection — so the timeout kills the whole group instead.
 */
export async function runFanoutSetup(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number = FANOUT_SETUP_TIMEOUT_MS,
): Promise<FanoutSetupRunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        cwd,
        env: { ...getExecEnv(), ...env },
        shell: true,
        // Own process group / job, so a timeout can take the grandchildren too.
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, error: `failed to start: ${(err as Error).message}` });
      return;
    }

    // Report tail only — the child is never killed for being chatty.
    let tail = '';
    const capture = (chunk: Buffer): void => {
      tail = (tail + chunk.toString('utf8')).slice(-FANOUT_SETUP_REPORT_TAIL_BYTES);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);

    const settle = (result: FanoutSetupRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on('error', (err) => {
      settle({ ok: false, error: `failed to start: ${err.message}` });
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        settle({ ok: false, error: `timed out after ${timeoutMs}ms${detailSuffix(tail)}` });
        return;
      }
      if (code === 0) {
        settle({ ok: true });
        return;
      }
      const how = signal ? `killed by ${signal}` : `exited with code ${code}`;
      settle({ ok: false, error: `${how}${detailSuffix(tail)}` });
    });
  });
}

function detailSuffix(tail: string): string {
  const detail = tail.trim().slice(-FANOUT_SETUP_ERROR_DETAIL_CHARS);
  return detail.length > 0 ? `: ${detail}` : '';
}

/**
 * Kill the hook's whole process tree. POSIX: negative pid = the process group
 * the `detached` spawn created. Windows has no process groups for this — the
 * documented equivalent is `taskkill /T /F`, which walks the child tree.
 */
function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      // best-effort — the close handler still settles the promise.
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Group already gone, or we never became a group leader — fall back to the
    // direct child so at least the shell dies.
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // best-effort
    }
  }
}
