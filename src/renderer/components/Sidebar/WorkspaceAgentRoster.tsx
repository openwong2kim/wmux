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

/**
 * What the row leads with. The surface title is the one thing that differs
 * between rows in the common case — a workspace running several sessions of
 * the SAME vendor renders "Claude Code · w2-127", "Claude Code · w2-131", …,
 * where every readable word is identical and only an opaque coordinate varies.
 * The title ("Zwroty", "Scalar SINOTKEN") is what the user actually calls that
 * pane, so it leads; the vendor name moves to the muted line, which is where
 * it still answers "which agent is this" for mixed-vendor workspaces.
 *
 * Previously the title was rendered ONLY when a leaf had 2+ surfaces, so the
 * single-surface panes that make up most workspaces never showed it at all.
 */
export function rosterPrimaryLabel(row: WorkspaceAgentRosterRow): string {
  // Truthiness, not `??`: the row type allows an empty title, and `??` would
  // let `''` win the lead. The trailer already tests truthiness, so `??` here
  // meant an empty title erased BOTH labels — no name led the row and the
  // vendor was withheld from the trailer as "already shown".
  return row.surfaceTitle ? row.surfaceTitle : row.agentName;
}

/**
 * The muted trailer: vendor, pane coordinate, and the tab position when the
 * leaf holds more than one surface.
 *
 * The vendor is dropped in two cases, both because it carries no information
 * there: when the title did not take the lead (it would be printed twice), and
 * when every row in this workspace runs the SAME vendor — the common case for
 * me and, from the issue tracker, for most people running one CLI. In a 240px
 * sidebar "Claude Code" costs roughly a third of the row so that every line can
 * repeat what the line above it already said, while the title it pushes out is
 * the only thing that tells the rows apart. It comes back the moment a
 * workspace mixes vendors, which is when it starts answering a real question.
 */
export function rosterSecondaryLabel(
  row: WorkspaceAgentRosterRow,
  opts: { showVendor?: boolean } = {},
): string {
  const showVendor = opts.showVendor ?? true;
  const parts: string[] = [];
  if (showVendor && row.surfaceTitle) parts.push(row.agentName);
  parts.push(row.paneName);
  if (row.surfaceCount > 1) parts.push(`#${row.surfaceIndex + 1}/${row.surfaceCount}`);
  return parts.join(' · ');
}

/**
 * True when the roster holds more than one distinct vendor, i.e. when naming
 * the vendor per row actually distinguishes anything.
 */
export function rosterHasMixedVendors(rows: readonly WorkspaceAgentRosterRow[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.agentName);
    if (seen.size > 1) return true;
  }
  return false;
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

  // Computed once per render, not per row: the vendor column earns its width
  // only when the workspace actually mixes vendors.
  const mixedVendors = rosterHasMixedVendors(roster.rows);

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
      </div>

      {open && (
        <div className="mt-0.5 ml-1 border-l border-[var(--border-soft)] pl-1.5">
          {roster.rows.map((row) => {
            const statusIcon = AGENT_STATUS_ICON[row.status];
            const statusLabel = t(statusIcon.labelKey);
            const primary = rosterPrimaryLabel(row);
            const secondary = rosterSecondaryLabel(row, { showVendor: mixedVendors });
            const detail = row.pendingQuestion ?? row.activity;
            const rowAriaLabel = [primary, secondary, statusLabel, detail]
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
                  {/* Name and location on one line. The title truncates first;
                      the coordinate (w85-1 etc.) takes at most 40% before it
                      ellipses too. */}
                  <span className="flex min-w-0 flex-1 items-baseline gap-1">
                    <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-[var(--text-main)]">
                      {primary}
                    </span>
                    <span className="flex-none text-[8px] text-[var(--text-muted)]">·</span>
                    <span className="max-w-[40%] flex-none truncate text-[8px] font-mono text-[var(--text-muted)]">
                      {secondary}
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
