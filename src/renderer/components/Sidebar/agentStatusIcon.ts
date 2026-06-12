import type { AgentStatus } from '../../../shared/types';

// Shared mapping from agent status → visual indicator. Used by WorkspaceItem
// (full sidebar) and MiniSidebar so they stay in lockstep when statuses change.
// `dotVar` paints the row's main status dot, `glowClass` adds the animated
// glow channel (globals.css sidebar polish section), `mark` picks the small
// right-aligned play/pause icon.
export const AGENT_STATUS_ICON: Record<AgentStatus, {
  dot: string;
  className: string;
  labelKey: string;
  dotVar: string;
  glowClass: string;
  mark: 'play' | 'pause' | null;
}> = {
  running:        { dot: '●', className: 'text-[var(--accent-blue)]',   labelKey: 'workspace.agentRunning',       dotVar: 'var(--accent-green)',  glowClass: 'sidebar-dot-running', mark: 'play' },
  complete:       { dot: '●', className: 'text-[var(--accent-green)]',  labelKey: 'workspace.agentComplete',      dotVar: 'var(--accent-green)',  glowClass: '',                    mark: null },
  error:          { dot: '●', className: 'text-[var(--accent-red)]',    labelKey: 'workspace.agentError',         dotVar: 'var(--accent-red)',    glowClass: 'sidebar-dot-error',   mark: null },
  waiting:        { dot: '●', className: 'text-[var(--accent-yellow)]', labelKey: 'workspace.agentWaiting',       dotVar: 'var(--accent-yellow)', glowClass: 'sidebar-dot-waiting', mark: 'pause' },
  awaiting_input: { dot: '●', className: 'text-[var(--accent-yellow)]', labelKey: 'workspace.agentAwaitingInput', dotVar: 'var(--accent-yellow)', glowClass: 'sidebar-dot-waiting', mark: 'pause' },
  idle:           { dot: '●', className: 'text-[var(--text-muted)]',    labelKey: 'workspace.agentIdle',          dotVar: 'var(--text-muted)',    glowClass: '',                    mark: null },
};
