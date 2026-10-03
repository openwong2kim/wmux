// Short-lived answers the Git page asks git for again and again: which
// worktree a cwd sits in, which repo (main worktree) a worktree belongs to,
// and the repo's remote identity. Shared by every GitTab and the All repos
// grouping, so a page with many workspaces on one repo resolves each cwd once,
// lists the repo's worktrees once, and reads its remote once. A refresh or a
// mutation passes `force`.

import { normWorktreePath } from './worktreeRows';

const TTL_MS = 30_000;

type ResolveRepo = (cwd: string) => Promise<{ ok: true; repoPath: string } | { ok: false }>;
type ListWorktrees = (repoPath: string) => Promise<
  { ok: true; mainPath: string; worktrees: { path: string }[] } | { ok: false }
>;
type RepoKey = (repoPath: string) => Promise<{ key: string | null }>;

const repoOf = new Map<string, { value: string | null; at: number }>();
const mainOf = new Map<string, { value: string | null; at: number }>();
const keyOf = new Map<string, { value: string | null; at: number }>();

function fresh<T>(m: Map<string, { value: T; at: number }>, k: string, force: boolean): { value: T } | null {
  const hit = m.get(k);
  return !force && hit && Date.now() - hit.at < TTL_MS ? hit : null;
}

/** cwd → its worktree toplevel (null when not in a repo). */
export async function resolveRepoCached(resolveRepo: ResolveRepo, cwd: string, force = false): Promise<string | null> {
  const hit = fresh(repoOf, cwd, force);
  if (hit) return hit.value;
  let value: string | null = null;
  try {
    const r = await resolveRepo(cwd);
    value = r.ok ? r.repoPath : null;
  } catch {
    value = null;
  }
  repoOf.set(cwd, { value, at: Date.now() });
  return value;
}

/**
 * A worktree toplevel → its repo's main worktree. One `worktree.list` answers
 * for every worktree it lists, so N workspaces on one repo cost one list.
 */
export async function mainPathCached(list: ListWorktrees, toplevel: string, platform?: string, force = false): Promise<string | null> {
  const k = normWorktreePath(toplevel, platform);
  const hit = fresh(mainOf, k, force);
  if (hit) return hit.value;
  let value: string | null = null;
  try {
    const r = await list(toplevel);
    if (r.ok) {
      value = r.mainPath || toplevel;
      const at = Date.now();
      for (const w of r.worktrees) mainOf.set(normWorktreePath(w.path, platform), { value, at });
    }
  } catch {
    value = null;
  }
  mainOf.set(k, { value, at: Date.now() });
  return value;
}

/** A repo path → its remote identity (host/owner/repo), null without a remote. */
export async function repoKeyCached(repoKey: RepoKey | undefined, repoPath: string, platform?: string, force = false): Promise<string | null> {
  if (!repoKey) return null;
  const k = normWorktreePath(repoPath, platform);
  const hit = fresh(keyOf, k, force);
  if (hit) return hit.value;
  let value: string | null = null;
  try {
    value = (await repoKey(repoPath)).key;
  } catch {
    value = null;
  }
  keyOf.set(k, { value, at: Date.now() });
  return value;
}

/** Test seam: forget everything. */
export function clearGitCaches(): void {
  repoOf.clear();
  mainOf.clear();
  keyOf.clear();
}
