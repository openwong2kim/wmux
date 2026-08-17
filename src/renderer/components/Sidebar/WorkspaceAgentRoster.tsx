import { memo, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import {
  createWorkspaceAgentRosterSelector,
  type WorkspaceAgentRosterRow,
} from '../../stores/selectors/workspaceAgentRoster';
import { focusPaneByPtyId } from '../../hooks/useNotificationListener';
import { useT } from '../../hooks/useT';
import { IconChevron } from '../icons';
import { AGENT_STATUS_ICON } from './agentStatusIcon';
import FanOutTrigger from '../AgentToolbar/FanOutTrigger';

interface WorkspaceAgentRosterProps {
  workspaceId: string;
  isActive: boolean;
}

function locationLabel(row: WorkspaceAgentRosterRow): string {
  if (row.surfaceCount <= 1) return row.paneName;
  const position = `#${row.surfaceIndex + 1}/${row.surfaceCount}`;
  return row.surfaceTitle
    ? `${row.paneName} · ${row.surfaceTitle} · ${position}`
    : `${row.paneName} · ${position}`;
}

function WorkspaceAgentRoster({ workspaceId, isActive }: WorkspaceAgentRosterProps) {
  const t = useT();
  const selector = useMemo(
    () => createWorkspaceAgentRosterSelector(workspaceId),
    [workspaceId],
  );
  const roster = useStore(selector);
  const [open, setOpen] = useState(isActive);

  // Newly selected workspaces reveal their agents automatically; workspaces
  // that move to the background collapse back to the compact summary. The user
  // can still explicitly toggle either state until selection changes again.
  useEffect(() => {
    setOpen(isActive);
  }, [isActive]);

  if (roster.agentCount === 0) return null;

  const countLabel = t('workspace.agentCount', { count: roster.agentCount });
  const disclosureLabel = open
    ? t('workspace.hideAgents')
    : t('workspace.showAgents');
  const disclosureAriaLabel = [countLabel, disclosureLabel].join(', ');

  return (
    <div
      className="mt-1 w-full min-w-0"
      data-workspace-agent-roster
      onMouseDown={(event) => {
        // Prevent Chromium from promoting the draggable WorkspaceItem ancestor
        // to a native drag source when the gesture starts on roster controls.
        event.preventDefault();
        event.stopPropagation();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="flex max-w-full items-center gap-1">
      <button
        type="button"
        draggable={false}
        className="flex min-w-0 flex-1 items-center gap-1 rounded px-0.5 py-0.5 text-[9px] font-mono text-[var(--text-muted)] transition-colors hover:text-[var(--text-sub)]"
        aria-expanded={open}
        aria-label={disclosureAriaLabel}
        title={disclosureAriaLabel}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        onDragStart={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <span
          className="flex-shrink-0 transition-transform duration-150"
          style={{ transform: open ? 'rotate(90deg)' : undefined }}
        >
          <IconChevron size={8} />
        </span>
        <span className="truncate">{countLabel}</span>
      </button>
      {isActive && <FanOutTrigger workspaceId={workspaceId} variant="multi" compact />}
      </div>

      {open && (
        <div className="mt-0.5 ml-1 border-l border-[var(--border-soft)] pl-1.5">
          {roster.rows.map((row) => {
            const statusIcon = AGENT_STATUS_ICON[row.status];
            const statusLabel = t(statusIcon.labelKey);
            const location = locationLabel(row);
            const detail = row.pendingQuestion ?? row.activity;
            const rowAriaLabel = [row.agentName, location, statusLabel, detail]
              .filter(Boolean)
              .join(', ');
            return (
              <div key={row.ptyId} className="min-w-0">
                <button
                  type="button"
                  draggable={false}
                  className={`flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-[3px] text-left transition-colors ${
                    row.isFocused
                      ? 'bg-[var(--bg-overlay)]'
                      : 'hover:bg-[rgba(var(--bg-surface-rgb),0.65)]'
                  }`}
                  title={rowAriaLabel}
                  aria-label={rowAriaLabel}
                  onClick={(event) => {
                    event.stopPropagation();
                    focusPaneByPtyId(() => useStore.getState(), row.ptyId);
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onDragStart={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  <span
                    className={`sidebar-dot h-1.5 w-1.5 flex-none rounded-full ${statusIcon.glowClass}`}
                    style={{ backgroundColor: statusIcon.dotVar }}
                  />
                  {/* 이름·위치를 한 줄에. 이름은 고정, 위치(w85-1 등)만 말줄임. */}
                  <span className="flex min-w-0 flex-1 items-baseline gap-1">
                    <span className="flex-none text-[10px] font-semibold text-[var(--text-main)]">
                      {row.agentName}
                    </span>
                    <span className="flex-none text-[8px] text-[var(--text-muted)]">·</span>
                    <span className="min-w-0 truncate text-[8px] font-mono text-[var(--text-muted)]">
                      {location}
                    </span>
                  </span>
                  <span
                    className={`flex-none whitespace-nowrap text-[8px] ${statusIcon.className}`}
                  >
                    {statusLabel}
                  </span>
                </button>
                {/* 확인 필요일 때만 질문을 빨강 2번째 줄로 편다(실제로 봐야 하는 신호). */}
                {row.pendingQuestion && (
                  <div
                    className="truncate pl-[18px] pr-1 text-[8px] text-[var(--accent-red)]"
                    title={row.pendingQuestion}
                  >
                    ? {row.pendingQuestion}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default memo(WorkspaceAgentRoster);
