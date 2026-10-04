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
export type WorktreeRowUI = WorktreeEntry & { merging?: boolean; integration?: boolean; conflicts?: number; lastCommitAt?: number };

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

export interface WorktreeGroups {
  /** A workspace sits on it. */
  inUse: GitWorktreeRow[];
  /** No workspace on it, and not a cleanup candidate. */
  idle: GitWorktreeRow[];
  /** No workspace, and detached, prunable or quiet for STALE_WORKTREE_DAYS.
   *  A candidate to look at, not a verdict: it may hold unpushed work. */
  cleanup: GitWorktreeRow[];
}

/** Split rows for the Worktrees tab. The main worktree and a merge session's
 *  integration worktree are never cleanup candidates. Pure. */
export function groupWorktreeRows(rows: readonly GitWorktreeRow[], now: number): WorktreeGroups {
  const out: WorktreeGroups = { inUse: [], idle: [], cleanup: [] };
  const staleMs = STALE_WORKTREE_DAYS * 24 * 60 * 60 * 1000;
  for (const row of rows) {
    if (row.workspaces.length > 0) {
      out.inUse.push(row);
      continue;
    }
    const e = row.entry;
    const quiet = e.lastCommitAt !== undefined && now - e.lastCommitAt > staleMs;
    const candidate = !row.isMain && !e.integration && (e.detached || e.prunable !== null || quiet);
    (candidate ? out.cleanup : out.idle).push(row);
  }
  return out;
}
