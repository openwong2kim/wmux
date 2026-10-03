// The Git rail icon's dot: some open workspace's PR wants a look — its checks
// fail or it conflicts with its base. Read from the PR status main already
// pushes into workspace metadata, so the dot costs no git or gh call. Only a
// PR still in play counts: a merged or closed PR's last (often cancelled) run
// says nothing that needs doing.

import type { StoreState } from '../../stores';

export function selectGitRailSignal(state: Pick<StoreState, 'workspaces'>): boolean {
  return state.workspaces.some((w) => {
    const pr = w.metadata?.pr;
    if (!pr || (pr.state !== 'open' && pr.state !== 'draft')) return false;
    return pr.checks === 'failing' || pr.conflicting === true;
  });
}
