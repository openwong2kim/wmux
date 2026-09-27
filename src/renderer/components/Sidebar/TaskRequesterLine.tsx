// ─── "Requested by" line on a fan-out task row ──────────────────────────────
//
// A workspace with two agent panes can fan out tasks from both; the owner
// group alone does not say which pane asked for which task. This muted second
// line on the task row says it at rest: the requesting pane (a link that
// jumps to it while it is open), its name as it was at launch plus `· closed`
// once it is gone, `Started by you`, the orchestrator, or `Requester unknown`
// — never a guess. The agent doing the task is named at the right.

import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { focusNotificationTarget } from '../../hooks/useNotificationListener';
import { requesterLine, requesterName, resolveTaskRequester } from '../../utils/fanoutProvenance';

interface TaskRequesterLineProps {
  workspaceId: string;
  /** The task workspace's agents (roster chip data): who is doing the task. */
  agents?: readonly { agentName: string }[];
}

function TaskRequesterLine({ workspaceId, agents = [] }: TaskRequesterLineProps) {
  const t = useT();
  const requester = useStore(useShallow((s) => resolveTaskRequester(s, workspaceId)));
  const line = requesterLine(requester, t);
  const assignee = [...new Set(agents.map((a) => a.agentName).filter(Boolean))].join(', ');
  const live = requester.kind === 'pane' && requester.live ? requester : undefined;

  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-sans text-[var(--text-muted)]" data-task-requester={requester.kind}>
      {live ? (
        <button
          type="button"
          draggable={false}
          // The row is a native drag source and selects its own workspace on
          // click: this control only jumps to the requesting pane.
          className={`min-w-0 truncate rounded text-left hover:text-[var(--accent-blue)] ${FOCUS_RING}`}
          title={line}
          aria-label={t('sidebar.requester.jump', { name: requesterName(live, t) ?? '' })}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            focusNotificationTarget(() => useStore.getState(), {
              surfaceId: live.surfaceId ?? null,
              workspaceId: live.workspaceId,
            });
          }}
          data-task-requester-jump
        >
          {line}
        </button>
      ) : (
        <span className="min-w-0 truncate" title={line}>{line}</span>
      )}
      {assignee && (
        <span className="ml-auto max-w-[40%] flex-none truncate" title={assignee} data-task-assignee>
          {assignee}
        </span>
      )}
    </div>
  );
}

export default memo(TaskRequesterLine);
