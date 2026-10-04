// Bind a fresh Codex pane to its rollout by cwd, without waiting for a notify.
//
// Codex names its thread only in the turn-complete notify, and the first
// notify a fresh pane hears is usually the internal title thread's, which has
// no rollout. The real thread's notify arrives only when its first turn ends
// normally; Ctrl+C never sends it. A fan-out worker started with a long argv
// prompt could therefore stay unbound for its whole life.
//
// The exact-id lookup (scanForCodexTranscript) stays the rule for notify ids.
// This module is the narrow exception the owner asked for: the rollout's
// `session_meta` records the cwd and start time, and a pane whose cwd no other
// live Codex pane shares (a fan-out worktree, typically) can be matched on
// them. It fails closed:
//   - only an interactive `codex-tui` top-level thread qualifies: sub-agent
//     rollouts share their parent's cwd, and phone/chat relay threads are not
//     the pane's TUI;
//   - the rollout must start after the pane's agent launch;
//   - ids bound to another pane are skipped;
//   - two or more matches refuse ('ambiguous'), and so does a cwd another
//     unbound live Codex pane shares (decided by the caller).
// The scan is bounded to the newest local-date folders and a capped number of
// session_meta reads.

import fs from 'node:fs';
import path from 'node:path';
import { checkNativeTranscriptPath, codexSessionRoot } from './providers';

/** A rollout may start a moment before the launch marker the caller saw. */
const START_SLACK_MS = 2_000;
/** Local-date folders examined, newest first. */
const MAX_DAY_DIRS = 3;
/** session_meta reads per scan. */
const MAX_HEAD_READS = 64;
/** session_meta is the first line; it carries the full base instructions (~22KB). */
const HEAD_BYTES = 128 * 1024;
const ROLLOUT_NAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;

export interface CodexCwdQuery {
  cwd: string;
  /** Epoch ms of the pane's agent launch; an older rollout is not this pane's. */
  notBefore: number;
  env?: Record<string, string>;
  /** Thread ids already bound to other panes. */
  exclude?: ReadonlySet<string>;
  now?: number;
}

export type CodexCwdMatch =
  | { ok: true; threadId: string; transcriptPath: string; cwd: string }
  | { ok: false; reason: 'none' | 'ambiguous' };

/** Canonical form for comparing two directories (macOS /tmp → /private/tmp, symlinked worktrees). */
export function canonicalDir(dir: string): string {
  let resolved = path.resolve(dir);
  try { resolved = fs.realpathSync(resolved); } catch { /* keep the lexical form */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** `<root>/YYYY/MM/DD` for the local dates from `now` back to `floor`, newest first. Codex names them in local time. */
function dayDirs(root: string, floor: number, now: number): string[] {
  const today = new Date(now);
  const dirs: string[] = [];
  for (let i = 0; i < MAX_DAY_DIRS; i += 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const pad = (n: number) => String(n).padStart(2, '0');
    dirs.push(path.join(root, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate())));
    if (day.getTime() <= floor) break;
  }
  return dirs;
}

interface SessionMeta { id?: unknown; cwd?: unknown; timestamp?: unknown; originator?: unknown; source?: unknown; thread_source?: unknown }

function readSessionMeta(file: string): SessionMeta | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    if (nl < 0) return undefined;
    const line = JSON.parse(text.slice(0, nl)) as { type?: unknown; payload?: SessionMeta };
    return line.type === 'session_meta' && line.payload && typeof line.payload === 'object' ? line.payload : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The one interactive Codex rollout started in `cwd` since `notBefore`, if exactly one exists. */
export function findCodexRolloutByCwd(query: CodexCwdQuery): CodexCwdMatch {
  const now = query.now ?? Date.now();
  const floor = query.notBefore - START_SLACK_MS;
  const want = canonicalDir(query.cwd);
  const hits = new Map<string, { file: string; cwd: string }>();
  let reads = 0;
  for (const dir of dayDirs(codexSessionRoot(query.env), floor, now)) {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    // Names start with the local start time, so newest first.
    for (const name of names.sort().reverse()) {
      const id = ROLLOUT_NAME.exec(name)?.[1];
      if (!id || query.exclude?.has(id)) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.mtimeMs < floor) continue;
      } catch { continue; }
      if (reads++ >= MAX_HEAD_READS) break;
      const meta = readSessionMeta(file);
      if (!meta || meta.id !== id || meta.originator !== 'codex-tui') continue;
      if (typeof meta.source !== 'string' || meta.thread_source === 'subagent') continue;
      const started = typeof meta.timestamp === 'string' ? Date.parse(meta.timestamp) : NaN;
      if (!(started >= floor) || typeof meta.cwd !== 'string' || canonicalDir(meta.cwd) !== want) continue;
      if (!checkNativeTranscriptPath('codex', file, id, query.env).ok) continue;
      hits.set(id, { file, cwd: meta.cwd });
    }
  }
  if (hits.size !== 1) return { ok: false, reason: hits.size === 0 ? 'none' : 'ambiguous' };
  const [[threadId, hit]] = hits;
  return { ok: true, threadId, transcriptPath: hit.file, cwd: hit.cwd };
}

/** Delays between attempts after the launch edge; the first runs at once. */
export const CWD_BIND_DELAYS_MS: readonly number[] = [0, 2_000, 5_000, 15_000, 45_000];

export interface CodexCwdBinderDeps {
  /**
   * The pane as it stands now, or undefined when there is nothing to do (gone,
   * no longer Codex, or already bound to a rollout). `sharedCwd` is true when
   * another unbound live Codex pane has the same cwd.
   */
  pane: (paneId: string) => (Omit<CodexCwdQuery, 'now'> & { sharedCwd: boolean }) | undefined;
  bind: (paneId: string, match: Extract<CodexCwdMatch, { ok: true }>) => void;
  log?: (level: 'info' | 'warn', message: string) => void;
  delaysMs?: readonly number[];
}

/** Runs the cwd match for a pane on its Codex launch edge, retrying while the rollout is not written yet. */
export class CodexCwdBinder {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Panes whose attempts for the current launch are over. */
  private readonly settled = new Set<string>();

  constructor(private readonly deps: CodexCwdBinderDeps) {}

  /** Start the attempts for this launch; a no-op while they run or after they ended. */
  arm(paneId: string): void {
    if (this.timers.has(paneId) || this.settled.has(paneId)) return;
    this.schedule(paneId, 0);
  }

  /** Forget the pane: a launch edge after this arms afresh. */
  reset(paneId: string): void {
    const timer = this.timers.get(paneId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(paneId);
    this.settled.delete(paneId);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(paneId: string, attempt: number): void {
    const delays = this.deps.delaysMs ?? CWD_BIND_DELAYS_MS;
    if (attempt >= delays.length) {
      this.timers.delete(paneId);
      this.settled.add(paneId);
      return;
    }
    const timer = setTimeout(() => {
      if (this.attempt(paneId)) {
        this.timers.delete(paneId);
        this.settled.add(paneId);
      } else {
        this.schedule(paneId, attempt + 1);
      }
    }, delays[attempt]);
    timer.unref?.();
    this.timers.set(paneId, timer);
  }

  /** One attempt; true when the attempts for this launch are over. */
  private attempt(paneId: string): boolean {
    let pane: ReturnType<CodexCwdBinderDeps['pane']>;
    try { pane = this.deps.pane(paneId); } catch { return true; }
    if (!pane) return true;
    if (pane.sharedCwd) {
      this.deps.log?.('info', `[codex] cwd bind refused for ${paneId}: another live Codex pane shares its cwd`);
      return true;
    }
    const match = findCodexRolloutByCwd(pane);
    if (match.ok) {
      try {
        this.deps.bind(paneId, match);
      } catch (err) {
        this.deps.log?.('warn', `[codex] cwd bind failed for ${paneId}: ${String(err)}`);
      }
      return true;
    }
    if (match.reason === 'ambiguous') {
      this.deps.log?.('info', `[codex] cwd bind refused for ${paneId}: several rollouts match its cwd`);
      return true;
    }
    return false;
  }
}
