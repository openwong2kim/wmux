import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { tryNativeSnapshot } from './winSnapshotNative';
import type { NativeTerminalCore } from '../../shared/nativeTerminalCore';
import { nativeRead } from '../../daemon/nativeProcessTable';

const execFileAsync = promisify(execFile);

/**
 * X1 workspace-context sidebar — per-session listening-port tracking.
 *
 * Frozen contract (docs/internal/fable-window-schema-freeze.md §2):
 *   - `listeningPorts`: daemon PID tree → in-process listener-table snapshot
 *     (`GetExtendedTcpTable`), 10 s interval.
 *   - Daemon broadcasts `{ type: 'context.ports', sessionId,
 *     data: { ports: Array<{ port: number, pid: number }> } }`.
 *
 * Windows snapshots are taken in-process via koffi FFI (winSnapshotNative).
 * They used to shell out to PowerShell, which got the unsigned app flagged as
 * a trojan by Defender's behavioral heuristics — see issue #1051 and the
 * header of winSnapshotNative.ts. Do NOT reintroduce a PowerShell spawn
 * here (regression-guarded in __tests__/winSnapshotNative.os.test.ts).
 *
 * Unlike the old MetadataCollector path (which listed the FIRST 20 ports of
 * the whole machine for every workspace), ports are matched against each
 * session's process tree, so "3000 is listening" is attributed to the pane
 * that actually owns the dev server.
 *
 * One snapshot pair per tick regardless of session count: a full
 * pid→ppid table + a full listening-socket table, then per-session
 * descendant matching in-process.
 */

export interface SessionPort {
  port: number;
  pid: number;
}

export interface PortSnapshot {
  /** child pid → parent pid for every live process. */
  ppidByPid: Map<number, number>;
  /** Every listening TCP socket on the machine. */
  listeners: SessionPort[];
}

export type SnapshotFn = () => Promise<PortSnapshot>;

const DEFAULT_INTERVAL_MS = 10_000;
/** Snapshot subprocess timeout (Unix path) — well under the tick interval. */
const SNAPSHOT_TIMEOUT_MS = 8_000;
/**
 * How long tick() waits for a snapshot before counting it as failed. The Unix
 * path runs `ps` then `lsof`, each with its own timeout, plus a margin. A child
 * stuck in an uninterruptible kernel wait never closes, so the execFile promise
 * may never settle; this deadline keeps one such child from freezing polling.
 */
export const SNAPSHOT_DEADLINE_MS = 2 * SNAPSHOT_TIMEOUT_MS + 2_000;
/** After this many consecutive snapshot failures, pause polling briefly. */
const FAILURE_BACKOFF_THRESHOLD = 3;
const FAILURE_BACKOFF_MS = 60_000;
/**
 * The encoded form of "this session has no listening ports". Shared by the
 * diff-state writer and the vanished-session clear below so the two can never
 * drift apart from the JSON encoding they both depend on.
 */
const EMPTY_PORTS_ENCODED = JSON.stringify([] as SessionPort[]);

/**
 * Windows: in-process FFI snapshot (see winSnapshotNative.ts — issue #1051).
 *
 * An unavailable native path REJECTS rather than resolving to an empty
 * snapshot, which is what the old subprocess path did on failure. That
 * distinction carries real weight downstream:
 *   - `tick()` skips the diff pass entirely, so an already-rendered chip is
 *     left alone instead of being cleared by a phantom "no ports" reading,
 *     and the consecutive-failure backoff below can actually engage.
 *   - `a2a.rpc.ts` branches on a failed snapshot to skip its retry; an empty
 *     table would look like a successful-but-stale one and cost a second
 *     pass on every single handshake.
 */
function snapshotWindowsNative(): PortSnapshot {
  const native = tryNativeSnapshot();
  if (!native) throw new Error('native snapshot unavailable');
  const ppidByPid = new Map<number, number>();
  const listeners: SessionPort[] = [];
  for (const p of native.procs) {
    ppidByPid.set(p.pid, p.ppid);
  }
  for (const c of native.conns) {
    // Skip System/Idle (pid ≤ 4) — same filter the old snapshot applied.
    if (c.pid > 4) listeners.push({ port: c.port, pid: c.pid });
  }
  return { ppidByPid, listeners };
}

type PortSnapshotRead = NonNullable<NativeTerminalCore['portSnapshot']>;

/** How long one native snapshot may take before its tick goes to ps/lsof.
 *  A read stuck in the kernel (a D-state /proc read) never returns: the
 *  timeout keeps the tick, and the 3-in-a-row latch, moving. */
export const NATIVE_SNAPSHOT_TIMEOUT_MS = 5_000;

/** macOS and Linux: the native core's walk and listening sockets in one call
 *  (`listen-sockets-v1`), behind the shared latch (nativeRead). */
const nativePorts = nativeRead<PortSnapshotRead>({
  platforms: ['darwin', 'linux'],
  capability: 'listen-sockets-v1',
  component: 'port-watch',
  pick: (core) => (typeof core.portSnapshot === 'function' ? core.portSnapshot : undefined),
});

/** Where ps and lsof are looked for first, then in PATH. */
const TOOL_PATHS: Record<'ps' | 'lsof', string[]> = {
  ps: ['/bin/ps', '/usr/bin/ps'],
  lsof: ['/usr/sbin/lsof', '/usr/bin/lsof', '/sbin/lsof', '/bin/lsof'],
};
const toolPaths = new Map<string, string>();

/**
 * The tool's absolute path, found in-process: the usual locations, then each
 * absolute PATH directory (NixOS, Guix), checked for execute access. Spawning
 * by bare name makes libuv search PATH itself, and on macOS its posix_spawn
 * path forks a process per PATH entry it tries before the one that holds the
 * tool (Linux forks once and execvp walks PATH in the child). Only a hit is
 * cached: after a miss the next tick looks again.
 */
function toolPath(tool: 'ps' | 'lsof'): string | undefined {
  const known = toolPaths.get(tool);
  if (known) return known;
  const dirs = (process.env.PATH ?? '').split(':').filter((d) => d.startsWith('/'));
  const found = [...TOOL_PATHS[tool], ...dirs.map((d) => `${d.replace(/\/+$/, '')}/${tool}`)].find((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (found) toolPaths.set(tool, found);
  return found;
}

/** Unix: the native walk and socket list, else `ps` for the process table +
 *  `lsof` for listening sockets. */
async function snapshotUnix(): Promise<PortSnapshot> {
  const native = await nativePorts.call((read) => read(), NATIVE_SNAPSHOT_TIMEOUT_MS);
  if (native) {
    return {
      ppidByPid: new Map(native.processes.map((r) => [r.pid, r.ppid])),
      listeners: native.sockets.map((s) => ({ port: s.port, pid: s.pid })),
    };
  }
  const ppidByPid = new Map<number, number>();
  try {
    const ps = toolPath('ps');
    if (!ps) throw new Error('ps not found');
    const { stdout } = await execFileAsync(ps, ['-axo', 'pid=,ppid='], {
      timeout: SNAPSHOT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    });
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) ppidByPid.set(Number(m[1]), Number(m[2]));
    }
  } catch { /* best-effort */ }

  const listeners: SessionPort[] = [];
  try {
    const lsof = toolPath('lsof');
    if (!lsof) throw new Error('lsof not found');
    // -F p n: machine-readable "p<pid>" / "n<addr>" lines.
    const { stdout } = await execFileAsync(lsof, ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], {
      timeout: SNAPSHOT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    });
    let currentPid: number | null = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) {
        currentPid = Number(line.slice(1)) || null;
      } else if (line.startsWith('n') && currentPid !== null) {
        const m = line.match(/:(\d+)$/);
        if (m) listeners.push({ port: Number(m[1]), pid: currentPid });
      }
    }
  } catch { /* lsof missing or denied — silently no ports */ }
  return { ppidByPid, listeners };
}

/**
 * `async` on purpose: the Windows path is synchronous and can throw, and one
 * consumer (`a2a.rpc.ts`) calls this OUTSIDE its try block — a synchronous
 * throw would escape its guard instead of being handled as a failed
 * snapshot. Declaring the function async turns every such throw into a
 * rejection, which every consumer already handles.
 */
export async function defaultSnapshot(): Promise<PortSnapshot> {
  return process.platform === 'win32' ? snapshotWindowsNative() : snapshotUnix();
}

/** Resolve `p`, but never wait longer than `ms` — on timeout resolve `fallback`.
 *  A rejection also resolves `fallback`. Keeps a snapshot whose child never
 *  exits from blocking its caller: PortWatcher.tick() and a2a.resolve.identity
 *  (which must answer before the client's RPC deadline). */
export function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (ms <= 0) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(fallback); } }, ms);
    timer.unref?.();
    const finish = (v: T) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    p.then(finish, () => finish(fallback));
  });
}

/**
 * Match a snapshot against a set of session root PIDs. Exported for the
 * daemon wiring and unit tests — pure, no I/O.
 */
export function matchSessionPorts(
  snapshot: PortSnapshot,
  sessions: Array<{ sessionId: string; pid: number }>,
): Map<string, SessionPort[]> {
  // Invert ppid→children once; BFS per session over its descendants.
  const childrenByPid = new Map<number, number[]>();
  for (const [pid, ppid] of snapshot.ppidByPid) {
    const arr = childrenByPid.get(ppid);
    if (arr) arr.push(pid);
    else childrenByPid.set(ppid, [pid]);
  }

  const result = new Map<string, SessionPort[]>();
  for (const { sessionId, pid } of sessions) {
    const tree = new Set<number>([pid]);
    const queue = [pid];
    while (queue.length > 0) {
      const cur = queue.pop() as number;
      for (const child of childrenByPid.get(cur) ?? []) {
        if (!tree.has(child)) {
          tree.add(child);
          queue.push(child);
        }
      }
    }
    const seen = new Set<string>();
    const ports: SessionPort[] = [];
    for (const l of snapshot.listeners) {
      if (!tree.has(l.pid)) continue;
      const key = `${l.port}:${l.pid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ports.push(l);
    }
    ports.sort((a, b) => a.port - b.port || a.pid - b.pid);
    result.set(sessionId, ports);
  }
  return result;
}

/**
 * Polls listening ports every `intervalMs` and emits per-session diffs.
 *
 * Events:
 *  - 'ports' → { sessionId: string, ports: SessionPort[] }
 *
 * Emits only when a session's port set actually changed (including the
 * transition back to empty, so the sidebar clears a dead dev server).
 */
export class PortWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastBySession = new Map<string, string>();
  private consecutiveFailures = 0;
  private backoffUntil = 0;
  /** The snapshot still running, kept past its deadline until it settles. */
  private outstanding: Promise<PortSnapshot> | null = null;
  private readonly intervalMs: number;
  private readonly snapshot: SnapshotFn;

  constructor(
    private getSessions: () => Array<{ sessionId: string; pid: number }>,
    opts: { intervalMs?: number; snapshot?: SnapshotFn } = {},
  ) {
    super();
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.snapshot = opts.snapshot ?? defaultSnapshot;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.lastBySession.clear();
  }

  /**
   * Forget every session's diff state and poll again, so the NEXT tick re-emits
   * the current port set for every session instead of staying silent because
   * nothing changed.
   *
   * #1135 — the daemon outlives the app (tmux-style detach), so a freshly
   * launched app starts with an empty per-surface port map while the watcher
   * still holds the diff state of the previous app's lifetime. Without a
   * resync, a dev server that was already listening before the restart is
   * invisible until it happens to change. Called when a client subscribes to
   * the event stream.
   */
  resync(): void {
    this.lastBySession.clear();
    void this.tick();
  }

  /** One poll cycle. Public so tests (and the daemon on session-create) can drive it. */
  async tick(): Promise<void> {
    if (this.ticking) return; // a slow snapshot must not stack subprocesses
    if (Date.now() < this.backoffUntil) return; // failure backoff window
    this.ticking = true;
    try {
      const sessions = this.getSessions().filter(
        (s) => Number.isInteger(s.pid) && s.pid > 0,
      );

      // Sessions that disappeared: emit one final empty set, then drop the
      // diff state so a recreated session with the same id re-emits its first
      // non-empty set.
      //
      // #1135 — the final empty emit is the important half. A session whose
      // process died stops being matched at all, so without it the LAST set of
      // ports it ever reported was also the last thing the sidebar heard, and
      // the chip stayed lit for a dead dev server until the surface itself was
      // closed. Suppressed when the last emitted value was already empty.
      const liveIds = new Set(sessions.map((s) => s.sessionId));
      for (const id of [...this.lastBySession.keys()]) {
        if (liveIds.has(id)) continue;
        const prev = this.lastBySession.get(id);
        this.lastBySession.delete(id);
        if (prev && prev !== EMPTY_PORTS_ENCODED) this.emit('ports', { sessionId: id, ports: [] });
      }
      if (sessions.length === 0) return;

      const snap = await this.boundedSnapshot();
      this.consecutiveFailures = 0;
      const matched = matchSessionPorts(snap, sessions);
      for (const [sessionId, ports] of matched) {
        const encoded = JSON.stringify(ports);
        const prev = this.lastBySession.get(sessionId);
        // First observation with no ports is a no-op (nothing to clear).
        if (prev === undefined && ports.length === 0) continue;
        if (encoded === prev) continue;
        this.lastBySession.set(sessionId, encoded);
        this.emit('ports', { sessionId, ports });
      }
    } catch {
      // Snapshot failure (FFI unavailable, lsof denied) — silent; the
      // sidebar simply shows no ports, matching the "quiet absence" policy.
      // Repeated failures pause polling briefly so a persistently broken
      // snapshot source is not hammered every tick.
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= FAILURE_BACKOFF_THRESHOLD) {
        this.consecutiveFailures = 0;
        this.backoffUntil = Date.now() + FAILURE_BACKOFF_MS;
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Run one snapshot, but give up waiting at SNAPSHOT_DEADLINE_MS. A snapshot
   * that outlived its deadline stays outstanding until it settles, and no new
   * one starts meanwhile, so at most one is ever in flight. Expiry, a pending
   * earlier snapshot and a failed one all reject, which tick() counts as a
   * failure toward the backoff.
   */
  private async boundedSnapshot(): Promise<PortSnapshot> {
    if (this.outstanding) throw new Error('previous snapshot still pending');
    const pending = this.snapshot();
    this.outstanding = pending;
    const clear = (): void => {
      if (this.outstanding === pending) this.outstanding = null;
    };
    pending.then(clear, clear);
    const snap = await withDeadline<PortSnapshot | null>(pending, SNAPSHOT_DEADLINE_MS, null);
    if (!snap) throw new Error('snapshot failed or exceeded its deadline');
    return snap;
  }
}
