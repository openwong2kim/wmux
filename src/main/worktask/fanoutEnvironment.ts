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
import { exec } from 'node:child_process';
import type { ProjectConfigState } from '../../shared/wmuxProjectConfig';
import { getExecEnv } from '../../shared/execEnv';

/** Env var carrying a fan-out task's assigned port into its pane. */
export const FANOUT_TASK_PORT_ENV = 'WMUX_TASK_PORT';

/** Setup hooks are allowed to install dependencies, so the budget is minutes. */
export const FANOUT_SETUP_TIMEOUT_MS = 300_000;

/** Cap the captured hook output kept for the failure report. */
const FANOUT_SETUP_MAX_OUTPUT_BYTES = 64 * 1024;

/** Probe: is `port` free to bind on loopback? (PortAllocator's technique.) */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Assign up to `count` DISTINCT free ports from `range`, in ascending order.
 *
 * The result is index-aligned with the task list: entry k is task k's port, or
 * undefined when the window ran out of free ports. Running out is not an error
 * — the task still spawns, it just gets no `WMUX_TASK_PORT` and behaves the way
 * it did before the range was declared.
 *
 * `probe` is injectable for tests; it defaults to a real bind test. Note the
 * probe result is advisory: nothing holds the port between this check and the
 * dev server's own bind, exactly like PortAllocator.
 */
export async function assignFanoutPorts(
  range: { min: number; max: number },
  count: number,
  probe: (port: number) => Promise<boolean> = isPortFree,
): Promise<(number | undefined)[]> {
  const assigned: (number | undefined)[] = [];
  let next = range.min;
  for (let i = 0; i < count; i++) {
    let found: number | undefined;
    while (next <= range.max) {
      const candidate = next;
      next++;
      if (await probe(candidate)) {
        found = candidate;
        break;
      }
    }
    assigned.push(found);
  }
  return assigned;
}

/** Why no setup hook will run for this fan-out (reported, never silent). */
export type FanoutSetupSkipReason = 'none-declared' | 'untrusted' | 'stale' | 'denied';

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
  const setup = state?.config?.fanout?.setup;
  if (!state?.found || setup === undefined) return { run: false, reason: 'none-declared' };
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
 */
export async function runFanoutSetup(
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<FanoutSetupRunResult> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        env: { ...getExecEnv(), ...env },
        timeout: FANOUT_SETUP_TIMEOUT_MS,
        maxBuffer: FANOUT_SETUP_MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (err, _stdout, stderr) => {
        if (err) {
          const detail = String(stderr ?? '').trim().slice(-2000);
          resolve({ ok: false, error: detail.length > 0 ? `${err.message}: ${detail}` : err.message });
          return;
        }
        resolve({ ok: true });
      },
    );
  });
}
