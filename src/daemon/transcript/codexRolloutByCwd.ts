// Bind a fresh Codex pane to its rollout by cwd, without waiting for a notify.
//
// Codex names its thread only in the turn-complete notify, and the first
// notify a fresh pane hears is usually the internal title thread's, which has
// no rollout. The real thread's notify arrives only when its first turn ends
// normally; Ctrl+C never sends it. A fan-out worker started with a long argv
// prompt could therefore stay unbound for its whole life.
//
// The exact-id lookup stays the rule for notify ids. This module is the narrow
// exception the owner asked for: the rollout's `session_meta` records the cwd
// and start time, and a pane whose cwd no other live Codex pane shares (a
// fan-out worktree, typically) can be matched on them. It fails closed:
//   - the pane's launch time must be known (the agent process's start time, or
//     the OSC 133 command-start that launched it); without one it waits;
//   - only a rollout started within LAUNCH_WINDOW_MS of that launch counts;
//   - only an interactive `codex-tui` top-level thread qualifies: sub-agent
//     rollouts share their parent's cwd, and phone/chat relay threads are not
//     the pane's TUI;
//   - ids bound to another pane are skipped;
//   - two or more matches refuse, and so does a candidate set too large to read
//     in full, and so does a cwd another live Codex pane shares unless that
//     pane is already bound for its current run.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ResumeBinding } from '../../shared/agentResume';
import { checkNativeTranscriptPath, codexSessionRoot } from './providers';

/** A rollout may start a moment before the launch marker (whole-second names, clock skew). */
const START_SLACK_MS = 2_000;
/** A rollout started this long after the launch belongs to something else. */
export const LAUNCH_WINDOW_MS = 120_000;
/** session_meta reads per scan; more candidates than this refuse. */
export const MAX_HEAD_READS = 64;
/** session_meta is the first line; it carries the full base instructions (~22KB). */
const HEAD_BYTES = 128 * 1024;
const ROLLOUT_NAME = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;

export interface CodexCwdQuery {
  cwd: string;
  /** Epoch ms of the pane's agent launch. */
  notBefore: number;
  env?: Record<string, string>;
  /** Thread ids already bound to other panes. */
  exclude?: ReadonlySet<string>;
}

export type CodexCwdMatch =
  | { ok: true; threadId: string; transcriptPath: string; cwd: string }
  | { ok: false; reason: 'none' | 'ambiguous' | 'budget' };

/** Canonical form for comparing two directories (macOS /tmp → /private/tmp, symlinked worktrees). */
export function canonicalDir(dir: string): string {
  let resolved = path.resolve(dir);
  try { resolved = fs.realpathSync(resolved); } catch { /* keep the lexical form */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** `<root>/YYYY/MM/DD` for each local date the window touches. Codex names them in local time. */
function dayDirs(root: string, from: number, to: number): string[] {
  const dirs = new Set<string>();
  for (const at of [from, to]) {
    const d = new Date(at);
    dirs.add(path.join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
  }
  return [...dirs];
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

/** The one interactive Codex rollout started in `cwd` within the launch window, if exactly one exists. */
export function findCodexRolloutByCwd(query: CodexCwdQuery): CodexCwdMatch {
  const from = query.notBefore - START_SLACK_MS;
  const to = query.notBefore + LAUNCH_WINDOW_MS;
  const want = canonicalDir(query.cwd);
  // Cheap pass first: the file name carries the local start time to the second.
  const candidates: Array<{ id: string; file: string }> = [];
  for (const dir of dayDirs(codexSessionRoot(query.env), from, to)) {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const m = ROLLOUT_NAME.exec(name);
      if (!m || query.exclude?.has(m[7])) continue;
      const named = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
      if (named < from - 1_000 || named > to + 1_000) continue;
      candidates.push({ id: m[7], file: path.join(dir, name) });
    }
  }
  // A match outside what we can read could be the second one: refuse rather than guess.
  if (candidates.length > MAX_HEAD_READS) return { ok: false, reason: 'budget' };
  const hits = new Map<string, { file: string; cwd: string }>();
  for (const { id, file } of candidates) {
    const meta = readSessionMeta(file);
    if (!meta || meta.id !== id || meta.originator !== 'codex-tui') continue;
    if (typeof meta.source !== 'string' || meta.thread_source === 'subagent') continue;
    const started = typeof meta.timestamp === 'string' ? Date.parse(meta.timestamp) : NaN;
    if (!(started >= from && started <= to)) continue;
    if (typeof meta.cwd !== 'string' || canonicalDir(meta.cwd) !== want) continue;
    if (!checkNativeTranscriptPath('codex', file, id, query.env).ok) continue;
    hits.set(id, { file, cwd: meta.cwd });
  }
  if (hits.size !== 1) return { ok: false, reason: hits.size === 0 ? 'none' : 'ambiguous' };
  const [[threadId, hit]] = hits;
  return { ok: true, threadId, transcriptPath: hit.file, cwd: hit.cwd };
}

/** Full session_meta reads for a resume check; more than this without a hit reads as "none". */
export const MAX_RESUME_HEAD_READS = 256;
/** Rollout files a resume check may look at in all (most are skipped from a small first read). */
export const MAX_RESUME_FILES = 4096;
const SNIFF_BYTES = 4096;

/** The originator from the first bytes of a rollout, or undefined when it is not there. */
function sniffOriginator(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(SNIFF_BYTES);
    const n = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
    return /"originator"\s*:\s*"([^"]*)"/.exec(buf.subarray(0, n).toString('utf8'))?.[1];
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Whether `codex resume --last` run in `cwd` has a conversation to continue:
 * any interactive top-level rollout recorded there, with no time window. The
 * walk goes newest first and stops at the first hit. A rollout whose first
 * bytes name another originator (`codex exec` writes many) is skipped without
 * a full read; a budget that runs out answers false, so a launch is refused
 * rather than left to fail in the TUI.
 */
export function hasCodexRolloutForCwd(cwd: string, env?: Record<string, string>, budget = MAX_RESUME_HEAD_READS, maxFiles = MAX_RESUME_FILES): boolean {
  const want = canonicalDir(cwd);
  const newestFirst = (dir: string, pattern: RegExp): string[] => {
    try { return fs.readdirSync(dir).filter((name) => pattern.test(name)).sort().reverse(); } catch { return []; }
  };
  const root = codexSessionRoot(env);
  let files = 0;
  let reads = 0;
  for (const year of newestFirst(root, /^\d{4}$/)) {
    for (const month of newestFirst(path.join(root, year), /^\d{2}$/)) {
      for (const day of newestFirst(path.join(root, year, month), /^\d{2}$/)) {
        const dir = path.join(root, year, month, day);
        for (const name of newestFirst(dir, ROLLOUT_NAME)) {
          if (++files > maxFiles) return false;
          const file = path.join(dir, name);
          const originator = sniffOriginator(file);
          if (originator !== undefined && originator !== 'codex-tui') continue;
          if (++reads > budget) return false;
          const meta = readSessionMeta(file);
          if (!meta || meta.originator !== 'codex-tui' || typeof meta.source !== 'string' || meta.thread_source === 'subagent') continue;
          if (typeof meta.cwd === 'string' && canonicalDir(meta.cwd) === want) return true;
        }
      }
    }
  }
  return false;
}

/** What the pane decision needs to know about one live pane. */
export interface CodexPaneFacts {
  id: string;
  cwd: string;
  binding?: ResumeBinding;
  /** Epoch ms the pane's current agent launched; undefined when unknown. */
  launchAt?: number;
  /** A Codex process is (or, untracked, was last detected) running in the pane. */
  codexLive: boolean;
}

export type CodexPaneDecision =
  | { kind: 'skip' }
  | { kind: 'wait' }
  | { kind: 'refuse'; reason: 'shared-cwd' }
  | { kind: 'query'; query: CodexCwdQuery };

/** The pane holds a rollout binding captured during its current Codex run. */
export function boundForCurrentRun(pane: Pick<CodexPaneFacts, 'binding' | 'launchAt'>): boolean {
  const b = pane.binding;
  return b?.agent === 'codex' && !!b.transcriptPath && pane.launchAt !== undefined
    && b.ts >= pane.launchAt - START_SLACK_MS;
}

/** Decide what the cwd bind may do for `self`, given every other live pane. Pure. */
export function describeCodexPane(
  self: CodexPaneFacts,
  others: readonly CodexPaneFacts[],
  env?: Record<string, string>,
): CodexPaneDecision {
  if (boundForCurrentRun(self)) return { kind: 'skip' };
  // No launch marker (tmux, a shell without integration, the process start not
  // read yet): nothing bounds the match in time.
  if (self.launchAt === undefined) return { kind: 'wait' };
  const want = canonicalDir(self.cwd);
  // A pane holding an older binding has started a new run whose rollout is not
  // bound yet; it competes for the same cwd until it is.
  const conflict = others.some((o) => o.codexLive && !boundForCurrentRun(o) && canonicalDir(o.cwd) === want);
  if (conflict) return { kind: 'refuse', reason: 'shared-cwd' };
  const exclude = new Set(others.flatMap((o) => (o.binding?.agent === 'codex' ? [o.binding.sessionId] : [])));
  return { kind: 'query', query: { cwd: self.cwd, notBefore: self.launchAt, ...(env ? { env } : {}), exclude } };
}

/** `ps` etime (`[[dd-]hh:]mm:ss`) in ms. */
export function parseEtime(etime: string): number | undefined {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(etime);
  if (!m) return undefined;
  return ((((+(m[1] ?? 0) * 24) + +(m[2] ?? 0)) * 60 + +m[3]) * 60 + +m[4]) * 1000;
}

/** Start time of a POSIX process, from its elapsed time; undefined on Windows or failure. */
export function readProcessStartMs(pid: number): Promise<number | undefined> {
  if (process.platform === 'win32' || !(pid > 0)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'etime=', '-p', String(pid)], { timeout: 5_000 }, (err, stdout) => {
      const elapsed = err ? undefined : parseEtime(String(stdout));
      // etime has whole-second resolution: round the start down.
      resolve(elapsed === undefined ? undefined : Date.now() - elapsed - 1_000);
    });
  });
}

/** Delays between attempts after the launch edge; the first runs at once. */
export const CWD_BIND_DELAYS_MS: readonly number[] = [0, 2_000, 5_000, 15_000, 45_000];

export interface CodexCwdBinderDeps {
  pane: (paneId: string) => CodexPaneDecision | undefined;
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
    let decision: CodexPaneDecision | undefined;
    try { decision = this.deps.pane(paneId); } catch { return true; }
    if (!decision || decision.kind === 'skip') return true;
    if (decision.kind === 'wait') return false;
    if (decision.kind === 'refuse') {
      this.deps.log?.('info', `[codex] cwd bind refused for ${paneId}: another live Codex pane shares its cwd`);
      return true;
    }
    const match = findCodexRolloutByCwd(decision.query);
    if (match.ok) {
      try {
        this.deps.bind(paneId, match);
      } catch (err) {
        this.deps.log?.('warn', `[codex] cwd bind failed for ${paneId}: ${String(err)}`);
      }
      return true;
    }
    if (match.reason !== 'none') {
      this.deps.log?.('info', `[codex] cwd bind refused for ${paneId}: ${match.reason === 'budget' ? 'too many recent rollouts to read' : 'several rollouts match its cwd'}`);
      return true;
    }
    return false;
  }
}
