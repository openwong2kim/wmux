// The Git page's view state, kept in the UI store so the scope, tab, issue
// filter, selected item and list scroll survive leaving the page and coming
// back. The tab is also kept per viewer (local storage) across restarts.
import type { IssueFilter } from '../../../shared/issueSurface';

export type GitScope = 'repo' | 'all';
export type GitPageTab = 'prs' | 'issues' | 'worktrees';

/** The item open in the detail pane; `repoPath` says which repo's list it is from. */
export interface GitSelection {
  kind: 'pr' | 'issue';
  repoPath: string;
  number: number;
}

export interface GitPageState {
  scope: GitScope;
  tab: GitPageTab;
  issueFilter: IssueFilter;
  selected: GitSelection | null;
  /** List scroll offset per list (scope + tab). */
  listScroll: Record<string, number>;
}

/** The key #1750 kept the Pull requests | Issues choice under. */
export const GIT_TAB_KEY = 'wmux.git.workView';

export function readGitTab(): GitPageTab {
  try {
    const v = localStorage.getItem(GIT_TAB_KEY);
    return v === 'issues' || v === 'worktrees' ? v : 'prs';
  } catch {
    return 'prs';
  }
}

export function saveGitTab(tab: GitPageTab): void {
  try {
    localStorage.setItem(GIT_TAB_KEY, tab);
  } catch {
    /* no storage: the choice lasts this session */
  }
}

export function initialGitPageState(): GitPageState {
  return { scope: 'repo', tab: readGitTab(), issueFilter: { kind: 'all' }, selected: null, listScroll: {} };
}
