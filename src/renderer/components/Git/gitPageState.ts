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
  /** The branch bar is expanded (collapsed to one thin line by default). */
  barOpen: boolean;
}

/** Where a dragged issue / PR came from: the repo and a workspace in it, for
 *  "Start in a new worktree" after the drop. */
export interface GitDragContext {
  repoPath: string;
  workspaceId: string;
}

/** An open hand-off (the confirm popover): the item, and either the dropped
 *  pane, a dropped workspace (pick one of its agents), or neither (pick any
 *  agent: the detail header's "Send to agent…"). */
export interface GitHandoffOpen {
  item: import('../../../shared/gitHandoff').HandoffRef;
  target?: import('../../../shared/gitHandoff').HandoffTarget;
  workspaceId?: string;
  repo?: GitDragContext;
  /** Where to show it (the drop point); centred when absent. */
  anchor?: { x: number; y: number };
}

/** The key #1750 kept the Pull requests | Issues choice under. */
export const GIT_TAB_KEY = 'wmux.git.workView';

/** The remembered tab; reading comes first, so the first visit opens Issues. */
export function readGitTab(): GitPageTab {
  try {
    const v = localStorage.getItem(GIT_TAB_KEY);
    return v === 'prs' || v === 'worktrees' ? v : 'issues';
  } catch {
    return 'issues';
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
  return { scope: 'repo', tab: readGitTab(), issueFilter: { kind: 'all' }, selected: null, listScroll: {}, barOpen: false };
}
