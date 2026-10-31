// What happens to a company seat's worktree once its company is over, decided
// from facts the driver (seatCleanup.ts) gathers: no git or disk here.
//
// seatLaunches makes `<wmux home>/company-worktrees/<repoHash>/<slug>` on
// branch `company/<slug>`. Nothing ends a seat's folder when its company does
// (Dissolve keeps every pane running in it), so a folder is removed once
// nothing points at it and all its work is on a remote, and listed in the task
// cleanup list with the reason otherwise.

import type { DirectoryHold } from '../../shared/directoryHold';
import type { WorktreeShape } from '../worktask/PhoneWorktreeRemoval';

/** A seat folder younger than this is a seat about to start: seatLaunches
 *  makes the folders before the panes spawn. */
export const SEAT_SWEEP_MIN_AGE_MS = 10 * 60 * 1000;

export const COMPANY_SEAT_BRANCH_PREFIX = 'company/';

/**
 * The names buildTaskSlug(label, workspaceId) gives a seat folder: the label's
 * slug (`[a-z0-9-]`, at most 24) and `-`, then the workspace id's last 8
 * characters; the suffix alone when the label has no slug. Never `.meta`.
 */
const SEAT_FOLDER = /^(?![.-])(?!.*\.\.)(?:[a-z0-9][a-z0-9-]{0,23}-)?[A-Za-z0-9._-]{1,8}$/;

/** A seat folder; its removal reports only its own `company/<folder>` branch. */
export const COMPANY_SEAT_SHAPE: WorktreeShape = {
  folder: (name) => SEAT_FOLDER.test(name),
  branch: (branch, folder) => branch === `${COMPANY_SEAT_BRANCH_PREFIX}${folder}`,
};

/** Why a seat folder stays and is not listed: it is in use, or about to be. */
export type SeatKeptReason = 'young' | 'in-use' | 'kept' | 'held';
/** Why a seat folder stays and is listed in the task cleanup list. */
export type SeatListedReason = 'unregistered' | 'locked' | 'uncommitted' | 'unpushed';

/** What git says about a seat folder. */
export interface SeatGitFacts {
  /** `rev-parse --show-toplevel` in it names the folder itself. */
  registered: boolean;
  locked: boolean;
  /** `status --porcelain --untracked-files=all` printed something. */
  dirty: boolean;
  /** HEAD's commit. */
  head?: string;
  /** `rev-list HEAD --not --remotes --count`: commits on no remote ref. */
  onlyHere: number;
  /** The same count for `company/<folder>` when HEAD has left it (0 at the
   *  base or at HEAD). */
  branchOnlyHere: number;
}

export interface SeatFacts {
  /** Since the stamp's createdAt, else since the folder's mtime. */
  ageMs: number;
  /** A live pane's cwd or spawn cwd is the folder or inside it. */
  liveSession: boolean;
  /** A folder the renderer keeps (a live, stashed or archived pane's) is the folder or inside it. */
  kept: boolean;
  hold: DirectoryHold;
  /** The stamp's: the commit the seat's branch was made at. */
  baseOid?: string;
  /** Read only once every check above passed. */
  git?: SeatGitFacts;
}

export type SeatVerdict =
  | { kind: 'keep'; reason: SeatKeptReason }
  /** The checks above git passed: read `git` and ask again. */
  | { kind: 'needs-git' }
  | { kind: 'list'; reason: SeatListedReason; commits?: number }
  | { kind: 'remove' };

/**
 * A seat folder is removed only when every check passes; the first that
 * fails is why it stays. A HEAD still at the commit the branch was made at
 * holds no work of the seat's, even with no remote at all.
 */
export function seatVerdict(f: SeatFacts): SeatVerdict {
  if (f.ageMs < SEAT_SWEEP_MIN_AGE_MS) return { kind: 'keep', reason: 'young' };
  if (f.liveSession) return { kind: 'keep', reason: 'in-use' };
  if (f.kept) return { kind: 'keep', reason: 'kept' };
  if (f.hold !== 'free') return { kind: 'keep', reason: 'held' };
  const git = f.git;
  if (!git) return { kind: 'needs-git' };
  if (!git.registered) return { kind: 'list', reason: 'unregistered' };
  if (git.locked) return { kind: 'list', reason: 'locked' };
  if (git.dirty) return { kind: 'list', reason: 'uncommitted' };
  const atBase = f.baseOid !== undefined && git.head === f.baseOid;
  if (git.onlyHere > 0 && !atBase) return { kind: 'list', reason: 'unpushed', commits: git.onlyHere };
  if (git.branchOnlyHere > 0) return { kind: 'list', reason: 'unpushed', commits: git.branchOnlyHere };
  return { kind: 'remove' };
}

/**
 * The branch a removed seat folder takes with it: only `company/<folder>`,
 * at the commit it points at now, and only when that commit is on a remote
 * ref or is the one the branch was made at. Null keeps it.
 */
export function seatBranchToDelete(f: { folder: string; branch: string; oid?: string; onRemote: boolean; baseOid?: string }): { branch: string; oid: string } | null {
  if (f.branch !== `${COMPANY_SEAT_BRANCH_PREFIX}${f.folder}` || !f.oid) return null;
  return f.onRemote || f.oid === f.baseOid ? { branch: f.branch, oid: f.oid } : null;
}
