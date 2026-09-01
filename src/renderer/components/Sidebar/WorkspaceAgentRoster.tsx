import { memo, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import {
  createWorkspaceAgentRosterSelector,
  type WorkspaceAgentRosterRow,
} from '../../stores/selectors/workspaceAgentRoster';
import { focusNotificationTarget, focusPaneByPtyId } from '../../hooks/useNotificationListener';
import { useT } from '../../hooks/useT';
import { IconEye, IconEyeOff, IconChevron } from '../icons';
import { FOCUS_RING } from '../focusRing';
import { timeAgo } from '../../utils/timeAgo';
import { AGENT_STATUS_ICON } from './agentStatusIcon';

/** How long the just-stashed row stays highlighted. Long enough to catch the
 *  eye after the pane vanishes from the layout, short enough not to linger. */
const STASH_PULSE_MS = 1500;

interface WorkspaceAgentRosterProps {
  workspaceId: string;
  /** Owned by WorkspaceItem, which also renders the summary control (#997). */
  open: boolean;
  /** The stash pulse forces the list open even when the user collapsed it. */
  onRequestOpen: () => void;
}

interface WorkspaceRosterSummaryProps {
  workspaceId: string;
  open: boolean;
  onToggle: () => void;
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

/**
 * #997 — the roster summary, rendered INSIDE the workspace row.
 *
 * It used to be a row of its own directly under the workspace: a chevron and
 * "Agents 3", costing one line per workspace that has any agents at all. That
 * line named nothing, and in the expanded state its count restated what the
 * rows immediately below it already showed — it was redundant exactly when it
 * was most expensive. With eleven workspaces open the eleven lines were the
 * difference between seeing the list and scrolling it.
 *
 * The count moves onto the workspace row and the line goes away. What does NOT
 * move with it is a needs-you count: the workspace row's leading dot is
 * already `selectWorkspaceAgentStatus`, the most-urgent status rolled up
 * across the whole workspace, so it is red the moment any agent here awaits
 * input. A number beside it would be a second rendering of a signal the row
 * already carries.
 *
 * Stash keeps its own glyph rather than a word — the same `IconEyeOff` the
 * expanded list's stash group header uses, so a collapsed workspace still
 * accounts for panes that are running but off-screen.
 */
function WorkspaceRosterSummary({ workspaceId, open, onToggle }: WorkspaceRosterSummaryProps) {
  const t = useT();
  const selector = useMemo(
    () => createWorkspaceAgentRosterSelector(workspaceId),
    [workspaceId],
  );
  const roster = useStore(selector);

  if (roster.agentCount === 0 && roster.stashedCount === 0) return null;

  // The accessible name keeps the words the visible chip drops. A workspace
  // whose only entries are stashed leads with the stash, never "Agents 0".
  const countLabel =
    roster.agentCount === 0
      ? t('roster.stashedOnly', { count: roster.stashedCount })
      : roster.stashedCount > 0
        ? `${t('workspace.agentCount', { count: roster.agentCount })} · ${t('roster.stashedCount', { count: roster.stashedCount })}`
        : t('workspace.agentCount', { count: roster.agentCount });
  const ariaLabel = [countLabel, open ? t('workspace.hideAgents') : t('workspace.showAgents')].join(', ');

  return (
    <button
      type="button"
      draggable={false}
      className={`flex flex-shrink-0 items-center gap-0.5 rounded px-0.5 text-[9px] font-mono tabular-nums text-[var(--text-muted)] transition-colors hover:text-[var(--text-sub)] ${FOCUS_RING}`}
      aria-expanded={open}
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={(event) => {
        // The workspace row selects the workspace on click; this control must
        // only expand, so it stops the gesture before the row sees it.
        event.stopPropagation();
        onToggle();
      }}
      onMouseDown={(event) => {
        // The row is a native drag source. Without this, pressing the chevron
        // starts a workspace drag instead of arming the click.
        event.preventDefault();
        event.stopPropagation();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
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
      {roster.agentCount > 0 && <span>{roster.agentCount}</span>}
      {roster.stashedCount > 0 && (
        <span className="flex items-center gap-0.5">
          <IconEyeOff size={8} />
          {roster.stashedCount}
        </span>
      )}
    </button>
  );
}

export const WorkspaceRosterSummaryMemo = memo(WorkspaceRosterSummary);

function WorkspaceAgentRoster({ workspaceId, open, onRequestOpen }: WorkspaceAgentRosterProps) {
  const t = useT();
  const selector = useMemo(
    () => createWorkspaceAgentRosterSelector(workspaceId),
    [workspaceId],
  );
  const roster = useStore(selector);
  // #977 — a pane that was just stashed disappeared from the layout. If the
  // list it moved into is collapsed, the gesture is indistinguishable from a
  // delete, so open the list and flash the row once.
  const stashPulse = useStore((s) => s.stashPulse);
  const pulsedPaneId = stashPulse?.workspaceId === workspaceId ? stashPulse.paneId : null;
  const [pulsingPaneId, setPulsingPaneId] = useState<string | null>(null);

  // TWO effects on purpose. Consuming the pulse and owning its timeout in one
  // effect is self-defeating: clearStashPulse() nulls `pulsedPaneId` on the very
  // next render, the effect re-runs, its cleanup clears the pending timeout, and
  // the highlight never turns off — a permanent bar identical to the focused
  // style. Splitting them lets the consume run once and the timeout live on its
  // own key.
  useEffect(() => {
    if (!pulsedPaneId) return;
    onRequestOpen();
    setPulsingPaneId(pulsedPaneId);
    useStore.getState().clearStashPulse();
  }, [pulsedPaneId, onRequestOpen]);

  useEffect(() => {
    if (!pulsingPaneId) return;
    const timer = setTimeout(() => setPulsingPaneId(null), STASH_PULSE_MS);
    return () => clearTimeout(timer);
  }, [pulsingPaneId]);

  if (!open) return null;
  if (roster.agentCount === 0 && roster.stashedCount === 0) return null;

  // Computed once per render, not per row: the vendor column earns its width
  // only when the workspace actually mixes vendors.
  const mixedVendors = rosterHasMixedVendors(roster.rows);

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
      <div className="ml-1 border-l border-[var(--border-soft)] pl-1.5">
          {roster.rows.map((row, index) => {
            // The one-line group header, immediately before the FIRST stashed
            // row. With six of seven panes stashed the list otherwise looked
            // untouched — same rows, same red "Waiting" labels — because an 8px
            // glyph and a relative time are not enough to carry "these are not
            // on your screen". A rule and a count are. It costs one line, and
            // only when there is something below it.
            const startsStashedGroup = !!row.stashed && !roster.rows[index - 1]?.stashed;
            const exited = row.stashedLiveness === 'exited';
            const statusIcon = AGENT_STATUS_ICON[row.status];
            // An exited stashed pane has no agent state left to report; saying
            // "session ended" is both the status and the reason the row looks
            // different from its neighbours.
            const statusLabel = exited ? t('roster.stashedExited') : t(statusIcon.labelKey);
            // A stashed SHELL pane has no agent name, and a shell surface often has
            // no title either — without this the row would render with no text at
            // all. Visible rows always carry an agent name, so it is a no-op there.
            const primary = rosterPrimaryLabel(row) || t('surface.terminal');
            const secondary = rosterSecondaryLabel(row, { showVendor: mixedVendors });
            const detail = row.pendingQuestion ?? row.activity;
            // The verb rides the accessible name and the tooltip, NOT the
            // visible status slot. Swapping the status text on hover would hide
            // the one thing a stashed row exists to prove — that the session is
            // still alive and still moving — at exactly the moment the user is
            // looking at it, and would leave keyboard users with no verb at all.
            const verb = row.stashed
              ? (exited ? t('roster.recoverAction') : t('roster.unstashAction'))
              : undefined;
            const stashedAgo = row.stashedAt ? timeAgo(row.stashedAt) : undefined;
            const rowAriaLabel = [primary, secondary, statusLabel, stashedAgo, detail, verb]
              .filter(Boolean)
              .join(', ');
            return (
              // Keyed by paneId for stashed rows: an exited pane has no ptyId
              // left, and two of them would collide on the empty string.
              <div key={row.stashed ? row.paneId : row.ptyId} className="min-w-0">
                {startsStashedGroup && (
                  <div
                    className="mt-1 flex items-center gap-1.5 border-t border-[var(--border-soft)] pt-1 pr-1 text-[8px] font-mono uppercase tracking-widest text-[var(--text-muted)]"
                    // Not a heading: the rows below it are already listed under
                    // the disclosure's own accessible name, and announcing a
                    // second level would imply a nesting that is not there.
                    aria-hidden="true"
                  >
                    <IconEyeOff size={9} />
                    <span className="truncate">{t('roster.stashedCount', { count: roster.stashedCount })}</span>
                  </div>
                )}
                <button
                  type="button"
                  draggable={false}
                  className={`group/roster-row flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-[3px] text-left transition-colors ${FOCUS_RING} ${
                    row.isFocused
                      ? 'bg-[var(--bg-overlay)]'
                      : 'hover:bg-[rgba(var(--bg-surface-rgb),0.65)]'
                  } ${pulsingPaneId === row.paneId ? 'bg-[var(--bg-overlay)]' : ''}`}
                  style={pulsingPaneId === row.paneId ? { transition: 'background-color 150ms ease-out' } : undefined}
                  title={rowAriaLabel}
                  aria-label={rowAriaLabel}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (row.stashed) {
                      // focusNotificationTarget resolves ptyId → surfaceId and
                      // unstashes on the way, so an exited pane (no ptyId left)
                      // still lands: it re-attaches into the layout and the
                      // existing dead-pane recovery offer renders in its spot,
                      // which is where the user can see WHAT is being recovered.
                      focusNotificationTarget(() => useStore.getState(), {
                        ptyId: row.ptyId || null,
                        surfaceId: row.surfaceId,
                      });
                      return;
                    }
                    focusPaneByPtyId(() => useStore.getState(), row.ptyId);
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onDragStart={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  {/* Filled, not a hollow ring. A ring drawn with box-shadow
                      disappears entirely under forced-colors, taking the row's
                      only status signal with it — and dimming would say "dead"
                      about a pane whose whole claim is the opposite. The stash
                      is signalled by the archive glyph, the list position, and
                      the label instead. */}
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
                  {row.stashed && (
                    // The ICON is the verb slot: eye-off at rest ("not on your
                    // screen"), eye-on under the pointer or keyboard focus
                    // ("bring it back"). The STATUS LABEL beside it never moves
                    // — that is the row's proof of life, and hiding it on hover
                    // would take it away exactly when the user is looking.
                    // CSS-only so it works identically for pointer and keyboard.
                    <span className="flex-none text-[var(--text-muted)]" aria-hidden="true">
                      <span className="block group-hover/roster-row:hidden group-focus-visible/roster-row:hidden">
                        <IconEyeOff size={9} />
                      </span>
                      <span className="hidden text-[var(--text-sub)] group-hover/roster-row:block group-focus-visible/roster-row:block">
                        <IconEye size={9} />
                      </span>
                    </span>
                  )}
                  <span
                    className={`flex-none whitespace-nowrap text-[8px] ${exited ? 'text-[var(--text-muted)]' : statusIcon.className}`}
                  >
                    {statusLabel}
                  </span>
                </button>
                {/* How long it has been off-screen. Free cost visibility: a
                    stashed agent burns tokens whether or not anyone remembers
                    it, and "3d ago" is the cheapest possible reminder. */}
                {row.stashed && stashedAgo && (
                  <div className="truncate pl-[18px] pr-1 text-[8px] text-[var(--text-muted)]">
                    {stashedAgo}
                  </div>
                )}
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
    </div>
  );
}

export default memo(WorkspaceAgentRoster);
