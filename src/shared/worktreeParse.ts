// `git worktree list --porcelain` parser + worktree GUI input validation (pure functions).
//
// Separate implementation from company/WorktreeManager's parser — that one is bound to
// paid module (company) internal types and frozen, so we do not touch it (layer + policy).
// This parser covers a wider porcelain block contract: detached / bare /
// locked (+reason) / prunable — the GUI needs these flags to show "why this worktree
// cannot be removed".
//
// porcelain contract (git-worktree(1)): one block per worktree, blank line separator.
//   worktree <path>          — always first line (absolute path)
//   HEAD <oid>               — present unless bare
//   branch refs/heads/<name> — attached only; detached uses `detached` line instead
//   bare / detached          — valueless boolean lines
//   locked [<reason>] / prunable [<reason>] — reason may or may not be present

export interface WorktreeEntry {
  /** Worktree absolute path (porcelain raw — may use slash separators). */
  readonly path: string;
  readonly headOid: string;
  /** Attached branch name (refs/heads/ stripped). null when detached·bare. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  /** Reason string when locked ('' if no reason), else null. */
  readonly locked: string | null;
  /** Reason string when prunable ('' if none), else null. */
  readonly prunable: string | null;
}

export function parseWorktreePorcelain(raw: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  for (const block of raw.split(/\r?\n\r?\n+/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    let path = '';
    let headOid = '';
    let branch: string | null = null;
    let detached = false;
    let bare = false;
    let locked: string | null = null;
    let prunable: string | null = null;
    for (const line of lines) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) headOid = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      else if (line === 'detached') detached = true;
      else if (line === 'bare') bare = true;
      else if (line === 'locked') locked = '';
      else if (line.startsWith('locked ')) locked = line.slice('locked '.length);
      else if (line === 'prunable') prunable = '';
      else if (line.startsWith('prunable ')) prunable = line.slice('prunable '.length);
    }
    if (!path) continue;
    out.push({ path, headOid, branch, detached, bare, locked, prunable });
  }
  return out;
}

/**
 * git ref (branch name) validation — block flag injection (leading '-'), traversal ('..'), controls.
 * Same rules as company WorktreeManager.validateGitRef (policy contract — rules copied only).
 * Returns trimmed value on success; throws Error on failure (not a null contract —
 * IPC handler caller downgrades fail-soft).
 */
export function validateGitRef(ref: string): string {
  const trimmed = (ref ?? '').trim();
  if (!trimmed) throw new Error('branch must not be empty');
  if (trimmed.startsWith('-')) throw new Error("branch must not start with '-'");
  if (trimmed.includes('..')) throw new Error("branch must not contain '..'");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) throw new Error('branch must not contain control characters');
  if (/[\s~^:?*[\\]/.test(trimmed)) throw new Error('branch contains invalid ref characters');
  if (trimmed.endsWith('/') || trimmed.endsWith('.lock')) throw new Error('branch has an invalid suffix');
  if (trimmed.length > 200) throw new Error('branch is too long (max 200 characters)');
  return trimmed;
}

/** Branch name → worktree directory leaf name (path-safe characters only). */
export function branchToDirName(branch: string): string {
  return branch.replace(/[/\\:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
}
