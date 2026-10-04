// The Git page's one ship button: which step the current branch is at, as a
// pure state machine. Uncommitted changes → Commit; commits not on the
// upstream → Push; pushed without a PR → Create PR; a PR → Open PR. The other
// steps that are valid right now go in the button's menu; a step that cannot
// run says why.

export type ShipAction = 'commit' | 'push' | 'createPr' | 'openPr';

export interface ShipInput {
  /** Uncommitted files (staged, unstaged or untracked). */
  dirty: number;
  /** Commits ahead of / behind the upstream. */
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  detached: boolean;
  /** The branch is the repo's default branch (a PR from it makes no sense). */
  onDefaultBranch: boolean;
  /** The branch's PR, if any. */
  pr: { state: 'open' | 'draft' | 'merged' | 'closed'; url: string } | null;
  /** A merge session (isolated integration worktree) is running. */
  mergeActive: boolean;
}

/** Why a step cannot run now; the UI words each one. */
export type ShipBlock = 'merge-active' | 'detached' | 'no-upstream' | 'behind' | 'default-branch' | 'nothing-to-ship';

export interface ShipStep {
  action: ShipAction;
  /** null when it can run. */
  blocked: ShipBlock | null;
}

export interface ShipState {
  /** The button: the next step for this branch, possibly blocked. */
  primary: ShipStep;
  /** The other steps that can run now. */
  menu: ShipAction[];
}

const prIsOpen = (pr: ShipInput['pr']) => pr?.state === 'open' || pr?.state === 'draft';

/** Whether `action` can run for `s`, and if not, why. */
export function shipBlock(action: ShipAction, s: ShipInput): ShipBlock | null {
  if (s.mergeActive) return 'merge-active';
  if (action === 'openPr') return s.pr ? null : 'nothing-to-ship';
  if (s.detached) return 'detached';
  switch (action) {
    case 'commit':
      return s.dirty > 0 ? null : 'nothing-to-ship';
    case 'push':
      if (!s.hasUpstream) return 'no-upstream';
      if (s.behind > 0) return 'behind';
      return s.ahead > 0 ? null : 'nothing-to-ship';
    case 'createPr':
      if (prIsOpen(s.pr)) return 'nothing-to-ship';
      if (s.onDefaultBranch) return 'default-branch';
      if (!s.hasUpstream) return 'no-upstream';
      return null;
  }
}

/** The next step: commit, then push, then a PR, then the PR itself. */
function nextAction(s: ShipInput): ShipAction {
  if (s.dirty > 0) return 'commit';
  if (s.ahead > 0) return 'push';
  if (prIsOpen(s.pr)) return 'openPr';
  // A merged or closed PR with nothing new: show it rather than offer another.
  if (s.pr) return 'openPr';
  return 'createPr';
}

export function shipState(s: ShipInput): ShipState {
  const action = nextAction(s);
  const primary: ShipStep = { action, blocked: shipBlock(action, s) };
  const order: ShipAction[] = ['commit', 'push', 'createPr', 'openPr'];
  const menu = order.filter((a) => a !== action && shipBlock(a, s) === null);
  return { primary, menu };
}
