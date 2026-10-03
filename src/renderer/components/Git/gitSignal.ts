// The Git rail icon's dot: some open workspace's PR wants a look — its checks
// fail or it conflicts with its base. Read from the PR status main already
// pushes into workspace metadata, so the dot costs no git or gh call.

import type { StoreState } from '../../stores';

export function selectGitRailSignal(state: Pick<StoreState, 'workspaces'>): boolean {
  return state.workspaces.some((w) => {
    const pr = w.metadata?.pr;
    return !!pr && (pr.checks === 'failing' || pr.conflicting === true);
  });
}
