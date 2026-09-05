// ─── Sidebar "Tasks" summary ────────────────────────────────────────────────
//
// The sidebar is NAVIGATION ONLY (DESIGN.md Layout Contract). It used to render
// the full fan-out task list — title, status dot, `#` channel link, parent
// grouping, a finished-tasks disclosure — which is the exact same list the
// deck's ledger panel renders from the ledger, in a column that is not supposed
// to hold status at all. Two lists of the same tasks, in two colour grammars,
// on opposite edges of the window.
//
// What is left here is one line: how many tasks are open, how many need you,
// and a click that takes you to the place that owns them (the deck's Agent tab,
// with the ledger panel scrolled into view). The per-task rows live in
// DeckLedgerPanel, which carries the `#` channel jump those rows had, so no
// entry point was lost.
//
// With zero tasks it renders NOTHING. A header reading "Tasks · 0 open" is a
// dead gauge (DESIGN.md: vitals render only when nonzero), and the fan-out
// entry point that justified the old always-there empty line moved to the
// agent toolbar long ago.
//
// Lifetime (owner policy): a task counts only while its fan-out workspace is
// alive. When the workspace is gone the task goes with it, and the record stays
// in the mission channel (see selectLiveMissions).

import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import type { WorkTask } from '../../../shared/workTask';
import { selectAllWorkspaceAgentStatus } from '../../stores/selectors/fleet';
import { summarizeMissions } from '../../stores/selectors/missions';
import { TASK_DOT_COLOR } from '../shared/taskStatusDot';
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
 * Take the operator to the surface that OWNS the tasks: open the deck, select
 * its Agent tab, and put the ledger panel in view. Exported so the click is
 * testable without a DOM: the two store actions are the whole navigation, and
 * the scroll is a best-effort courtesy on top (the panel is pinned chrome, so
 * on a normal-height deck it is already on screen).
 */
export function openTaskLedger(): void {
  const state = useStore.getState();
  state.setChannelDockVisible(true);
  state.setActiveDeckTab('commander');
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
  // The same per-workspace roll-up the titlebar vitals and the sidebar dots
  // read, so "N need you" here means what it means everywhere else.
  const agentStatusByWorkspace = useStore(useShallow(selectAllWorkspaceAgentStatus));
  const summary = useMemo(
    () => summarizeMissions(missions, agentStatusByWorkspace),
    [missions, agentStatusByWorkspace],
  );

  // No tasks, no header. See the file note: a zero row is a dead gauge.
  if (missions.length === 0) return null;

  return (
    <div className="mb-1 flex items-center" data-missions-section>
      <button
        type="button"
        className={`min-w-0 flex-1 flex items-center gap-1.5 px-4 pt-1 pb-1 text-[9px] font-mono font-semibold tracking-widest text-[var(--text-muted)] uppercase hover:text-[var(--text-subtle)] transition-colors ${FOCUS_RING}`}
        onClick={openTaskLedger}
        title={t('missions.summaryTooltip')}
        data-missions-summary
        data-open-count={summary.open}
        data-need-you-count={summary.needYou}
      >
        <span>{t('missions.label')}</span>
        <span aria-hidden="true">·</span>
        <span>{t('missions.openCount', { count: summary.open })}</span>
        {/* "0 need you" is the dead gauge this whole section is getting rid of —
            the clause appears only when somebody is actually waiting. */}
        {summary.needYou > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span
              className="normal-case tracking-normal font-semibold"
              style={{ color: TASK_DOT_COLOR.attention }}
              data-missions-need-you
            >
              {t('missions.needYouCount', { count: summary.needYou })}
            </span>
          </>
        )}
      </button>
      {/* C-4: the worktree cleanup scan has no entry point outside the command
          palette, and it stays on this header — the orphaned directories and
          unmaterialized tasks it finds are exactly what you have when the
          ledger shows nothing left to do. */}
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
