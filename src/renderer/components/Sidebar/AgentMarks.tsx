// ─── Sidebar agent identity glyph + status mark (#1481) ──────────────────────
//
// Two small, single-purpose marks every agent row carries:
//
//   AgentGlyph  — WHICH agent: a one- or two-letter monogram in a rounded
//                 frame, drawn here. Deliberately not a vendor logo or favicon:
//                 those marks are their owners' trademarks and are not ours to
//                 redistribute. Steel/muted, never amber — identity is not
//                 "alive", and amber's budget belongs to running dots. The
//                 agent's name rides the accessible name and tooltip.
//
//   StatusMark  — WHAT it is doing, told by SHAPE first and colour second
//                 (see AGENT_STATUS_ICON.mark): running = filled amber dot ·
//                 needs input = red ring · error = cross · complete = green
//                 check · unconfirmed = hollow amber ring · idle = nothing.

import type { AgentStatus } from '../../../shared/types';
import type { AgentSlug } from '../../../shared/agentIdentity';
import { AGENT_STATUS_ICON, type StatusMark } from './agentStatusIcon';

/**
 * One distinct, readable monogram per known agent. Letters are chosen to be
 * unique across the table (Codex takes X so Claude keeps C; Copilot takes P;
 * Grok takes R), and OpenClaude gets two letters because both of its
 * one-letter candidates are taken.
 */
export const AGENT_MONOGRAM: Record<AgentSlug, string> = {
  claude: 'C',
  codex: 'X',
  gemini: 'G',
  aider: 'A',
  opencode: 'O',
  copilot: 'P',
  openclaude: 'OC',
  kiro: 'K',
  grok: 'R',
};

/** The monogram for a slug, or null for an unknown / absent agent kind. */
export function agentMonogram(slug: string | undefined): string | null {
  if (!slug) return null;
  return (AGENT_MONOGRAM as Record<string, string>)[slug] ?? null;
}

interface AgentGlyphProps {
  slug?: string;
  /** Plain-text agent name for the tooltip / accessible name. */
  name: string;
  size?: number;
  /** When the surrounding control already speaks the name, hide the glyph. */
  decorative?: boolean;
}

/**
 * 11px monogram. Unknown kinds (and plain shells) get a neutral terminal
 * glyph on the same frame so every row keeps the same column.
 */
export function AgentGlyph({ slug, name, size = 11, decorative = false }: AgentGlyphProps) {
  const letters = agentMonogram(slug);
  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img' as const, 'aria-label': name };
  return (
    <span
      className="inline-flex flex-none text-[var(--text-sub)]"
      title={decorative ? undefined : name}
      data-agent-glyph={letters ?? 'terminal'}
      {...a11y}
    >
      <svg width={size} height={size} viewBox="0 0 11 11" fill="none" aria-hidden="true">
        <rect x="0.5" y="0.5" width="10" height="10" rx="2.5" stroke="currentColor" strokeWidth="1" opacity="0.7" />
        {letters ? (
          <text
            x="5.5"
            y="5.6"
            textAnchor="middle"
            dominantBaseline="central"
            fill="currentColor"
            fontFamily="Inter, system-ui, sans-serif"
            fontWeight={600}
            fontSize={letters.length > 1 ? 4.6 : 6.6}
            letterSpacing={letters.length > 1 ? -0.2 : 0}
          >
            {letters}
          </text>
        ) : (
          // Neutral terminal: a prompt chevron and an underscore.
          <g stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3,4 4.6,5.5 3,7" />
            <line x1="5.6" y1="7.2" x2="8" y2="7.2" />
          </g>
        )}
      </svg>
    </span>
  );
}

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
