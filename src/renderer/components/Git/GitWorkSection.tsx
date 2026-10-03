// The Git page's left column: one disclosure over a Pull requests | Issues
// switch. Only the chosen list is mounted, so only it reads and polls; the
// choice is remembered per viewer (this browser's storage).
import { useId, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconChevron } from '../icons';
import { PrSection } from './PrSection';
import { IssueSection } from './IssueSection';

export type WorkView = 'prs' | 'issues';
export const WORK_VIEW_KEY = 'wmux.git.workView';

export function readWorkView(): WorkView {
  try {
    return localStorage.getItem(WORK_VIEW_KEY) === 'issues' ? 'issues' : 'prs';
  } catch {
    return 'prs';
  }
}

function saveWorkView(view: WorkView): void {
  try {
    localStorage.setItem(WORK_VIEW_KEY, view);
  } catch {
    /* no storage (private mode, tests): the choice lasts this session */
  }
}

const countText = (n: number | null) => (n === null ? '' : n >= 100 ? '100+' : String(n));

export function GitWorkSection({ repoPath, refreshKey = 0, defaultOpen = false, poll = true, lazy = false }: {
  repoPath: string | null;
  refreshKey?: number;
  defaultOpen?: boolean;
  /** Whether the open list polls (only the active repo's does). */
  poll?: boolean;
  /** Read nothing until first opened (another repo's list). */
  lazy?: boolean;
}): React.ReactElement | null {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const [view, setView] = useState<WorkView>(readWorkView);
  const [count, setCount] = useState<number | null>(null);
  const id = useId();
  if (!repoPath) return null;

  const choose = (next: WorkView) => {
    if (next !== view) {
      setCount(null);
      setView(next);
      saveWorkView(next);
    }
    setOpen(true);
  };
  const tabs: Array<{ value: WorkView; label: string }> = [
    { value: 'prs', label: t('git.pullRequests') },
    { value: 'issues', label: t('git.issues') },
  ];
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const next: WorkView = e.key === 'Home' ? 'prs' : e.key === 'End' ? 'issues' : view === 'prs' ? 'issues' : 'prs';
    choose(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };

  return (
    <div className="wmux-git-work wmux-git-prs" data-open={open ? 'true' : undefined} data-git-work={view}>
      <div className="wmux-git-work-head">
        <button
          type="button"
          className={`wmux-git-work-toggle ${FOCUS_RING}`}
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          aria-label={open ? t('git.work.hide') : t('git.work.show')}
          title={open ? t('git.work.hide') : t('git.work.show')}
          onClick={() => setOpen((v) => !v)}
          data-pr-toggle
        >
          <span className="wmux-git-chevron" aria-hidden="true"><IconChevron size={12} /></span>
        </button>
        <div role="tablist" aria-label={t('git.work.label')} className="wmux-git-work-tabs">
          {tabs.map((tab) => {
            const selected = tab.value === view;
            return (
              <button
                key={tab.value}
                id={`${id}-tab-${tab.value}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${id}-panel`}
                tabIndex={selected ? 0 : -1}
                className={`wmux-git-work-tab ${FOCUS_RING}`}
                onClick={() => (selected ? setOpen((v) => !v) : choose(tab.value))}
                onKeyDown={onTabKey}
                data-git-work-tab={tab.value}
              >
                {tab.label}
                {selected && count !== null && <span className="wmux-git-count"> · {countText(count)}</span>}
              </button>
            );
          })}
        </div>
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${view}`} hidden={!open}>
        {view === 'prs' ? (
          <PrSection key="prs" repoPath={repoPath} refreshKey={refreshKey} poll={poll} lazy={lazy} open={open} onCount={setCount} />
        ) : (
          <IssueSection key="issues" repoPath={repoPath} refreshKey={refreshKey} poll={poll} lazy={lazy} open={open} onCount={setCount} />
        )}
      </div>
    </div>
  );
}
