// ─── Git page (rail) ─────────────────────────────────────────────────────────
//
// The rail's Git page: the active workspace's current-branch card on top,
// then a scope filter — This repo (the active pane's repo) or All repos (every
// open workspace, grouped by repo) — then each repo's Pull requests and
// Worktrees. Everything is pull-only and lives only while the page is shown:
// leaving the page unmounts it, and the PR list polls only while it is open
// on this page.

import { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconRefresh } from '../icons';
import SegmentedControl from '../ui/SegmentedControl';
import { GitTab } from './GitTab';
import { PrSection } from './PrSection';
import { useRepoGroups } from './repoGroups';

type Scope = 'repo' | 'all';

export default function GitPage() {
  const t = useT();
  // Focus moves to the page title on open, so keyboard users start on this
  // page and never in the panes it covers.
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);
  const [scope, setScope] = useState<Scope>('repo');
  const [refreshKey, setRefreshKey] = useState(0);
  const [repo, setRepo] = useState<string | null>(null);

  const filter = (
    <div className="wmux-git-scope">
      <SegmentedControl<Scope>
        value={scope}
        onValueChange={setScope}
        ariaLabel={t('git.scope.label')}
        data-testid="git-scope"
        options={[
          { value: 'repo', label: t('git.scope.thisRepo') },
          { value: 'all', label: t('git.scope.allRepos') },
        ]}
      />
    </div>
  );

  return (
    <div className="wmux-git-page" data-git-page>
      <header className="wmux-git-page-header">
        <div className="min-w-0">
          <h1 ref={titleRef} tabIndex={-1} className="wmux-git-page-title">{t('git.title')}</h1>
          {repo && <p className="wmux-git-page-summary" data-git-page-repo>{repo}</p>}
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
      {scope === 'repo' ? (
        <GitTab refreshKey={refreshKey} onRepo={setRepo} slot={filter} />
      ) : (
        <>
          <GitTab layout="card" refreshKey={refreshKey} onRepo={setRepo} slot={filter} />
          <AllRepos refreshKey={refreshKey} />
        </>
      )}
    </div>
  );
}

function AllRepos({ refreshKey }: { refreshKey: number }) {
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
          <div className="wmux-git-sections">
            {/* One PR list per repo, however many clones. Only the active
                repo's opens and polls; another repo's reads once when opened. */}
            <section className="wmux-git-col" aria-label={t('git.pullRequests')}>
              <PrSection repoPath={g.prPath} refreshKey={refreshKey} defaultOpen={g.active} poll={g.active} lazy={!g.active} />
            </section>
            <section className="wmux-git-col" aria-label={t('git.worktrees')}>
              {g.checkouts.map((c) => (
                <div key={c.mainPath} className="wmux-git-checkout" data-git-checkout={c.label}>
                  {g.checkouts.length > 1 && (
                    <h3 className="wmux-git-checkout-title" title={c.mainPath}>{c.label}</h3>
                  )}
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
          </div>
        </section>
      ))}
    </div>
  );
}
