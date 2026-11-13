// Kill a process tree and KNOW it is gone (#2388).
//
// treeKill.ts sends the signals and returns; nothing says whether every
// process in the tree exited. A caller that removes a folder afterwards (a
// task worktree) needs that answer: on Windows a process still running in the
// folder, or holding a file there, makes the delete fail part way. So this
// helper takes the tree in two steps:
//   1. capture, while the root is still alive (before the PTY is destroyed,
//      which would orphan the tree): every descendant found and pinned;
//   2. kill: everything captured, plus any child a captured process started
//      since, and then wait until each one has exited. Whatever has not by
//      the deadline is reported as a survivor; the caller fails closed.
//
// Windows: a handle is opened on every process in the tree. A held handle
// keeps Windows from handing the pid to another process, so the ppid walk
// in later rounds cannot reach an unrelated process through a reused pid,
// and "exited" is read from the handle (signaled), not from the pid: an
// exited process whose handle someone still holds keeps its pid. Windows
// never re-parents an orphan, so a process whose ppid names one of ours
// is ours only if it was created no earlier than that process (the rule
// collectTreeCpuTimes in winSnapshotNative.ts applies) and no later than the
// moment the table was asked for: a process on a pid the table had for one
// that exited since was created after that.
//
// POSIX: the tree is frozen (SIGSTOP, rescanning until no new descendant
// appears, as killProcessTreePosix does), so nothing in it can fork or exit
// before the kill; a frozen process keeps its pid. After SIGKILL, each pid
// is polled until it is gone or a zombie (which holds no files), its start
// time compared so a reused pid is not mistaken for a survivor's absence.
//
// Not covered, by construction: a process that left the tree before the
// capture (a POSIX daemon re-parented to init, a Windows process whose
// parent had already exited and been released); on Windows, a grandchild
// whose parent was started and exited between two tables, so no table ever
// listed that parent (nothing freezes a Windows tree; containing it takes a
// Job Object, #2398); and the Linux side of a WSL pane, which the Windows
// process table does not show. A caller that deletes files keeps its own
// checks for what this cannot see. Kept independent of any caller (the
// worktree removal, the Job Object of #2398).

import { execFile } from 'node:child_process';
import { UNKNOWN_ROOT_REFUSAL } from '../../shared/rpc';
import { collectDescendants } from './treeKill';
import { dmtfToUtcMicros, sameProcessStartTime } from '../phantomExit';
import { tryProcessHandleApi, type ProcessHandle, type ProcessHandleApi } from '../../main/pty/winSnapshotNative';
import { kernelStartOf, sameKernelStart } from '../../shared/processStartTime';

/** A process of the tree that did not exit, and why. */
export interface TreeKillSurvivor {
  pid: number;
  reason: string;
  /** Its creation time (Windows: FILETIME; POSIX: `lstart`), when it was
   *  identified: what survivorsStillRunning checks it by later. */
  startTime?: string;
  /** POSIX: its boot-bound kernel start (shared/processStartTime
   *  kernelStartOf), which a clock step does not move; compared before
   *  `startTime` when both sides have one. */
  startKernel?: string;
  /** Not a process seen running: the tree under `pid` could not be checked
   *  whole (the table unreadable, still growing). Whatever was missed cannot
   *  be checked later either, so survivorsStillRunning always keeps it. */
  unverified?: true;
}

export type VerifiedTreeKillResult =
  | { ok: true; killed: number[] }
  | { ok: false; killed: number[]; survivors: TreeKillSurvivor[] };

/** A process tree captured while its root was alive. */
export interface CapturedTree {
  readonly rootPid: number;
  /** The pids captured so far, root first. */
  pids(): number[];
  /** Kill everything captured and every child a captured process started
   *  since, then wait (up to `timeoutMs`) until each has exited. Releases
   *  what the capture held; call once. */
  kill(opts?: { timeoutMs?: number }): Promise<VerifiedTreeKillResult>;
  /** Release what the capture held without killing anything. */
  release(): void;
}

/** How long kill() waits for the tree to exit. */
export const VERIFIED_TREE_KILL_TIMEOUT_MS = 5000;
const POLL_MS = 50;
/** Capture rounds (rescans of the process table) before giving up on a tree
 *  that keeps growing. */
export const CAPTURE_ROUNDS = 8;

export interface CaptureOptions {
  /** Whether the root found at the pid is the process the caller means:
   *  given the root's creation time (Windows: FILETIME; POSIX: `ps -o
   *  lstart=`), false when it is another one (the pid was reused). Absent:
   *  taken as the caller's. Null (nothing recorded to compare with): the tree
   *  is not walked, since nothing confirms the pid leads to the caller's
   *  process; the kill reports it unverified and leaves the root to its
   *  owner (the PTY destroy ends a pane's shell). */
  rootIsOurs?: (startTime: string, startKernel: string | null) => boolean | null;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A {@link CaptureOptions.rootIsOurs} from a start time recorded at spawn
 * (a session's `pidStartTime`): equal readings name the same process.
 * Windows records a FILETIME, or (before #2398) CIM's DMTF string, which is
 * compared in UTC microseconds (sameProcessStartTime). POSIX compares the
 * boot-bound kernel starts when both sides have one (a clock step moves
 * `lstart`, not them), and otherwise the `lstart` text, where a one-digit day
 * is padded with a second space, so runs of spaces compare as one. Null
 * (unknown) when nothing was recorded or the record is in neither format.
 */
export function matchesRecordedStart(
  recorded: string | undefined,
  current: string,
  kernels: { recorded?: string | null; current?: string | null } = {},
): boolean | null {
  if (!recordedStartUsable(recorded)) return null;
  if (process.platform === 'win32') return sameProcessStartTime(recorded, current);
  const byKernel = sameKernelStart(kernels.recorded, kernels.current);
  if (byKernel !== null) return byKernel;
  return recorded.trim().replace(/\s+/g, ' ') === current.trim().replace(/\s+/g, ' ');
}

/**
 * A rootIsOurs for a pid's recorded start that logs a mismatch once: the pid
 * names another process now, or the record and the reading disagree, and the
 * tree is left alone either way.
 */
export function recordedRootMatcher(
  pid: number,
  recorded: string | undefined,
  warn: (msg: string) => void,
  recordedKernel?: string | null,
): (startTime: string, startKernel: string | null) => boolean | null {
  return (current, currentKernel) => {
    const ours = matchesRecordedStart(recorded, current, { recorded: recordedKernel, current: currentKernel });
    if (ours === false) {
      warn(
        `pid ${pid}: the recorded start (${JSON.stringify(recorded)}, kernel ${recordedKernel ?? 'none'}) does not match ` +
          `the current one (${JSON.stringify(current)}, kernel ${currentKernel ?? 'none'}), so its process tree is left alone`,
      );
    }
    return ours;
  };
}

/** Whether a recorded start time can be compared at all (matchesRecordedStart). */
function recordedStartUsable(recorded: string | undefined, platform: NodeJS.Platform = process.platform): recorded is string {
  if (!recorded) return false;
  return platform !== 'win32' || /^\d+$/.test(recorded) || dmtfToUtcMicros(recorded) !== null;
}

/** Why a pane's tree kill is refused now (shared/rpc.ts). */
export { UNKNOWN_ROOT_REFUSAL };

/**
 * Why a running pane's tree may not be killed now (#2388), or null: no start
 * time of its shell is recorded (read right after the spawn, a few attempts:
 * DaemonSessionManager.recordSpawnStartTime), so nothing confirms its pid
 * still leads to the shell and the tree cannot be taken. Destroying the
 * session then would end the pane but orphan its tree, unkilled, and a later
 * close would find nothing left to stop. The session is left as it is
 * instead, and the caller keeps the folder.
 */
export function treeKillRefusal(
  meta: { pid: number; state: string; pidCreatedAtFt?: string; pidStartTime?: string },
  platform: NodeJS.Platform = process.platform,
): string | null {
  if ((meta.state !== 'attached' && meta.state !== 'detached') || !(meta.pid > 0)) return null;
  return recordedStartUsable(recordedStartOf(meta, platform), platform) ? null : UNKNOWN_ROOT_REFUSAL;
}

/**
 * The start time a session recorded for its pid, in the form
 * matchesRecordedStart compares: Windows records the FILETIME
 * (`pidCreatedAtFt`, #2398), and `pidStartTime` holds the POSIX `lstart` or
 * a Windows record from before that.
 */
export function recordedStartOf(
  meta: { pidCreatedAtFt?: string; pidStartTime?: string },
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return platform === 'win32' ? meta.pidCreatedAtFt ?? meta.pidStartTime : meta.pidStartTime;
}

/**
 * The identified survivors of an earlier kill that still run: the same
 * process (its start time compared) and not exited, and on Windows any
 * process one of them started before it exited. One that cannot be read
 * counts as running. An unverified entry is not a process and is not kept:
 * each stop decides on its own tree. Never throws.
 */
export async function survivorsStillRunning(survivors: readonly TreeKillSurvivor[]): Promise<TreeKillSurvivor[]> {
  return processesStillRunning(survivors.filter((s) => !s.unverified));
}

async function processesStillRunning(survivors: readonly TreeKillSurvivor[]): Promise<TreeKillSurvivor[]> {
  if (survivors.length === 0) return [];
  if (process.platform === 'win32') {
    const api = tryProcessHandleApi();
    return api ? survivorsStillRunningWin32(survivors, api) : [...survivors];
  }
  let rows: PosixProcRow[];
  try {
    rows = await defaultPosixDeps.listProcesses();
  } catch {
    return [...survivors];
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  return survivors.flatMap((s): TreeKillSurvivor[] => {
    const row = byPid.get(s.pid);
    // Gone: POSIX hands what it started to init, where no tree leads.
    if (!row || row.stat.startsWith('Z')) return [];
    const byKernel = sameKernelStart(s.startKernel, defaultPosixDeps.kernelStart?.(row.pid));
    if (byKernel !== null) return byKernel ? [s] : [];
    return s.startTime === undefined || row.start === s.startTime ? [s] : [];
  });
}

/**
 * Windows {@link survivorsStillRunning}: a survivor still running, or, once
 * it exited, every process it started meanwhile that still runs (it
 * outlived the kill, so it could start more). Those are found through the
 * table under the survivor's pid, each no older than its parent and, when
 * the pid has gone to another process since, older than that one. Exported
 * for tests.
 */
export function survivorsStillRunningWin32(survivors: readonly TreeKillSurvivor[], api: ProcessHandleApi): TreeKillSurvivor[] {
  let table: Array<{ pid: number; ppid: number }> | null = null;
  const children = (pid: number): number[] => {
    if (table === null) table = api.processTable();
    return table.filter((p) => p.ppid === pid && p.pid !== pid).map((p) => p.pid);
  };
  const out: TreeKillSurvivor[] = [];
  for (const s of survivors) {
    if (s.startTime === undefined || !/^\d+$/.test(s.startTime)) {
      // Not identified: only whether its pid is still in use can be read.
      const now = api.open(s.pid);
      if ('handle' in now) {
        const exited = api.hasExited(now.handle) === true;
        api.close(now.handle);
        if (!exited) out.push(s);
      } else if ('failure' in now) {
        out.push(s);
      }
      continue;
    }
    const started = BigInt(s.startTime);
    const now = api.open(s.pid);
    if ('failure' in now) {
      out.push(s);
      continue;
    }
    /** Children of the survivor are older than this: a later owner of its pid. */
    let before: bigint | null = null;
    if ('handle' in now) {
      try {
        if (now.createdAt === started) {
          if (api.hasExited(now.handle) !== true) {
            out.push(s);
            continue;
          }
        } else {
          before = now.createdAt;
        }
      } finally {
        api.close(now.handle);
      }
    }
    try {
      const queue: Array<{ pid: number; created: bigint; until: bigint | null }> = [{ pid: s.pid, created: started, until: before }];
      const seen = new Set<number>([s.pid]);
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        for (const pid of children(item.pid)) {
          if (seen.has(pid)) continue;
          seen.add(pid);
          const child = api.open(pid);
          // One that is gone is not followed. One still running that cannot
          // be opened (another user's, an elevated one) cannot be told apart
          // from what the survivor started: the survivor stays in the record,
          // so a later check looks again rather than clearing it.
          if ('failure' in child) {
            if (!out.includes(s)) out.push(s);
            continue;
          }
          if (!('handle' in child)) continue;
          try {
            const ours = child.createdAt >= item.created && (item.until === null || child.createdAt < item.until);
            if (!ours) continue;
            if (api.hasExited(child.handle) !== true) {
              out.push({ pid, reason: `started by ${s.pid}, which outlived the kill`, startTime: child.createdAt.toString() });
            }
            queue.push({ pid, created: child.createdAt, until: null });
          } finally {
            api.close(child.handle);
          }
        }
      }
    } catch {
      // The table cannot be read: the survivor is counted as still running.
      out.push(s);
    }
  }
  return out;
}

/**
 * Capture the tree rooted at `rootPid`. Null when the root is gone already
 * (or is not the caller's process): there is no tree to take. Never throws.
 */
export async function captureProcessTree(rootPid: number, opts: CaptureOptions = {}): Promise<CapturedTree | null> {
  if (!Number.isInteger(rootPid) || rootPid <= 1) return null;
  if (process.platform === 'win32') {
    const api = tryProcessHandleApi();
    // Without the native path nothing can be pinned or verified: fail closed.
    if (!api) return failedCapture(rootPid, 'native process access is unavailable');
    return captureTreeWin32(rootPid, api, opts);
  }
  return captureTreePosix(rootPid, defaultPosixDeps, opts);
}

/** Capture and kill in one step (the root must still be alive). */
export async function killProcessTreeVerified(
  rootPid: number,
  opts: CaptureOptions & { timeoutMs?: number } = {},
): Promise<VerifiedTreeKillResult> {
  const tree = await captureProcessTree(rootPid, opts);
  return tree ? tree.kill({ timeoutMs: opts.timeoutMs }) : { ok: true, killed: [] };
}

/** A capture that could not see the tree: its kill reports the root as a
 *  survivor, so the caller keeps whatever it guards. */
function failedCapture(rootPid: number, reason: string): CapturedTree {
  return {
    rootPid,
    pids: () => [rootPid],
    kill: async () => ({ ok: false, killed: [], survivors: [{ pid: rootPid, reason, unverified: true }] }),
    release: () => undefined,
  };
}

const UNCONFIRMED_ROOT = "the pane's shell has no recorded start time to confirm its pid, so its tree was not taken";

// ─── Windows ────────────────────────────────────────────────────────────────

interface WinTracked {
  pid: number;
  handle: ProcessHandle;
  createdAt: bigint;
  canTerminate: boolean;
}

/** Exported for tests, with a fake {@link ProcessHandleApi}. */
export function captureTreeWin32(rootPid: number, api: ProcessHandleApi, opts: CaptureOptions = {}): CapturedTree | null {
  const sleep = opts.sleep ?? defaultSleep;
  const root = api.open(rootPid);
  if ('gone' in root) return null;
  if ('failure' in root) return failedCapture(rootPid, `the root could not be opened: ${root.failure}`);
  const ours = opts.rootIsOurs?.(root.createdAt.toString(), null);
  if (ours === false || ours === null) api.close(root.handle);
  if (ours === false) return null;
  if (ours === null) return failedCapture(rootPid, UNCONFIRMED_ROOT);
  const tracked = new Map<number, WinTracked>([[rootPid, { pid: rootPid, ...root }]]);
  /** Processes whose ppid names one of ours but that could not be identified. */
  const unidentified = new Map<number, string>();
  /** A process of the table that exited before it could be opened, or could
   *  not be identified, while it had children there: they cannot be told
   *  from strangers (nothing pins its pid), so the tree is not known whole. */
  const lostParents = new Set<number>();
  /** A child of ours that exited before it could be opened, with no child in
   *  that table: one it started just before it exited shows up in a later
   *  table under its pid. Its parent's creation time bounds such a child. */
  const vanished = new Map<number, bigint>();
  let released = false;

  /** One rescan: adds every new process of the tree. Returns how many were
   *  added; throws when the table cannot be read. */
  const scan = (): number => {
    // Taken before the table: every process the table lists was created by
    // then, unless it is a later process on a pid the table had for another.
    const askedAt = api.now();
    const table = api.processTable();
    const children = new Map<number, number[]>();
    for (const { pid, ppid } of table) {
      if (pid === ppid) continue;
      const list = children.get(ppid);
      if (list) list.push(pid);
      else children.set(ppid, [pid]);
    }
    const untrackedChildren = (pid: number): number[] => (children.get(pid) ?? []).filter((c) => !tracked.has(c));
    /** A child of `floor`'s process that is gone (or whose pid another
     *  process took): its children now, or in a later table, are lost. */
    const lostChild = (pid: number, floor: bigint): void => {
      if (untrackedChildren(pid).length > 0) lostParents.add(pid);
      else vanished.set(pid, floor);
    };
    // A child that vanished earlier: one that started under it shows up now.
    // It is lost unless it is younger than a later owner of that pid.
    for (const [pid, floor] of vanished) {
      if (lostParents.has(pid)) continue;
      const owner = api.open(pid);
      const ownerCreated = 'handle' in owner ? owner.createdAt : null;
      if ('handle' in owner) api.close(owner.handle);
      for (const c of untrackedChildren(pid)) {
        const child = api.open(c);
        if ('gone' in child) continue;
        if ('handle' in child) api.close(child.handle);
        const created = 'handle' in child ? child.createdAt : null;
        if (created === null || (created >= floor && (ownerCreated === null || created < ownerCreated))) {
          lostParents.add(pid);
          break;
        }
      }
    }
    let added = 0;
    const queue = [...tracked.values()];
    for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
      for (const pid of children.get(parent.pid) ?? []) {
        if (tracked.has(pid)) continue;
        const opened = api.open(pid);
        if ('gone' in opened) {
          lostChild(pid, parent.createdAt);
          continue;
        }
        if ('failure' in opened) {
          // Its ppid names one of ours, pinned, so it is ours or an orphan
          // older than the process now holding that pid: unknown either way.
          // Its children are not walked, so with any in the table the tree
          // is not known whole even once it exits.
          unidentified.set(pid, `could not be identified: ${opened.failure}`);
          if ((children.get(pid) ?? []).some((c) => !tracked.has(c))) lostParents.add(pid);
          continue;
        }
        // Older than its "parent": an orphan whose dead parent's pid went to
        // one of ours. Newer than the table: a later process on a pid the
        // table had for an exited one (a real child that new is taken by the
        // next scan, whose table lists it).
        if (opened.createdAt < parent.createdAt || opened.createdAt > askedAt) {
          api.close(opened.handle);
          // Newer than the table: the child the table listed exited and its
          // pid went to this one, so its own children in the table are lost.
          if (opened.createdAt > askedAt) lostChild(pid, parent.createdAt);
          continue;
        }
        unidentified.delete(pid);
        const t: WinTracked = { pid, ...opened };
        tracked.set(pid, t);
        queue.push(t);
        added++;
      }
    }
    return added;
  };

  let scanError: string | null = null;
  const tryScan = (): number => {
    try {
      return scan();
    } catch (err) {
      scanError = err instanceof Error ? err.message : String(err);
      return 0;
    }
  };
  for (let round = 0; round < CAPTURE_ROUNDS && tryScan() > 0; round++) { /* grow until stable */ }

  const release = (): void => {
    if (released) return;
    released = true;
    for (const t of tracked.values()) api.close(t.handle);
  };

  const exited = (t: WinTracked): boolean => api.hasExited(t.handle) === true;

  return {
    rootPid,
    pids: () => [...tracked.keys()],
    release,
    kill: async ({ timeoutMs = VERIFIED_TREE_KILL_TIMEOUT_MS } = {}) => {
      if (released) return { ok: false, killed: [], survivors: [{ pid: rootPid, reason: 'the capture was released', unverified: true }] };
      const deadline = Date.now() + timeoutMs;
      const refused = new Map<number, string>();
      try {
        // Parents first, so a parent stops starting children as early as
        // possible; a child it started meanwhile is found by the rescan.
        const terminateAll = (): void => {
          for (const t of tracked.values()) {
            if (exited(t) || refused.has(t.pid)) continue;
            if (!t.canTerminate) refused.set(t.pid, 'access denied (another user\'s or an elevated process)');
            else if (!api.terminate(t.handle) && !exited(t)) refused.set(t.pid, 'TerminateProcess failed');
          }
        };
        terminateAll();
        let settled = false;
        for (;;) {
          // Settled when every captured process has exited and a table read
          // after that shows no child of theirs: an exited process starts
          // nothing, so none can appear later.
          const allExited = [...tracked.values()].every(exited);
          const added = tryScan();
          if (added > 0) terminateAll();
          if (added === 0 && allExited) {
            settled = true;
            break;
          }
          if (Date.now() >= deadline) break;
          if (added === 0) await sleep(POLL_MS);
        }
        const survivors: TreeKillSurvivor[] = [];
        for (const t of tracked.values()) {
          if (exited(t)) continue;
          survivors.push({ pid: t.pid, reason: refused.get(t.pid) ?? 'still running', startTime: t.createdAt.toString() });
        }
        for (const pid of lostParents) {
          unidentified.delete(pid);
          survivors.push({ pid, reason: 'it exited before its children could be identified; they may still run', unverified: true });
        }
        // Never identified, so never walked: whatever it started (even after
        // it exited, its children keep its pid as their parent only until
        // that pid is reused) cannot be ruled out.
        for (const [pid, reason] of unidentified) survivors.push({ pid, reason, unverified: true });
        // The tree was still growing at the deadline: a child started last may
        // not have been seen.
        if (!settled && survivors.length === 0) survivors.push({ pid: rootPid, reason: 'the tree kept starting processes until the deadline', unverified: true });
        const killed = [...tracked.values()].filter(exited).map((t) => t.pid);
        if (scanError !== null) survivors.push({ pid: rootPid, reason: `the process table could not be read: ${scanError}`, unverified: true });
        return survivors.length === 0 ? { ok: true, killed } : { ok: false, killed, survivors };
      } finally {
        release();
      }
    },
  };
}

// ─── POSIX ──────────────────────────────────────────────────────────────────

/** One row of `ps -axo pid=,ppid=,stat=,lstart=`. */
export interface PosixProcRow {
  pid: number;
  ppid: number;
  /** Process state; a zombie starts with `Z`. */
  stat: string;
  /** `lstart`: the start time, as the daemon records a session's pid. */
  start: string;
}

export interface PosixTreeDeps {
  /** The process table; throws when it cannot be read. */
  listProcesses(): Promise<PosixProcRow[]>;
  signal(pid: number, sig: NodeJS.Signals): void;
  /** A pid's boot-bound kernel start (shared/processStartTime kernelStartOf), null when unread. */
  kernelStart?(pid: number): string | null;
}

export function parsePsIdentityRows(output: string): PosixProcRow[] {
  const rows: PosixProcRow[] = [];
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], start: m[4].replace(/\s+/g, ' ') });
  }
  return rows;
}

/**
 * The kernel starts of `pids` as listed in `rows`, read after that listing.
 * One is kept only when a listing taken after the reads shows the same pid
 * with the same parent and start text: the kernel start and the text then
 * name one process. A pid freed and reused in between keeps its text only,
 * so a stranger's kernel start is never recorded for it.
 */
export async function confirmedKernelStarts(
  deps: Pick<PosixTreeDeps, 'listProcesses' | 'kernelStart'>,
  rows: ReadonlyMap<number, PosixProcRow>,
  pids: readonly number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!deps.kernelStart || pids.length === 0) return out;
  const read = new Map<number, string>();
  for (const pid of pids) {
    const kernel = deps.kernelStart(pid);
    if (kernel) read.set(pid, kernel);
  }
  if (read.size === 0) return out;
  let after: PosixProcRow[];
  try {
    after = await deps.listProcesses();
  } catch {
    return out;
  }
  const again = new Map(after.map((r) => [r.pid, r]));
  for (const [pid, kernel] of read) {
    const before = rows.get(pid);
    const now = again.get(pid);
    if (before && now && now.start === before.start && now.ppid === before.ppid) out.set(pid, kernel);
  }
  return out;
}

const defaultPosixDeps: PosixTreeDeps = {
  listProcesses: () =>
    new Promise((resolve, reject) => {
      // The daemon's own environment, as getProcessStartTime reads a
      // session's `lstart`: the same locale gives the same words.
      execFile('/bin/ps', ['-axo', 'pid=,ppid=,stat=,lstart='], { timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (error, output) => {
        if (error) reject(error);
        else resolve(parsePsIdentityRows(output ?? ''));
      });
    }),
  signal: (pid, sig) => process.kill(pid, sig),
  kernelStart: kernelStartOf,
};

/** Exported for tests, with fake {@link PosixTreeDeps}. */
export async function captureTreePosix(rootPid: number, deps: PosixTreeDeps, opts: CaptureOptions = {}): Promise<CapturedTree | null> {
  const sleep = opts.sleep ?? defaultSleep;
  const send = (pid: number, sig: NodeJS.Signals): boolean => {
    try {
      deps.signal(pid, sig);
      return true;
    } catch {
      /* already gone, or not ours to signal */
      return false;
    }
  };
  let rows: PosixProcRow[];
  try {
    rows = await deps.listProcesses();
  } catch (err) {
    return failedCapture(rootPid, `the process table could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rootRow = rows.find((r) => r.pid === rootPid);
  if (!rootRow || rootRow.stat.startsWith('Z')) return null;
  const ours = opts.rootIsOurs?.(rootRow.start, deps.kernelStart?.(rootPid) ?? null);
  if (ours === false) return null;
  if (ours === null) return failedCapture(rootPid, UNCONFIRMED_ROOT);
  /** pid → start time, in discovery order (parents before children). */
  const targets = new Map<number, string>();
  let scanError: string | null = null;
  let complete = false;
  const unfrozen: number[] = [];
  /** Found in the tree, but gone or another process's by the stop: what it
   *  started meanwhile went to init, where no scan leads. */
  const lost: number[] = [];
  for (let round = 0; round < CAPTURE_ROUNDS; round++) {
    if (round > 0) {
      try {
        rows = await deps.listProcesses();
      } catch (err) {
        scanError = err instanceof Error ? err.message : String(err);
        break;
      }
    }
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    // The root confirmed above, or nothing: once its pid holds another
    // process, what the pid leads to is not ours (the root may not be among
    // the captured yet, when it changed hands before its stop).
    if (byPid.get(rootPid)?.start !== rootRow.start) {
      scanError = 'the root ended or was replaced before the tree was taken';
      break;
    }
    // Parent links lead to our processes only through the ones captured: a
    // frozen one someone else killed hands its children to init, and its pid
    // can go to another process whose children are not ours.
    const replaced = [...targets].filter(([pid, start]) => byPid.get(pid)?.start !== start).map(([pid]) => pid);
    if (replaced.length > 0) {
      scanError = `process(es) ${replaced.join(', ')} of the tree ended or were replaced while frozen`;
      break;
    }
    const found = collectDescendants(rows.map((r) => [r.pid, r.ppid] as const), rootPid)
      .filter((pid) => !targets.has(pid) && byPid.has(pid));
    if (found.length === 0) {
      complete = true;
      break;
    }
    // Read again right before the stop: one that exited since, or whose pid
    // went to another process, is not stopped, and the tree is not known
    // whole (a child it forked before it went is under no captured pid).
    let fresh: Map<number, PosixProcRow>;
    try {
      fresh = new Map((await deps.listProcesses()).map((r) => [r.pid, r]));
    } catch (err) {
      scanError = err instanceof Error ? err.message : String(err);
      break;
    }
    const stopped: number[] = [];
    for (const pid of found) {
      const start = (byPid.get(pid) as PosixProcRow).start;
      if (fresh.get(pid)?.start !== start) {
        lost.push(pid);
        continue;
      }
      targets.set(pid, start);
      // One that cannot be frozen (another user's, a setuid program) can
      // still fork and exit, leaving a child the tree no longer leads to.
      if (send(pid, 'SIGSTOP')) stopped.push(pid);
      else unfrozen.push(pid);
    }
    if (stopped.length === 0) continue;
    // Read once more after the stops. A pid still held by the process read
    // before its stop was stopped as that process (a pid cannot change hands
    // and come back). One that changed hands is not ours, and nothing shows
    // whether it took the stop (it may be a job stopped on its own): it is
    // never signalled again. Only a process whose identity is unchanged
    // since its stop is ever resumed or killed (release, kill).
    let after: Map<number, PosixProcRow>;
    try {
      after = new Map((await deps.listProcesses()).map((r) => [r.pid, r]));
    } catch (err) {
      scanError = err instanceof Error ? err.message : String(err);
      break;
    }
    const changed: number[] = [];
    for (const pid of stopped) {
      if (after.get(pid)?.start === targets.get(pid)) continue;
      targets.delete(pid);
      changed.push(pid);
    }
    // What such a process forked before it went is under no captured pid,
    // and its pid now leads to another process's children.
    if (changed.length > 0) {
      scanError = `process(es) ${changed.join(', ')} of the tree ended or changed hands around their stop`;
      break;
    }
  }
  // Still finding new processes in the last round: one of them may have
  // forked before it was frozen, into a process group the kill misses.
  if (!complete && scanError === null) scanError = `the tree was still growing after ${CAPTURE_ROUNDS} scans`;
  if (unfrozen.length > 0 && scanError === null) scanError = `process(es) ${unfrozen.join(', ')} could not be frozen`;
  if (lost.length > 0 && scanError === null) scanError = `process(es) ${lost.join(', ')} of the tree ended or changed hands before they could be frozen`;
  let released = false;
  /** The captured pids still held by the processes captured (their start
   *  time unchanged), in capture order. A frozen process cannot exit, but
   *  another process can kill it and its pid go to an unrelated one; that
   *  one is never killed. When the table cannot be read, the frozen ones:
   *  they keep their pids. One that could not be frozen may have exited and
   *  its pid gone to another process, so it is left out. */
  const stillCaptured = async (): Promise<number[]> => {
    try {
      const byPid = new Map((await deps.listProcesses()).map((r) => [r.pid, r]));
      return [...targets].filter(([pid, start]) => byPid.get(pid)?.start === start).map(([pid]) => pid);
    } catch {
      return [...targets.keys()].filter((pid) => !unfrozen.includes(pid));
    }
  };
  return {
    rootPid,
    pids: () => [...targets.keys()],
    release: () => {
      if (released) return;
      released = true;
      // What this capture stopped runs again: each pid still held by the
      // process it stopped. One whose pid went to another process since is
      // not signalled (that one never took this stop).
      void stillCaptured().then((pids) => {
        for (const pid of pids) send(pid, 'SIGCONT');
      });
    },
    kill: async ({ timeoutMs = VERIFIED_TREE_KILL_TIMEOUT_MS } = {}) => {
      if (released) return { ok: false, killed: [], survivors: [{ pid: rootPid, reason: 'the capture was released', unverified: true }] };
      released = true;
      const ours = await stillCaptured();
      // Leaves first (discovery order is parent-before-child), then the PTY's
      // process group (the root is a session leader) and the root, while the
      // root is still the one captured (its group is then still its own).
      for (const pid of [...ours].reverse()) send(pid, 'SIGKILL');
      if (ours.includes(rootPid)) {
        send(-rootPid, 'SIGKILL');
        send(rootPid, 'SIGKILL');
      }
      const deadline = Date.now() + timeoutMs;
      let alive: TreeKillSurvivor[] = [];
      let lastRows = new Map<number, PosixProcRow>();
      for (;;) {
        try {
          const byPid = new Map((await deps.listProcesses()).map((r) => [r.pid, r]));
          lastRows = byPid;
          alive = [...targets].flatMap(([pid, start]) => {
            const row = byPid.get(pid);
            return row && row.start === start && !row.stat.startsWith('Z') ? [{ pid, reason: 'still running', startTime: start }] : [];
          });
        } catch (err) {
          alive = [...targets].map(([pid, start]) => ({ pid, reason: `the process table could not be read: ${err instanceof Error ? err.message : String(err)}`, startTime: start }));
        }
        if (alive.length === 0 || Date.now() >= deadline) break;
        await sleep(POLL_MS);
      }
      const kernels = await confirmedKernelStarts(deps, lastRows, alive.map((s) => s.pid));
      const survivors = alive.map((s) => (kernels.has(s.pid) ? { ...s, startKernel: kernels.get(s.pid) } : s));
      if (scanError !== null) survivors.push({ pid: rootPid, reason: `the tree could not be taken whole: ${scanError}`, unverified: true });
      const killed = [...targets.keys()].filter((pid) => !alive.some((s) => s.pid === pid));
      return survivors.length === 0 ? { ok: true, killed } : { ok: false, killed, survivors };
    },
  };
}
