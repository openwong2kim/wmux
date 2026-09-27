/**
 * Caller process-ancestry checks for pane identity.
 *
 * A pipe caller (the `wmux` CLI, the MCP server) sends its own pid as
 * `callerPid`. Main reads the live process table and walks up from that pid.
 * Two consumers:
 *   - `a2a.resolve.identity` finds WHICH pane shell the caller runs under;
 *   - the RpcRouter gate checks that the pane a request CLAIMS (`senderPtyId`)
 *     is really among the caller's ancestors, so a command that inherited
 *     another pane's environment (a shared background server, tmux, setsid)
 *     cannot act as that pane.
 *
 * The pid is caller-asserted, so this is attribution for well-behaved callers
 * under the same-user trust ceiling, not a boundary against a hostile process.
 *
 * Process table sources:
 *   - Unix: `ps -axo pid=,ppid=` only (no `lsof`: identity needs no sockets).
 *   - Windows: the in-process native process table first; if that is
 *     unavailable, one PowerShell `Get-CimInstance Win32_Process` query bounded
 *     by the attempt's deadline.
 * An empty table counts as a failure: `ps` failing yields no rows, not an error.
 */

import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import type { PortSnapshot } from './portWatch';
import { tryNativeProcessTable } from './winSnapshotNative';
import type { PaneAncestryStatus } from '../../shared/paneIdentity';

const execFileAsync = promisify(execFile);

/** Process-table source. The timeout is advisory: an injected test double may ignore it. */
export type IdentitySnapshotFn = (timeoutMs?: number) => Promise<PortSnapshot>;

/** First attempt bound. The retry gets whatever budget remains. */
export const FIRST_ATTEMPT_MS = 3000;
/** A table this fresh that already contains the caller is reused without a new read. */
const REUSE_MAX_AGE_MS = 2000;
/**
 * When both reads fail, a table this recent that contains the caller is used
 * instead. Kept short: an older table risks a recycled pid carrying someone
 * else's ancestry.
 */
const LAST_GOOD_MAX_AGE_MS = 30_000;
const MAX_WALK_DEPTH = 32;

function parsePidPpidLines(stdout: string): Map<number, number> {
  const table = new Map<number, number>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) table.set(Number(m[1]), Number(m[2]));
  }
  return table;
}

async function windowsCimTable(timeoutMs: number): Promise<Map<number, number>> {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await execFileAsync(
    ps,
    ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
    { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  );
  return parsePidPpidLines(stdout);
}

/** Default identity snapshot. Rejects on failure or an empty table. */
export async function identitySnapshot(timeoutMs = 5000): Promise<PortSnapshot> {
  let table: Map<number, number>;
  if (process.platform === 'win32') {
    const native = tryNativeProcessTable();
    if (native && native.length > 0) {
      table = new Map(native.map((p) => [p.pid, p.ppid] as [number, number]));
    } else {
      table = await windowsCimTable(timeoutMs);
    }
  } else {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid='], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    table = parsePidPpidLines(stdout);
  }
  if (table.size === 0) throw new Error('process table unavailable');
  return { ppidByPid: table, listeners: [] };
}

function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (ms <= 0) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(fallback); } }, ms);
    const finish = (v: T) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    p.then(finish, () => finish(fallback));
  });
}

type Table = ReadonlyMap<number, number>;

/**
 * Reads process tables for callers: coalesces concurrent reads, refreshes a
 * table that predates the caller, retries a failed read once with a longer
 * bound, and falls back to a recent good table that already contains the
 * caller when both reads fail.
 */
export class CallerTableResolver {
  private inflight: Promise<PortSnapshot> | null = null;
  /** Timeout the in-flight read was started with; a longer attempt starts its own. */
  private inflightMs = 0;
  private lastGood: { table: Table; at: number } | null = null;

  constructor(
    private readonly snapshot: IdentitySnapshotFn,
    private readonly now: () => number = Date.now,
  ) {}

  private attempt(ms: number): Promise<Table | null> {
    if (!this.inflight || this.inflightMs < ms) {
      const p = Promise.resolve().then(() => this.snapshot(ms));
      this.inflight = p;
      this.inflightMs = ms;
      const clear = () => { if (this.inflight === p) this.inflight = null; };
      p.then(clear, clear);
    }
    const read = this.inflight.then(
      (s) => {
        const t = s?.ppidByPid;
        if (!t || t.size === 0) return null;
        this.lastGood = { table: t, at: this.now() };
        return t as Table;
      },
      () => null,
    );
    return withDeadline(read, ms, null);
  }

  /** A table containing `callerPid`, a fresh table without it (a real miss), or null (unavailable). */
  async tableFor(callerPid: number, budgetMs: number): Promise<Table | null> {
    const start = this.now();
    const recent = this.lastGood;
    if (recent && start - recent.at <= REUSE_MAX_AGE_MS && recent.table.has(callerPid)) return recent.table;

    const first = await this.attempt(Math.min(FIRST_ATTEMPT_MS, budgetMs));
    if (first && first.has(callerPid)) return first;
    // Failed, or read before this caller existed: one more read on the remaining budget.
    const remaining = budgetMs - (this.now() - start);
    const second = await this.attempt(remaining);
    if (second) return second;
    const last = this.lastGood;
    if (last && this.now() - last.at <= LAST_GOOD_MAX_AGE_MS && last.table.has(callerPid)) return last.table;
    return null;
  }
}

/**
 * Is `shellPid` the caller itself or one of its ancestors? The caller's own pid
 * matches only when it IS the claimed pane's shell: another pane's shell, or a
 * stale pid-map anchor for the same pane, never counts.
 */
export function callerDescendsFrom(callerPid: number, table: Table, shellPid: number): boolean {
  if (!Number.isInteger(shellPid) || shellPid <= 0) return false;
  const visited = new Set<number>();
  let current = callerPid;
  for (let depth = 0; depth <= MAX_WALK_DEPTH; depth++) {
    if (current === shellPid) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    const parent = table.get(current);
    if (parent === undefined || !Number.isInteger(parent) || parent <= 0 || parent === current) return false;
    current = parent;
  }
  return false;
}

/**
 * The live shell pid of a pane: a number, null when the pane has no live
 * session, or undefined when that cannot be determined right now.
 */
export type LiveShellPidFn = (ptyId: string) => Promise<number | null | undefined>;

export interface PaneAncestryGate {
  check(callerPid: number, ptyId: string): Promise<PaneAncestryStatus>;
}

export function createPaneAncestryGate(opts: {
  resolver: CallerTableResolver;
  liveShellPid: LiveShellPidFn;
  budgetMs?: number;
}): PaneAncestryGate {
  const budget = opts.budgetMs ?? 8000;
  return {
    async check(callerPid, ptyId) {
      let shellPid: number | null | undefined;
      try {
        shellPid = await opts.liveShellPid(ptyId);
      } catch {
        shellPid = undefined;
      }
      if (shellPid === undefined) return 'unavailable';
      if (shellPid === null) return 'miss';
      const table = await opts.resolver.tableFor(callerPid, budget);
      if (!table) return 'unavailable';
      return callerDescendsFrom(callerPid, table, shellPid) ? 'hit' : 'miss';
    },
  };
}

/**
 * Live shell pid from the daemon's own session list: the session must exist
 * and be neither dead nor suspended. Liveness is the daemon's session state;
 * the process table carries no start times to compare.
 */
export function daemonLiveShellPid(
  listSessions: () => Promise<unknown>,
): LiveShellPidFn {
  return async (ptyId) => {
    const sessions = await listSessions();
    if (!Array.isArray(sessions)) return undefined;
    for (const s of sessions as Array<{ id?: unknown; pid?: unknown; state?: unknown }>) {
      if (!s || s.id !== ptyId) continue;
      if (s.state === 'dead' || s.state === 'suspended') return null;
      return typeof s.pid === 'number' && Number.isInteger(s.pid) && s.pid > 0 ? s.pid : null;
    }
    return null;
  };
}

/**
 * Memoize an async read for `ttlMs`. The gate runs on every pane-claiming
 * request (terminal reads and event polls included), so the daemon's session
 * list is fetched at most once per window instead of once per request. A
 * failed read is not cached.
 */
export function cachedFor<T>(read: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T> {
  let cached: { at: number; value: Promise<T> } | null = null;
  return () => {
    const t = now();
    if (cached && t - cached.at < ttlMs) return cached.value;
    const value = read();
    const entry = { at: t, value };
    cached = entry;
    value.catch(() => { if (cached === entry) cached = null; });
    return value;
  };
}
