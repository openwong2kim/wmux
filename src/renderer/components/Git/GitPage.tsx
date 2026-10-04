// ─── Git page (rail) ─────────────────────────────────────────────────────────
//
// The rail's Git page leads with the repo: its owner/repo (a link to it on
// GitHub) and how many issues and pull requests are open, then a scope (This
// repo / All repos) and the tabs Issues, Pull requests and, set apart,
// Worktrees. Issues and Pull requests are a list/detail split: the list (~30%,
// its own scroll) selects, the detail (~70%, its own scroll) shows the item
// under a sticky header. Branches live in Worktrees: the active workspace's
// branch bar (Diff, Go to terminal, the ship button) on top, then the grouped
// worktree list with the new-branch line and the merge session.
//
// Scope, tab, issue filter, selection and list scroll live in the UI store,
// so leaving the page and coming back finds them as they were. Everything is
// pull-only and lives only while the page is shown; only the shown list of
// the active repo polls.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { FOCUS_RING } from '../focusRing';
import { IconChevron, IconRefresh } from '../icons';
import { useActiveRepo } from './useActiveRepo';
import SegmentedControl from '../ui/SegmentedControl';
import { GitTab, pathLeaf } from './GitTab';
import { PrSection } from './PrSection';
import { IssueSection, getIssueBridge } from './IssueSection';
import { GitDetail } from './GitDetail';
import { repoOwnerWorkspace, useRepoGroups } from './repoGroups';
import { GhConnectPage } from './GhConnectPage';
import { useGhAuthGate } from './ghAuthGate';
import type { GitDragOwner } from './gitPageState';
import { saveGitTab, type GitPageTab, type GitScope, type GitSelection } from './gitPageState';
import type { PrSummary } from '../../../shared/prSurface';
import type { IssueFilter, IssueSummary } from '../../../shared/issueSurface';

const TABS: GitPageTab[] = ['issues', 'prs', 'worktrees'];
/** The most a list reads (main's gh list caps); a list this long says "100+". */
const LIST_READ_CAP = 100;

/** owner/repo and its web page from a host/owner/repo key, or null. */
function repoWeb(key: string | null): { label: string; url: string } | null {
  const m = key ? /^([\w.-]+)\/([\w.-]+)\/([\w.-]+)$/.exec(key) : null;
  return m ? { label: `${m[2]}/${m[3]}`, url: `https://${m[1]}/${m[2]}/${m[3]}` } : null;
}
const itemsKey = (repoPath: string, kind: GitSelection['kind']) => `${repoPath}\0${kind}`;

export default function GitPage() {
  const t = useT();
  // Focus moves to the page title on open, so keyboard users start on this
  // page and never in the panes it covers.
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);
  const page = useStore((s) => s.gitPage);
  const setGitPage = useStore((s) => s.setGitPage);
  const [refreshKey, setRefreshKey] = useState(0);
  // The active workspace's repo, resolved whether or not Worktrees is open.
  const active = useActiveRepo(refreshKey);
  const resolved = active.repo;
  const web = repoWeb(resolved?.remoteKey ?? null);
  const repoName = resolved ? web?.label ?? pathLeaf(resolved.mainPath) : null;
  // Signed out or no gh: the page is one connect card (re-read on refresh / after a login).
  // The open PR count comes from the gate's own PR list read (one per repo and refresh).
  const [gatePrs, setGatePrs] = useState<{ repoPath: string; count?: number }>({ repoPath: '' });
  const gate = useGhAuthGate(resolved?.repoPath ?? null, refreshKey, (repoPath, res) => {
    setGatePrs({ repoPath, ...(res.ok ? { count: res.prs.length } : {}) });
  });
  const recheck = () => setRefreshKey((k) => k + 1);
  // Back from the connect card: the lists mounted while the gate was still
  // re-checking read main's stale signed-out answer, so read them once more,
  // forced, now that gh answers.
  const wasBlocked = useRef(false);
  useEffect(() => {
    if (gate === 'unauthenticated' || gate === 'cli-missing') wasBlocked.current = true;
    else if (gate === 'ok' && wasBlocked.current) {
      wasBlocked.current = false;
      setRefreshKey((k) => k + 1);
    }
  }, [gate]);
  // Who owns a hand-off from a list (the fan-out's workspace for "Start in a
  // new worktree"): in This repo the active workspace, which is in it; in All
  // repos each group's own workspace, reported by AllLists.
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const repoContext: GitDragOwner | undefined = resolved
    ? { repoPath: resolved.repoPath, ...(activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {}) }
    : undefined;
  const [groupOwners, setGroupOwners] = useState<Record<string, string | undefined>>({});
  const groupContext = (repoPath: string): GitDragOwner => {
    const workspaceId = groupOwners[repoPath];
    return { repoPath, ...(workspaceId ? { workspaceId } : {}) };
  };
  // Each list's last answer, so the detail pane can find the selected item.
  const [items, setItems] = useState<Record<string, PrSummary[] | IssueSummary[]>>({});
  // Bumped by every new list answer, so the list scroll can be restored once
  // the rows it was saved over are there.
  const [itemsVersion, setItemsVersion] = useState(0);
  const publish = useCallback((repoPath: string, kind: GitSelection['kind']) => (list: PrSummary[] | IssueSummary[]) => {
    setItems((m) => (m[itemsKey(repoPath, kind)] === list ? m : { ...m, [itemsKey(repoPath, kind)]: list }));
    setItemsVersion((v) => v + 1);
  }, []);

  // All open issues while the issue list is not shown (or is filtered): one
  // read per repo and per refresh, made when first needed and never polled
  // (main caches it and shares it with the list). The PR count needs no read
  // of its own: the gate reads that list anyway.
  const [readIssues, setReadIssues] = useState<{ repoPath: string; count?: number }>({ repoPath: '' });
  const issuesRead = useRef('');
  const issuesRefresh = useRef(refreshKey);
  const countsRepo = page.scope === 'repo' ? resolved?.repoPath ?? null : null;
  const needIssues = page.tab !== 'issues' || page.issueFilter.kind !== 'all';
  useEffect(() => {
    const issues = getIssueBridge();
    if (!countsRepo || !needIssues || !issues) return undefined;
    const readKey = `${countsRepo}\0${refreshKey}`;
    if (issuesRead.current === readKey) return undefined;
    issuesRead.current = readKey;
    const force = issuesRefresh.current !== refreshKey;
    issuesRefresh.current = refreshKey;
    // A gate or an error leaves the count out. The answer is kept even if the
    // tab changes meanwhile; it is tagged with its repo.
    void issues.issueList(countsRepo, { kind: 'all' }, force).then(
      (res) => setReadIssues({ repoPath: countsRepo, ...(res.ok ? { count: res.issues.length } : {}) }),
      () => undefined,
    );
    return undefined;
  }, [countsRepo, refreshKey, needIssues]);

  const tabIds = useRef(`git-tab-${Math.random().toString(36).slice(2)}`).current;
  const setTab = (tab: GitPageTab) => {
    setGitPage({ tab });
    saveGitTab(tab);
  };
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.indexOf(page.tab);
    let next: GitPageTab | null = null;
    if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
    else if (e.key === 'ArrowLeft') next = TABS[(i + TABS.length - 1) % TABS.length];
    else if (e.key === 'Home') next = TABS[0];
    else if (e.key === 'End') next = TABS[TABS.length - 1];
    if (!next) return;
    e.preventDefault();
    setTab(next);
    document.getElementById(`${tabIds}-${next}`)?.focus();
  };

  const kind: GitSelection['kind'] = page.tab === 'issues' ? 'issue' : 'pr';
  const select = (repoPath: string, number: number) => setGitPage({ selected: { kind, repoPath, number } });
  // In This repo, a selection from another repo (the active pane moved) is not shown.
  const sel = page.selected && page.selected.kind === kind
    && (page.scope === 'all' || page.selected.repoPath === resolved?.repoPath)
    ? page.selected
    : null;
  const detailRef = useRef<HTMLDivElement>(null);
  const selKey = sel ? `${sel.kind}\0${sel.repoPath}\0${sel.number}` : '';
  // A new selection starts at the top of its detail.
  useEffect(() => { if (detailRef.current) detailRef.current.scrollTop = 0; }, [selKey]);
  const selList = sel ? items[itemsKey(sel.repoPath, sel.kind)] : undefined;
  const selItem = sel && selList ? (selList as Array<PrSummary | IssueSummary>).find((x) => x.number === sel.number) ?? null : null;

  // Open counts: the shown list's own answer when it has one (an issue list
  // only when unfiltered), else one read of that list (all open issues).
  const countOf = (length: number | undefined, key: string) => {
    if (length === undefined) return null;
    const count = length >= LIST_READ_CAP ? `${LIST_READ_CAP}+` : length;
    return t(`${key}.${count === 1 ? 'one' : 'other'}`, { count });
  };
  const shownIssues = page.issueFilter.kind === 'all' && resolved ? items[itemsKey(resolved.repoPath, 'issue')] : undefined;
  const shownPrs = resolved ? items[itemsKey(resolved.repoPath, 'pr')] : undefined;
  const counts = page.scope === 'repo' && resolved ? [
    countOf(shownIssues?.length ?? (readIssues.repoPath === resolved.repoPath ? readIssues.count : undefined), 'git.count.issues'),
    countOf(shownPrs?.length ?? (gatePrs.repoPath === resolved.repoPath ? gatePrs.count : undefined), 'git.count.prs'),
  ].filter((c): c is string => c !== null) : [];

  return (
    <div className="wmux-git-page" data-git-page>
      <header className="wmux-git-page-header">
        <div className="min-w-0">
          <h1 ref={titleRef} tabIndex={-1} className="sr-only">{t('git.title')}</h1>
          {repoName && (
            <p className="wmux-git-page-repo" data-git-page-repo>
              {web ? (
                <a
                  href={web.url}
                  className={`wmux-git-page-repo-link ${FOCUS_RING}`}
                  title={web.url}
                  onClick={(e) => { e.preventDefault(); window.open(web.url, '_blank'); }}
                  data-git-page-repo-link
                >
                  {repoName}
                </a>
              ) : repoName}
            </p>
          )}
          {!resolved && !active.loading && <p className="wmux-git-page-summary" data-git-no-repo>{t('git.noRepo')}</p>}
          {counts.length > 0 && <p className="wmux-git-page-summary" data-git-page-counts>{counts.join(' · ')}</p>}
        </div>
        <button
          type="button"
          className={`ui-icon-btn h-7 w-7 ${FOCUS_RING}`}
          onClick={() => setRefreshKey((k) => k + 1)}
          title={t('git.refresh')}
          aria-label={t('git.refresh')}
          data-git-refresh
        ><IconRefresh size={15} /></button>
      </header>

      {(gate === 'unauthenticated' || gate === 'cli-missing') ? (
        // Not connected (or gh missing): the whole page is the connect card.
        <GhConnectPage gate={gate} onRecheck={recheck} onConnected={recheck} />
      ) : (<>
      <div className="wmux-git-toolbar">
        <div role="tablist" aria-label={t('git.tab.label')} className="wmux-git-tabs">
          {TABS.map((tab) => (
            <button
              key={tab}
              id={`${tabIds}-${tab}`}
              type="button"
              role="tab"
              aria-selected={page.tab === tab}
              aria-controls={`${tabIds}-panel`}
              tabIndex={page.tab === tab ? 0 : -1}
              className={`wmux-git-tab ${tab === 'worktrees' ? 'wmux-git-tab-aside ' : ''}${FOCUS_RING}`}
              onClick={() => setTab(tab)}
              onKeyDown={onTabKey}
              data-git-page-tab={tab}
            >
              {tab === 'prs' ? t('git.pullRequests') : tab === 'issues' ? t('git.issues') : t('git.worktrees')}
            </button>
          ))}
        </div>
        <SegmentedControl<GitScope>
          value={page.scope}
          onValueChange={(scope) => setGitPage({ scope })}
          ariaLabel={t('git.scope.label')}
          data-testid="git-scope"
          options={[
            { value: 'repo', label: t('git.scope.thisRepo') },
            { value: 'all', label: t('git.scope.allRepos') },
          ]}
        />
      </div>

      <div id={`${tabIds}-panel`} role="tabpanel" aria-labelledby={`${tabIds}-${page.tab}`} className="wmux-git-panel">
        {page.tab === 'worktrees' ? (
          <div className="wmux-git-scroll" data-git-worktrees-tab>
            {/* The active workspace's branch: Diff, Go to terminal, the ship button. */}
            <GitTab layout="summary" refreshKey={refreshKey} />
            {page.scope === 'repo'
              ? <GitTab layout="worktrees" refreshKey={refreshKey} />
              : <AllWorktrees refreshKey={refreshKey} />}
          </div>
        ) : (
          <div className="wmux-git-split" data-git-split>
            <ListPane scrollKey={`${page.scope}:${page.tab}`} ready={itemsVersion}>
              {page.scope === 'repo' ? (
                resolved && (
                  <RepoList
                    tab={page.tab}
                    repoPath={resolved.repoPath}
                    refreshKey={refreshKey}
                    active
                    filter={page.issueFilter}
                    onFilter={(issueFilter) => setGitPage({ issueFilter })}
                    selected={sel && sel.repoPath === resolved.repoPath ? sel.number : null}
                    onSelect={(n) => select(resolved.repoPath, n)}
                    onItems={publish(resolved.repoPath, kind)}
                    dragContext={repoContext}
                  />
                )
              ) : (
                <AllLists
                  tab={page.tab}
                  refreshKey={refreshKey}
                  filter={page.issueFilter}
                  onFilter={(issueFilter) => setGitPage({ issueFilter })}
                  sel={sel}
                  onSelect={select}
                  publish={(repoPath) => publish(repoPath, kind)}
                  onOwners={setGroupOwners}
                />
              )}
            </ListPane>
            <div ref={detailRef} className="wmux-git-detailpane" data-git-detailpane>
              {sel && selItem ? (
                <GitDetail
                  kind={kind}
                  refreshKey={refreshKey}
                  repoPath={sel.repoPath}
                  repoLabel={page.scope === 'repo' ? repoName ?? '' : repoLabelOf(sel.repoPath)}
                  pr={kind === 'pr' ? (selItem as PrSummary) : null}
                  issue={kind === 'issue' ? (selItem as IssueSummary) : null}
                  repo={page.scope === 'repo' ? repoContext : groupContext(sel.repoPath)}
                />
              ) : (
                <GitDetail kind={kind} repoPath="" repoLabel="" />
              )}
            </div>
          </div>
        )}
      </div>
      </>)}
    </div>
  );
}

/** The folder name of a repo path, for the detail header in All repos. */
function repoLabelOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** The list column: its own scroll, kept in the store per scope + tab. */
function ListPane({ scrollKey, ready, children }: { scrollKey: string; ready: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const saved = useStore((s) => s.gitPage.listScroll[scrollKey] ?? 0);
  const setGitPage = useStore((s) => s.setGitPage);
  const restored = useRef<string | null>(null);
  // Restore once the rows are there (the lists load after the pane mounts).
  useEffect(() => {
    const el = ref.current;
    if (!el || restored.current === scrollKey) return;
    if (saved > 0 && el.scrollHeight <= el.clientHeight) return;
    el.scrollTop = saved;
    restored.current = scrollKey;
  }, [scrollKey, ready, saved]);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  return (
    <div
      ref={ref}
      className="wmux-git-listpane"
      data-git-listpane
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          const cur = useStore.getState().gitPage.listScroll;
          setGitPage({ listScroll: { ...cur, [scrollKey]: top } });
        }, 150);
      }}
    >
      {children}
    </div>
  );
}

function RepoList({ tab, repoPath, refreshKey, active, filter, onFilter, selected, onSelect, onItems, dragContext }: {
  tab: GitPageTab;
  repoPath: string;
  refreshKey: number;
  /** The active repo's list polls; another repo's reads when first shown. */
  active: boolean;
  filter: IssueFilter;
  onFilter: (f: IssueFilter) => void;
  selected: number | null;
  onSelect: (n: number) => void;
  onItems: (list: PrSummary[] | IssueSummary[]) => void;
  dragContext?: GitDragOwner;
}) {
  return tab === 'issues' ? (
    <IssueSection
      repoPath={repoPath}
      filter={filter}
      onFilter={onFilter}
      refreshKey={refreshKey}
      poll={active}
      lazy={!active}
      selected={selected}
      onSelect={(i) => onSelect(i.number)}
      onItems={onItems}
      dragContext={dragContext}
    />
  ) : (
    <PrSection
      repoPath={repoPath}
      refreshKey={refreshKey}
      poll={active}
      lazy={!active}
      selected={selected}
      onSelect={(p) => onSelect(p.number)}
      onItems={onItems}
      dragContext={dragContext}
    />
  );
}

/** All repos: one collapsible list per repo, the active repo first and open. */
function AllLists({ tab, refreshKey, filter, onFilter, sel, onSelect, publish, onOwners }: {
  tab: GitPageTab;
  refreshKey: number;
  filter: IssueFilter;
  onFilter: (f: IssueFilter) => void;
  sel: GitSelection | null;
  onSelect: (repoPath: string, n: number) => void;
  publish: (repoPath: string) => (list: PrSummary[] | IssueSummary[]) => void;
  /** Each group's owning workspace by its list path, for the detail header. */
  onOwners?: (owners: Record<string, string | undefined>) => void;
}) {
  const t = useT();
  const groups = useRepoGroups(refreshKey);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const owners = useMemo(
    () => Object.fromEntries((groups ?? []).map((g) => [g.prPath, repoOwnerWorkspace(g, activeWorkspaceId)])),
    [groups, activeWorkspaceId],
  );
  useEffect(() => { onOwners?.(owners); }, [owners, onOwners]);
  if (groups === null) return <div className="wmux-git-note">{t('git.loading')}</div>;
  if (groups.length === 0) return <div className="wmux-git-note" data-git-all-empty>{t('git.allRepos.empty')}</div>;
  return (
    <div data-git-all-repos>
      {groups.map((g) => {
        // Open by default: the active repo, and the one holding the selection.
        const isOpen = open[g.key] ?? (g.active || sel?.repoPath === g.prPath);
        return (
          <section key={g.key} className="wmux-git-group" data-git-repo-group={g.name} aria-label={g.name}>
            <button
              type="button"
              className={`wmux-git-group-head ${FOCUS_RING}`}
              aria-expanded={isOpen}
              onClick={() => setOpen((m) => ({ ...m, [g.key]: !isOpen }))}
            >
              <span className="wmux-git-chevron" data-open={isOpen ? 'true' : undefined} aria-hidden="true"><IconChevron size={12} /></span>
              <span className="wmux-git-group-name">{g.name}</span>
              <span className="wmux-git-group-meta">{t('git.allRepos.workspaces', { count: g.workspaceCount })}</span>
            </button>
            {isOpen && (
              <RepoList
                tab={tab}
                repoPath={g.prPath}
                refreshKey={refreshKey}
                active={g.active}
                filter={filter}
                onFilter={onFilter}
                selected={sel && sel.repoPath === g.prPath ? sel.number : null}
                onSelect={(n) => onSelect(g.prPath, n)}
                onItems={publish(g.prPath)}
                dragContext={{ repoPath: g.prPath, ...(owners[g.prPath] ? { workspaceId: owners[g.prPath] } : {}) }}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}

/** All repos on the Worktrees tab: each repo's checkouts, grouped. */
function AllWorktrees({ refreshKey }: { refreshKey: number }) {
  const t = useT();
  const groups = useRepoGroups(refreshKey);
  if (groups === null) return <div className="wmux-git-note">{t('git.loading')}</div>;
  if (groups.length === 0) return <div className="wmux-git-note" data-git-all-empty>{t('git.allRepos.empty')}</div>;
  return (
    <div className="wmux-git-groups" data-git-all-repos>
      {groups.map((g) => (
        <section key={g.key} className="wmux-git-group" data-git-repo-group={g.name} aria-label={g.name}>
          <h2 className="wmux-git-group-title">
            {g.name}
            <span className="wmux-git-group-meta">{t('git.allRepos.workspaces', { count: g.workspaceCount })}</span>
          </h2>
          {g.checkouts.map((c) => (
            <div key={c.mainPath} className="wmux-git-checkout" data-git-checkout={c.label}>
              {g.checkouts.length > 1 && <h3 className="wmux-git-checkout-title" title={c.mainPath}>{c.label}</h3>}
              {/* cwd pins the checkout; the active pane's worktree comes
                  apart, so switching panes inside the repo reloads nothing. */}
              <GitTab
                layout="worktrees"
                cwd={c.mainPath}
                currentPath={c.currentPath}
                markCurrent={!!c.currentPath}
                workspacesOnRepo={c.workspaces}
                refreshKey={refreshKey}
              />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
