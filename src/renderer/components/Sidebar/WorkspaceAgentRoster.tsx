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
  const attentionLabel = roster.needsAttentionCount > 0
    ? t('workspace.agentNeedsAttention', { count: roster.needsAttentionCount })
    : undefined;
  const disclosureLabel = open
    ? t('workspace.hideAgents')
    : t('workspace.showAgents');
  const disclosureAriaLabel = [countLabel, attentionLabel, disclosureLabel]
    .filter(Boolean)
    .join(', ');

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
      <button
        type="button"
        draggable={false}
        className="flex max-w-full items-center gap-1 rounded px-0.5 py-0.5 text-[9px] font-mono text-[var(--text-muted)] transition-colors hover:text-[var(--text-sub)]"
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
        {attentionLabel && (
          <span className="flex-shrink-0 text-[var(--accent-red)]">
            · {attentionLabel}
          </span>
        )}
      </button>

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
              <button
                key={row.ptyId}
                type="button"
                draggable={false}
                className={`grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_max-content] items-start gap-x-1.5 rounded px-1 py-1 text-left transition-colors ${
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
                  className={`sidebar-dot mt-1 h-1.5 w-1.5 rounded-full ${statusIcon.glowClass}`}
                  style={{ backgroundColor: statusIcon.dotVar }}
                />
                <span className="min-w-0">
                  <span className="block truncate text-[10px] font-semibold text-[var(--text-main)]">
                    {row.agentName}
                  </span>
                  <span className="block truncate text-[8px] font-mono text-[var(--text-muted)]">
                    {location}
                  </span>
                  {detail && (
                    <span
                      className={`block truncate text-[8px] ${
                        row.pendingQuestion
                          ? 'text-[var(--accent-red)]'
                          : 'text-[var(--text-muted)]'
                      }`}
                      title={detail}
                    >
                      {row.pendingQuestion ? `? ${detail}` : detail}
                    </span>
                  )}
                </span>
                <span
                  className={`whitespace-nowrap text-right text-[8px] ${statusIcon.className}`}
                >
                  {statusLabel}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default memo(WorkspaceAgentRoster);
