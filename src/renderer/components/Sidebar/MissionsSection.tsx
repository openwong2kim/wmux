// ─── Sidebar "Missions" section (NB2 wave 2 cycle C) ───────────────────────────
//
// Promotes fan-out (J1) missions (WorkTask) to a separate group at the top of the
// workspace list. Each mission = one prompt expanded into an isolated task; `paneGroupId`
// is the dedicated child workspace id for that task. Rows show title, status (open/closed),
// and a link to the mission channel.
//
// Coexistence with worktree badge (⊕, WorkspaceItem): the badge is the low-level fact
// "this workspace is a git worktree"; this section adds the higher-level concept "this
// workspace is a fan-out task" (worktree ⊂ task does not hold — broadcast mode has no
// isolation). They are independent axes, so the same child workspace may appear both in
// the sidebar list (with badge) and in this section (mission row) — intentional dual
// representation.
//
// Empty state: when there are no missions (most normal workspaces), this component returns
// null and **occupies no space at all** (does not even render a header).

import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import type { WorkTask } from '../../../shared/workTask';

/**
 * Flatten and sort all parent caches into one mission list (pure function — testable).
 * Open first, then newest (createdAt desc) within each status. Tasks belong to only one
 * parent, so there are no duplicates.
 */
export function flattenMissions(byWorkspace: Record<string, WorkTask[]>): WorkTask[] {
  const all: WorkTask[] = [];
  for (const tasks of Object.values(byWorkspace)) all.push(...tasks);
  return all.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
}

function useFlatMissions(): WorkTask[] {
  const byWorkspace = useStore(useShallow((s) => s.missionsByWorkspace));
  return useMemo(() => flattenMissions(byWorkspace), [byWorkspace]);
}

function MissionRow({ task }: { task: WorkTask }): React.ReactElement {
  // Whether the child workspace exists (row click jump only when it does).
  const childExists = useStore((s) =>
    task.paneGroupId ? s.workspaces.some((w) => w.id === task.paneGroupId) : false,
  );
  const isOpen = task.status === 'open';
  const statusColor = isOpen ? 'var(--accent-green)' : 'var(--text-muted)';

  const jumpToChild = (): void => {
    if (task.paneGroupId && childExists) {
      useStore.getState().setActiveWorkspace(task.paneGroupId);
    }
  };
  const openMissionChannel = (): void => {
    // Reuse existing channel-open path (setActiveChannel opens dock and selects channel) —
    // no new routing.
    useStore.getState().setActiveChannel(task.missionChannelId);
  };

  return (
    <div
      className={`group flex items-center gap-2 mx-2 px-3 py-1 rounded-md select-none ${
        task.paneGroupId && childExists
          ? 'cursor-pointer hover:bg-[rgba(var(--bg-surface-rgb),0.5)]'
          : ''
      }`}
      onClick={jumpToChild}
      data-mission-row
      data-task-id={task.id}
      data-task-status={task.status}
    >
      {/* status dot: open=green, closed=muted */}
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ backgroundColor: statusColor }}
        title={isOpen ? 'open' : 'closed'}
      />
      <span
        className={`flex-1 min-w-0 truncate text-caption font-mono ${
          isOpen ? 'text-[var(--text-sub)]' : 'text-[var(--text-muted)] line-through'
        }`}
        title={task.title}
      >
        {task.title}
      </span>
      {/* Mission channel link — opens that channel in existing ChannelDock. */}
      <button
        type="button"
        className="flex-shrink-0 text-[10px] font-mono text-[var(--text-subtle)] hover:text-[var(--accent-blue)] transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          openMissionChannel();
        }}
        title={`Open mission channel`}
        aria-label={`Open mission channel for ${task.title}`}
        data-mission-channel-link
      >
        #
      </button>
    </div>
  );
}

function MissionsSection(): React.ReactElement | null {
  const missions = useFlatMissions();
  // Empty state: render nothing when there are no missions (zero space).
  if (missions.length === 0) return null;

  return (
    <div className="mb-1" data-missions-section>
      <div className="px-4 pt-1 pb-1 text-[9px] font-mono font-semibold tracking-widest text-[var(--text-muted)] uppercase">
        Missions
      </div>
      <div className="space-y-0.5">
        {missions.map((task) => (
          <MissionRow key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
}

export default memo(MissionsSection);
