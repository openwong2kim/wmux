// ─── Checkout ownership: is this cwd a checkout another agent run owns? ─────
//
// A fan-out task's worktree belongs to that task: its own workspace works in
// it, and so may the orchestrator workspace that fanned it out. An agent
// started there from any other workspace silently shares the checkout — two
// agents editing, staging and committing in one working tree.
//
// The path comparison is adapted from MonoCode (hardbeat920/monocode@6bd432ca,
// src-tauri/src/control.rs — paths_overlap / comparison_path), MIT License,
// Copyright (c) 2026 Nick. Unlike there, only the checkout itself and folders
// inside it count: every worktree lives under the user's home, so a pane
// sitting in a PARENT folder (home itself) is not sharing any checkout.

/** The WorkTask fields the ownership check reads. */
export interface CheckoutOwnerTask {
  id: string;
  title: string;
  status: 'open' | 'closed';
  worktreePath?: string;
  /** The task's own workspace. */
  paneGroupId?: string;
  /** The orchestrator that fanned it out. */
  owner?: { verifiedWorkspaceId?: string };
}

/**
 * Normalize a path for comparison: forward slashes, no trailing slash, and
 * case-folded only on Windows (POSIX paths must keep their case).
 */
export function comparisonPath(p: string, caseInsensitive: boolean): string {
  let value = p.replace(/\\/g, '/');
  while (value.length > 1 && value.endsWith('/') && !/^[A-Za-z]:\/$/.test(value)) value = value.slice(0, -1);
  return caseInsensitive ? value.toLowerCase() : value;
}

/** True when normalized `child` is `parent` or lies inside it. */
export function isSameOrInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

/**
 * The open task whose worktree `cwd` overlaps, when the pane's workspace is
 * neither that task's own workspace nor its orchestrator. Null otherwise.
 */
export function findForeignCheckoutOwner<T extends CheckoutOwnerTask>(
  cwd: string,
  paneWorkspaceId: string,
  tasks: Iterable<T>,
  caseInsensitive: boolean,
): T | null {
  if (!cwd) return null;
  const here = comparisonPath(cwd, caseInsensitive);
  for (const task of tasks) {
    if (task.status !== 'open' || !task.worktreePath || !task.paneGroupId) continue;
    if (!isSameOrInside(here, comparisonPath(task.worktreePath, caseInsensitive))) continue;
    if (paneWorkspaceId === task.paneGroupId) continue;
    if (paneWorkspaceId === task.owner?.verifiedWorkspaceId) continue;
    return task;
  }
  return null;
}
