// What happens to a company seat's worktree once its company is over, decided
// from facts the driver (seatCleanup.ts) gathers: no git or disk here.
//
// seatLaunches makes `<wmux home>/company-worktrees/<repoHash>/<slug>` on
// branch `company/<slug>`. Nothing ends a seat's folder when its company does
// (Dissolve keeps every pane running in it), so a folder is removed once
// nothing points at it and all its work is on a remote, and listed in the task
// cleanup list with the reason otherwise.

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
