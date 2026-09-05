// ─── Sidebar "Tasks" summary ────────────────────────────────────────────────
//
// The sidebar is NAVIGATION ONLY (DESIGN.md Layout Contract). It used to render
// the full fan-out task list — title, status dot, `#` channel link, parent
// grouping, a finished-tasks disclosure — which is the exact same list the
// deck's ledger panel renders from the ledger, in a column that is not supposed
// to hold status at all. Two lists of the same tasks, in two colour grammars,
// on opposite edges of the window.
//
// What is left here is one line — how many tasks are open — and a click that
// takes you to the place that owns them: the workspace whose ledger holds
// them, the deck, its Agent tab. The per-task rows live in DeckLedgerPanel,
// which carries the `#` channel jump and the workspace jump those rows had, so
// no entry point was lost.
//
// It does NOT state "N need you". That fact already has its two permitted
// renditions (the titlebar vitals chip and the deck's red dots, DESIGN.md
// attention grammar), and a third one here would have had to be rolled up from
// the pane mirror while the deck rolls its dots up from the ledger — two
// derivations of one fact, free to disagree.
//
// With zero tasks it renders NOTHING (a "Tasks · 0 open" row is a dead gauge).
// When only finished tasks are left it says so, and the click opens the deck's
// finished disclosure — that is the only way back to a closed task's mission
// channel now.
//
// Lifetime (owner policy): a task counts only while its fan-out workspace is
// alive. When the workspace is gone the task goes with it, and the record stays
// in the mission channel (see selectLiveMissions).

import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import type { WorkTask } from '../../../shared/workTask';
import { ownerForTaskLedger, summarizeMissions } from '../../stores/selectors/missions';
import { FOCUS_RING } from '../focusRing';

/**
 * 모든 부모 캐시를 평탄화·정렬한 미션 목록(순수 함수 — 테스트 가능). open을 먼저,
 * 그 안에서 최신(createdAt desc) 순으로 정렬한다. 태스크는 부모 하나에만 속하므로
 * 중복은 없다.
 */
export function flattenMissions(byWorkspace: Record<string, WorkTask[]>): WorkTask[] {
  const all: WorkTask[] = [];
  for (const tasks of Object.values(byWorkspace)) all.push(...tasks);
  return all.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
}

/**
 * Mission = workspace lifetime (owner policy). Visibility is decided on
 * **workspace existence alone** — derived/inferred signals (agent status, delivery
 * status, and the like) have reported false several times in this repo, so they are
 * not used here. `liveWorkspaceIds` is the workspace list restored from the session,
 * verbatim.
 *
 *   - paneGroupId materialized + workspace absent → **excluded** (the record stays in the channel).
 *   - paneGroupId materialized + workspace present → shown.
 *   - paneGroupId not materialized (fan-out in flight) → **shown**. There is no
 *     workspace yet; that is not the same as one having disappeared — hiding a
 *     mission that is still running is far worse.
 */
export function selectLiveMissions(
  byWorkspace: Record<string, WorkTask[]>,
  liveWorkspaceIds: ReadonlySet<string>,
): WorkTask[] {
  return flattenMissions(byWorkspace).filter(
    (task) => !task.paneGroupId || liveWorkspaceIds.has(task.paneGroupId),
  );
}

function useLiveMissions(): WorkTask[] {
  const byWorkspace = useStore(useShallow((s) => s.missionsByWorkspace));
  // Subscribe to the id array with a shallow compare (renames and metadata changes do
  // not recompute). Do NOT use a joined string key — with zero workspaces
  // `''.split(',')` yields `['']`, which makes the empty-string id count as "alive",
  // and any id containing a comma would be split apart.
  const workspaceIds = useStore(useShallow((s) => s.workspaces.map((w) => w.id)));
  return useMemo(
    () => selectLiveMissions(byWorkspace, new Set(workspaceIds)),
    [byWorkspace, workspaceIds],
  );
}

/**
 * Take the operator to the surface that OWNS the tasks: the workspace whose
 * ledger holds them, the deck, its Agent tab, and — for a finished-only
 * summary — the finished disclosure the closed tasks live in.
 *
 * The workspace hop is the point. The summary counts every workspace's tasks
 * while the deck panel reads one workspace's ledger, so without it "Tasks · 3
 * open" could open an empty panel. Exported for the test: the store calls ARE
 * the navigation, and the scroll is a best-effort courtesy on top.
 */
export function openTaskLedger(wanted: WorkTask['status'] = 'open'): void {
  const state = useStore.getState();
  const liveIds = new Set(state.workspaces.map((w) => w.id));
  const owner = ownerForTaskLedger(
    state.missionsByWorkspace,
    state.activeWorkspaceId,
    wanted,
    (task) => !task.paneGroupId || liveIds.has(task.paneGroupId),
  );
  if (owner) state.setActiveWorkspace(owner);
  state.setChannelDockVisible(true);
  state.setActiveDeckTab('commander');
  // A finished-only line has nothing to show in the open list — it is pointing
  // at the disclosure, so it opens it.
  state.setDeckLedgerFinishedExpanded(wanted === 'closed');
  if (typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => {
    document
      .querySelector('[data-deck-ledger-panel]')
      ?.scrollIntoView({ block: 'nearest' });
  });
}

function MissionsSection(): React.ReactElement | null {
  const t = useT();
  const missions = useLiveMissions();
  const summary = useMemo(() => summarizeMissions(missions), [missions]);

  // No tasks at all, no line. See the file note: a zero row is a dead gauge,
  // and with the line gone the command palette is the way to the cleanup scan.
  if (summary.open === 0 && summary.finished === 0) return null;
  // Open work is what the line is for; a finished-only line still says so,
  // because the closed tasks' mission channels are reachable from the deck's
  // finished disclosure and nowhere else.
  const wanted: WorkTask['status'] = summary.open > 0 ? 'open' : 'closed';

  return (
    <div className="mb-1 flex items-center" data-missions-section>
      <button
        type="button"
        className={`min-w-0 flex-1 flex items-center gap-1.5 px-4 pt-1 pb-1 text-[9px] font-mono font-semibold tracking-widest text-[var(--text-muted)] uppercase hover:text-[var(--text-subtle)] transition-colors ${FOCUS_RING}`}
        onClick={() => openTaskLedger(wanted)}
        title={t('missions.summaryTooltip')}
        data-missions-summary
        data-open-count={summary.open}
        data-finished-count={summary.finished}
      >
        <span>{t('missions.label')}</span>
        <span aria-hidden="true">·</span>
        <span>{t('missions.openCount', { count: summary.open })}</span>
        {/* Only when the open list is empty: otherwise the line would carry a
            count nobody is going to act on next. */}
        {summary.open === 0 && summary.finished > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span data-missions-finished>
              {t('missions.finishedCount', { count: summary.finished })}
            </span>
          </>
        )}
      </button>
      {/* C-4: the worktree cleanup scan rides this line — the orphaned
          directories and unmaterialized tasks it finds are exactly what you
          have when the ledger shows nothing left to do. With no tasks at all
          the line is gone and the command palette is the way in. */}
      <button
        type="button"
        className={`shrink-0 pr-4 pl-1 pt-1 pb-1 text-[9px] font-mono uppercase tracking-widest text-[var(--text-subtle)] hover:text-[var(--accent-blue)] transition-colors ${FOCUS_RING}`}
        onClick={() => useStore.getState().setWorktaskCleanupVisible(true)}
        aria-label={t('missions.cleanUpTooltip')}
        data-missions-cleanup
      >
        {t('missions.cleanUp')}
      </button>
    </div>
  );
}

export default memo(MissionsSection);
