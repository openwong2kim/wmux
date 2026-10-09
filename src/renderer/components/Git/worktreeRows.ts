// ─── Git page: one row per worktree ─────────────────────────────────────────
//
// The section used to be two lists in the tools panel: the Git tab's worktree
// roster (path, branch, main / locked / prunable) and the Review section's
// workspaces on those worktrees (name, PR, uncommitted diff stat). This joins
// them on the worktree path so each worktree is one row that says which
// workspaces sit on it. Pure, so the join and the ordering are testable
// without a renderer.

import type { PrStatus } from '../../../shared/types';
import type { WorktreeEntry } from '../../../shared/worktreeParse';

/** A `git worktree list` row, plus the merge-session fields main derives. */
export type WorktreeRowUI = WorktreeEntry & { merging?: boolean; integration?: boolean; conflicts?: number; lastCommitAt?: number; worktreeAt?: number };

/** Uncommitted changes of one worktree (summed `diff:read` numstat). */
export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
  /** The read failed; the stat cell degrades to a dash with this as its title. */
  error: string | null;
}

/** A workspace whose repo resolved to one of this repo's worktrees. */
export interface WorkspaceOnRepo {
  workspaceId: string;
  name: string;
  pr: PrStatus | null;
  /** Resolved worktree toplevel of the workspace's active pane. */
  repoPath: string;
}

export interface GitWorktreeRow {
  entry: WorktreeRowUI;
  /** Normalized path — the join key. */
  key: string;
  isMain: boolean;
  /** The worktree the active pane is in (the row's one accent dot). */
  isCurrent: boolean;
  workspaces: { workspaceId: string; name: string; pr: PrStatus | null }[];
  /** Absent until read; only worktrees with a workspace on them are read. */
  stat: DiffStat | null;
}

/**
 * Path identity for the join: trailing separators dropped, backslashes turned
 * into slashes, and case folded where the file system ignores it.
 */
export function normWorktreePath(p: string, platform?: string): string {
  const s = p.replace(/[/\\]+$/, '').replace(/\\/g, '/');
  return platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s;
}

/**
 * The worktree a path sits in: the longest worktree path that is the path or
 * one of its parents (a linked worktree nested inside the main one wins over
 * the main one). Returns the worktree's path as given, or null.
 */
export function worktreeContaining(path: string, worktreePaths: readonly string[], platform?: string): string | null {
  const p = normWorktreePath(path, platform);
  let best: string | null = null;
  let bestLen = -1;
  for (const wt of worktreePaths) {
    const w = normWorktreePath(wt, platform);
    if ((p === w || p.startsWith(`${w}/`)) && w.length > bestLen) {
      best = wt;
      bestLen = w.length;
    }
  }
  return best;
}

export function buildWorktreeRows(input: {
  worktrees: readonly WorktreeRowUI[];
  mainPath: string;
  currentPath: string;
  workspaces: readonly WorkspaceOnRepo[];
  stats: Readonly<Record<string, DiffStat>>;
  platform?: string;
}): GitWorktreeRow[] {
  const norm = (p: string) => normWorktreePath(p, input.platform);
  const main = input.mainPath ? norm(input.mainPath) : '';
  const current = input.currentPath ? norm(input.currentPath) : '';
  const rows = input.worktrees
    // Our own merge-session worktree is an implementation detail; the merge
    // session panel stands in for it.
    .filter((wt) => !wt.integration)
    .map((entry): GitWorktreeRow => {
      const key = norm(entry.path);
      return {
        entry,
        key,
        isMain: main !== '' && key === main,
        isCurrent: current !== '' && key === current,
        workspaces: input.workspaces
          .filter((ws) => norm(ws.repoPath) === key)
          .map(({ workspaceId, name, pr }) => ({ workspaceId, name, pr })),
        stat: input.stats[key] ?? null,
      };
    });
  // Worktrees with uncommitted changes first — the rows you came to review —
  // then the rest, each group in git's own order (main first).
  const dirty = rows.filter((r) => (r.stat?.files ?? 0) > 0);
  const rest = rows.filter((r) => (r.stat?.files ?? 0) === 0);
  return [...dirty, ...rest];
}

/** A branch with no commit for this long counts as having no recent activity. */
export const STALE_WORKTREE_DAYS = 14;

// ─── Who acts next on a worktree ────────────────────────────────────────────
//
// The Worktrees tab's sections, the worktree form of the flat list's
// who-acts-next grammar. First match wins:
//   inUse        a workspace sits on it (someone is on it), unless its PR is
//                merged, its tree is clean and no agent there is working or
//                asking: then it is a cleanup candidate (below).
//   uncommitted  no workspace, and uncommitted changes: work nobody is on.
//   cleanup      not the main worktree, not locked, not a merge session's,
//                and: its workspace's PR is merged (see inUse), or no
//                workspace and detached, prunable, or quiet for
//                STALE_WORKTREE_DAYS without an open PR. A candidate to look
//                at, not a verdict: it may hold unpushed work.
//   noPr         no workspace, a branch (not the main worktree) and the
//                repo's open PR list, when the page holds one, has no PR
//                from it.
//   idle         the rest: no workspace and nothing to do (an open PR, the
//                main worktree, a locked one, or the PR list unknown).
// The signals are ones wmux already reads: the worktree list, the uncommitted
// diff stat, the workspaces on each worktree with their pushed PR status (the
// only place a merged PR shows: the open list holds open PRs only) and live
// agent status, and the repo's open PR list as the page already read it
// (its own header read or a Pull requests list; the tab reads none itself).

export type WorktreeSection = 'inUse' | 'uncommitted' | 'noPr' | 'cleanup' | 'idle';

/** The sections in the order the tab draws them. */
export const WORKTREE_SECTION_ORDER: readonly WorktreeSection[] = ['inUse', 'uncommitted', 'noPr', 'cleanup', 'idle'];

/** Sections a row can be snoozed out of: the ones that ask something of the owner. */
export const SNOOZABLE_SECTIONS: ReadonlySet<WorktreeSection> = new Set<WorktreeSection>(['uncommitted', 'noPr', 'cleanup']);

export interface WorktreeSignals {
  /** Epoch ms. */
  now: number;
  /** The head branches of the repo's open PRs; null when the page holds no list. */
  openPrBranches: ReadonlySet<string> | null;
  /** Workspaces where an agent is working or asking. */
  busyWorkspaces: ReadonlySet<string>;
}

/** The section a worktree row belongs in. Pure. */
export function classifyWorktree(row: GitWorktreeRow, s: WorktreeSignals): WorktreeSection {
  const e = row.entry;
  const clean = row.stat !== null && row.stat.error === null && row.stat.files === 0;
  const dirty = row.stat !== null && row.stat.error === null && row.stat.files > 0;
  const removable = !row.isMain && !e.integration && e.locked === null;
  if (row.workspaces.length > 0) {
    const merged = row.workspaces.some((w) => w.pr?.state === 'merged');
    const busy = row.workspaces.some((w) => s.busyWorkspaces.has(w.workspaceId));
    return merged && clean && !busy && removable ? 'cleanup' : 'inUse';
  }
  if (dirty) return 'uncommitted';
  const openPr = !!e.branch && !!s.openPrBranches?.has(e.branch);
  // The later of the branch tip and the worktree's own git activity (its
  // admin dir), so a fresh worktree on an old branch is not "quiet".
  const lastAt = Math.max(e.lastCommitAt ?? 0, e.worktreeAt ?? 0);
  const quiet = lastAt > 0 && s.now - lastAt > STALE_WORKTREE_DAYS * 24 * 60 * 60 * 1000;
  if (removable && (e.detached || e.prunable !== null || (quiet && !openPr))) return 'cleanup';
  if (!row.isMain && !e.integration && e.branch && s.openPrBranches !== null && !openPr) return 'noPr';
  return 'idle';
}

/** Rows per section, each in the order given. Pure. */
export function sectionWorktreeRows(rows: readonly GitWorktreeRow[], s: WorktreeSignals): Record<WorktreeSection, GitWorktreeRow[]> {
  const out = Object.fromEntries(WORKTREE_SECTION_ORDER.map((k) => [k, [] as GitWorktreeRow[]])) as Record<WorktreeSection, GitWorktreeRow[]>;
  for (const row of rows) out[classifyWorktree(row, s)].push(row);
  return out;
}

// ─── Snooze ─────────────────────────────────────────────────────────────────
//
// A row in a section that asks something of the owner can be snoozed: it
// leaves its section for a folded Snoozed group until the chosen time, or
// until its state changes, whichever comes first. Its state is its section,
// its head commit and its uncommitted file count, so a new commit, new edits
// or a move to another section wakes it. Kept per viewer (gitPageState).

export interface WorktreeSnooze {
  /** Epoch ms the snooze ends; null = only a change of state ends it. */
  until: number | null;
  /** The row's state when snoozed (worktreeSnoozeSig). */
  sig: string;
  /** The repo's main worktree (normalized), so that repo's list can drop a
   *  snooze whose worktree is gone without touching other repos'. */
  repo: string;
}

/** A row's state for snooze purposes. Pure. */
export function worktreeSnoozeSig(row: GitWorktreeRow, section: WorktreeSection): string {
  const files = row.stat && row.stat.error === null ? row.stat.files : 0;
  return `${section}|${row.entry.headOid}|${files}`;
}

/** Which of one repo's rows are snoozed now, and which kept snoozes have
 *  ended. A snooze ends when its time passes (any repo), when its worktree
 *  is no longer listed or its state differs (this repo only, and only once
 *  `settled`: the list and its stats are in, so a row still loading does not
 *  read as changed). While the repo's PR list is unknown (`prKnown` false) a
 *  row cannot tell No open PR from No workspace, so its section is left out
 *  of the comparison and only a new commit or new edits wake it. Pure. */
export function resolveWorktreeSnoozes(input: {
  snoozes: Readonly<Record<string, WorktreeSnooze>>;
  repo: string;
  rows: readonly { row: GitWorktreeRow; section: WorktreeSection }[];
  now: number;
  settled: boolean;
  prKnown: boolean;
}): { snoozed: Set<string>; ended: string[] } {
  const tail = (sig: string) => sig.slice(sig.indexOf('|'));
  const byKey = new Map(input.rows.map((r) => [r.row.key, r]));
  const snoozed = new Set<string>();
  const ended: string[] = [];
  for (const [key, z] of Object.entries(input.snoozes)) {
    if (z.until !== null && z.until <= input.now) {
      ended.push(key);
      continue;
    }
    if (z.repo !== input.repo) continue;
    const hit = byKey.get(key);
    if (!hit) {
      if (input.settled) ended.push(key);
      continue;
    }
    const sig = worktreeSnoozeSig(hit.row, hit.section);
    const changed = input.prKnown
      ? !SNOOZABLE_SECTIONS.has(hit.section) || sig !== z.sig
      : (hit.section === 'inUse' || tail(sig) !== tail(z.sig));
    if (input.settled && changed) {
      ended.push(key);
      continue;
    }
    snoozed.add(key);
  }
  return { snoozed, ended };
}

/** The snooze presets: an hour, a day, a week, or until the row changes. */
export type SnoozeChoice = 'hour' | 'day' | 'week' | 'change';
export const SNOOZE_CHOICES: readonly SnoozeChoice[] = ['hour', 'day', 'week', 'change'];

/** When a snooze picked at `now` ends; null for 'change'. Pure. */
export function snoozeUntil(choice: SnoozeChoice, now: number): number | null {
  const h = 60 * 60 * 1000;
  return choice === 'hour' ? now + h : choice === 'day' ? now + 24 * h : choice === 'week' ? now + 7 * 24 * h : null;
}
