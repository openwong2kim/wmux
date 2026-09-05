import type { AgentStatus } from '../../../shared/types';

// Shared mapping from agent status → visual indicator. Used by WorkspaceItem
// (full sidebar) and MiniSidebar so they stay in lockstep when statuses change.
// `dotVar` paints the row's main status dot, `glowClass` adds the animated
// glow channel (globals.css sidebar polish section), `mark` picks the small
// right-aligned play/pause icon.
// `shape` separates error from the other red statuses by FORM, not hue: red is
// spent on both "needs you" and "error", so only the ✕ says which one it is.
export const AGENT_STATUS_ICON: Record<AgentStatus, {
  dot: string;
  className: string;
  labelKey: string;
  dotVar: string;
  glowClass: string;
  mark: 'play' | 'pause' | null;
  shape: 'dot' | 'cross';
}> = {
  // DESIGN.md status-dot vocabulary (must match DeckFleet.dotColor): amber =
  // running/alive, green = complete/ok, red = needs-you (awaiting/waiting) +
  // error, gray = idle. Amber is the canonical --accent-cursor ("the one
  // colored thing"). Previously running was green (indistinguishable from
  // complete) and awaiting/waiting were amber (should be red).
  running:        { dot: '●', className: 'text-[var(--accent-cursor)]', labelKey: 'workspace.agentRunning',       dotVar: 'var(--accent-cursor)', glowClass: 'sidebar-dot-running', mark: 'play', shape: 'dot'   },
  complete:       { dot: '●', className: 'text-[var(--accent-green)]',  labelKey: 'workspace.agentComplete',      dotVar: 'var(--accent-green)',  glowClass: '',                    mark: null,   shape: 'dot'   },
  error:          { dot: '●', className: 'text-[var(--accent-red)]',    labelKey: 'workspace.agentError',         dotVar: 'var(--accent-red)',    glowClass: 'sidebar-dot-error',   mark: null,   shape: 'cross' },
  waiting:        { dot: '●', className: 'text-[var(--accent-red)]',    labelKey: 'workspace.agentWaiting',       dotVar: 'var(--accent-red)',    glowClass: 'sidebar-dot-waiting', mark: 'pause', shape: 'dot'  },
  awaiting_input: { dot: '●', className: 'text-[var(--accent-red)]',    labelKey: 'workspace.agentAwaitingInput', dotVar: 'var(--accent-red)',    glowClass: 'sidebar-dot-waiting', mark: 'pause', shape: 'dot'  },
  idle:           { dot: '●', className: 'text-[var(--text-muted)]',    labelKey: 'workspace.agentIdle',          dotVar: 'var(--text-muted)',    glowClass: '',                    mark: null,   shape: 'dot'   },
};
