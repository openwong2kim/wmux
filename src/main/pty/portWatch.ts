import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tryNativeSnapshot } from './winSnapshotNative';

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
 * here (regression-guarded in __tests__/winSnapshotNative.test.ts).
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

/** Unix: `ps` for the process table + `lsof` for listening sockets. */
async function snapshotUnix(): Promise<PortSnapshot> {
  const ppidByPid = new Map<number, number>();
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid='], {
      timeout: SNAPSHOT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) ppidByPid.set(Number(m[1]), Number(m[2]));
    }
  } catch { /* best-effort */ }

  const listeners: SessionPort[] = [];
  try {
    // -F p n: machine-readable "p<pid>" / "n<addr>" lines.
    const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], {
      timeout: SNAPSHOT_TIMEOUT_MS,
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

      const snap = await this.snapshot();
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
}
