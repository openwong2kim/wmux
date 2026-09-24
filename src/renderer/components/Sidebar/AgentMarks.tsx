// ─── Sidebar agent status mark (#1481) ───────────────────────────────────────
//
// Agent rows carry no identity glyph: Claude is the default and gets no mark;
// any other agent names itself in muted text on the row (WorkspaceAgentRoster).
//
//   StatusMark  — WHAT it is doing, told by SHAPE first and colour second
//                 (see AGENT_STATUS_ICON.mark): running = filled amber dot ·
//                 needs input = red ring · error = cross · complete = green
//                 check · unconfirmed = hollow amber ring · idle = nothing.

import type { AgentStatus } from '../../../shared/types';
import { AGENT_STATUS_ICON, type StatusMark } from './agentStatusIcon';

/** The mark a row draws: the status table's mark, or the unconfirmed ring. */
export type RowStatusMark = StatusMark | 'unconfirmed';

/** Pure status → mark mapping, so the grammar can be asserted without a DOM. */
export function rowStatusMark(status: AgentStatus, unverifiable: boolean): RowStatusMark {
  if (unverifiable) return 'unconfirmed';
  return AGENT_STATUS_ICON[status].mark;
}

interface StatusMarkViewProps {
  status: AgentStatus;
  unverifiable?: boolean;
  /** Drop the animated glow (a question the user has already seen). */
  quiet?: boolean;
  /** Tooltip + accessible name. Omit when the row already speaks the status. */
  label?: string;
  /** #1481 review — draw a running dot neutral: a secondary summary must not
   *  spend a second amber point on a workspace whose row dot is already amber. */
  neutralRunning?: boolean;
}

/**
 * A 10px box, the same footprint for every mark, so the name column starts at
 * the same x on every row whatever the status. Idle draws an empty box.
 */
export function StatusMarkView({ status, unverifiable = false, quiet = false, label, neutralRunning = false }: StatusMarkViewProps) {
  const icon = AGENT_STATUS_ICON[status];
  const mark = rowStatusMark(status, unverifiable);
  const a11y = label ? { role: 'img' as const, 'aria-label': label, title: label } : { 'aria-hidden': true as const };
  let inner: React.ReactNode = null;
  switch (mark) {
    case 'dot':
      inner = (
        <span
          className={`sidebar-dot h-1.5 w-1.5 rounded-full ${quiet || neutralRunning ? '' : icon.glowClass}`}
          style={{ backgroundColor: neutralRunning && status === 'running' ? 'var(--text-sub)' : icon.dotVar }}
        />
      );
      break;
    case 'ring':
      // Border, not box-shadow: forced-colors keeps borders and drops shadows.
      inner = (
        <span
          className={`sidebar-dot h-[7px] w-[7px] rounded-full ${quiet ? '' : icon.glowClass}`}
          style={{ border: `1.5px solid ${icon.dotVar}` }}
        />
      );
      break;
    case 'unconfirmed':
      inner = <span className="sidebar-dot sidebar-dot-unverifiable h-1.5 w-1.5 rounded-full" />;
      break;
    case 'cross':
      inner = (
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke={icon.dotVar} strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <line x1="1.5" y1="1.5" x2="6.5" y2="6.5" />
          <line x1="6.5" y1="1.5" x2="1.5" y2="6.5" />
        </svg>
      );
      break;
    case 'check':
      inner = (
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke={icon.dotVar} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="1.4,4.8 3.6,6.9 7.6,2.1" />
        </svg>
      );
      break;
    case 'none':
      inner = null;
      break;
  }
  return (
    <span
      className="flex h-2.5 w-2.5 flex-none items-center justify-center"
      data-status-mark={mark}
      {...a11y}
    >
      {inner}
    </span>
  );
}
