// ─── Requester line on a fan-out task row ───────────────────────────────────
//
// A workspace with two agent panes can fan out tasks from both; the owner
// group alone does not say which pane asked for which task. This muted line
// under the task row says it at rest, on its own line at the row's full width:
// `by w115-74 · Compare` — the coordinate leads, so a narrow sidebar truncates
// the name, never the part that tells two panes apart. While the pane is open
// the line is a link that jumps to it; once it is gone the launch-time name
// stays with `· closed`. `Started by you`, the orchestrator, or `Requester
// unknown` otherwise — never a guess.

import { memo } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { focusNotificationTarget } from '../../hooks/useNotificationListener';
import { requesterLine, type TaskRequester } from '../../utils/fanoutProvenance';

interface TaskRequesterLineProps {
  /** Resolved by the row (one subscription shared with its tooltip). */
  requester: TaskRequester;
}

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

function TaskRequesterLine({ requester }: TaskRequesterLineProps) {
  const t = useT();
  const line = requesterLine(requester, t);
  const live = requester.kind === 'pane' && requester.live ? requester : undefined;
  const closed = requester.kind === 'pane' && !requester.live;

  return (
    <div
      className="flex min-w-0 items-center gap-1 pl-[18px] text-[11px] font-sans text-[var(--text-muted)]"
      data-task-requester={requester.kind}
      data-task-requester-live={live ? 'true' : undefined}
    >
      {live ? (
        <button
          type="button"
          draggable={false}
          // The row is a native drag source that selects its own workspace on
          // press/click: no part of this press may reach it, or a real mouse
          // click lands on the task workspace instead of the requester. The
          // roster marker also puts it behind the row's handleDragStart guard.
          data-workspace-agent-roster
          className={`block w-full min-w-0 truncate rounded text-left hover:text-[var(--accent-blue)] ${FOCUS_RING}`}
          title={line}
          aria-label={t('sidebar.requester.jump', { name: live.label })}
          onPointerDown={stop}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onPointerUp={stop}
          onMouseUp={stop}
          onDoubleClick={stop}
          onClick={(event) => {
            event.stopPropagation();
            focusNotificationTarget(() => useStore.getState(), {
              surfaceId: live.surfaceId,
              workspaceId: live.workspaceId,
            });
          }}
          data-task-requester-jump
        >
          {line}
        </button>
      ) : closed ? (
        <>
          {/* The marker keeps its width; the name truncates first. */}
          <span className="min-w-0 truncate" title={line}>
            {t('sidebar.requester.by', { name: requester.label ?? t('sidebar.provenance.callerPane') })}
          </span>
          <span className="flex-none" aria-hidden="true">· {t('sidebar.requester.closed')}</span>
        </>
      ) : (
        <span className="min-w-0 truncate" title={line}>{line}</span>
      )}
    </div>
  );
}

export default memo(TaskRequesterLine);
