// The Git page's view state, kept in the UI store so the scope, tab, issue
// filter, selected item and list scroll survive leaving the page and coming
// back. The tab, the repo choice (All repos, a picked repo, or following
// the active workspace), the All repos layout and its repo chips are also
// kept per viewer (local storage) across restarts, and so are the Worktrees
// tab's snoozed rows.
import type { IssueFilter } from '../../../shared/issueSurface';
import type { WorktreeSection, WorktreeSnooze } from './worktreeRows';

export type GitScope = 'repo' | 'all';
export type GitPageTab = 'prs' | 'issues' | 'worktrees';
/** All repos' Issues and Pull requests: one flat list across repos, or one group per repo. */
export type GitAllLayout = 'flat' | 'repo';

/** The item open in the detail pane; `repoPath` says which repo's list it is from. */
export interface GitSelection {
  kind: 'pr' | 'issue';
  repoPath: string;
  number: number;
}

export interface GitPageState {
  /** 'repo' shows one repo (the picked one, else the active workspace's); 'all' groups every repo. */
  scope: GitScope;
  /** The repo picked in the header (its group key: the remote key, or
   *  `path:<main worktree>` without one); null follows the active workspace. */
  pick: string | null;
  tab: GitPageTab;
  issueFilter: IssueFilter;
  selected: GitSelection | null;
  /** List scroll offset per list (scope + tab). */
  listScroll: Record<string, number>;
  /** All repos' layout for Issues and Pull requests. */
  allLayout: GitAllLayout;
  /** The repo chips on in the flat list (group keys); none on means every repo. */
  repoChips: string[];
  /** The flat list's who-acts-next sections the viewer opened or closed;
   *  a section absent here keeps its default (GitTurnSections). */
  turnCollapsed: Partial<Record<import('./gitTurn').GitTurn, boolean>>;
  /** The Worktrees tab's sections (and its Snoozed group) the viewer opened
   *  or closed; one choice for every repo shown. */
  wtCollapsed: Partial<Record<WorktreeSection | 'snoozed', boolean>>;
  /** Snoozed worktree rows by normalized worktree path. */
  wtSnooze: Record<string, WorktreeSnooze>;
}

/** Where a dragged issue / PR came from: the repo and a workspace in it, for
 *  "Start in a new worktree" after the drop. */
/** Where a list's rows come from: the repo, and the workspace that owns it
 *  (the fan-out's owner for "Start in a new worktree"; absent when no open
 *  workspace is in that repo). */
export interface GitDragOwner {
  repoPath: string;
  workspaceId?: string;
}

/** A hand-off drag in flight from a Git page row: its owner plus the repo the
 *  row is in. A drop is accepted only when the dropped ref names this repo. */
export interface GitDragContext extends GitDragOwner {
  owner: string;
  repo: string;
}

/** An open hand-off (the confirm popover): the item, and either the dropped
 *  pane, a dropped workspace (pick one of its agents), or neither (pick any
 *  agent: the detail header's "Send to agent…"). */
export interface GitHandoffOpen {
  item: import('../../../shared/gitHandoff').HandoffRef;
  target?: import('../../../shared/gitHandoff').HandoffTarget;
  workspaceId?: string;
  repo?: GitDragOwner;
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

/** Where the repo choice is kept: 'all', 'follow' or `repo:<group key>`. */
export const GIT_REPO_KEY = 'wmux.git.repo';

export function readGitRepoChoice(): Pick<GitPageState, 'scope' | 'pick'> {
  try {
    const v = localStorage.getItem(GIT_REPO_KEY);
    if (v === 'all') return { scope: 'all', pick: null };
    if (v?.startsWith('repo:') && v.length > 5) return { scope: 'repo', pick: v.slice(5) };
  } catch {
    /* no storage */
  }
  return { scope: 'repo', pick: null };
}

export function saveGitRepoChoice(choice: Pick<GitPageState, 'scope' | 'pick'>): void {
  try {
    localStorage.setItem(GIT_REPO_KEY, choice.scope === 'all' ? 'all' : choice.pick ? `repo:${choice.pick}` : 'follow');
  } catch {
    /* no storage: the choice lasts this session */
  }
}

/** Where the All repos layout is kept: 'flat' (the default) or 'repo'. */
export const GIT_ALL_LAYOUT_KEY = 'wmux.git.allLayout';

export function readGitAllLayout(): GitAllLayout {
  try {
    return localStorage.getItem(GIT_ALL_LAYOUT_KEY) === 'repo' ? 'repo' : 'flat';
  } catch {
    return 'flat';
  }
}

export function saveGitAllLayout(layout: GitAllLayout): void {
  try {
    localStorage.setItem(GIT_ALL_LAYOUT_KEY, layout);
  } catch {
    /* no storage: the choice lasts this session */
  }
}

/** Where the flat list's repo chips are kept: a JSON array of group keys. */
export const GIT_REPO_CHIPS_KEY = 'wmux.git.repoChips';

export function readGitRepoChips(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(GIT_REPO_CHIPS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function saveGitRepoChips(keys: string[]): void {
  try {
    localStorage.setItem(GIT_REPO_CHIPS_KEY, JSON.stringify(keys));
  } catch {
    /* no storage: the choice lasts this session */
  }
}

/** Where the Worktrees tab's snoozes are kept: a JSON object of WorktreeSnooze by worktree key. */
export const GIT_WT_SNOOZE_KEY = 'wmux.git.wtSnooze';

const isSnooze = (v: unknown): v is WorktreeSnooze => {
  const z = v as Partial<WorktreeSnooze> | null;
  return !!z && typeof z === 'object' && typeof z.sig === 'string' && typeof z.repo === 'string'
    && (z.until === null || (typeof z.until === 'number' && Number.isFinite(z.until)));
};

/** The kept snoozes, without malformed ones or ones whose time has passed. */
export function readGitWtSnoozes(now: number = Date.now()): Record<string, WorktreeSnooze> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(GIT_WT_SNOOZE_KEY) ?? '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, z]) => isSnooze(z) && (z.until === null || z.until > now)));
  } catch {
    return {};
  }
}

export function saveGitWtSnoozes(snoozes: Record<string, WorktreeSnooze>): void {
  try {
    if (Object.keys(snoozes).length === 0) localStorage.removeItem(GIT_WT_SNOOZE_KEY);
    else localStorage.setItem(GIT_WT_SNOOZE_KEY, JSON.stringify(snoozes));
  } catch {
    /* no storage: the snoozes last this session */
  }
}

export function initialGitPageState(): GitPageState {
  return {
    ...readGitRepoChoice(), tab: readGitTab(), issueFilter: { kind: 'all' }, selected: null, listScroll: {},
    allLayout: readGitAllLayout(), repoChips: readGitRepoChips(), turnCollapsed: {},
    wtCollapsed: {}, wtSnooze: readGitWtSnoozes(),
  };
}
